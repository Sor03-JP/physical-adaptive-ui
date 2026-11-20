import { z } from 'zod'
import { participantSchema } from './management'
import { metadataSchema, completionSchema, sampleSchema, MAX_SAMPLES, hasValidSampleTimes, hasConsistentReceivedIntervals } from './recording-schema'
import { estimateSchema, estimationConfigSchema, hasValidEstimateTimes } from './estimation'
import { taskRunSchema } from './task-schema'
import { surveyListSchema, validSurveyLinks } from './questionnaire'
import type { LoadedCheckpoint } from './checkpoint'
import { continuationSchema } from './continuation'
import { phoneFlowSchema, phoneNextStep, validPhoneFlow } from './phone-flow'

export const phoneArchiveSchema = z.strictObject({
  format: z.literal('physical-adaptive-phone-checkpoint'), version: z.literal(1),
  metadata: metadataSchema, participant: participantSchema.nullable(), completion: completionSchema.nullable(),
  config: estimationConfigSchema.nullable(), savedThroughMs: z.number().finite().nonnegative(),
  tasks: z.array(taskRunSchema).max(100), questionnaires: surveyListSchema,
  continuation: continuationSchema.optional(),
  phoneFlow: phoneFlowSchema.optional(),
  samples: z.array(sampleSchema).max(MAX_SAMPLES), estimates: z.array(estimateSchema).max(MAX_SAMPLES),
}).superRefine((data, ctx) => {
  if (data.savedThroughMs < data.metadata.startedAtMs
    || !hasValidSampleTimes(data.samples, data.metadata.startedAtMs, data.savedThroughMs)
    || !hasConsistentReceivedIntervals(data.samples)
    || !hasValidEstimateTimes(data.estimates, data.metadata.startedAtMs, data.savedThroughMs)
    || (data.completion !== null && (data.completion.endedAtMs > data.savedThroughMs
      || !hasValidSampleTimes(data.samples, data.metadata.startedAtMs, data.completion.endedAtMs)
      || !hasValidEstimateTimes(data.estimates, data.metadata.startedAtMs, data.completion.endedAtMs)))
    || (data.config === null && data.estimates.length > 0)
    || new Set(data.tasks.map((t) => t.id)).size !== data.tasks.length
    || data.tasks.some((t) => t.sessionId !== data.metadata.sessionId || t.requestedAtMs < data.metadata.startedAtMs)
    || data.questionnaires.some((s) => s.sessionId !== data.metadata.sessionId || !validSurveyLinks(s,
      [...(data.continuation?.questionnaires ?? []), ...data.questionnaires], [...(data.continuation?.tasks ?? []), ...data.tasks], data.continuation?.previousSessionIds))
    || (data.continuation && JSON.stringify(data.continuation.participant) !== JSON.stringify(data.participant))
    || (data.phoneFlow && (!data.participant || !validPhoneFlow(data.phoneFlow, data.metadata.sessionId, data.tasks, data.metadata.startedAtMs, data.completion?.endedAtMs ?? data.savedThroughMs)
      || (data.phoneFlow.stage === 'transfer' && (!data.completion || phoneNextStep(data.participant, data.tasks, data.questionnaires, data.phoneFlow).kind !== 'done')))))
    ctx.addIssue({ code: 'custom', message: 'iPhone保存データの時刻・計測IDが不整合です。' })
})
export type PhoneArchive = z.infer<typeof phoneArchiveSchema>
export function readPhoneCheckpoint(saved: LoadedCheckpoint): PhoneArchive {
  return phoneArchiveSchema.parse({ ...(saved.header as object), samples: saved.samples, estimates: saved.estimates })
}

/** Compare phone-owned data only; PC receipt times and local save times differ. */
export async function phoneArchiveDigest(archive: PhoneArchive): Promise<string> {
  const { savedThroughMs: _savedThroughMs, ...content } = phoneArchiveSchema.parse(archive)
  content.tasks.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  const bytes = new TextEncoder().encode(JSON.stringify(content))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
