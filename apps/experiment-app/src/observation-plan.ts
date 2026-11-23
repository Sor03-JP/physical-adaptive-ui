import { instructionTimingFor, taskInstructionTiming, taskTiming } from './task-schema'
import type { TaskRun, TrialTaskId } from './task-schema'
import type { ObservationProtocol } from './research-log'

export const currentObservationProtocol: ObservationProtocol = {
  method: 'post-task-confirmation', instructionTiming: { ...taskInstructionTiming },
}
export const movementLabels = { stationary: '静止', walking: '歩行', running: '軽いジョギング' }
type Movement = keyof typeof movementLabels

export function movementPlan(taskId: TrialTaskId, displayMs: number): { atMs: number; state: Movement }[] {
  const { firstMs, secondMs } = instructionTimingFor(displayMs)
  if (taskId.endsWith('2')) return [{ atMs: 0, state: 'stationary' }, { atMs: firstMs, state: 'walking' }, { atMs: secondMs, state: 'stationary' }]
  if (taskId.endsWith('3')) return [{ atMs: 0, state: 'walking' }, { atMs: firstMs, state: 'running' },
    { atMs: secondMs, state: 'walking' }, { atMs: displayMs, state: 'stationary' }]
  return [{ atMs: 0, state: 'stationary' }]
}

export function movementPlanText(taskId: TrialTaskId, displayMs: number = taskTiming.displayMs): string {
  const steps = movementPlan(taskId, displayMs)
  if (steps.length === 1) return `${displayMs / 1000}秒間、静止を維持`
  return steps.map(({ atMs, state }) => atMs === 0 ? `${movementLabels[state]}で開始`
    : `${atMs / 1000}秒で${state === 'stationary' ? '停止' : movementLabels[state]}`).join(' → ')
}

/** Planned cues only; never turn this schedule into observed states or actual instruction events. */
export function observationGuide(run: TaskRun | null, elapsedMs: number) {
  if (!run || run.purpose === 'practice' || ['complete', 'aborted'].includes(run.phase)) return null
  const steps = movementPlan(run.taskId, run.timing.displayMs)
  if (run.phase === 'waiting-stop' || run.phase === 'answering') return { state: 'stationary' as const, next: null, elapsedMs: null }
  const elapsed = run.phase === 'viewing' ? Math.max(0, elapsedMs) : 0
  const current = steps.findLast((step) => step.atMs <= elapsed) ?? steps[0]!
  const next = steps.find((step) => step.atMs > elapsed) ?? null
  return { state: current.state, next, elapsedMs: run.phase === 'viewing' ? elapsed : null }
}
