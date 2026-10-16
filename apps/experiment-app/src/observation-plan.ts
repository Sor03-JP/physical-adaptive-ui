import { taskInstructionTiming } from './task-schema'
import type { TaskRun } from './task-schema'
import type { ObservationProtocol } from './research-log'

export const currentObservationProtocol: ObservationProtocol = {
  method: 'state-confirmation', instructionTiming: { ...taskInstructionTiming },
}
export const movementLabels = { stationary: '静止', walking: '歩行', running: '軽いジョギング' }
type Movement = keyof typeof movementLabels

/** Planned cues only; never turn this schedule into observed states or actual instruction events. */
export function observationGuide(run: TaskRun | null, elapsedMs: number) {
  if (!run || run.purpose === 'practice' || ['complete', 'aborted'].includes(run.phase)) return null
  const initial: Movement = run.taskId.endsWith('3') ? 'walking' : 'stationary'
  const { firstMs, secondMs } = currentObservationProtocol.instructionTiming
  const steps: { atMs: number; state: Movement }[] = [{ atMs: 0, state: initial }]
  if (run.taskId.endsWith('2')) steps.push({ atMs: firstMs, state: 'walking' }, { atMs: secondMs, state: 'stationary' })
  if (run.taskId.endsWith('3')) steps.push({ atMs: firstMs, state: 'running' }, { atMs: secondMs, state: 'walking' }, { atMs: run.timing.displayMs, state: 'stationary' })
  if (run.phase === 'waiting-stop' || run.phase === 'answering') return { state: 'stationary' as const, next: null, elapsedMs: null }
  const elapsed = run.phase === 'viewing' ? Math.max(0, elapsedMs) : 0
  const current = steps.findLast((step) => step.atMs <= elapsed) ?? steps[0]!
  const next = steps.find((step) => step.atMs > elapsed) ?? null
  return { state: current.state, next, elapsedMs: run.phase === 'viewing' ? elapsed : null }
}
