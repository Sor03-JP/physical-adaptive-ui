import { z } from 'zod'
import { managementSchema, participantSchema, nextStep } from './management'
import { taskRunSchema } from './task-schema'
import { surveyListSchema } from './questionnaire'
import type { Transfer } from './transfer'

export const continuationSchema = z.strictObject({
  previousSessionId: z.string().min(1), previousSessionIds: z.array(z.string().min(1)).min(1).max(20),
  participant: participantSchema, controllerTimeOriginMs: z.number().finite().nonnegative(),
  reason: z.string().trim().min(1).max(1000), confirmedAtControllerMs: z.number().finite().nonnegative(),
  resumeRunId: z.string().min(1).nullable(),
  tasks: z.array(taskRunSchema).max(100), questionnaires: surveyListSchema, management: managementSchema,
}).superRefine((c, ctx) => {
  if (new Set(c.previousSessionIds).size !== c.previousSessionIds.length || c.previousSessionIds.at(-1) !== c.previousSessionId
    || new Set(c.tasks.map((t) => t.id)).size !== c.tasks.length
    || c.tasks.some((t) => !c.previousSessionIds.includes(t.sessionId))
    || c.questionnaires.some((s) => s.phase !== 'submitted' || !c.previousSessionIds.includes(s.sessionId))
    || JSON.stringify(c.participant) !== JSON.stringify(c.management.participant)
    || (c.resumeRunId !== null && !c.management.retries.some((r) => r.retryRunId === c.resumeRunId)))
    ctx.addIssue({ code: 'custom', message: '同じ参加者の続行記録の対応が不整合です。' })
})
export type Continuation = z.infer<typeof continuationSchema>
export const continuationIntentSchema = z.strictObject({
  sessionId: z.string().min(1), context: continuationSchema,
})
export type ContinuationIntent = z.infer<typeof continuationIntentSchema>

/** Retain original tasks and answers; only unfinished work becomes the next attempt. */
export function prepareContinuation(data: Transfer, reason: string, now: number, newRunId: string): Continuation {
  if (!data.management.participant || (!data.complete && !data.recovery)) throw new Error('停止後のデータ回収を確認してから再開してください。')
  const tasks = [...(data.continuation?.tasks ?? []), ...data.tasks]
  const questionnaires = [...(data.continuation?.questionnaires ?? []), ...data.questionnaires.filter((s) => s.phase === 'submitted')]
  const management = structuredClone(data.management)
  const latest = data.tasks.at(-1)
  const interrupted = latest?.purpose === 'main' && latest.phase !== 'complete' ? latest : null
  let resumeRunId = data.continuation?.resumeRunId ?? null
  if (interrupted) {
    if (management.retries.some((r) => r.retryRunId === interrupted.id)) throw new Error('この課題は再実施済みです。再実施の再実施はできません。元の記録を保存して扱いを確認してください。')
    let failure = management.failures.find((f) => f.originalRunId === interrupted.id)
    if (!failure) {
      failure = { originalRunId: interrupted.id, category: 'app-stopped', reason, recordedAtControllerMs: now }
      management.failures.push(failure)
    }
    let retry = management.retries.find((r) => r.originalRunId === interrupted.id)
    if (!retry) {
      retry = { ...failure, retryRunId: newRunId, consentConfirmed: true, requestedAtControllerMs: now }
      management.retries.push(retry)
    }
    resumeRunId = retry.retryRunId
  }
  // A pending intent already consumed by a completed attempt must not be used again.
  if (resumeRunId && tasks.some((t) => t.id === resumeRunId)) resumeRunId = null
  const context = continuationSchema.parse({
    previousSessionId: data.metadata.sessionId,
    previousSessionIds: [...(data.continuation?.previousSessionIds ?? []), data.metadata.sessionId],
    participant: data.management.participant, controllerTimeOriginMs: data.controllerTimeOriginMs,
    reason, confirmedAtControllerMs: now, resumeRunId, tasks, questionnaires, management,
  })
  if (nextStep(context.participant, tasks.filter((t) => t.purpose !== 'practice' || t.phase === 'complete'), questionnaires, management).kind === 'done') throw new Error('全課題が終了しています。データを保存して次の参加者へ進んでください。')
  return context
}
