import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initWasmForTests } from '../core/wasm/nodeTestInit'
import { IDENTITY_TRANSFORM } from '../core/types'
import type { Affine } from '../core/wasm/registration'
import { defaultRectParams } from '../elements/shapes'
import { useCameraRig } from './cameraRig'
import { useDoc } from './document'
import { usePlotSession } from './plotSession'
import { HPGL_CUTTER } from './profiles'
import { cutMap, goHome, useRegistration } from './registration'
import { useSerial } from './serial'

// A silent HP-GL port: accepts every write, never flow-controls or disconnects.
const link = vi.hoisted(() => ({ write: vi.fn(async (_: string) => {}), onFlow() {}, onDisconnect() {} }))
vi.mock('./serial', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serial')>()),
  currentHpgl: () => link,
}))
// A still camera: every frame identical.
vi.mock('../output/camera/capture', () => ({
  captureFrame: async () => ({ rgba: new Uint8Array(64), width: 4, height: 4, blob: new Blob([]) }),
}))

const affine: Affine = [1, 0, 0, 0, 1, 0]

beforeAll(async () => {
  await initWasmForTests()
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  useDoc.setState({
    profile: structuredClone(HPGL_CUTTER),
    fiducial: null,
    elements: [
      { id: 'r', type: 'rect', transform: { ...IDENTITY_TRANSFORM, x: 30, y: 30 }, params: defaultRectParams(20, 10), pen: 0 },
    ],
  })
  useCameraRig.getState().patch({ url: 'http://c' })
})

describe('cutMap', () => {
  it('cutMap passes plain plots through when the camera is off', () =>
    expect(cutMap({ url: '', knifeOffset: { x: 0, y: 0 } }, null)).toEqual({ map: null, error: null }))
  it('cutMap demands a measured sheet when the camera is on', () =>
    expect(cutMap({ url: 'http://c', knifeOffset: { x: 0, y: 0 } }, null).error).toMatch(/measure/i))
  it('cutMap adds the knife offset', () =>
    expect(cutMap({ url: 'http://c', knifeOffset: { x: 0.2, y: -0.1 } }, [1, 0, 5, 0, 1, 7]).map).toEqual([1, 0, 5.2, 0, 1, 6.9]))
})

describe('cutting with a registration', () => {
  it('full job consumes the registration, test cut does not', async () => {
    useRegistration.setState({ phase: 'ready', affine })

    await usePlotSession.getState().startTestCut()
    expect(link.write).toHaveBeenCalled()
    expect(useRegistration.getState().affine).toEqual(affine)

    link.write.mockClear()
    await usePlotSession.getState().start()
    expect(link.write).toHaveBeenCalled()
    expect(useRegistration.getState()).toMatchObject({ affine: null, phase: 'idle' })
  })

  it('a job refused by the soft limit keeps the registration', async () => {
    useCameraRig.getState().patch({ softLimitMm: 5 })
    useRegistration.setState({ phase: 'ready', affine })
    link.write.mockClear()
    await usePlotSession.getState().start()
    useCameraRig.getState().patch({ softLimitMm: 490.75 })
    expect(link.write).not.toHaveBeenCalled()
    expect(useRegistration.getState().affine).toEqual(affine)
  })

  it('a full job with the camera off still consumes a measured registration', async () => {
    useCameraRig.getState().patch({ url: '' })
    useRegistration.setState({ phase: 'ready', affine })
    await usePlotSession.getState().start()
    useCameraRig.getState().patch({ url: 'http://c' })
    expect(useRegistration.getState().affine).toBeNull()
  })
})

describe('the shared head hold', () => {
  it('goHome after a jog leaves no hold running', async () => {
    vi.useFakeTimers()
    try {
      const jog = useRegistration.getState().jog(5, 5)
      await vi.advanceTimersByTimeAsync(1000)
      await jog
      expect(useSerial.getState().headAway).toBe(true)
      expect(link.write).toHaveBeenLastCalledWith('PU200,200;') // the hold repeats at the jog target

      await goHome()
      expect(link.write).toHaveBeenLastCalledWith('PU;PU0,0;')
      link.write.mockClear()
      await vi.advanceTimersByTimeAsync(2000)
      expect(link.write).not.toHaveBeenCalled()
      expect(useSerial.getState().headAway).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
