import { beforeAll, describe, expect, it } from 'vitest'
import { initWasmForTests } from './nodeTestInit'
import { affineStrain, findMarks, fitCamera, frameDiff, solveAffine, type Affine, type Pt } from './registration'

beforeAll(async () => {
  await initWasmForTests()
})

describe('registration wasm wrappers', () => {
  it('round-trips an affine through solveAffine and affineStrain', () => {
    const src: [Pt, Pt, Pt] = [
      { x: 12.64, y: 12.65 },
      { x: 284.92, y: 12.36 },
      { x: 12.36, y: 197.93 },
    ]
    const m: Affine = [0, -1, 500, 1, 0, 20] // 90° + shift
    const dst = src.map((p) => ({
      x: m[0] * p.x + m[1] * p.y + m[2],
      y: m[3] * p.x + m[4] * p.y + m[5],
    })) as [Pt, Pt, Pt]
    const got = solveAffine(src, dst)!
    got.forEach((v, i) => expect(v).toBeCloseTo(m[i], 9))
    expect(affineStrain(got).rotDeg).toBeCloseTo(90, 6)
  })

  it('returns null for degenerate input', () => {
    const p = (x: number): Pt => ({ x, y: x })
    expect(solveAffine([p(0), p(1), p(2)], [p(0), p(1), p(2)])).toBeNull()
    expect(fitCamera([p(1), p(2)], [p(1), p(2)])).toBeNull()
  })

  it('finds a square mark in an RGBA frame and diffs frames', () => {
    const w = 120,
      h = 90
    const a = new Uint8Array(w * h * 4).fill(255)
    for (let y = 30; y < 60; y++) for (let x = 45; x < 75; x++) a.set([20, 20, 20, 255], (y * w + x) * 4)
    const marks = findMarks(a, w, h, 0)
    expect(marks).toHaveLength(1)
    expect(marks[0].kind).toBe('square')
    expect(marks[0].x).toBeCloseTo(60, 0)
    expect(frameDiff(a, a)).toBe(0)
    expect(frameDiff(a, a.slice(4))).toBe(Infinity)
  })
})
