// Drive the HP-GL head (pen up) somewhere and keep it there. The cutter reports nothing back and
// reads a gap in the data as end-of-job (it drives home), so the hold command - a move to where
// the head already is - repeats every HPGL_HOLD_MS until `home()`, `stop()` or a write failure.
import { HPGL_HOLD_MS, hpglHoldCommand, hpglInitCommands } from '../../core/pipeline/emitHpgl'
import type { HpglProfile } from '../../core/types'
import type { Pt } from '../../core/wasm/registration'
import { beyondSoftLimit } from './softLimit'

export class SoftLimitError extends Error {}

export class HeadHold {
  private timer: ReturnType<typeof setInterval> | undefined
  private held: Pt | null = null

  /** `maxMm` = carriage-axis soft limit in machine mm, or null for none. */
  constructor(
    private link: { write(d: string): Promise<void> },
    private profile: HpglProfile,
    private maxMm: number | null,
  ) {}

  /** The held position, or null when not holding. */
  get at(): Pt | null {
    return this.held
  }

  /** Move to `p` (machine mm) and hold there. The first move of a hold also sends the init. */
  async moveTo(p: Pt): Promise<void> {
    if (this.maxMm !== null && beyondSoftLimit(p, this.maxMm)) {
      throw new SoftLimitError(`Beyond the carriage limit of ${this.maxMm} mm`)
    }
    const cmd = hpglHoldCommand(p.x, p.y)
    const first = this.held === null
    clearInterval(this.timer)
    try {
      await this.link.write(first ? hpglInitCommands(this.profile).join('') + 'PU;' + cmd : cmd)
    } catch (e) {
      this.stop()
      throw e
    }
    this.held = p
    this.timer = setInterval(() => this.link.write(cmd).catch(() => this.stop()), HPGL_HOLD_MS)
  }

  async home(): Promise<void> {
    this.stop()
    await this.link.write('PU;PU0,0;')
  }

  /** Stop holding without sending anything (the link is gone). */
  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.held = null
  }
}
