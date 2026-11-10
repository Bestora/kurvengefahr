// Per-browser camera rig: describes this physical cutter + camera holder (camera URL, soft limit,
// px->mm calibration, knife offset, mark layout, last found marks / affine). Deliberately NOT in the
// document or machine profile — documents are undoable, exported and shared; the rig is not.
// Persisted to localStorage under one key; the loader never throws (Outcome + per-field sanitizing).
import { create } from 'zustand'
import { PROXIES_AT_HOME_MARKS, type MarkLayout } from '../core/registration'
import type { Affine, CamMatrix, Pt } from '../core/wasm/registration'
import type { Outcome } from './persistence/schema'

export const CAMERA_RIG_KEY = 'kg-camera-rig'
export const CURRENT_RIG_SCHEMA = 1

/** px->mm calibration; only valid for this image size. */
export interface CamCal {
  m: CamMatrix
  w: number
  h: number
}

export interface CameraRig {
  /** '' = feature off. */
  url: string
  softLimitMm: number
  cam: CamCal | null
  /** mm, added to every cut point. */
  knifeOffset: Pt
  marks: MarkLayout
  /** Machine-mm mark positions of the last sheet. */
  lastMarks: MarkLayout | null
  lastAffine: Affine | null
}

const DEFAULTS: CameraRig = {
  url: '',
  softLimitMm: 490.75,
  cam: null,
  knifeOffset: { x: 0, y: 0 },
  marks: PROXIES_AT_HOME_MARKS,
  lastMarks: null,
  lastAffine: null,
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const posInt = (v: unknown): v is number => fin(v) && Number.isInteger(v) && v > 0
const finArr = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(fin)

const pt = (v: unknown): Pt | null => (isObj(v) && fin(v.x) && fin(v.y) ? { x: v.x, y: v.y } : null)

function layout(v: unknown): MarkLayout | null {
  if (!isObj(v)) return null
  const square = pt(v.square)
  const topRight = pt(v.topRight)
  const bottomLeft = pt(v.bottomLeft)
  return square && topRight && bottomLeft ? { square, topRight, bottomLeft } : null
}

function camCal(v: unknown): CamCal | null {
  return isObj(v) && finArr(v.m, 4) && posInt(v.w) && posInt(v.h)
    ? { m: [v.m[0], v.m[1], v.m[2], v.m[3]], w: v.w, h: v.h }
    : null
}

export function loadRig(raw: unknown): Outcome<CameraRig> {
  if (!isObj(raw)) return { status: 'invalid', message: 'Camera rig settings are not an object.' }
  const version = fin(raw.schemaVersion) ? raw.schemaVersion : 1
  if (version > CURRENT_RIG_SCHEMA) {
    return { status: 'unsupported', message: `Camera rig settings use schema ${version}, newer than ${CURRENT_RIG_SCHEMA}.` }
  }
  return {
    status: 'ok',
    value: {
      url: typeof raw.url === 'string' ? raw.url : DEFAULTS.url,
      softLimitMm: fin(raw.softLimitMm) ? raw.softLimitMm : DEFAULTS.softLimitMm,
      cam: camCal(raw.cam),
      knifeOffset: pt(raw.knifeOffset) ?? DEFAULTS.knifeOffset,
      marks: layout(raw.marks) ?? DEFAULTS.marks,
      lastMarks: layout(raw.lastMarks),
      lastAffine: finArr(raw.lastAffine, 6) ? (raw.lastAffine as Affine) : null,
    },
  }
}

const read = (): CameraRig => {
  try {
    const s = localStorage.getItem(CAMERA_RIG_KEY)
    if (s) {
      const o = loadRig(JSON.parse(s))
      if (o.status === 'ok') return o.value
    }
  } catch {
    // ignore (no/blocked storage, bad JSON) - fall back to defaults
  }
  return DEFAULTS
}

export const useCameraRig = create<CameraRig & { patch(p: Partial<CameraRig>): void }>((set, get) => ({
  ...read(),
  patch: (p) => {
    const { patch: _patch, ...rig } = { ...get(), ...p }
    try {
      localStorage.setItem(CAMERA_RIG_KEY, JSON.stringify({ schemaVersion: CURRENT_RIG_SCHEMA, ...rig }))
    } catch {
      // ignore - setting still applies for this session
    }
    set(p)
  },
}))
