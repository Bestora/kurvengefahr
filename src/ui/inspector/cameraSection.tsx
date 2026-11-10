// HP-GL machine tab: camera registration. Camera URL + live frame, jog, calibrate / measure / test
// cut, knife offset, soft limit and the mark layout. All actions live in `store/registration`;
// they need the port, and refuse while a plot runs or another action is busy.
import { useState } from 'react'
import { PROXIES_AT_HOME_MARKS, previewOrientation, type MarkLayout } from '../../core/registration'
import { affineStrain } from '../../core/wasm/registration'
import { useCameraRig } from '../../store/cameraRig'
import { usePlotSession } from '../../store/plotSession'
import { useRegistration } from '../../store/registration'
import { useSerial } from '../../store/serial'
import { Banner, Button, Disclosure, Field, IconButton, SectionTitle, controlClass } from '../primitives'
import { Num } from './controls'

const STEPS = [1, 5, 20]
const NEEDS_PORT = 'Connect the cutter first'
const NEEDS_URL = 'Enter the camera URL first'

export function CameraRegistrationSection() {
  const rig = useCameraRig()
  const reg = useRegistration()
  const connected = useSerial((s) => s.connected)
  const idle = usePlotSession((s) => s.phase === 'idle')
  const [step, setStep] = useState(5)
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null)

  const busy = reg.phase === 'busy'
  const free = idle && !busy
  const act = free && connected && !!rig.url
  const portTitle = (t: string) => (!connected ? NEEDS_PORT : !rig.url ? NEEDS_URL : t)
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const commitUrl = () => {
    if (urlDraft !== null) rig.patch({ url: urlDraft.trim() })
    setUrlDraft(null)
  }
  const marks = rig.marks
  const setMark = (k: keyof MarkLayout, axis: 'x' | 'y', v: number) =>
    rig.patch({ marks: { ...marks, [k]: { ...marks[k], [axis]: v } } })
  const strain = reg.affine ? affineStrain(reg.affine) : null
  const mmPerPx = rig.cam ? Math.sqrt(Math.abs(rig.cam.m[0] * rig.cam.m[3] - rig.cam.m[1] * rig.cam.m[2])) : null
  const stale = !!rig.cam && !!frameSize && (rig.cam.w !== frameSize.w || rig.cam.h !== frameSize.h)
  const orient = rig.cam && !stale ? previewOrientation(rig.cam.m) : [1, 0, 0, 1]
  const swap = orient[0] === 0
  const fw = frameSize?.w ?? rig.cam?.w ?? 4
  const fh = frameSize?.h ?? rig.cam?.h ?? 3

  // Y runs along the carriage: +Y moves the head left. X is the feed axis.
  const jogBtn = (glyph: string, axis: 'X' | 'Y', sign: 1 | -1) => {
    const dir = axis === 'Y' ? (sign > 0 ? 'head left' : 'head right') : 'feed'
    const label = `Jog ${sign > 0 ? '+' : '-'}${axis}`
    return (
      <IconButton
        aria-label={label}
        title={act ? `${label} - ${dir} (${step} mm)` : portTitle('')}
        disabled={!act}
        onClick={() => void reg.jog(axis === 'X' ? sign * step : 0, axis === 'Y' ? sign * step : 0)}
      >
        {glyph}
      </IconButton>
    )
  }

  return (
    <>
      <SectionTitle>Camera registration</SectionTitle>
      {location.protocol === 'https:' && (
        <Banner variant="warn">The camera is plain HTTP. Run Kurvengefahr on http://localhost to use it.</Banner>
      )}
      <Field label="Camera URL">
        <input
          className={controlClass}
          value={urlDraft ?? rig.url}
          placeholder="http://<ip>/capture"
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={commitUrl}
          onKeyDown={(e) => e.key === 'Enter' && commitUrl()}
        />
      </Field>
      {reg.frameUrl && (
        // Shown as the operator sees the bed (see previewOrientation); raw frame until calibrated.
        <div
          className="relative mt-2 overflow-hidden rounded-md border border-border"
          style={{ aspectRatio: swap ? `${fh} / ${fw}` : `${fw} / ${fh}` }}
        >
          <img
            src={reg.frameUrl}
            alt="Camera frame"
            className="absolute left-1/2 top-1/2 max-w-none"
            style={{
              width: swap ? `${(100 * fw) / fh}%` : '100%',
              transform: `translate(-50%, -50%) matrix(${orient.join(', ')}, 0, 0)`,
            }}
            onLoad={(e) => setFrameSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          <div className="pointer-events-none absolute left-1/2 top-0 h-full w-px bg-accent" />
          <div className="pointer-events-none absolute left-0 top-1/2 h-px w-full bg-accent" />
        </div>
      )}
      <Button className="mt-2 w-full" disabled={!rig.url || !free} onClick={() => void reg.snapshot()}>
        Refresh
      </Button>

      <div className="mt-2 flex items-center gap-1">
        {jogBtn('←', 'Y', 1)}
        {jogBtn('→', 'Y', -1)}
        {jogBtn('↑', 'X', 1)}
        {jogBtn('↓', 'X', -1)}
        <select
          className={controlClass}
          aria-label="Jog step"
          value={step}
          onChange={(e) => setStep(Number(e.target.value))}
        >
          {STEPS.map((s) => (
            <option key={s} value={s}>
              {s} mm
            </option>
          ))}
        </select>
        <Button disabled={!act} title={portTitle('Send the head back to the origin')} onClick={() => void reg.home()}>
          Back to origin
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted">
        Check the carriage direction once before the first search: +Y should move the head left.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          disabled={!act}
          title={portTitle('Put the square mark under the camera first')}
          onClick={() => void reg.calibrate()}
        >
          Calibrate camera
        </Button>
        <Button disabled={!act} title={portTitle('Find and measure the sheet’s marks')} onClick={() => void reg.measure()}>
          Measure sheet
        </Button>
        {busy && <Button onClick={reg.cancel}>Cancel</Button>}
        {reg.affine !== null && (
          <Button disabled={!act} title={portTitle('Cut a small square on the square mark')} onClick={() => void usePlotSession.getState().startTestCut()}>
            Test cut
          </Button>
        )}
      </div>
      {mmPerPx !== null && (
        <p className="mt-1 text-xs text-muted">
          Camera: {mmPerPx.toFixed(3)} mm/px{stale && ' - Recalibrate - the camera resolution changed'}
        </p>
      )}
      {reg.message && <p className="mt-1 text-xs text-muted">{reg.message}</p>}
      {strain && (
        <p className="mt-1 text-xs text-muted">
          Rotation {strain.rotDeg.toFixed(2)} deg, scale {strain.sx.toFixed(3)} x {strain.sy.toFixed(3)}, shear{' '}
          {strain.shearDeg.toFixed(2)} deg
        </p>
      )}
      {reg.warning && <Banner variant="warn">{reg.warning}</Banner>}

      <Num label="Knife offset X (mm)" value={rig.knifeOffset.x} step={0.1}
        onChange={(v) => rig.patch({ knifeOffset: { ...rig.knifeOffset, x: v } })} />
      <Num label="Knife offset Y (mm)" value={rig.knifeOffset.y} step={0.1}
        onChange={(v) => rig.patch({ knifeOffset: { ...rig.knifeOffset, y: v } })} />
      <p className="text-xs text-muted">
        Uses the jog axes: a positive X or Y shifts the cut the way the Jog +X / +Y button moves the head. If the
        test cut&apos;s white rim is wider on one side, shift the cut towards that side by half the difference.
      </p>
      <Num label="Soft limit (mm)" title="Furthest the head may travel along the carriage with the camera fitted."
        value={rig.softLimitMm} step={0.25} onChange={(v) => v > 0 && rig.patch({ softLimitMm: v })} />

      <Disclosure label="Mark layout">
        {(['square', 'topRight', 'bottomLeft'] as const).map((k) => (
          <div key={k}>
            <Num label={`${k} X (mm)`} value={marks[k].x} step={0.1} onChange={(v) => setMark(k, 'x', v)} />
            <Num label={`${k} Y (mm)`} value={marks[k].y} step={0.1} onChange={(v) => setMark(k, 'y', v)} />
          </div>
        ))}
        <Button className="mt-2 w-full" onClick={() => rig.patch({ marks: PROXIES_AT_HOME_MARKS })}>
          Reset to Proxies at Home
        </Button>
      </Disclosure>
    </>
  )
}
