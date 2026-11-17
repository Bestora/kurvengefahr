// Camera registration run: find the three printed marks with the camera on the cutter head, center
// each one under it, and solve page -> machine. A mark seen at pixel u lies at
// head + J·(u - image center), J = the calibrated camera matrix (`CamCal.m`). Every hardware touch
// goes through `RigIO` (the store wires HeadHold + HTTP capture + WASM detection), so the whole flow
// runs against a simulated world in the tests. The cutter never reports its position: "head" is
// always the last commanded target.
import { checkRegistration, markNames, type MarkLayout } from '../../core/registration'
import { affineStrain, fitCamera, solveAffine, type Affine, type CamMatrix, type Detected, type Pt } from '../../core/wasm/registration'
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
export const SETTLE_MAX_FRAMES = 40
/** Frames the camera may still hold from before the move. */
export const STALE_FRAMES = 2
/** A re-measure this close to the previous one ends centering. */
export const CONVERGE_MM = 0.15
const CENTER_ROUNDS = 3
/** Search step as a fraction of the shorter image side, so neighbouring views overlap. */
const STEP_OF_VIEW = 0.8
const SEARCH_ROWS = 4
/** Feed spacing of the search rows - finer than the view so a mark at a row's edge is not missed. */
const ROW_FEED_MM = 5
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

type Corner = 'cornerX' | 'cornerY'
const ORIGIN: Pt = { x: 0, y: 0 }
const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + k * b.x, y: a.y + k * b.y })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const cap = (t: string) => t[0].toUpperCase() + t.slice(1)
const fmt = (p: Pt) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
/** A point from carriage-axis and feed-axis coordinates. */
const onAxes = (carriage: number, feed: number): Pt =>
  CARRIAGE_AXIS === 'y' ? { x: feed, y: carriage } : { x: carriage, y: feed }
const mmPerPx = (m: CamMatrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
export function plausibleCam(cam: CamCal): boolean {
  const s = mmPerPx(cam.m)
  return s >= MM_PER_PX_RANGE[0] && s <= MM_PER_PX_RANGE[1]
}
/** Widest mark (a corner's 9.4 mm leg plus margin): a mark only counts when wholly inside the view. */
const MARK_SPAN_MM = 10
/** Search pitch: the strip of the view where a whole mark fits, overlapped (STEP_OF_VIEW). On the
 *  SK-720T's ~19 mm view that is ~7 mm - a pitch of 60 % of the view left gaps a corner fell into. */
const stepMm = (cam: CamCal) =>
  Math.max(2, STEP_OF_VIEW * (Math.min(cam.w, cam.h) * mmPerPx(cam.m) - MARK_SPAN_MM))
/** Furthest feed travel any registration move may ask for - past it the mat can leave the rollers.
 *  ponytail: fixed for a 12" mat; make it a rig setting if longer media show up. */
export const FEED_LIMIT_MM = 300
const feedOf = (p: Pt) => (CARRIAGE_AXIS === 'y' ? p.x : p.y)
const reachable = (p: Pt, limitMm: number) =>
  p.x >= 0 && p.y >= 0 && feedOf(p) <= FEED_LIMIT_MM && !beyondSoftLimit(p, limitMm)
/** The reachable point nearest `p`. */
function clampReach(p: Pt, limitMm: number): Pt {
  const feed = Math.min(Math.max(feedOf(p), 0), FEED_LIMIT_MM)
  const carriage = Math.min(Math.max(CARRIAGE_AXIS === 'y' ? p.y : p.x, 0), limitMm)
  return onAxes(carriage, feed)
}
/** Which limit `p` lies past, for the operator. */
function whyOut(p: Pt, limitMm: number): string {
  const feed = feedOf(p)
  const carriage = CARRIAGE_AXIS === 'y' ? p.y : p.x
  const F = CARRIAGE_AXIS === 'y' ? 'X' : 'Y'
  const C = CARRIAGE_AXIS === 'y' ? 'Y' : 'X'
  if (carriage > limitMm) return `${(carriage - limitMm).toFixed(1)} mm past the soft limit (${C} ${limitMm} mm)`
  if (feed > FEED_LIMIT_MM) return `${(feed - FEED_LIMIT_MM).toFixed(1)} mm past the feed limit (${F} ${FEED_LIMIT_MM} mm)`
  if (feed < 0) return `${(-feed).toFixed(1)} mm behind the origin in ${F} (feed)`
  return `${(-carriage).toFixed(1)} mm behind the origin in ${C} (carriage)`
}
/** How far past a limit a mark may lie and still be wholly in view from the limit (a square printed
 *  right at the origin, a slightly skewed sheet's far corner). Such a mark is measured off-center
 *  from the limit - the calibrated camera matrix maps the offset; the head never crosses. */
const edgeMm = (cam: CamCal) => Math.max(0, (Math.min(cam.w, cam.h) * mmPerPx(cam.m) - MARK_SPAN_MM) / 2)

/** Wait out the move, then return the first frame that matches its predecessor. */
export async function settle(io: RigIO, distMm: number): Promise<Frame> {
  // ponytail: ~100 mm/s worst case (the feed rollers are the slow axis on the SK-720T); tune if moves get faster
  await io.sleep(Math.max(250, 300 + 10 * distMm))
  // The ESP32 hands out frames it grabbed earlier (driver frame buffers): drop them unseen.
  for (let i = 0; i < STALE_FRAMES; i++) await io.capture()
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

/** Look positions around a guess, nearest first: the 5×5 block of steps (±2 steps). */
const SPIRAL: readonly (readonly [number, number])[] = Array.from({ length: 25 }, (_, k) => [(k % 5) - 2, Math.floor(k / 5) - 2] as const)
  .sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))

/** Center the `kind` mark near `guess` under the camera; its machine-mm position. */
export async function measureMark(
  io: RigIO,
  cam: CamCal,
  guess: Pt,
  kind: Detected['kind'],
  limitMm: number,
): Promise<Pt> {
  // A mark further out can never be measured - say so before touring the looks around it.
  // ponytail: a partner guess just past the edge band gives up even if its mark lies just inside.
  const outOfReach = (p: Pt) => dist(p, clampReach(p, limitMm)) > edgeMm(cam)
  if (outOfReach(guess)) {
    throw new MarkNotFound(
      `The ${kind} mark near ${fmt(guess)} is out of reach: ${whyOut(guess, limitMm)}.`,
    )
  }
  const s = stepMm(cam)
  let hit: Pt | null = null
  for (const [i, j] of SPIRAL) {
    const t = { x: guess.x + i * s, y: guess.y + j * s }
    if (outOfReach(t)) continue
    hit = (await look(io, cam, clampReach(t, limitMm), kind))?.at ?? null
    if (hit) break
  }
  if (!hit) throw new MarkNotFound(`No ${kind} mark near ${fmt(guess)}.`)
  // Each round looks from the last estimate (clamped into reach) until the estimate stops moving.
  let p: Pt = hit
  for (let i = 0; i < CENTER_ROUNDS; i++) {
    const t = clampReach(p, limitMm)
    const q: Pt | undefined = (await look(io, cam, t, kind))?.at
    if (!q) {
      throw new RegistrationError(
        dist(p, t) > 0
          ? `The ${kind} mark at ${fmt(p)} is out of reach: ${whyOut(p, limitMm)}.`
          : `Lost the ${kind} mark while centering it.`,
      )
    }
    if (dist(p, q) <= CONVERGE_MM) return q
    p = q
  }
  throw new RegistrationError(`The ${kind} mark does not center under the camera - calibrate the camera again.`)
}

/** The mark's position, or why it was not found there. */
async function tryMeasure(
  io: RigIO,
  cam: CamCal,
  guess: Pt,
  kind: Detected['kind'],
  limitMm: number,
): Promise<Pt | string> {
  try {
    return await measureMark(io, cam, guess, kind, limitMm)
  } catch (e) {
    if (e instanceof MarkNotFound) return e.message
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
  if (held) onStatus(jogged ? `A ${jogged.kind} mark is under the camera at ${fmt(jogged.at)}.` : 'No mark under the camera.')
  let found: MarkLayout | null = null
  // A mark the operator jogged onto far from the last sheet's says the sheet moved.
  const moved = jogged && Object.values(lastMarks ?? {}).every((p) => dist(p, jogged.at) > MARK_SPAN_MM)
  if (lastMarks && !moved) {
    // Fast path: the next sheet usually lies where the last one did.
    onStatus('Looking where the last sheet was…')
    const measure = async (k: keyof MarkLayout) => {
      onStatus(`Measuring ${markNames(page)[k]}…`)
      const p = await measureMark(io, cam, lastMarks[k], k === 'square' ? 'square' : 'corner', rig.softLimitMm)
      onStatus(`${cap(markNames(page)[k])} at ${fmt(p)}.`)
      return p
    }
    try {
      found = {
        square: await measure('square'),
        cornerX: await measure('cornerX'),
        cornerY: await measure('cornerY'),
      }
    } catch (e) {
      if (!(e instanceof RegistrationError)) throw e
      onStatus(`Not where the last sheet was: ${e.message}`)
    }
  }
  found ??= await search(io, cam, rig, jogged, onStatus)
  const affine = solveAffine(
    [page.square, page.cornerX, page.cornerY],
    [found.square, found.cornerX, found.cornerY],
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
      onStatus(`Sweeping row ${k + 1} of ${SEARCH_ROWS} along Y (feed ${k * ROW_FEED_MM} mm, every ${s.toFixed(1)} mm)…`)
      for (let c = 0; c <= lim; c += s) {
        first = await look(io, cam, onAxes(c, k * ROW_FEED_MM), null)
        if (first) break rows
      }
    }
  }
  if (!first) throw new RegistrationError('No mark found - jog the camera over a mark and try again.')
  onStatus(`Found a ${first.kind} mark near ${fmt(first.at)} - centering it…`)
  const m1 = await measureMark(io, cam, first.at, first.kind, lim)
  onStatus(`First mark (${first.kind}) at ${fmt(m1)}.`)

  // Second mark: the square's partner along the carriage axis (or the feed axis, when the first mark
  // is a corner on the far side of the square), named by its distance.
  const pageDist: Record<Corner, number> = {
    cornerX: dist(page.cornerX, page.square),
    cornerY: dist(page.cornerY, page.square),
  }
  const partner = first.kind === 'square' ? 'corner' : 'square'
  onStatus('Searching for the second mark…')
  let pair: { square: Pt; corner: Pt; which: Corner } | null = null
  let offDist: number | null = null
  // Guesses: from the last accepted sheet's scale and rotation first (prints are often a few % small,
  // which puts a corner 5 mm off the layout distance), then the layout distance along the carriage,
  // then along the feed. Unreachable guesses cost no moves.
  const guesses: Pt[] = []
  if (rig.lastAffine) {
    const [a, b, , d, e] = rig.lastAffine
    const lin = (v: Pt): Pt => ({ x: a * v.x + b * v.y, y: d * v.x + e * v.y })
    for (const k of ['cornerX', 'cornerY'] as const) {
      const v = sub(page[k], page.square)
      guesses.push(add(m1, lin(first.kind === 'square' ? v : { x: -v.x, y: -v.y }), 1))
    }
  }
  for (const along of [onAxes(1, 0), onAxes(0, 1)])
    for (const d of [pageDist.cornerX, -pageDist.cornerX, pageDist.cornerY, -pageDist.cornerY])
      guesses.push(add(m1, along, d))
  for (const g of guesses) {
    onStatus(`Looking for the ${partner} near ${fmt(g)}…`)
    const m2 = await tryMeasure(io, cam, g, partner, lim)
    if (typeof m2 === 'string') {
      onStatus(m2)
      continue
    }
    const got = dist(m1, m2)
    const fits = (k: Corner) => Math.abs(got / pageDist[k] - 1) <= DIST_TOL
    const which: Corner | null = fits('cornerX') ? 'cornerX' : fits('cornerY') ? 'cornerY' : null
    if (!which) {
      onStatus(`A ${partner} at ${fmt(m2)} is ${got.toFixed(1)} mm away - not the layout's ${pageDist.cornerX.toFixed(1)} or ${pageDist.cornerY.toFixed(1)} mm, skipped.`)
      offDist ??= got
      continue
    }
    onStatus(`${cap(markNames(page)[which])} pairs with the square (${got.toFixed(1)} mm apart).`)
    pair = first.kind === 'square' ? { square: m1, corner: m2, which } : { square: m2, corner: m1, which }
    break
  }
  if (!pair) {
    throw new RegistrationError(
      offDist === null
        ? `Found a ${first.kind} mark but no partner along the carriage or the feed - align a sheet edge with the carriage.`
        : `The second mark is ${offDist.toFixed(1)} mm from the first; the layout says ${pageDist.cornerX.toFixed(1)} or ${pageDist.cornerY.toFixed(1)} mm - wrong mark or the scale is off.`,
    )
  }

  // Third mark: off the square, perpendicular to the known corner, at the measured scale.
  const { square, corner, which } = pair
  const missing: Corner = which === 'cornerX' ? 'cornerY' : 'cornerX'
  const known = sub(corner, square)
  const len = Math.hypot(known.x, known.y)
  const normal = { x: -known.y / len, y: known.x / len }
  const reach = (pageDist[missing] * len) / pageDist[which]
  onStatus(`Measuring ${markNames(page)[missing]}…`)
  // Which side: the page's turn from the known corner to the missing one, flipped when page ->
  // machine mirrors. Never probe the other side - that can feed the mat out.
  // ponytail: with no accepted sheet yet, assume mirrored - a face-up sheet whose x runs along the
  // carriage mirrors on the SK-720T (measured 2026-11-10). Make it a rig setting if a cutter differs.
  const kp = sub(page[which], page.square)
  const mp = sub(page[missing], page.square)
  const turn = Math.sign(kp.x * mp.y - kp.y * mp.x) || 1
  const mirrored = rig.lastAffine ? affineStrain(rig.lastAffine).mirrored : true
  const sign = mirrored ? -turn : turn
  const target = add(square, normal, sign * reach)
  const m3 = await tryMeasure(io, cam, target, 'corner', lim)
  if (typeof m3 !== 'string') {
    onStatus(`${cap(markNames(page)[missing])} at ${fmt(m3)}.`)
    return which === 'cornerX' ? { square, cornerX: corner, cornerY: m3 } : { square, cornerX: m3, cornerY: corner }
  }
  throw new RegistrationError(
    `${cap(markNames(page)[missing])}: ${m3} Place the sheet so all three marks lie inside the reachable area.`,
  )
}

/** Sweep pitch before calibration: the scale is unknown, so a fixed step well under the smallest
 *  view (~19 mm on the SK-720T) minus the square. */
const FIND_STEP_MM = 4

/** Head position with the square in view, centered along the carriage. Looks at `start` first,
 *  then sweeps rows along the carriage from feed `start`, stepping on while the square stays in
 *  view and returning the middle of that run (at least two looks long).
 *  ponytail: not centered along the feed - a square at the feed edge can drop out of a probe; the
 *  calibration then asks for a jog. */
export async function findSquare(io: RigIO, start: Pt, limitMm: number, onStatus: (msg: string) => void): Promise<Pt> {
  const sees = async (p: Pt) => io.detect(await goTo(io, p), 0).some((m) => m.kind === 'square')
  if (await sees(start)) {
    onStatus('Square under the camera.')
    return start
  }
  const feed0 = feedOf(start)
  for (let k = 0; k < SEARCH_ROWS; k++) {
    const feed = feed0 + k * FIND_STEP_MM
    onStatus(`No square yet - sweeping row ${k + 1} of ${SEARCH_ROWS} along Y (feed ${feed.toFixed(0)} mm, every ${FIND_STEP_MM} mm)…`)
    for (let c = 0; c <= limitMm; c += FIND_STEP_MM) {
      const p = onAxes(c, feed)
      if (!reachable(p, limitMm) || !(await sees(p))) continue
      let end = c
      while (end + FIND_STEP_MM <= limitMm && (await sees(onAxes(end + FIND_STEP_MM, feed)))) end += FIND_STEP_MM
      // The square spans several steps of the view; a single sighting is a flicker (paper edge, foil).
      if (end === c) {
        onStatus(`Something square-ish at Y ${c} mm, gone one step on - ignored.`)
        continue
      }
      const mid = onAxes((c + end) / 2, feed)
      onStatus(`Found the square between Y ${c} and ${end} mm - calibrating at ${fmt(mid)}…`)
      return mid
    }
  }
  throw new RegistrationError('No square found along Y - jog the camera over the square and try again.')
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
