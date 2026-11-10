import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HPGL_CUTTER } from '../../store/profiles'
import { HeadHold, SoftLimitError } from './headHold'

const profile = structuredClone(HPGL_CUTTER)

function setup(maxMm: number | null = null, fail = false) {
  const sent: string[] = []
  const link = {
    write: async (d: string) => {
      if (fail) throw new Error('gone')
      sent.push(d)
    },
  }
  return { sent, hold: new HeadHold(link, profile, maxMm), setFail: (f: boolean) => (fail = f) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HeadHold', () => {
  it('moves, then repeats the hold command at the target', async () => {
    const { sent, hold } = setup()
    await hold.moveTo({ x: 10, y: 20 })
    expect(sent[0].startsWith('IN;')).toBe(true)
    expect(sent[0]).toContain('PU;PU400,800;')
    expect(hold.at).toEqual({ x: 10, y: 20 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.slice(1)).toEqual(['PU400,800;', 'PU400,800;'])
    await hold.moveTo({ x: 11, y: 20 })
    expect(sent.at(-1)).toBe('PU440,800;')
  })

  it('refuses moves beyond the soft limit without sending', async () => {
    const { sent, hold } = setup(490.75)
    await expect(hold.moveTo({ x: 0, y: 491 })).rejects.toBeInstanceOf(SoftLimitError)
    expect(sent).toEqual([])
    expect(hold.at).toBeNull()
  })

  it('home stops holding and returns to the origin', async () => {
    const { sent, hold } = setup()
    await hold.moveTo({ x: 10, y: 20 })
    await hold.home()
    expect(sent.at(-1)).toBe('PU;PU0,0;')
    const n = sent.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.length).toBe(n)
    expect(hold.at).toBeNull()
  })

  it('stops holding when the link goes away', async () => {
    const { sent, hold, setFail } = setup()
    await hold.moveTo({ x: 10, y: 20 })
    setFail(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(hold.at).toBeNull()
    const n = sent.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.length).toBe(n)
  })
})
