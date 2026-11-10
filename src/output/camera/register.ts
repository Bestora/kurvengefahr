// Camera registration run: find the three printed marks with the camera on the cutter head, center
// each one under it, and solve page -> machine. A mark seen at pixel u lies at
// head + J·(u - image center), J = the calibrated camera matrix (`CamCal.m`). Every hardware touch
// goes through `RigIO` (the store wires HeadHold + HTTP capture + WASM detection), so the whole flow
// runs against a simulated world in the tests. The cutter never reports its position: "head" is
// always the last commanded target.
import { checkRegistration, type MarkLayout } from '../../core/registration'
import { fitCamera, solveAffine, type Affine, type CamMatrix, type Detected, type Pt } from '../../core/wasm/registration'
import type { CamCal, CameraRig } from '../../store/cameraRig'
import { beyondSoftLimit, CARRIAGE_AXIS } from '../hpgl/softLimit'
import type { Frame } from './capture'

export interface RigIO {
  /** Held head position (machine mm); null = at the origin, not held. */
  at(): Pt | null
  /** Rejects on abort (the store's AbortSignal) and with SoftLimitError. */
  moveTo(p: Pt): Promise<void>
  capture(): Promise<Frame>
  detect(f: Frame, mmPerPx: number): Detected[]
  diff(a: Frame, b: Frame): number
  sleep(ms: number): Promise<void>
}

/** Mean luma difference below which two consecutive frames count as still. */
export const SETTLE_DIFF = 3
export const SETTLE_MAX_FRAMES = 15
/** A re-measure this close to the previous one ends centering. */
export const CONVERGE_MM = 0.15
const CENTER_ROUNDS = 3
/** Search step as a fraction of the shorter image side, so neighbouring views overlap. */
const STEP_OF_VIEW = 0.6
const SEARCH_ROWS = 4
/** A square-to-corner distance names the corner when within this fraction of the layout's. */
const DIST_TOL = 0.02
/** Probe move for the camera calibration. */
const PROBE_MM = 3
/** Plausible camera scale. Outside it the search step is metres or microns - a failed calibration. */
export const MM_PER_PX_RANGE = [0.01, 0.3] as const

export class RegistrationError extends Error {}
/** Nothing of the wanted kind around the guess - a search moves on to its next candidate. */
class MarkNotFound extends RegistrationError {}

export interface SheetResult {
  affine: Affine
  /** Machine mm. */
  marks: MarkLayout
  /** From `checkRegistration`; the caller shows it and asks before using the result. */
  warning: string | null
}

type Corner = 'topRight' | 'bottomLeft'
const LABEL: Record<keyof MarkLayout, string> = {
  square: 'square',
  topRight: 'top-right corner',
  bottomLeft: 'bottom-left corner',
}
const ORIGIN: Pt = { x: 0, y: 0 }
const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + k * b.x, y: a.y + k * b.y })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const fmt = (p: Pt) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
/** A point from carriage-axis and feed-axis coordinates. */
const onAxes = (carriage: number, feed: number): Pt =>
  CARRIAGE_AXIS === 'y' ? { x: feed, y: carriage } : { x: carriage, y: feed }
const mmPerPx = (m: CamMatrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
export function plausibleCam(cam: CamCal): boolean {
  const s = mmPerPx(cam.m)
  return s >= MM_PER_PX_RANGE[0] && s <= MM_PER_PX_RANGE[1]
}
const stepMm = (cam: CamCal) => STEP_OF_VIEW * Math.min(cam.w, cam.h) * mmPerPx(cam.m)
const reachable = (p: Pt, limitMm: number) => p.x >= 0 && p.y >= 0 && !beyondSoftLimit(p, limitMm)

/** Wait out the move, then return the first frame that matches its predecessor. */
export async function settle(io: RigIO, distMm: number): Promise<Frame> {
  await io.sleep(Math.max(250, 200 + 4 * distMm))
  let prev = await io.capture()
  for (let i = 1; i < SETTLE_MAX_FRAMES; i++) {
    const cur = await io.capture()
    if (io.diff(prev, cur) < SETTLE_DIFF) return cur
    prev = cur
  }
  throw new RegistrationError('The head did not come to rest')
}

async function goTo(io: RigIO, target: Pt): Promise<Frame> {
  const from = io.at() ?? ORIGIN
  await io.moveTo(target)
  return settle(io, dist(from, target))
}

/** The mark of `kind` (any when null) nearest the image center. */
function nearest(marks: Detected[], f: Frame, kind: Detected['kind'] | null): Detected | null {
  const r = (m: Detected) => Math.hypot(m.x - f.width / 2, m.y - f.height / 2)
  return marks
    .filter((m) => !kind || m.kind === kind)
    .reduce<Detected | null>((best, m) => (best && r(best) <= r(m) ? best : m), null)
}

interface Seen {
  kind: Detected['kind']
  at: Pt
}

/** The mark nearest the center of `f` (taken with the head at `head`), in machine mm. */
function markIn(io: RigIO, cam: CamCal, f: Frame, head: Pt, kind: Detected['kind'] | null): Seen | null {
  if (f.width !== cam.w || f.height !== cam.h) throw new RegistrationError('Calibrate the camera first')
  const m = nearest(io.detect(f, mmPerPx(cam.m)), f, kind)
  if (!m) return null
  const [a, b, c, d] = cam.m
  const du = m.x - f.width / 2
  const dv = m.y - f.height / 2
  return { kind: m.kind, at: { x: head.x + a * du + b * dv, y: head.y + c * du + d * dv } }
}

const look = async (io: RigIO, cam: CamCal, target: Pt, kind: Detected['kind'] | null) =>
  markIn(io, cam, await goTo(io, target), target, kind)

const SPIRAL = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const

/** Center the `kind` mark near `guess` under the camera; its machine-mm position. */
export async function measureMark(
  io: RigIO,
  cam: CamCal,
  guess: Pt,
  kind: Detected['kind'],
  limitMm: number,
): Promise<Pt> {
  const s = stepMm(cam)
  let hit: Pt | null = null
  for (const [i, j] of SPIRAL) {
    const t = { x: guess.x + i * s, y: guess.y + j * s }
    if (!reachable(t, limitMm)) continue
    hit = (await look(io, cam, t, kind))?.at ?? null
    if (hit) break
  }
  if (!hit) throw new MarkNotFound(`No ${kind} mark near ${fmt(guess)}.`)
  let p: Pt = hit
  for (let i = 0; i < CENTER_ROUNDS; i++) {
    if (!reachable(p, limitMm)) throw new RegistrationError(`The ${kind} mark at ${fmt(p)} is out of reach.`)
    const q: Pt | undefined = (await look(io, cam, p, kind))?.at
    if (!q) throw new RegistrationError(`Lost the ${kind} mark while centering it.`)
    if (dist(p, q) <= CONVERGE_MM) return q
    p = q
  }
  throw new RegistrationError(`The ${kind} mark does not center under the camera - calibrate the camera again.`)
}

async function tryMeasure(io: RigIO, cam: CamCal, guess: Pt, kind: Detected['kind'], limitMm: number) {
  try {
    return await measureMark(io, cam, guess, kind, limitMm)
  } catch (e) {
    if (e instanceof MarkNotFound) return null
    throw e
  }
}

export async function registerSheet(
  io: RigIO,
  rig: CameraRig,
  onStatus: (msg: string) => void,
): Promise<SheetResult> {
  const { cam, lastMarks, marks: page } = rig
  if (!cam || !plausibleCam(cam)) throw new RegistrationError('Calibrate the camera first')
  // Manual start: a mark the operator jogged into view is the first mark of a search. Looked at
  // before the fast path moves the head away.
  const held = io.at()
  const jogged = held ? markIn(io, cam, await settle(io, 0), held, null) : null
  let found: MarkLayout | null = null
  if (lastMarks) {
    // Fast path: the next sheet usually lies where the last one did.
    const measure = (k: keyof MarkLayout) => {
      onStatus(`Measuring ${LABEL[k]}…`)
      return measureMark(io, cam, lastMarks[k], k === 'square' ? 'square' : 'corner', rig.softLimitMm)
    }
    try {
      found = {
        square: await measure('square'),
        topRight: await measure('topRight'),
        bottomLeft: await measure('bottomLeft'),
      }
    } catch (e) {
      if (!(e instanceof RegistrationError)) throw e
    }
  }
  found ??= await search(io, cam, rig, jogged, onStatus)
  const affine = solveAffine(
    [page.square, page.topRight, page.bottomLeft],
    [found.square, found.topRight, found.bottomLeft],
  )
  if (!affine) throw new RegistrationError('The marks lie on one line - check the mark layout.')
  const { error, warning } = checkRegistration(affine, rig.lastAffine)
  if (error) throw new RegistrationError(error)
  return { affine, marks: found, warning }
}

/** Cold path: a first mark (`first`, else by row scan), then its two partners. */
async function search(
  io: RigIO,
  cam: CamCal,
  rig: CameraRig,
  first: Seen | null,
  onStatus: (msg: string) => void,
): Promise<MarkLayout> {
  const { marks: page, softLimitMm: lim } = rig
  if (!first) {
    onStatus('Searching for the first mark…')
    const s = stepMm(cam)
    // ponytail: four search rows from feed 0 - extend when sheets lie further back.
    rows: for (let k = 0; k < SEARCH_ROWS; k++) {
      for (let c = 0; c <= lim; c += s) {
        first = await look(io, cam, onAxes(c, k * s), null)
        if (first) break rows
      }
    }
  }
  if (!first) throw new RegistrationError('No mark found - jog the camera over a mark and try again.')
  onStatus('Measuring the first mark…')
  const m1 = await measureMark(io, cam, first.at, first.kind, lim)

  // Second mark: the square's partner along the carriage axis, named by its distance.
  const pageDist: Record<Corner, number> = {
    topRight: dist(page.topRight, page.square),
    bottomLeft: dist(page.bottomLeft, page.square),
  }
  const along = onAxes(1, 0)
  const partner = first.kind === 'square' ? 'corner' : 'square'
  onStatus('Searching for the second mark…')
  let pair: { square: Pt; corner: Pt; which: Corner } | null = null
  let offDist: number | null = null
  for (const d of [pageDist.topRight, -pageDist.topRight, pageDist.bottomLeft, -pageDist.bottomLeft]) {
    const m2 = await tryMeasure(io, cam, add(m1, along, d), partner, lim)
    if (!m2) continue
    const got = dist(m1, m2)
    const fits = (k: Corner) => Math.abs(got / pageDist[k] - 1) <= DIST_TOL
    const which: Corner | null = fits('topRight') ? 'topRight' : fits('bottomLeft') ? 'bottomLeft' : null
    if (!which) {
      offDist ??= got
      continue
    }
    pair = first.kind === 'square' ? { square: m1, corner: m2, which } : { square: m2, corner: m1, which }
    break
  }
  if (!pair) {
    throw new RegistrationError(
      offDist === null
        ? `Found a ${first.kind} mark but no partner along the carriage - align a sheet edge with the carriage.`
        : `The second mark is ${offDist.toFixed(1)} mm from the first; the layout says ${pageDist.topRight.toFixed(1)} or ${pageDist.bottomLeft.toFixed(1)} mm - wrong mark or the scale is off.`,
    )
  }

  // Third mark: off the square, perpendicular to the known corner, at the measured scale.
  const { square, corner, which } = pair
  const missing: Corner = which === 'topRight' ? 'bottomLeft' : 'topRight'
  const known = sub(corner, square)
  const len = Math.hypot(known.x, known.y)
  const normal = { x: -known.y / len, y: known.x / len }
  const reach = (pageDist[missing] * len) / pageDist[which]
  onStatus(`Measuring ${LABEL[missing]}…`)
  for (const sign of [1, -1]) {
    const m3 = await tryMeasure(io, cam, add(square, normal, sign * reach), 'corner', lim)
    if (m3) {
      return which === 'topRight'
        ? { square, topRight: corner, bottomLeft: m3 }
        : { square, topRight: m3, bottomLeft: corner }
    }
  }
  throw new RegistrationError(`The ${LABEL[missing]} mark was not found.`)
}

/** px -> mm matrix from three looks at the square: at `start`, then PROBE_MM along x and along y. */
export async function calibrateCamera(io: RigIO, start: Pt): Promise<CamCal> {
  const shot = async (d: Pt) => {
    const f = await goTo(io, add(start, d))
    const sq = nearest(io.detect(f, 0), f, 'square')
    if (!sq) throw new RegistrationError('No square mark under the camera - jog the camera over the square.')
    return { f, sq }
  }
  const dx = { x: PROBE_MM, y: 0 }
  const dy = { x: 0, y: PROBE_MM }
  const a = await shot(ORIGIN)
  const b = await shot(dx)
  const c = await shot(dy)
  const m = fitCamera([sub(a.sq, b.sq), sub(a.sq, c.sq)], [dx, dy])
  const cal = m && { m, w: a.f.width, h: a.f.height }
  if (!cal || !plausibleCam(cal)) {
    throw new RegistrationError('The square did not move in the image - is the camera on the head?')
  }
  return cal
}
