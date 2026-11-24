// PDF import: the first page rendered to a PNG, then imported like any raster image but at the
// page's true size and placed at the page origin - a print sheet lands on top of its cut template.
// pdf.js loads only when a PDF is imported.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/** Rendering resolution. ponytail: fixed; importImage downsamples past its pixel cap anyway. */
const DPI = 150
const PT_PER_MM = 72 / 25.4

export async function renderPdfPage(file: Blob): Promise<{ png: Blob; widthMm: number; heightMm: number; pages: number }> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  try {
    const page = await doc.getPage(1)
    const unit = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: DPI / 72 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d canvas')
    // White under the page: a transparent PDF background would read as black to the stylizer.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    const png = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('toBlob'))), 'image/png'))
    return { png, widthMm: unit.width / PT_PER_MM, heightMm: unit.height / PT_PER_MM, pages: doc.numPages }
  } finally {
    void task.destroy()
  }
}
