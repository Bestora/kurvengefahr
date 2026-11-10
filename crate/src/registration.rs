//! Camera registration compute: find printed registration marks in an RGBA frame, compare frames,
//! solve/decompose a 3-point affine, and fit the 2x2 camera-pixel -> head-mm matrix.
//! Pure functions on flat buffers; the TS side marshals (see `src/core/wasm/registration.ts`).

use crate::raster::Grid;

pub const SQUARE: u8 = 0;
pub const CORNER: u8 = 1;

/// A detected mark; `x`/`y` in px (pixel centre = +0.5), `area_mm2` 0 when the scale is unknown.
#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub kind: u8,
    pub x: f64,
    pub y: f64,
    pub area_mm2: f64,
}

const MIN_PX: usize = 30;

/// Dark blobs that are markedly darker than their surroundings, classified by shape: a filled
/// square (compactness ~1) or an L-shaped corner mark (thin arms, compactness ~0.2). Blobs
/// touching the frame border are dropped (cut off, centroid biased).
pub fn find_marks(rgba: &[u8], w: usize, h: usize, mm_per_px: f64) -> Vec<Mark> {
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return vec![];
    }
    let grid = Grid::build(rgba, w, h, w as f32, h as f32, false);
    // Integral image of inkness for a cheap local mean (handles vignetting / uneven lighting).
    let iw = w + 1;
    let mut integ = vec![0.0f64; iw * (h + 1)];
    for y in 0..h {
        let mut row = 0.0;
        for x in 0..w {
            row += grid.at(x, y) as f64;
            integ[(y + 1) * iw + x + 1] = integ[y * iw + x + 1] + row;
        }
    }
    let r = w.max(h) / 4; // window side max(w,h)/2
    let mut mask = vec![false; w * h];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
            let sum = integ[y1 * iw + x1] - integ[y0 * iw + x1] - integ[y1 * iw + x0]
                + integ[y0 * iw + x0];
            let mean = sum / ((x1 - x0) * (y1 - y0)) as f64;
            // ponytail: fixed threshold 0.15 / window max(w,h)/2 - retune on real frames if the camera is too flat.
            mask[y * w + x] = grid.at(x, y) as f64 - mean > 0.15;
        }
    }

    let mut seen = vec![false; w * h];
    let mut out = vec![];
    let mut stack = vec![];
    for start in 0..w * h {
        if !mask[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let mut px = vec![];
        let mut border = false;
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            border |= x == 0 || y == 0 || x == w - 1 || y == h - 1;
            px.push((x as f64 + 0.5, y as f64 + 0.5));
            let mut push = |j: usize| {
                if mask[j] && !seen[j] {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                push(i - 1);
            }
            if x + 1 < w {
                push(i + 1);
            }
            if y > 0 {
                push(i - w);
            }
            if y + 1 < h {
                push(i + w);
            }
        }
        if border || px.len() < MIN_PX {
            continue;
        }
        let n = px.len() as f64;
        let (cx, cy) = (
            px.iter().map(|p| p.0).sum::<f64>() / n,
            px.iter().map(|p| p.1).sum::<f64>() / n,
        );
        let (mut m20, mut m02, mut m11) = (0.0, 0.0, 0.0);
        for &(x, y) in &px {
            m20 += (x - cx) * (x - cx);
            m02 += (y - cy) * (y - cy);
            m11 += (x - cx) * (y - cy);
        }
        let (m20, m02, m11) = (m20 / n, m02 / n, m11 / n);
        let det = m20 * m02 - m11 * m11;
        if det <= 0.0 {
            continue;
        }
        let c = n / (12.0 * det.sqrt());
        let area_mm2 = n * mm_per_px * mm_per_px;
        let known = mm_per_px > 0.0;
        let kind = if (0.8..=1.25).contains(&c) && (!known || (23.0..=49.0).contains(&area_mm2)) {
            SQUARE
        } else if (0.12..=0.35).contains(&c) && (!known || (11.0..=24.0).contains(&area_mm2)) {
            CORNER
        } else {
            continue;
        };
        out.push(Mark {
            kind,
            x: cx,
            y: cy,
            area_mm2: if known { area_mm2 } else { 0.0 },
        });
    }
    out
}

/// Mean absolute luma difference of two equal-sized RGBA frames (0..255); unequal length -> inf.
pub fn frame_diff(a: &[u8], b: &[u8]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return f64::INFINITY;
    }
    let luma = |p: &[u8]| 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
    let sum: f64 = a
        .chunks_exact(4)
        .zip(b.chunks_exact(4))
        .map(|(p, q)| (luma(p) - luma(q)).abs())
        .sum();
    sum / (a.len() / 4) as f64
}

/// Affine mapping three points `src` -> `dst` (`x0,y0,x1,y1,x2,y2`): `[a,b,c,d,e,f]` with
/// `x' = a x + b y + c`, `y' = d x + e y + f`. Collinear sources -> `None`.
pub fn solve_affine(src: &[f64; 6], dst: &[f64; 6]) -> Option<[f64; 6]> {
    let (x0, y0, x1, y1, x2, y2) = (src[0], src[1], src[2], src[3], src[4], src[5]);
    let det = x0 * (y1 - y2) - y0 * (x1 - x2) + (x1 * y2 - x2 * y1);
    if det.abs() < 1e-12 {
        return None;
    }
    // Solve [x y 1]·[p q r]ᵀ = t for each target coordinate (Cramer's rule).
    let solve = |t0: f64, t1: f64, t2: f64| {
        let p = (t0 * (y1 - y2) - y0 * (t1 - t2) + (t1 * y2 - t2 * y1)) / det;
        let q = (x0 * (t1 - t2) - t0 * (x1 - x2) + (x1 * t2 - x2 * t1)) / det;
        let r =
            (x0 * (y1 * t2 - y2 * t1) - y0 * (x1 * t2 - x2 * t1) + t0 * (x1 * y2 - x2 * y1)) / det;
        [p, q, r]
    };
    let [a, b, c] = solve(dst[0], dst[2], dst[4]);
    let [d, e, f] = solve(dst[1], dst[3], dst[5]);
    Some([a, b, c, d, e, f])
}

/// QR-decompose the linear part: `[rot_deg, sx, sy, shear_deg, mirrored(0|1)]`.
pub fn affine_strain(m: &[f64; 6]) -> [f64; 5] {
    let (a, b, d, e) = (m[0], m[1], m[3], m[4]);
    let sx = a.hypot(d);
    let det = a * e - b * d;
    let k = (a * b + d * e) / sx;
    let sy = det.abs() / sx;
    [
        d.atan2(a).to_degrees(),
        sx,
        sy,
        (k / sy).atan().to_degrees(),
        if det < 0.0 { 1.0 } else { 0.0 },
    ]
}

/// Camera matrix `J = [a,b,c,d]` (row-wise) with `J · du_i = dh_i` for two probe moves
/// (`du = [du0x,du0y,du1x,du1y]`, same for `dh`); singular probes -> `None`.
pub fn fit_camera(du: &[f64; 4], dh: &[f64; 4]) -> Option<[f64; 4]> {
    // U = [du0 du1] as columns, H likewise; J = H · U⁻¹.
    let det = du[0] * du[3] - du[2] * du[1];
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = [du[3] / det, -du[2] / det, -du[1] / det, du[0] / det];
    Some([
        dh[0] * inv[0] + dh[2] * inv[2],
        dh[0] * inv[1] + dh[2] * inv[3],
        dh[1] * inv[0] + dh[3] * inv[2],
        dh[1] * inv[1] + dh[3] * inv[3],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn white(_: usize, _: usize) -> u8 {
        255
    }

    fn img(
        w: usize,
        h: usize,
        ink: impl Fn(f64, f64) -> bool,
        bg: impl Fn(usize, usize) -> u8,
    ) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let g = if ink(x as f64 + 0.5, y as f64 + 0.5) {
                    20
                } else {
                    bg(x, y)
                };
                v.extend_from_slice(&[g, g, g, 255]);
            }
        }
        v
    }

    fn rotated_square(cx: f64, cy: f64, side: f64, deg: f64) -> impl Fn(f64, f64) -> bool {
        let (s, c) = deg.to_radians().sin_cos();
        move |x, y| {
            let (dx, dy) = (x - cx, y - cy);
            let (u, v) = (dx * c + dy * s, -dx * s + dy * c);
            u.abs() <= side / 2.0 && v.abs() <= side / 2.0
        }
    }

    fn l_shape(x0: f64, y0: f64, arm: f64, t: f64) -> impl Fn(f64, f64) -> bool {
        move |x, y| {
            x >= x0 && y >= y0 && ((x < x0 + arm && y < y0 + t) || (x < x0 + t && y < y0 + arm))
        }
    }

    #[test]
    fn finds_square_centroid() {
        let m = find_marks(
            &img(400, 300, rotated_square(200.0, 150.0, 60.0, 5.0), white),
            400,
            300,
            0.1,
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, SQUARE);
        assert!((m[0].x - 200.0).abs() < 0.5 && (m[0].y - 150.0).abs() < 0.5);
        assert!((m[0].area_mm2 - 36.0).abs() < 4.0);
    }

    #[test]
    fn finds_corner_mark() {
        let m = find_marks(
            &img(400, 300, l_shape(100.0, 80.0, 94.0, 10.0), white),
            400,
            300,
            0.1,
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, CORNER);
        // analytic centroid of the L: 100 + 48380/1780, 80 + 48380/1780
        let c = 48380.0 / 1780.0;
        assert!((m[0].x - (100.0 + c)).abs() < 0.5 && (m[0].y - (80.0 + c)).abs() < 0.5);
    }

    #[test]
    fn ignores_blobs_touching_the_border() {
        let m = find_marks(
            &img(400, 300, rotated_square(5.0, 150.0, 60.0, 0.0), white),
            400,
            300,
            0.1,
        );
        assert!(m.is_empty());
    }

    #[test]
    fn survives_a_vignette() {
        let bg = |x: usize, _: usize| (230.0 - 170.0 * x as f64 / 399.0) as u8;
        let m = find_marks(
            &img(400, 300, rotated_square(80.0, 150.0, 60.0, 0.0), bg),
            400,
            300,
            0.1,
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, SQUARE);
    }

    #[test]
    fn rejects_wrong_size_when_scale_known() {
        let a = img(400, 300, rotated_square(200.0, 150.0, 30.0, 0.0), white);
        assert!(find_marks(&a, 400, 300, 0.1).is_empty());
        assert_eq!(find_marks(&a, 400, 300, 0.0).len(), 1);
    }

    #[test]
    fn frame_diff_is_zero_for_identical_frames() {
        let a = img(40, 30, rotated_square(20.0, 15.0, 10.0, 0.0), white);
        assert_eq!(frame_diff(&a, &a), 0.0);
        assert_eq!(frame_diff(&a, &a[4..]), f64::INFINITY);
    }

    #[test]
    fn solves_known_affine() {
        let (s, c) = 1.5f64.to_radians().sin_cos();
        let (sx, sy) = (1.003, -0.998);
        let m = [c * sx, -s * sy, 40.0, s * sx, c * sy, 300.0];
        let src = [12.64, 12.65, 284.92, 12.36, 12.36, 197.93];
        let ap = |x: f64, y: f64| (m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
        let (p0, p1, p2) = (ap(src[0], src[1]), ap(src[2], src[3]), ap(src[4], src[5]));
        let got = solve_affine(&src, &[p0.0, p0.1, p1.0, p1.1, p2.0, p2.1]).unwrap();
        for i in 0..6 {
            assert!((got[i] - m[i]).abs() < 1e-9, "coef {i}");
        }
        let [rot, ssx, ssy, shear, mir] = affine_strain(&got);
        assert!(
            (rot - 1.5).abs() < 1e-9 && (ssx - 1.003).abs() < 1e-9 && (ssy - 0.998).abs() < 1e-9
        );
        assert!(shear.abs() < 1e-9 && mir == 1.0);
    }

    #[test]
    fn solve_affine_rejects_collinear_points() {
        assert!(solve_affine(&[0., 0., 1., 1., 2., 2.], &[0.; 6]).is_none());
    }

    #[test]
    fn fits_camera_matrix() {
        let j = [0.12, 0.01, -0.01, 0.12];
        let det = j[0] * j[3] - j[1] * j[2];
        let inv = [j[3] / det, -j[1] / det, -j[2] / det, j[0] / det];
        let du_of = |h: [f64; 2]| [inv[0] * h[0] + inv[1] * h[1], inv[2] * h[0] + inv[3] * h[1]];
        let (a, b) = (du_of([3.0, 0.0]), du_of([0.0, 3.0]));
        let got = fit_camera(&[a[0], a[1], b[0], b[1]], &[3.0, 0.0, 0.0, 3.0]).unwrap();
        for i in 0..4 {
            assert!((got[i] - j[i]).abs() < 1e-9, "coef {i}");
        }
    }
}
