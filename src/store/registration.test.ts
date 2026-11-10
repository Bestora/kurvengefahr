import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initWasmForTests } from '../core/wasm/nodeTestInit'
import { IDENTITY_TRANSFORM } from '../core/types'
import type { Affine } from '../core/wasm/registration'
import { defaultRectParams } from '../elements/shapes'
import { useCameraRig } from './cameraRig'
import { useDoc } from './document'
import { usePlotSession } from './plotSession'
import { HPGL_CUTTER } from './profiles'
import { cutMap, useRegistration } from './registration'

// A silent HP-GL port: accepts every write, never flow-controls or disconnects.
const link = vi.hoisted(() => ({ write: vi.fn(async (_: string) => {}), onFlow() {}, onDisconnect() {} }))
vi.mock('./serial', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serial')>()),
  currentHpgl: () => link,
}))

describe('cutMap', () => {
  it('cutMap passes plain plots through when the camera is off', () =>
    expect(cutMap({ url: '', knifeOffset: { x: 0, y: 0 } }, null)).toEqual({ map: null, error: null }))
  it('cutMap demands a measured sheet when the camera is on', () =>
    expect(cutMap({ url: 'http://c', knifeOffset: { x: 0, y: 0 } }, null).error).toMatch(/measure/i))
  it('cutMap adds the knife offset', () =>
    expect(cutMap({ url: 'http://c', knifeOffset: { x: 0.2, y: -0.1 } }, [1, 0, 5, 0, 1, 7]).map).toEqual([1, 0, 5.2, 0, 1, 6.9]))
})

describe('cutting with a registration', () => {
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

  it('full job consumes the registration, test cut does not', async () => {
    const affine: Affine = [1, 0, 0, 0, 1, 0]
    useRegistration.setState({ phase: 'ready', affine })

    await usePlotSession.getState().startTestCut()
    expect(link.write).toHaveBeenCalled()
    expect(useRegistration.getState().affine).toEqual(affine)

    link.write.mockClear()
    await usePlotSession.getState().start()
    expect(link.write).toHaveBeenCalled()
    expect(useRegistration.getState()).toMatchObject({ affine: null, phase: 'idle' })
  })
})
