import { taskInstructionTiming } from './task-schema'
import type { TaskRun } from './task-schema'
import type { TransitTrial } from './tasks'

export function taskCues(run: Pick<TaskRun, 'taskId' | 'timing'>) {
  const changes = run.taskId.endsWith('1') ? [] : [taskInstructionTiming.firstMs, taskInstructionTiming.secondMs]
  return [...changes.map((offsetMs) => ({ kind: 'change' as const, offsetMs })), { kind: 'finish' as const, offsetMs: run.timing.displayMs }]
}

/** Schedule on the audio clock once, independently of React renders and PC traffic. */
export class TaskAudio {
  private context: AudioContext | null = null
  private activeId: string | null = null
  private pending: { node: OscillatorNode; trial: TransitTrial; kind: 'change' | 'finish'; plannedAtMs: number; endAtMs: number }[] = []

  get ready(): boolean { return this.context?.state === 'running' }

  async prepare(): Promise<void> {
    this.context ??= new AudioContext()
    this.context.onstatechange = () => { if (!this.ready) this.cancel('cue-unavailable') }
    await this.context.resume()
    if (!this.ready) throw new Error('合図音を準備できませんでした。iPhoneで音の準備をやり直してください。')
    this.tone(this.context.currentTime, 'change')
    this.tone(this.context.currentTime + 0.4, 'finish')
  }

  private tone(at: number, kind: 'change' | 'finish') {
    const context = this.context!
    const node = context.createOscillator(), gain = context.createGain()
    const duration = kind === 'change' ? 0.12 : 0.35
    node.frequency.value = kind === 'change' ? 880 : 660
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.15, at + 0.01)
    gain.gain.setValueAtTime(0.15, at + duration - 0.02)
    gain.gain.linearRampToValueAtTime(0, at + duration)
    node.connect(gain); gain.connect(context.destination)
    node.onended = () => { node.disconnect(); gain.disconnect() }
    node.start(at); node.stop(at + duration)
    return { node, duration }
  }

  schedule(trial: TransitTrial): void {
    const run = trial.snapshot()
    if (run.phase !== 'viewing' || run.startedAtMs === null || this.activeId === run.id) return
    this.cancel()
    this.activeId = run.id
    const now = performance.now(), audioNow = this.context?.currentTime ?? 0
    for (const cue of taskCues(run)) {
      const plannedAtMs = run.startedAtMs + cue.offsetMs
      if (!this.ready || plannedAtMs < now) {
        trial.recordCue('cue-unavailable', cue.kind, plannedAtMs, now); continue
      }
      const at = audioNow + (plannedAtMs - now) / 1000
      try {
        const tone = this.tone(at, cue.kind)
        this.pending.push({ ...tone, trial, kind: cue.kind, plannedAtMs, endAtMs: plannedAtMs + tone.duration * 1000 })
        trial.recordCue('cue-scheduled', cue.kind, plannedAtMs, now, at)
      } catch { trial.recordCue('cue-unavailable', cue.kind, plannedAtMs, now) }
    }
  }

  cancel(type: 'cue-cancelled' | 'cue-unavailable' = 'cue-cancelled'): void {
    const now = performance.now()
    for (const cue of this.pending) if (cue.endAtMs > now) {
      cue.node.stop()
      cue.trial.recordCue(type, cue.kind, cue.plannedAtMs, now)
    }
    this.pending = []
    if (type === 'cue-cancelled') this.activeId = null
  }

  close(): void { this.cancel(); void this.context?.close().catch(() => {}); this.context = null }
}
