import { z } from 'zod'
import type { MotionSample } from '@physical-adaptive/device-motion'

// Memory/file guards for this measurement tool, not experiment duration settings.
export const MAX_SAMPLES = 30_000
export const BATCH_SIZE = 100
export const MAX_FILE_BYTES = 20 * 1024 * 1024
const finite = z.number().finite()
const nullable = finite.nullable()
const vector = z.strictObject({ x: nullable, y: nullable, z: nullable }).nullable()
const sampleFields = {
  receivedAtMs: finite.nonnegative(), eventTimestampMs: nullable,
  acceleration: vector, accelerationIncludingGravity: vector,
  rotationRate: z.strictObject({ alpha: nullable, beta: nullable, gamma: nullable }).nullable(),
}
export const sampleSchema = z.strictObject({ ...sampleFields,
  reportedIntervalRaw: nullable, receivedIntervalMs: finite.nonnegative().nullable(),
}) satisfies z.ZodType<MotionSample>
// v1 stored the unconverted API value under the misleading name intervalMs.
export const legacySampleSchema = z.strictObject({ ...sampleFields, intervalMs: nullable })
export type ReadableMotionSample = MotionSample | z.infer<typeof legacySampleSchema>

export function hasConsistentReceivedIntervals(samples: readonly MotionSample[], previous?: MotionSample): boolean {
  return samples.every((sample) => {
    const valid = sample.receivedIntervalMs === (previous ? sample.receivedAtMs - previous.receivedAtMs : null)
    previous = sample
    return valid
  })
}

export function hasValidSampleTimes(samples: readonly Pick<MotionSample, 'receivedAtMs'>[], startedAtMs: number, endedAtMs?: number): boolean {
  if (endedAtMs !== undefined && endedAtMs < startedAtMs) return false
  let previous = startedAtMs
  return samples.every((sample) => {
    const valid = sample.receivedAtMs >= previous && (endedAtMs === undefined || sample.receivedAtMs <= endedAtMs)
    previous = sample.receivedAtMs
    return valid
  })
}

export const metadataSchema = z.strictObject({
  sessionId: z.string().min(1), startedAt: z.string().datetime(),
  timeOriginMs: finite.nonnegative(), startedAtMs: finite.nonnegative(), userAgent: z.string(),
})

export const completionSchema = z.strictObject({
  endedAtMs: finite.nonnegative(), stopReason: z.enum(['manual', 'page-hidden', 'capacity', 'recovered-after-reload']),
})

const currentRecordingBase = metadataSchema.extend({
  ...completionSchema.shape,
  format: z.literal('physical-adaptive-motion-measurement'), version: z.literal(2),
  clock: z.literal('device-local-performance'), samples: z.array(sampleSchema).max(MAX_SAMPLES),
})
const legacyRecordingBase = currentRecordingBase.extend({
  version: z.literal(1), samples: z.array(legacySampleSchema).max(MAX_SAMPLES),
})
function validateRecording(value: z.infer<typeof currentRecordingBase> | z.infer<typeof legacyRecordingBase>, context: z.RefinementCtx) {
  if (!hasValidSampleTimes(value.samples, value.startedAtMs, value.endedAtMs)) {
    context.addIssue({ code: 'custom', message: 'サンプル時刻または記録区間が不整合です。' })
  }
  if (value.version === 2 && !hasConsistentReceivedIntervals(value.samples)) {
    context.addIssue({ code: 'custom', message: '実受信間隔と受信時刻差が一致しません。' })
  }
}
const readableRecordingSchema = z.discriminatedUnion('version', [currentRecordingBase, legacyRecordingBase])
  .superRefine(validateRecording)

export type Recording = z.infer<typeof currentRecordingBase>
export type ReadableRecording = z.infer<typeof readableRecordingSchema>
export type RecordingMetadata = z.infer<typeof metadataSchema>
export type Completion = z.infer<typeof completionSchema>
export type StopReason = Completion['stopReason']

export function hasCompleteAcceleration(sample: MotionSample): boolean {
  return [sample.acceleration, sample.accelerationIncludingGravity].some(
    (value) => value !== null && value.x !== null && value.y !== null && value.z !== null,
  )
}


export function readRecording(text: string): ReadableRecording {
  return readableRecordingSchema.parse(JSON.parse(text))
}

export function writeRecording(recording: ReadableRecording): string {
  return JSON.stringify(readableRecordingSchema.parse(recording))
}
