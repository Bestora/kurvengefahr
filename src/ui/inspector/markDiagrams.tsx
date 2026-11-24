// Camera registration, the two pictures: where the marks are printed on the page (click a sheet
// corner to put the square there), and where the head is on the cutter right now. Both are plain
// SVG in mm; strokes stay 1 px (`non-scaling-stroke`).
import { squareCorner, type MarkLayout, type PageSize, type SheetCorner } from '../../core/registration'
import type { Pt } from '../../core/wasm/registration'
import { FEED_LIMIT_MM, type Seen } from '../../output/camera/register'

const CORNERS: SheetCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const THIN = { strokeWidth: 1, vectorEffect: 'non-scaling-stroke' as const }

/** The page with its three marks. Marks are drawn oversized; positions are true. */
export function MarkLayoutPicker({
  marks,
  page,
  onPick,
}: {
  marks: MarkLayout
  page: PageSize
  onPick(corner: SheetCorner): void
}) {
  const { width: w, height: h } = page
  const u = Math.max(w, h) / 20
  const at = squareCorner(marks)
  // An L with its vertex on the mark and its legs towards the page center.
  const corner = (p: Pt) =>
    `${p.x + (p.x < w / 2 ? u : -u)},${p.y} ${p.x},${p.y} ${p.x},${p.y + (p.y < h / 2 ? u : -u)}`
  return (
    <svg
      viewBox={`${-u} ${-u} ${w + 2 * u} ${h + 2 * u}`}
      className="mt-2 w-full"
      role="group"
      aria-label="Mark layout on the page"
    >
      <rect width={w} height={h} className="fill-none stroke-muted" {...THIN} />
      {CORNERS.map((c) => {
        const [v, side] = c.split('-')
        const label = c === at ? `The square is in the ${c} corner` : `Put the square in the ${c} corner`
        return (
          <rect
            key={c}
            x={side === 'left' ? 0 : w / 2}
            y={v === 'top' ? 0 : h / 2}
            width={w / 2}
            height={h / 2}
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={c === at}
            className="cursor-pointer fill-transparent hover:fill-text/10"
            onClick={() => onPick(c)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(c)}
          >
            <title>{label}</title>
          </rect>
        )
      })}
      <g className="pointer-events-none">
        <rect x={marks.square.x - u / 2} y={marks.square.y - u / 2} width={u} height={u} className="fill-text" />
        {[marks.cornerX, marks.cornerY].map((p, i) => (
          <polyline key={i} points={corner(p)} className="fill-none stroke-text" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  )
}

const CARD = { w: 63, h: 88 }
const BLOWUP = 8

/** The knife offset in the head map's view (+Y left, +X up): the printed card grey, the cut red,
 *  shifted by the offset blown up BLOWUP times so a few tenths of a mm are visible. */
export function KnifeOffsetDiagram({ offset }: { offset: Pt }) {
  const dx = -offset.y * BLOWUP
  const dy = -offset.x * BLOWUP
  const m = 30
  const arrow = (x2: number, y2: number, label: string, tx: number, ty: number) => (
    <g className="stroke-muted fill-muted">
      <line x1={0} y1={0} x2={x2} y2={y2} {...THIN} />
      <circle cx={x2} cy={y2} r={1.5} />
      <text x={tx} y={ty} fontSize={8} textAnchor="middle" stroke="none">{label}</text>
    </g>
  )
  return (
    <figure className="mt-2">
      <svg viewBox={`${-m} ${-m} ${CARD.w + 2 * m} ${CARD.h + 2 * m}`} className="w-full max-w-48" role="img"
        aria-label={`Knife offset X ${offset.x} mm, Y ${offset.y} mm`}>
        <rect width={CARD.w} height={CARD.h} rx={3} className="fill-text/10 stroke-muted" {...THIN} />
        <rect x={dx} y={dy} width={CARD.w} height={CARD.h} rx={3} className="fill-none stroke-accent" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <g transform={`translate(${CARD.w / 2},${CARD.h / 2})`}>
          {arrow(0, -22, '+X', 0, -25)}
          {arrow(-22, 0, '+Y', -28, 3)}
        </g>
      </svg>
      <figcaption className="mt-1 text-xs text-muted">
        Seen from the front, like the head map. Grey: the print. Red: where the knife cuts, shift drawn {BLOWUP}x.
        +X moves the cut away from you, +Y moves it left.
      </figcaption>
    </figure>
  )
}

const PAD = 15
const GLYPH = 14

/** The cutter as the operator sees it from the front: the carriage (+Y) runs left, the feed (+X)
 *  up, the origin sits bottom right. Shows the head (last commanded target), the camera's view
 *  around it, the last sheet's marks (faint) and the marks measured in this run. */
export function HeadMap({
  limitMm,
  head,
  viewMm,
  last,
  found,
}: {
  limitMm: number
  head: Pt | null
  /** Shorter side of the camera's view; null = not calibrated. */
  viewMm: number | null
  last: MarkLayout | null
  found: Seen[]
}) {
  const sx = (p: Pt) => limitMm - p.y
  const sy = (p: Pt) => FEED_LIMIT_MM - p.x
  const glyph = (m: Seen, cls: string, key: string) => {
    const x = sx(m.at)
    const y = sy(m.at)
    return m.kind === 'square' ? (
      <rect key={key} x={x - GLYPH / 2} y={y - GLYPH / 2} width={GLYPH} height={GLYPH} className={`fill-none ${cls}`} {...THIN} />
    ) : (
      <path key={key} d={`M${x - GLYPH / 2},${y}h${GLYPH}M${x},${y - GLYPH / 2}v${GLYPH}`} className={cls} {...THIN} />
    )
  }
  const lastSeen: Seen[] = last
    ? [
        { kind: 'square', at: last.square },
        { kind: 'corner', at: last.cornerX },
        { kind: 'corner', at: last.cornerY },
      ]
    : []
  const h = head ?? { x: 0, y: 0 }
  return (
    <figure className="mt-2">
      <svg
        viewBox={`${-PAD} ${-PAD} ${limitMm + 2 * PAD} ${FEED_LIMIT_MM + 2 * PAD}`}
        className="w-full rounded-md border border-border"
        role="img"
        aria-label="Head position on the cutter"
      >
        <rect width={limitMm} height={FEED_LIMIT_MM} className="fill-none stroke-muted" strokeDasharray="4 3" {...THIN} />
        {lastSeen.map((m, i) => glyph(m, 'stroke-muted', `l${i}`))}
        {found.map((m, i) => glyph(m, 'stroke-text', `f${i}`))}
        {viewMm !== null && <circle cx={sx(h)} cy={sy(h)} r={viewMm / 2} className="fill-none stroke-accent" {...THIN} />}
        <circle cx={sx(h)} cy={sy(h)} r={5} className="fill-accent" />
      </svg>
      <figcaption className="mt-1 text-xs text-muted">
        {head ? `Head at X ${head.x.toFixed(1)}, Y ${head.y.toFixed(1)} mm` : 'Head at the origin'} - seen from the
        front, origin bottom right. Dashed: the reachable area. Faint: the last sheet&apos;s marks.
      </figcaption>
    </figure>
  )
}
