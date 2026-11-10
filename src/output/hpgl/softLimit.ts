// Carriage-axis soft limit for the HP-GL cutter: the camera bracket on the head sticks out
// sideways and would hit the frame past this travel. Machine mm; `null` limit = unlimited.
import type { GrblTape } from '../../core/pipeline/grblTape'
import type { Pt } from '../../core/wasm/registration'

/** The axis the head carriage moves along (the display shows it as Y). */
export const CARRIAGE_AXIS: 'x' | 'y' = 'y'

export function beyondSoftLimit(p: Pt, maxMm: number): boolean {
  return !(p[CARRIAGE_AXIS] <= maxMm) // fail closed: NaN refuses
}

export function tapeBeyondSoftLimit(tape: GrblTape, maxMm: number): boolean {
  const axis = tape[CARRIAGE_AXIS]
  for (let i = 0; i < tape.length; i++) if (!(axis[i] <= maxMm)) return true
  return false
}
