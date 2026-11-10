/**
 * Camera registration, core logic: where the printed marks sit on the sheet, applying the solved
 * page->machine affine, the plausibility verdict, and the test-cut geometry. Pure TS; the image
 * and matrix math lives in Rust (`wasm/registration.ts`).
 */
import type { Geometry, PenId } from "./types";
import { affineStrain, type Affine, type Pt } from "./wasm/registration";

/** Mark centroids in page mm (top-left origin). */
export interface MarkLayout {
  square: Pt;
  topRight: Pt;
  bottomLeft: Pt;
}

export const PROXIES_AT_HOME_MARKS: MarkLayout = {
  square: { x: 12.64, y: 12.65 },
  topRight: { x: 284.92, y: 12.36 },
  bottomLeft: { x: 12.36, y: 197.93 },
};

export const TEST_CUT_SIDE_MM = 7.99;

const SCALE_MIN = 0.98;
const SCALE_MAX = 1.02;
const MAX_SHEAR_DEG = 0.5;
const DRIFT_REF_MM = 300;
const DRIFT_WARN_MM = 0.3;

export function applyAffine(m: Affine, p: Pt): Pt {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2],
    y: m[3] * p.x + m[4] * p.y + m[5],
  };
}

/** Shift the output by `d` (adds to the translation terms). */
export function withOffset(m: Affine, d: Pt): Affine {
  return [m[0], m[1], m[2] + d.x, m[3], m[4], m[5] + d.y];
}

export interface Verdict {
  error: string | null;
  warning: string | null;
}

export function checkRegistration(m: Affine, prev: Affine | null): Verdict {
  const s = affineStrain(m);
  for (const [name, v] of [
    ["X scale", s.sx],
    ["Y scale", s.sy],
  ] as const) {
    if (v < SCALE_MIN || v > SCALE_MAX)
      return {
        error: `${name} ${v.toFixed(3)} is outside ${SCALE_MIN}-${SCALE_MAX} - wrong mark or the sheet moved.`,
        warning: null,
      };
  }
  if (Math.abs(s.shearDeg) > MAX_SHEAR_DEG)
    return {
      error: `Shear ${s.shearDeg.toFixed(2)} deg exceeds ${MAX_SHEAR_DEG} deg - the sheet is skewed or a mark was misread.`,
      warning: null,
    };
  if (!prev) return { error: null, warning: null };

  const p = affineStrain(prev);
  if (s.mirrored !== p.mirrored)
    return {
      error:
        "The sheet is mirrored compared to the previous sheet - marks were probably swapped.",
      warning: null,
    };
  const rad = Math.PI / 180;
  const drift =
    DRIFT_REF_MM *
    Math.max(
      Math.abs(s.sx - p.sx),
      Math.abs(s.sy - p.sy),
      Math.abs(Math.tan((s.shearDeg - p.shearDeg) * rad)),
    );
  if (drift > DRIFT_WARN_MM)
    return {
      error: null,
      warning: `Strain differs from the previous sheet by ${drift.toFixed(2)} mm over ${DRIFT_REF_MM} mm - check the material.`,
    };
  return { error: null, warning: null };
}

/** One closed square, `TEST_CUT_SIDE_MM` wide, centered on the square mark. */
export function testCutGeometry(layout: MarkLayout, pen: PenId): Geometry {
  const h = TEST_CUT_SIDE_MM / 2;
  const { x, y } = layout.square;
  const points = [
    { x: x - h, y: y - h },
    { x: x + h, y: y - h },
    { x: x + h, y: y + h },
    { x: x - h, y: y + h },
    { x: x - h, y: y - h },
  ];
  return [{ points, pen, reversible: false }];
}
