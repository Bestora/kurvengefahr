// Decode an image blob to raw RGBA bytes via an OffscreenCanvas. Works in workers and on the main
// thread: the raster tracing worker and camera frames both use it.

export interface Decoded {
  rgba: Uint8Array
  width: number
  height: number
}

export async function decodeRgba(blob: Blob): Promise<Decoded> {
  const bitmap = await createImageBitmap(blob)
  try {
    const { width, height } = bitmap
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, width, height).data
    return { rgba: new Uint8Array(data.buffer), width, height }
  } finally {
    bitmap.close()
  }
}
