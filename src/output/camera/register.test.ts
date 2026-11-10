import { beforeAll, describe, expect, it } from 'vitest'
import { PROXIES_AT_HOME_MARKS as L, applyAffine, type MarkLayout } from '../../core/registration'
import { initWasmForTests } from '../../core/wasm/nodeTestInit'
import type { Affine, CamMatrix, Detected, Pt } from '../../core/wasm/registration'
import type { CamCal, CameraRig } from '../../store/cameraRig'
import type { Frame } from './capture'
import {
  SETTLE_MAX_FRAMES,
  CONVERGE_MM,
  RegistrationError,
  calibrateCamera,
  measureMark,
  registerSheet,
  settle,
  type RigIO,
} from './register'

beforeAll(async () => {
  await initWasmForTests()
})

// Camera image: u (400 px) runs along the carriage (machine y), v along the feed (machine x),
// mirrored and a hair rotated; ~0.1 mm/px.
const J: CamMatrix = [0.004, 0.1, 0.1, -0.004]
const cam: CamCal = { m: J, w: 400, h: 300 }
const LIMIT = 490.75
const KEYS = ['square', 'topRight', 'bottomLeft'] as const

interface World {
  marks: { kind: Detected['kind']; at: Pt }[] // machine mm
  J: CamMatrix
  w: number
  h: number
  /** Captures after each moveTo that still show the head moving. */
  moveLagFrames?: number
  /** Held head position at the start (operator jogged); default origin, not held. */
  head?: Pt
}
type Token = Frame & { head: Pt; moving: boolean }

const world = (marks: World['marks'], over: Partial<World> = {}): World => ({ marks, J, w: 400, h: 300, ...over })

function fakeIO(w: World) {
  const [a, b, c, d] = w.J
  const det = a * d - b * c
  let head = w.head ?? { x: 0, y: 0 }
  let held = w.head !== undefined
  let lag = 0
  const moves: Pt[] = []
  const log: string[] = []
  const io: RigIO = {
    at: () => (held ? head : null),
    moveTo: async (p) => {
      moves.push(p)
      head = p
      held = true
      lag = w.moveLagFrames ?? 0
    },
    capture: async () => {
      log.push('capture')
      const t: Token = { rgba: new Uint8Array(0), width: w.w, height: w.h, blob: new Blob([]), head, moving: lag-- > 0 }
      return t
    },
    // u = center + J⁻¹·(mark − head); only marks more than 10 px inside the image.
    detect: (f) => {
      const h0 = (f as Token).head
      return w.marks.flatMap(({ kind, at }) => {
        const dx = at.x - h0.x
        const dy = at.y - h0.y
        const x = w.w / 2 + (d * dx - b * dy) / det
        const y = w.h / 2 + (-c * dx + a * dy) / det
        return x > 10 && x < w.w - 10 && y > 10 && y < w.h - 10 ? [{ kind, x, y, areaMm2: 0 }] : []
      })
    },
    diff: (p, q) => ((p as Token).moving || (q as Token).moving ? 50 : 0),
    sleep: async (ms) => {
      log.push(`sleep ${ms}`)
    },
  }
  return { io, moves, log }
}

const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y)

/** Page -> machine: rotate `deg`, scale `k`, square at `square`. `alongCarriage`: page x runs
 * along the carriage (machine y) - a mirror; otherwise page x runs along the feed. */
function placed(deg: number, alongCarriage: boolean, square: Pt, k = 1): Affine {
  const s = k * Math.sin((deg * Math.PI) / 180)
  const c = k * Math.cos((deg * Math.PI) / 180)
  const [p, q, r, t] = alongCarriage ? [-s, c, c, s] : [c, -s, s, c]
  const S = L.square
  return [p, q, square.x - p * S.x - q * S.y, r, t, square.y - r * S.x - t * S.y]
}

function sheet(m: Affine) {
  const truth: MarkLayout = {
    square: applyAffine(m, L.square),
    topRight: applyAffine(m, L.topRight),
    bottomLeft: applyAffine(m, L.bottomLeft),
  }
  const marks: World['marks'] = [
    { kind: 'square', at: truth.square },
    { kind: 'corner', at: truth.topRight },
    { kind: 'corner', at: truth.bottomLeft },
  ]
  return { truth, marks }
}

const rig = (over: Partial<CameraRig> = {}): CameraRig => ({
  url: 'http://cam.local/capture',
  softLimitMm: LIMIT,
  cam,
  knifeOffset: { x: 0, y: 0 },
  marks: L,
  lastMarks: null,
  lastAffine: null,
  ...over,
})

function expectRegistered(r: { affine: Affine; marks: MarkLayout }, truth: MarkLayout) {
  for (const k of KEYS) {
    expect(dist(applyAffine(r.affine, L[k]), truth[k])).toBeLessThan(0.1)
    expect(dist(r.marks[k], truth[k])).toBeLessThan(0.1)
  }
}

const SKEWED = sheet(placed(1.2, true, { x: 20, y: 180 }))

describe('settle', () => {
  it('settle waits the minimum delay before comparing', async () => {
    const { io, log } = fakeIO(world([]))
    await settle(io, 100)
    expect(log.slice(0, 2)).toEqual(['sleep 600', 'capture'])
    log.length = 0
    await settle(io, 0)
    expect(log[0]).toBe('sleep 250')
  })

  it('settle gives up after 15 restless frames', async () => {
    const { io, log } = fakeIO(world([]))
    io.diff = () => 50
    const e = await settle(io, 0).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(RegistrationError)
    expect((e as Error).message).toMatch(/did not come to rest/)
    expect(log.filter((l) => l === 'capture')).toHaveLength(SETTLE_MAX_FRAMES)
  })
})

describe('measureMark', () => {
  it('picks the mark nearest the image center', async () => {
    const near = { x: 101, y: 203 }
    const { io } = fakeIO(
      world([
        { kind: 'square', at: { x: 106, y: 190 } },
        { kind: 'square', at: near },
        { kind: 'corner', at: { x: 100.5, y: 200.5 } },
      ]),
    )
    const p = await measureMark(io, cam, { x: 100, y: 200 }, 'square', LIMIT)
    expect(dist(p, near)).toBeLessThan(1e-6)
  })

  it('centers and converges within 0.15 mm', async () => {
    const mark = { x: 50, y: 120 }
    const { io, moves } = fakeIO(world([{ kind: 'square', at: mark }], { moveLagFrames: 2 }))
    // The calibration is off by 2 % scale and 1 deg rotation; the world projects with the true J.
    const k = 1.02
    const s = Math.sin(Math.PI / 180)
    const c = Math.cos(Math.PI / 180)
    const [a, b, cc, d] = J
    const wrong: CamMatrix = [k * (c * a - s * cc), k * (c * b - s * d), k * (s * a + c * cc), k * (s * b + c * d)]
    const p = await measureMark(io, { ...cam, m: wrong }, { x: 58, y: 112 }, 'square', LIMIT)
    expect(dist(p, mark)).toBeLessThan(0.05)
    expect(dist(moves[moves.length - 1], p)).toBeLessThanOrEqual(CONVERGE_MM)
  })
})

describe('registerSheet', () => {
  it('registers a skewed sheet from a cold search', async () => {
    const { io } = fakeIO(world(SKEWED.marks, { moveLagFrames: 2 }))
    const r = await registerSheet(io, rig(), () => {})
    expectRegistered(r, SKEWED.truth)
    expect(r.warning).toBeNull()
  })

  it('finds the sheet when square and bottom-left corner lie on the carriage axis', async () => {
    const { truth, marks } = sheet(placed(-0.8, false, { x: 20, y: 180 }))
    const { io } = fakeIO(world(marks))
    expectRegistered(await registerSheet(io, rig(), () => {}), truth)
  })

  it('uses the last positions first', async () => {
    const { truth, marks } = SKEWED
    const lastMarks = {
      square: { x: truth.square.x + 1.5, y: truth.square.y - 1 },
      topRight: { x: truth.topRight.x - 1, y: truth.topRight.y + 2 },
      bottomLeft: { x: truth.bottomLeft.x + 0.5, y: truth.bottomLeft.y + 1 },
    }
    const { io, moves } = fakeIO(world(marks))
    expectRegistered(await registerSheet(io, rig({ lastMarks }), () => {}), truth)
    expect(moves.length).toBeLessThanOrEqual(9)
  })

  it('falls back to the full search when the sheet moved', async () => {
    const { truth, marks } = SKEWED
    const shift = (p: Pt) => ({ x: p.x, y: p.y + 80 })
    const lastMarks = { square: shift(truth.square), topRight: shift(truth.topRight), bottomLeft: shift(truth.bottomLeft) }
    const status: string[] = []
    const { io } = fakeIO(world(marks))
    expectRegistered(await registerSheet(io, rig({ lastMarks }), (m) => status.push(m)), truth)
    expect(status).toContain('Searching for the first mark…')
  })

  it('starts from a mark the operator jogged into view', async () => {
    const { truth, marks } = SKEWED
    const status: string[] = []
    const { io, moves } = fakeIO(world(marks, { head: { x: truth.topRight.x + 3, y: truth.topRight.y - 4 } }))
    expectRegistered(await registerSheet(io, rig(), (m) => status.push(m)), truth)
    expect(status).not.toContain('Searching for the first mark…')
    expect(moves.length).toBeLessThanOrEqual(9)
  })

  it('never moves beyond the soft limit', async () => {
    const limit = 460
    const { truth, marks } = sheet(placed(-0.8, false, { x: 10, y: 180 }))
    const { io, moves } = fakeIO(world(marks))
    expectRegistered(await registerSheet(io, rig({ softLimitMm: limit }), () => {}), truth)
    for (const p of moves) {
      expect(p.y).toBeLessThanOrEqual(limit)
      expect(Math.min(p.x, p.y)).toBeGreaterThanOrEqual(0)
    }
  })

  it('aborts with a readable reason when scale is implausible', async () => {
    const { truth, marks } = sheet(placed(1.2, true, { x: 20, y: 180 }, 1.03))
    await expect(registerSheet(fakeIO(world(marks)).io, rig(), () => {})).rejects.toThrow(/scale/i)
    const warm = registerSheet(fakeIO(world(marks)).io, rig({ lastMarks: truth }), () => {})
    await expect(warm).rejects.toThrow(RegistrationError)
    await expect(warm).rejects.toThrow(/scale/i)
  })

  it('asks for a camera calibration first', async () => {
    const { io } = fakeIO(world(SKEWED.marks))
    await expect(registerSheet(io, rig({ cam: null }), () => {})).rejects.toThrow('Calibrate the camera first')
    await expect(registerSheet(io, rig({ cam: { ...cam, w: 320 } }), () => {})).rejects.toThrow(
      'Calibrate the camera first',
    )
  })
})

describe('calibrateCamera', () => {
  it('calibrates the camera matrix', async () => {
    const { io } = fakeIO(world([{ kind: 'square', at: { x: 41, y: 58 } }]))
    const cal = await calibrateCamera(io, { x: 40, y: 60 })
    expect([cal.w, cal.h]).toEqual([400, 300])
    cal.m.forEach((v, i) => expect(Math.abs(v - J[i])).toBeLessThan(1e-6))
  })
})
