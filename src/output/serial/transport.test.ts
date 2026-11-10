import { describe, expect, it, vi } from 'vitest'
import { WebSerialTransport } from './transport'

function fakePort() {
  let onDisconnect: () => void = () => {}
  const port = {
    open: async () => {},
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    addEventListener: (_: string, cb: () => void) => (onDisconnect = cb),
  }
  return { port: port as unknown as SerialPort, disconnect: () => onDisconnect() }
}

describe('WebSerialTransport', () => {
  it('notifies every disconnect consumer', async () => {
    const { port, disconnect } = fakePort()
    const t = await WebSerialTransport.open(port, 9600)
    const a = vi.fn()
    const b = vi.fn()
    t.onDisconnect(a)
    t.onDisconnect(b)
    disconnect()
    disconnect()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})
