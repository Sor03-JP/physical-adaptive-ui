import { z } from 'zod'
import { phoneMovementConfirmationSchema, validMovementConfirmation } from './movement-confirmation'
import { nextStep, emptyManagement } from './management'
import type { Participant } from './management'
import type { TaskRun } from './task-schema'
import type { SurveyRun } from './questionnaire'
import type { Continuation } from './continuation'

const time = z.number().finite().nonnegative()
export const phoneFlowSchema = z.strictObject({
  version: z.literal(1), sessionId: z.string().min(1), stage: z.enum(['consent', 'tutorial', 'experiment', 'transfer']),
  syncedAtMs: time.nullable(), consentedAtMs: time.nullable(), tutorialPage: z.int().min(0).max(2),
  previousSessionId: z.string().min(1).nullable(), restartReason: z.string().trim().min(1).max(1000).nullable(),
  confirmations: z.array(phoneMovementConfirmationSchema).max(1000),
  preparationInterruptions: z.array(time).max(100),
}).superRefine((flow, ctx) => {
  if ((flow.stage !== 'consent' && (flow.syncedAtMs === null || flow.consentedAtMs === null))
    || (flow.stage === 'consent' && flow.consentedAtMs !== null)
    || (flow.consentedAtMs !== null && (flow.syncedAtMs === null || flow.consentedAtMs < flow.syncedAtMs))
    || (flow.previousSessionId === null) !== (flow.restartReason === null)
    || flow.previousSessionId === flow.sessionId
    || flow.confirmations.some((entry, index) => entry.confirmedAtPhoneMs < (flow.confirmations[index - 1]?.confirmedAtPhoneMs ?? 0)))
    ctx.addIssue({ code: 'custom', message: '端末内の進行・同意・やり直しの記録が不整合です。' })
})
export type PhoneFlow = z.infer<typeof phoneFlowSchema>
export function createPhoneFlow(sessionId: string, previousSessionId: string | null = null, restartReason: string | null = null): PhoneFlow {
  return phoneFlowSchema.parse({ version: 1, sessionId, stage: 'consent', syncedAtMs: null, consentedAtMs: null,
    tutorialPage: 0, previousSessionId, restartReason, confirmations: [], preparationInterruptions: [] })
}
export function validPhoneFlow(flow: PhoneFlow, sessionId: string, tasks: readonly TaskRun[], startAtMs = 0, endAtMs = Infinity) {
  const times = [flow.syncedAtMs, flow.consentedAtMs, ...flow.preparationInterruptions, ...flow.confirmations.map((entry) => entry.confirmedAtPhoneMs)]
  return flow.sessionId === sessionId && times.every((at) => at === null || (at >= startAtMs && at <= endAtMs))
    && flow.confirmations.every((entry) => validMovementConfirmation(entry, tasks)
      && entry.confirmedAtPhoneMs >= tasks.find((task) => task.id === entry.taskRunId)!.endedAtMs!)
}
export function phoneNextStep(participant: Participant, tasks: readonly TaskRun[], surveys: readonly SurveyRun[], flow: PhoneFlow, continuation?: Continuation) {
  const pending = tasks.find((task) => task.purpose === 'main' && task.phase === 'complete'
    && !flow.confirmations.some((entry) => entry.taskRunId === task.id))
  if (pending) return { kind: 'confirmation' as const, task: pending }
  const previousTasks = continuation?.tasks.filter((task) => task.purpose !== 'practice' || task.phase === 'complete') ?? []
  return nextStep(participant, [...previousTasks, ...tasks], [...(continuation?.questionnaires ?? []), ...surveys], continuation?.management ?? emptyManagement())
}
