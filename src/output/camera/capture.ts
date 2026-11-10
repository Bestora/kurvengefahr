// One still from the camera on the cutter head (e.g. an ESP32-CAM `/capture` endpoint): fetched
// uncached with a hard timeout - a stalled camera must fail the registration, not hang it.
import { decodeRgba } from '../../core/decodeRgba'

export interface Frame {
  rgba: Uint8Array
  width: number
  height: number
  /** The encoded image, for showing it. */
  blob: Blob
}

export async function captureFrame(url: string, timeoutMs = 3000): Promise<Frame> {
  const noAnswer = () => new Error(`The camera did not answer at ${url}.`)
  let res: Response
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw noAnswer()
  }
  if (!res.ok) throw new Error(`The camera answered ${res.status} at ${url}.`)
  // The timeout also covers the body; a camera that stalls mid-image reads as no answer.
  const blob = await res.blob().catch(() => {
    throw noAnswer()
  })
  return { ...(await decodeRgba(blob)), blob }
}
