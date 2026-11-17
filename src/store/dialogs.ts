// App-styled replacements for the browser's native popups. Call sites stay as terse as
// `window.confirm`/`prompt` but async:
//
//   if (await confirmDialog({ title: 'Delete tool', message: '…', danger: true })) …
//   const name = await promptDialog({ title: 'Rename tool', initial: t.name })
//
// The pending request lives here; ui/DialogHost.tsx (mounted once in App) renders it as a Modal.
// Requests queue FIFO so overlapping calls can't clobber each other. Native alert/confirm/prompt
// are banned (see CLAUDE.md): notifications go through store/toast instead.
import { create } from 'zustand'
import { laserLive, type MachineProfile } from '../core/types'

export type DialogRequest = { id: number } & (
  | {
      kind: 'confirm'
      title: string
      message: string
      confirmLabel: string
      /** Destructive action → the confirm button uses the danger style. */
      danger: boolean
      /** Physical hazard (live laser) → the message renders as a big red warning block. */
      alarm: boolean
      resolve: (ok: boolean) => void
    }
  | {
      kind: 'prompt'
      title: string
      /** Optional explanatory line above the input. */
      message?: string
      initial: string
      confirmLabel: string
      resolve: (value: string | null) => void
    }
)

interface DialogStore {
  /** The request currently shown (head of the queue), or null. */
  current: DialogRequest | null
  queue: DialogRequest[]
  _push: (r: DialogRequest) => void
  /** Settle the current dialog and show the next queued one. */
  _next: () => void
}

let dialogSeq = 0

export const useDialogs = create<DialogStore>((set) => ({
  current: null,
  queue: [],
  _push: (r) =>
    set((s) => (s.current ? { queue: [...s.queue, r] } : { current: r })),
  _next: () => set((s) => ({ current: s.queue[0] ?? null, queue: s.queue.slice(1) })),
}))

export function confirmDialog(opts: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  alarm?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.getState()._push({
      id: ++dialogSeq,
      kind: 'confirm',
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? 'OK',
      danger: opts.danger ?? opts.alarm ?? false,
      alarm: opts.alarm ?? false,
      resolve,
    })
  })
}

/** Resolves to the entered (trimmed) text, or null when cancelled / left empty. */
export function promptDialog(opts: {
  title: string
  message?: string
  initial?: string
  confirmLabel?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState()._push({
      id: ++dialogSeq,
      kind: 'prompt',
      title: opts.title,
      message: opts.message,
      initial: opts.initial ?? '',
      confirmLabel: opts.confirmLabel ?? 'Save',
      resolve,
    })
  })
}

/** Gate for anything that may fire a laser (stream, download, pen test). Resolves true straight
 *  away for non-laser profiles and dry runs; otherwise the operator must confirm a red warning. */
export function confirmLaser(profile: MachineProfile, action: string): Promise<boolean> {
  if (!laserLive(profile)) return Promise.resolve(true)
  return confirmDialog({
    title: 'LASER WILL FIRE',
    message:
      `${action} switches the laser ON. Everyone in the room wears laser safety goggles, ` +
      'the material is safe to laser (no PVC, no vinyl), extraction is running, ' +
      'and someone stays at the machine with a hand on the power switch until it finishes.',
    confirmLabel: 'Laser on - I am at the machine',
    alarm: true,
  })
}
