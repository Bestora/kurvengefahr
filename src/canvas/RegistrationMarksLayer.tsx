// Where the printed registration marks are expected on the page (the rig's mark layout, page mm):
// a 6 mm square outline at the square mark, 4 mm crosses at the two corner marks. Only with an
// HP-GL profile and a camera URL. Display only; strokes are screen-constant (divided by px-per-mm).
import { Group, Line, Rect } from 'react-konva'
import { useDoc } from '../store/document'
import { useCameraRig } from '../store/cameraRig'

const COLOR = '#8b8b94'
const SQUARE_MM = 6
const CROSS_MM = 4

export function RegistrationMarksLayer({ pxPerMm }: { pxPerMm: number }) {
  const hpgl = useDoc((s) => s.profile.kind === 'hpgl')
  const url = useCameraRig((s) => s.url)
  const marks = useCameraRig((s) => s.marks)
  if (!hpgl || !url) return null

  const sw = 1 / pxPerMm
  const h = CROSS_MM / 2
  return (
    <Group listening={false}>
      <Rect
        x={marks.square.x - SQUARE_MM / 2}
        y={marks.square.y - SQUARE_MM / 2}
        width={SQUARE_MM}
        height={SQUARE_MM}
        stroke={COLOR}
        strokeWidth={sw}
      />
      {[marks.cornerX, marks.cornerY].map((p, i) => (
        <Group key={i} x={p.x} y={p.y}>
          <Line points={[-h, 0, h, 0]} stroke={COLOR} strokeWidth={sw} />
          <Line points={[0, -h, 0, h]} stroke={COLOR} strokeWidth={sw} />
        </Group>
      ))}
    </Group>
  )
}
