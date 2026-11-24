import { beforeAll, describe, expect, it } from "vitest";
import { initWasmForTests } from "./wasm/nodeTestInit";
import type { Affine } from "./wasm/registration";
import {
  PROXIES_AT_HOME_MARKS,
  applyAffine,
  checkRegistration,
  markNames,
  insetLayout,
  markInset,
  moveLayout,
  onSheet,
  previewOrientation,
  rotateLayout,
  squareCorner,
  squareToCorner,
  testCutGeometry,
  withOffset,
} from "./registration";

beforeAll(async () => {
  await initWasmForTests();
});

const rot = (deg: number): Affine => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0];
};
const scaled = (sx: number, sy: number): Affine => [sx, 0, 0, 0, sy, 0];
const sheared = (deg: number): Affine => [
  1,
  Math.tan((deg * Math.PI) / 180),
  0,
  0,
  1,
  0,
];
const mirrorY = (m: Affine): Affine => [m[0], m[1], m[2], -m[3], -m[4], -m[5]];

describe("registration core", () => {
  it("applies an affine and an offset", () => {
    const m: Affine = [0, -1, 500, 1, 0, 20];
    expect(applyAffine(m, { x: 3, y: 4 })).toEqual({ x: 496, y: 23 });
    expect(withOffset(m, { x: 1, y: -2 })).toEqual([0, -1, 501, 1, 0, 18]);
  });

  it("accepts a clean rotation", () =>
    expect(checkRegistration(rot(2), null)).toEqual({
      error: null,
      warning: null,
    }));
  it("rejects scale outside 0.98..1.02", () =>
    expect(checkRegistration(scaled(1.03, 1), null).error).toMatch(/scale/i));
  it("rejects shear above 0.5°", () =>
    expect(checkRegistration(sheared(0.6), null).error).toMatch(/shear/i));
  it("rejects a mirror flip against the previous sheet", () =>
    expect(checkRegistration(mirrorY(rot(0)), rot(0)).error).toMatch(
      /mirror/i,
    ));
  it("warns when strain drifts > 0.3 mm over 300 mm from the previous sheet", () => {
    expect(checkRegistration(scaled(1.0015, 1), scaled(1, 1)).warning).toMatch(
      /previous sheet/i,
    ); // 0.45 mm
    expect(
      checkRegistration(scaled(1.0005, 1), scaled(1, 1)).warning,
    ).toBeNull(); // 0.15 mm
  });
  it("cuts a 7.99 mm square around the square mark", () => {
    const [s] = testCutGeometry(PROXIES_AT_HOME_MARKS, 0);
    expect(s.points).toHaveLength(5);
    expect(s.points[0]).toEqual(s.points[4]);
    expect(s.points[0].x).toBeCloseTo(12.64 - 3.995, 6);
    expect(s.points[2].y).toBeCloseTo(12.65 + 3.995, 6);
    expect(s.reversible).toBe(false);
  });
});

describe("previewOrientation", () => {
  it("turns the SK-720T frame (image x = feed, image y = carriage) into the operator view", () => {
    // Calibrated on the SK-720T, 2026-11-10.
    const m: [number, number, number, number] = [-0.0885, -0.0087, 0.0031, -0.0744];
    expect(previewOrientation(m)).toEqual([0, 1, 1, 0]);
  });
  it("leaves an already upright camera alone", () => {
    // image +x = head right (-Y), image +y = toward the operator (-X)
    expect(previewOrientation([0, -0.08, -0.08, 0])).toEqual([1, 0, 0, 1]);
  });
});

describe("mark layout sides", () => {
  const L = PROXIES_AT_HOME_MARKS;
  const A4 = { width: 297, height: 210 };
  it("puts the square in another sheet corner by flipping across the page", () => {
    expect(squareCorner(L)).toBe("top-left");
    const f = squareToCorner(L, "bottom-right", A4);
    expect(squareCorner(f)).toBe("bottom-right");
    expect(f.square.x).toBeCloseTo(297 - L.square.x);
    expect(f.cornerY.y).toBeCloseTo(210 - L.cornerY.y);
    expect(onSheet(f, A4)).toBe(true);
    expect(markNames(L)).toEqual({ square: "square", cornerX: "top-right corner", cornerY: "bottom-left corner" });
    expect(markNames(f)).toEqual({ square: "square", cornerX: "bottom-left corner", cornerY: "top-right corner" });
    expect(squareToCorner(f, "top-left", A4).cornerX.x).toBeCloseTo(L.cornerX.x);
  });
  it("turns a quarter clockwise: square top-right, the long side runs down", () => {
    const r = rotateLayout(L, A4.height);
    expect(squareCorner(r)).toBe("top-right");
    expect(r.square).toEqual({ x: 210 - L.square.y, y: L.square.x });
    expect(Math.abs(r.cornerX.x - r.square.x)).toBeCloseTo(L.cornerY.y - L.square.y);
    expect(Math.abs(r.cornerY.y - r.square.y)).toBeCloseTo(L.cornerX.x - L.square.x);
    expect(onSheet(r, A4)).toBe(false);
    expect(onSheet(r, { width: 210, height: 297 })).toBe(true);
    expect(squareCorner(rotateLayout(r, A4.width))).toBe("bottom-right");
  });
  it("builds the layout from sheet, inset and corner", () => {
    for (const k of ["square", "cornerX", "cornerY"] as const) {
      expect(L[k].x).toBeCloseTo([12.64, 284.92, 12.36][["square", "cornerX", "cornerY"].indexOf(k)]);
      expect(L[k].y).toBeCloseTo([12.65, 12.36, 197.93][["square", "cornerX", "cornerY"].indexOf(k)]);
    }
    const portrait = { width: 210, height: 297 };
    const l = insetLayout(portrait, 5, "bottom-right");
    expect(l.square.x).toBeCloseTo(202.36);
    expect(l.square.y).toBeCloseTo(289.35);
    expect(l.cornerX.x).toBeCloseTo(7.08);
    expect(l.cornerY.y).toBeCloseTo(7.07);
    expect(markInset(l, portrait)).toBeCloseTo(5);
    expect(markInset(L, A4)).toBeCloseTo(10);
    expect(markInset({ ...l, cornerX: { x: 9.5, y: l.cornerX.y } }, portrait)).toBeNull();
  });
  it("moves every mark with the square", () => {
    const m = moveLayout(L, { x: L.square.x + 10, y: L.square.y - 5 });
    expect(m.cornerX.x).toBeCloseTo(L.cornerX.x + 10);
    expect(m.cornerY.y).toBeCloseTo(L.cornerY.y - 5);
  });
});
