/**
 * Camera registration, core logic: where the printed marks sit on the sheet, applying the solved
 * page->machine affine, the plausibility verdict, and the test-cut geometry. Pure TS; the image
 * and matrix math lives in Rust (`wasm/registration.ts`).
 */
import type { Geometry, PenId } from "./types";
import { affineStrain, type Affine, type CamMatrix, type Pt } from "./wasm/registration";

/** Mark centroids in page mm (top-left origin). `cornerX` is the corner mark level with the square
 *  (to its right or left), `cornerY` the one in line with it (below or above). */
export interface MarkLayout {
  square: Pt;
  cornerX: Pt;
  cornerY: Pt;
}

export type Side = "right" | "left" | "below" | "above";

/** Which side of the square each corner mark lies on. */
export function cornerSides(l: MarkLayout): { x: "right" | "left"; y: "below" | "above" } {
  return { x: l.cornerX.x >= l.square.x ? "right" : "left", y: l.cornerY.y >= l.square.y ? "below" : "above" };
}

export type SheetCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface PageSize {
  width: number;
  height: number;
}

/** The sheet corner the square is printed in: away from the sides its corner marks lie on. */
export function squareCorner(l: MarkLayout): SheetCorner {
  const s = cornerSides(l);
  return `${s.y === "below" ? "top" : "bottom"}-${s.x === "right" ? "left" : "right"}`;
}

/** The layout flipped across the sheet's center lines so the square lands in sheet corner `to`.
 *  The sheet's top-left corner is the page origin. */
export function squareToCorner(l: MarkLayout, to: SheetCorner, page: PageSize): MarkLayout {
  const [fromV, fromH] = squareCorner(l).split("-");
  const [v, h] = to.split("-");
  const m = (p: Pt): Pt => ({
    x: fromH === h ? p.x : page.width - p.x,
    y: fromV === v ? p.y : page.height - p.y,
  });
  return { square: m(l.square), cornerX: m(l.cornerX), cornerY: m(l.cornerY) };
}

export function onSheet(l: MarkLayout, page: PageSize): boolean {
  return [l.square, l.cornerX, l.cornerY].every(
    (p) => p.x >= 0 && p.x <= page.width && p.y >= 0 && p.y <= page.height,
  );
}

/** A quarter turn clockwise with the sheet (its height before the turn), for a sheet printed the
 *  other way up: the long side of the marks becomes the short one. The corner level with the
 *  square ends up in line with it, so the two corners swap roles. */
export function rotateLayout(l: MarkLayout, sheetHeight: number): MarkLayout {
  const r = (p: Pt): Pt => ({ x: sheetHeight - p.y, y: p.x });
  return { square: r(l.square), cornerX: r(l.cornerY), cornerY: r(l.cornerX) };
}

/** The whole layout shifted so the square sits at `to`. */
export function moveLayout(l: MarkLayout, to: Pt): MarkLayout {
  const d = { x: to.x - l.square.x, y: to.y - l.square.y };
  const m = (p: Pt): Pt => ({ x: p.x + d.x, y: p.y + d.y });
  return { square: to, cornerX: m(l.cornerX), cornerY: m(l.cornerY) };
}

/** Sheet-corner names ("top-right corner") from where the marks sit relative to each other. */
export function markNames(l: MarkLayout): Record<keyof MarkLayout, string> {
  const s = cornerSides(l);
  const h = s.x;
  const v = s.y === "below" ? "bottom" : "top";
  const notH = h === "right" ? "left" : "right";
  const notV = v === "bottom" ? "top" : "bottom";
  return { square: "square", cornerX: `${notV}-${h} corner`, cornerY: `${v}-${notH} corner` };
}

export const PROXIES_AT_HOME_SHEET: PageSize = { width: 297, height: 210 };

/** Centroid offsets of the Proxies at Home marks, as measured on its default template. */
const SQUARE_IN = { x: 2.64, y: 2.65 };
const CORNER_IN = { along: 2.08, across: 2.36 };

/** The Proxies at Home marks for a sheet: `inset` mm in from the edges (the template's setting,
 *  10 by default - it is in the file name, "5mm_inset"), the square in sheet corner `corner`. */
export function insetLayout(sheet: PageSize, inset: number, corner: SheetCorner): MarkLayout {
  const topLeft: MarkLayout = {
    square: { x: inset + SQUARE_IN.x, y: inset + SQUARE_IN.y },
    cornerX: { x: sheet.width - inset - CORNER_IN.along, y: inset + CORNER_IN.across },
    cornerY: { x: inset + CORNER_IN.across, y: sheet.height - inset - CORNER_IN.along + 0.01 },
  };
  return squareToCorner(topLeft, corner, sheet);
}

/** The inset `l` was laid out with, or null when its marks match no inset (hand-edited positions). */
export function markInset(l: MarkLayout, sheet: PageSize): number | null {
  const inset = Math.round((Math.min(l.square.x, sheet.width - l.square.x) - SQUARE_IN.x) * 100) / 100;
  const want = insetLayout(sheet, inset, squareCorner(l));
  const same = (["square", "cornerX", "cornerY"] as const).every(
    (k) => Math.hypot(want[k].x - l[k].x, want[k].y - l[k].y) < 0.05,
  );
  return same ? inset : null;
}

export const PROXIES_AT_HOME_MARKS: MarkLayout = insetLayout(PROXIES_AT_HOME_SHEET, 10, "top-left");

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

/** The CSS matrix `[a, b, c, d]` that turns a raw camera frame into the operator's view, standing in
 *  front of the cutter: +Y (head left) is screen left, +X (feed, away from the operator) is screen
 *  up. Built from the calibrated px -> mm matrix and snapped to the nearest quarter turn or mirror. */
export function previewOrientation(m: CamMatrix): [number, number, number, number] {
  // screen x = -(machine Y), screen y = -(machine X); machine delta = m · pixel delta.
  const snap = (u: number, v: number): [number, number] =>
    Math.abs(u) >= Math.abs(v) ? [Math.sign(u), 0] : [0, Math.sign(v)];
  const [a, c] = snap(-m[2], -m[3]);
  const [b, d] = snap(-m[0], -m[1]);
  return [a, b, c, d];
}
