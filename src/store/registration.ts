// Camera registration at runtime: runs the registration flow (`output/camera/register.ts`) against
// the real rig - the HP-GL head through the one `HeadHold` per port (shared with the machine tab's
// Go-to-fiducial, so two holds never fight over the head), frames over HTTP, marks via WASM - and
// keeps the measured page -> machine affine until one cutting job consumes it. Rig
// settings (URL, calibration, soft limit, last marks) live in `cameraRig`; this store is never
// persisted. Every head move sets `headAway`, which locks plotting until the head is home again;
// the plot session also refuses while a run is busy, and these actions refuse while it plots.
import { create } from 'zustand'
import { withOffset } from '../core/registration'
import { affineStrain, findMarks, frameDiff, type Affine, type Pt } from '../core/wasm/registration'
import { captureFrame } from '../output/camera/capture'
import { calibrateCamera, findSquare, plausibleCam, registerSheet, RegistrationError, settle, type RigIO } from '../output/camera/register'
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
  /** Live status (where the head goes), then the outcome or error. English. */
  message: string | null
  /** Steps of the running / last action, oldest first. */
  log: string[]
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
let holdLimit: number | null = null
/** The running action's; replaced per action. */
let abort = new AbortController()

/** The port's one head hold, rebuilt when the port or the soft limit changed. The limit guards
 *  the camera bracket, so it applies only with the camera rig on. */
export function headHold(): HeadHold {
  const link = currentHpgl()
  const { profile } = useDoc.getState()
  // Plain Error, not RegistrationError: registerSheet's fast path would swallow it and search on.
  if (!link || profile.kind !== 'hpgl') throw new Error('Connect the HP-GL cutter first.')
  const rig = useCameraRig.getState()
  const limit = rig.url ? rig.softLimitMm : null
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

/** Head to the origin, hold released. Never throws: a dead port can't take the command, and the
 *  cutter drives home on silence anyway. */
export async function goHome(): Promise<void> {
  if (!currentHpgl()) return
  try {
    await headHold().home()
  } catch {
    hold?.stop()
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
      useRegistration.setState({ message: `Moving to (${p.x.toFixed(1)}, ${p.y.toFixed(1)})…` })
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
    set({ phase: 'busy', message: null, log: [] })
    try {
      const message = await work(rigIO(ctl.signal))
      set({ phase: get().affine ? 'ready' : 'idle', message })
    } catch (e) {
      const err = ctl.signal.aborted ? ctl.signal.reason : e
      set({ phase: 'error', message: `Failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const note = (m: string) => set({ log: [...get().log, m] })
  // The head stays on the square - a measure right after starts from that mark.
  const calibrateHere = async (io: RigIO) => {
    const at = await findSquare(io, io.at() ?? ORIGIN, useCameraRig.getState().softLimitMm, note)
    const cam = await calibrateCamera(io, at)
    useCameraRig.getState().patch({ cam })
    const s = Math.sqrt(Math.abs(cam.m[0] * cam.m[3] - cam.m[1] * cam.m[2]))
    return `Camera calibrated: ${s.toFixed(3)} mm/px, view ${(cam.w * s).toFixed(0)} x ${(cam.h * s).toFixed(0)} mm.`
  }

  return {
    phase: 'idle',
    affine: null,
    message: null,
    log: [],
    warning: null,
    frameUrl: null,

    measure: () =>
      act(async (io) => {
        set({ affine: null, warning: null })
        try {
          const { cam } = useCameraRig.getState()
          if (!cam || !plausibleCam(cam)) note(await calibrateHere(io))
          const r = await registerSheet(io, useCameraRig.getState(), note)
          useCameraRig.getState().patch({ lastMarks: r.marks, lastAffine: r.affine })
          set({ affine: r.affine, warning: r.warning })
          const s = affineStrain(r.affine)
          return `Sheet measured: rotated ${s.rotDeg.toFixed(2)} deg, scale ${s.sx.toFixed(4)} x ${s.sy.toFixed(4)}. Swap the camera for the knife, then cut.`
        } finally {
          // The operator swaps camera for knife at the origin; home also unblocks plotting.
          await goHome()
        }
      }),

    calibrate: () => act(calibrateHere),

    jog: (dx, dy) =>
      act(async (io) => {
        const from = io.at() ?? ORIGIN
        const to = { x: from.x + dx, y: from.y + dy }
        // The search never goes below the origin, so a mark jogged to out there can't be measured.
        // Only moves further out are refused - a head already out there can come back.
        if ((dx < 0 && to.x < 0) || (dy < 0 && to.y < 0)) {
          throw new RegistrationError(
            `(${to.x.toFixed(1)}, ${to.y.toFixed(1)}) is out of reach - X and Y stay at or above the origin. Move the cutter's origin instead.`,
          )
        }
        await io.moveTo(to)
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

    consume: () => set({ affine: null, warning: null, phase: 'idle', message: null, log: [] }),
  }
})
