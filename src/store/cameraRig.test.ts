import { describe, expect, it } from 'vitest'
import { PROXIES_AT_HOME_MARKS } from '../core/registration'
import { loadRig, useCameraRig } from './cameraRig'

describe('loadRig', () => {
  it('falls back to defaults for garbage', () =>
    expect(loadRig('nope')).toEqual({ status: 'invalid', message: expect.any(String) }))

  it('backfills missing fields', () => {
    const o = loadRig({ schemaVersion: 1, url: 'http://cam/capture' })
    expect(o.status === 'ok' && o.value.url).toBe('http://cam/capture')
    expect(o.status === 'ok' && o.value.softLimitMm).toBe(490.75)
    expect(o.status === 'ok' && o.value.marks).toEqual(PROXIES_AT_HOME_MARKS)
    expect(o.status === 'ok' && o.value.lastAffine).toBeNull()
  })

  it('drops a malformed camera matrix', () => {
    const o = loadRig({ cam: { m: [1, 2], w: 320, h: 240 } })
    expect(o.status === 'ok' && o.value.cam).toBeNull()
  })

  it('keeps a valid camera calibration and affine', () => {
    const cam = { m: [1, 0, 0, 1], w: 320, h: 240 }
    const o = loadRig({ cam, lastAffine: [1, 0, 0, 1, 2, 3] })
    expect(o.status === 'ok' && o.value.cam).toEqual(cam)
    expect(o.status === 'ok' && o.value.lastAffine).toEqual([1, 0, 0, 1, 2, 3])
  })

  it('drops malformed marks, affine, and knife offset', () => {
    const o = loadRig({ marks: { square: { x: 1, y: 2 } }, lastMarks: 5, lastAffine: [1, NaN, 0, 1, 0, 0], knifeOffset: { x: 'a' } })
    expect(o.status === 'ok' && o.value.marks).toEqual(PROXIES_AT_HOME_MARKS)
    expect(o.status === 'ok' && o.value.lastMarks).toBeNull()
    expect(o.status === 'ok' && o.value.lastAffine).toBeNull()
    expect(o.status === 'ok' && o.value.knifeOffset).toEqual({ x: 0, y: 0 })
  })

  it('refuses a newer schema', () => expect(loadRig({ schemaVersion: 2 }).status).toBe('unsupported'))
})

describe('useCameraRig', () => {
  it('works without localStorage and merges patches', () => {
    expect(useCameraRig.getState().softLimitMm).toBe(490.75)
    useCameraRig.getState().patch({ url: 'x' })
    expect(useCameraRig.getState().url).toBe('x')
  })
})
