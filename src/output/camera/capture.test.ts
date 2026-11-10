import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureFrame } from './capture'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureFrame', () => {
  it('capture times out with a readable error', async () => {
    // A camera that never answers: the request only ends when its signal aborts.
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    )
    await expect(captureFrame('http://cam.local/capture', 20)).rejects.toThrow(/camera did not answer/i)
  })
})
