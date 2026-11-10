import { describe, expect, it } from 'vitest'
import { planGrblTape } from '../../core/pipeline/grblTape'
import { HPGL_CUTTER } from '../../store/profiles'
import { beyondSoftLimit, tapeBeyondSoftLimit } from './softLimit'

describe('soft limit', () => {
  it('fails closed on NaN', () => {
    expect(beyondSoftLimit({ x: 0, y: 5 }, NaN)).toBe(true)
    expect(beyondSoftLimit({ x: 0, y: NaN }, 10)).toBe(true)
    expect(beyondSoftLimit({ x: 0, y: 10 }, 10)).toBe(false)
  })
  it('tape beyond the limit', () => {
    const p = structuredClone(HPGL_CUTTER)
    const tape = planGrblTape([{ points: [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }], pen: 0, reversible: true }], p, null, Infinity)
    expect(tapeBeyondSoftLimit(tape, 1000)).toBe(false)
    expect(tapeBeyondSoftLimit(tape, 20)).toBe(true)
    expect(tapeBeyondSoftLimit(tape, NaN)).toBe(true)
  })
})
