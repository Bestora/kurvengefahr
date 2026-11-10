import { beforeAll, describe, expect, it } from "vitest";
import { initWasmForTests } from "./wasm/nodeTestInit";
import type { Affine } from "./wasm/registration";
import {
  PROXIES_AT_HOME_MARKS,
  applyAffine,
  checkRegistration,
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
