import { z } from 'zod'
import type { TaskRun } from './task-schema'

export const movementSegments = { '0-4s': '開始〜4秒', '4-11s': '4〜11秒', '11-15s': '11〜15秒', all: '全体' } as const
export const movementConfirmationSchema = z.strictObject({
  taskRunId: z.string().min(1),
  status: z.enum(['as-planned', 'deviation']),
  confirmedAtControllerMs: z.number().finite().nonnegative(),
  deviations: z.array(z.strictObject({
    segments: z.array(z.enum(['0-4s', '4-11s', '11-15s', 'all'])).min(1).max(3)
      .refine((segments) => new Set(segments).size === segments.length && (!segments.includes('all') || segments.length === 1)),
    comment: z.string().trim().min(1).max(1000),
  })).max(1),
}).refine((entry) => entry.deviations.length === (entry.status === 'deviation' ? 1 : 0), 'ずれありの場合は区間と内容を記録してください。')
export type MovementConfirmation = z.infer<typeof movementConfirmationSchema>
export type MovementConfirmationInput = Omit<MovementConfirmation, 'confirmedAtControllerMs'>

export function latestMovementConfirmation(history: readonly MovementConfirmation[], taskRunId: string) {
  return history.findLast((entry) => entry.taskRunId === taskRunId)
}
export function pendingMovementConfirmations(tasks: readonly TaskRun[], history: readonly MovementConfirmation[]) {
  return tasks.filter((task) => task.purpose === 'main' && task.phase === 'complete' && !latestMovementConfirmation(history, task.id))
}
export function validMovementConfirmation(entry: MovementConfirmation, tasks: readonly TaskRun[]) {
  const task = tasks.find((task) => task.id === entry.taskRunId)
  return !!task && task.purpose === 'main' && task.phase === 'complete'
    && (!task.taskId.endsWith('1') || entry.deviations.every((deviation) => deviation.segments.length === 1 && deviation.segments[0] === 'all'))
}
