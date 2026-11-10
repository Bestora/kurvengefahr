import { describe, expect, it } from 'vitest'
import { importOffset } from './importSvg'

describe('importOffset', () => {
  it('centres by default and keeps the SVG origin when asked', () => {
    const b = { minX: 48, minY: 14, maxX: 250, maxY: 196 }
    expect(importOffset(b, { width: 500, height: 630 }, false)).toEqual({ x: 101, y: 210 })
    expect(importOffset(b, { width: 500, height: 630 }, true)).toEqual({ x: 0, y: 0 })
  })
})
