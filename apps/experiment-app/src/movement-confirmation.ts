import { z } from 'zod'
import { previousTaskTiming } from './task-schema'
import type { TaskRun } from './task-schema'

export const movementSegments = {
  '0-4s': '開始〜4秒', '4-11s': '4〜11秒', '11-15s': '11〜15秒', '4-14s': '4〜14秒', '14-18s': '14〜18秒', all: '全体',
} as const
type MovementSegment = keyof typeof movementSegments
const movementSegmentKeys = Object.keys(movementSegments) as MovementSegment[]
export const movementConfirmationInputSchema = z.strictObject({
  taskRunId: z.string().min(1),
  status: z.enum(['as-planned', 'deviation']),
  deviations: z.array(z.strictObject({
    segments: z.array(z.enum(movementSegmentKeys)).min(1).max(3)
      .refine((segments) => new Set(segments).size === segments.length && (!segments.includes('all') || segments.length === 1)),
    comment: z.string().trim().min(1).max(1000),
  })).max(1),
}).refine((entry) => entry.deviations.length === (entry.status === 'deviation' ? 1 : 0), 'ずれありの場合は区間と内容を記録してください。')
export const movementConfirmationSchema = movementConfirmationInputSchema.safeExtend({ confirmedAtControllerMs: z.number().finite().nonnegative() })
export const phoneMovementConfirmationSchema = movementConfirmationInputSchema.safeExtend({ confirmedAtPhoneMs: z.number().finite().nonnegative() })
export type MovementConfirmation = z.infer<typeof movementConfirmationSchema>
export type MovementConfirmationInput = z.infer<typeof movementConfirmationInputSchema>

export function movementSegmentsFor(task: Pick<TaskRun, 'taskId' | 'timing'>): readonly MovementSegment[] {
  if (task.taskId.endsWith('1')) return ['all']
  return task.timing.displayMs === previousTaskTiming.displayMs ? ['0-4s', '4-11s', '11-15s', 'all'] : ['0-4s', '4-14s', '14-18s', 'all']
}

export function latestMovementConfirmation<T extends MovementConfirmationInput>(history: readonly T[], taskRunId: string) {
  return history.findLast((entry) => entry.taskRunId === taskRunId)
}
export function pendingMovementConfirmations(tasks: readonly TaskRun[], history: readonly MovementConfirmationInput[]) {
  return tasks.filter((task) => task.purpose === 'main' && task.phase === 'complete' && !latestMovementConfirmation(history, task.id))
}
export function validMovementConfirmation(entry: MovementConfirmationInput, tasks: readonly TaskRun[]) {
  const task = tasks.find((task) => task.id === entry.taskRunId)
  if (!task || task.purpose !== 'main' || task.phase !== 'complete') return false
  const segments = movementSegmentsFor(task)
  return entry.deviations.every((deviation) => deviation.segments.every((segment) => segments.includes(segment)))
}
