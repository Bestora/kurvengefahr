// Camera registration at runtime: runs the registration flow (`output/camera/register.ts`) against
// the real rig - the HP-GL head through one module-level `HeadHold`, frames over HTTP, marks via
// WASM - and keeps the measured page -> machine affine until one cutting job consumes it. Rig
// settings (URL, calibration, soft limit, last marks) live in `cameraRig`; this store is never
// persisted. Every head move sets `headAway`, which locks plotting until the head is home again;
// the plot session also refuses while a run is busy, and these actions refuse while it plots.
import { create } from 'zustand'
import { withOffset } from '../core/registration'
import { affineStrain, findMarks, frameDiff, type Affine, type Pt } from '../core/wasm/registration'
import { captureFrame } from '../output/camera/capture'
import { calibrateCamera, registerSheet, RegistrationError, settle, type RigIO } from '../output/camera/register'
import { HeadHold } from '../output/hpgl/headHold'
import type { WebSerialTransport } from '../output/serial/transport'
import { useCameraRig, type CameraRig } from './cameraRig'
import { useDoc } from './document'
import { usePlotSession } from './plotSession'
import { currentHpgl, useSerial } from './serial'

export type RegPhase = 'idle' | 'busy' | 'ready' | 'error'

interface RegistrationStore {
  phase: RegPhase
  affine: Affine | null
  /** Status or error, English. */
  message: string | null
  /** Series drift; cutting asks for confirmation first. */
  warning: string | null
  /** Object URL of the latest frame (the previous one is revoked). */
  frameUrl: string | null
  /** Find and measure the sheet's marks; stores them as the rig's last marks/affine. */
  measure(): Promise<void>
  /** Camera px -> mm calibration at the current head position. */
  calibrate(): Promise<void>
  jog(dx: number, dy: number): Promise<void>
  /** Fetch one frame, nothing else. */
  snapshot(): Promise<void>
  home(): Promise<void>
  /** Abort the running action; the head goes home. */
  cancel(): void
  /** A cutting job used the registration up. */
  consume(): void
}

/** The cut's page -> machine map: the registration plus the knife offset. No camera URL = a plain plot. */
export function cutMap(
  rig: Pick<CameraRig, 'url' | 'knifeOffset'>,
  affine: Affine | null,
): { map: Affine | null; error: string | null } {
  if (!rig.url) return { map: null, error: null }
  if (!affine) return { map: null, error: 'Measure the sheet first.' }
  return { map: withOffset(affine, rig.knifeOffset), error: null }
}

const ORIGIN: Pt = { x: 0, y: 0 }
let hold: HeadHold | null = null
let holdLink: WebSerialTransport | null = null
let holdLimit = 0
/** The running action's; replaced per action. */
let abort = new AbortController()

/** The head hold, rebuilt when the port or the soft limit changed. */
function headHold(): HeadHold {
  const link = currentHpgl()
  const { profile } = useDoc.getState()
  // Plain Error, not RegistrationError: registerSheet's fast path would swallow it and search on.
  if (!link || profile.kind !== 'hpgl') throw new Error('Connect the HP-GL cutter first.')
  const limit = useCameraRig.getState().softLimitMm
  if (hold && link === holdLink && limit === holdLimit) return hold
  hold?.stop()
  if (link !== holdLink) link.onDisconnect(() => linkGone(link))
  hold = new HeadHold(link, profile, limit)
  holdLink = link
  holdLimit = limit
  return hold
}

/** A hold never outlives its port. */
function linkGone(link: WebSerialTransport) {
  if (link !== holdLink) return
  hold?.stop()
  hold = null
  holdLink = null
  if (useRegistration.getState().phase !== 'busy') return
  const gone = new Error('The plotter disconnected.')
  abort.abort(gone)
  useRegistration.setState({ phase: 'error', message: gone.message })
}

/** Never throws: a dead port can't take the command, and the cutter drives home on silence anyway. */
async function goHome() {
  const h = hold
  if (!h) return
  try {
    await h.home()
  } catch {
    h.stop()
  }
  useSerial.getState().setHeadAway(false)
}

function showFrame(blob: Blob) {
  if (typeof URL.createObjectURL !== 'function') return
  const prev = useRegistration.getState().frameUrl
  if (prev) URL.revokeObjectURL(prev)
  useRegistration.setState({ frameUrl: URL.createObjectURL(blob) })
}

function rigIO(signal: AbortSignal): RigIO {
  return {
    at: () => hold?.at ?? null,
    moveTo: async (p) => {
      signal.throwIfAborted()
      await headHold().moveTo(p)
      signal.throwIfAborted() // cancel's home() superseded this move
      useSerial.getState().setHeadAway(true)
    },
    capture: async () => {
      const f = await captureFrame(useCameraRig.getState().url)
      showFrame(f.blob)
      return f
    },
    detect: (f, mmPerPx) => findMarks(f.rgba, f.width, f.height, mmPerPx),
    diff: (a, b) => frameDiff(a.rgba, b.rgba),
    sleep: (ms) =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted()
        const stop = () => {
          clearTimeout(t)
          reject(signal.reason)
        }
        const t = setTimeout(() => {
          signal.removeEventListener('abort', stop)
          resolve()
        }, ms)
        signal.addEventListener('abort', stop, { once: true })
      }),
  }
}

export const useRegistration = create<RegistrationStore>((set, get) => {
  /** One action at a time, never during a plot: busy while it runs, its outcome as the message. */
  const act = async (work: (io: RigIO) => Promise<string | null>) => {
    if (get().phase === 'busy' || usePlotSession.getState().phase !== 'idle') return
    const ctl = (abort = new AbortController())
    set({ phase: 'busy', message: null })
    try {
      const message = await work(rigIO(ctl.signal))
      set({ phase: get().affine ? 'ready' : 'idle', message })
    } catch (e) {
      const err = ctl.signal.aborted ? ctl.signal.reason : e
      set({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    phase: 'idle',
    affine: null,
    message: null,
    warning: null,
    frameUrl: null,

    measure: () =>
      act(async (io) => {
        set({ affine: null, warning: null })
        try {
          const r = await registerSheet(io, useCameraRig.getState(), (message) => set({ message }))
          useCameraRig.getState().patch({ lastMarks: r.marks, lastAffine: r.affine })
          set({ affine: r.affine, warning: r.warning })
          const s = affineStrain(r.affine)
          return `Sheet measured: rotated ${s.rotDeg.toFixed(2)} deg, scale ${s.sx.toFixed(4)} x ${s.sy.toFixed(4)}.`
        } finally {
          // The operator swaps camera for knife at the origin; home also unblocks plotting.
          await goHome()
        }
      }),

    // The head stays where calibration left it - measuring starts from there.
    calibrate: () =>
      act(async (io) => {
        useCameraRig.getState().patch({ cam: await calibrateCamera(io, io.at() ?? ORIGIN) })
        return 'Camera calibrated.'
      }),

    jog: (dx, dy) =>
      act(async (io) => {
        const from = io.at() ?? ORIGIN
        await io.moveTo({ x: from.x + dx, y: from.y + dy })
        await settle(io, Math.hypot(dx, dy)) // the frame once the head is still
        return null
      }),

    snapshot: () =>
      act(async (io) => {
        await io.capture()
        return null
      }),

    home: () =>
      act(async () => {
        await goHome()
        return null
      }),

    cancel: () => {
      if (usePlotSession.getState().phase !== 'idle') return // home would cut into the plot
      abort.abort(new RegistrationError('Cancelled.'))
      void goHome()
    },

    consume: () => set({ affine: null, warning: null, phase: 'idle', message: null }),
  }
})
