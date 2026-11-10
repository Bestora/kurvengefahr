// Synchronous TS wrappers over the Rust camera-registration exports (mark detection, frame
// difference, 3-point affine + decomposition, camera-matrix fit). See crate/src/registration.rs.
import { find_marks, frame_diff, solve_affine, affine_strain, fit_camera } from './index'

export type Pt = { x: number; y: number }
/** `x' = a·x + b·y + c`, `y' = d·x + e·y + f`. */
export type Affine = [number, number, number, number, number, number]
/** Row-wise 2x2 `[a, b, c, d]`. */
export type CamMatrix = [number, number, number, number]
export interface Detected {
  kind: 'square' | 'corner'
  x: number
  y: number
  areaMm2: number
}

/** Marks in an RGBA frame (px, pixel centre +0.5). `mmPerPx` 0 skips the size check. */
export function findMarks(rgba: Uint8Array, w: number, h: number, mmPerPx: number): Detected[] {
  const flat = find_marks(rgba, w, h, mmPerPx)
  const out: Detected[] = []
  for (let i = 0; i < flat.length; i += 4) {
    out.push({
      kind: flat[i] === 0 ? 'square' : 'corner',
      x: flat[i + 1],
      y: flat[i + 2],
      areaMm2: flat[i + 3],
    })
  }
  return out
}

/** Mean absolute luma difference, 0..255 (Infinity for unequal frame sizes). */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  return frame_diff(a, b)
}

const flat = (p: Pt[]) => new Float64Array(p.flatMap((q) => [q.x, q.y]))

/** Affine taking `src` to `dst`; null for collinear points. */
export function solveAffine(src: [Pt, Pt, Pt], dst: [Pt, Pt, Pt]): Affine | null {
  const r = solve_affine(flat(src), flat(dst))
  return r.length === 6 ? (Array.from(r) as Affine) : null
}

export function affineStrain(m: Affine): {
  rotDeg: number
  sx: number
  sy: number
  shearDeg: number
  mirrored: boolean
} {
  const [rotDeg, sx, sy, shearDeg, mirrored] = affine_strain(new Float64Array(m))
  return { rotDeg, sx, sy, shearDeg, mirrored: mirrored === 1 }
}

/** `J` with `J·du[i] = dh[i]`; null when the probe moves are degenerate. */
export function fitCamera(du: [Pt, Pt], dh: [Pt, Pt]): CamMatrix | null {
  const r = fit_camera(flat(du), flat(dh))
  return r.length === 4 ? (Array.from(r) as CamMatrix) : null
}
