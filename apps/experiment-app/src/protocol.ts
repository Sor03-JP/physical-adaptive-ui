import { z } from 'zod'
import { clockReplySchema } from './research-log'
import { experimentModeSchema } from './adaptation'
import { BATCH_SIZE, MAX_SAMPLES, metadataSchema, sampleSchema, completionSchema } from './recording-schema'
import { estimateSchema, estimationConfigSchema } from './estimation'
import { taskIdSchema, taskRunSchema } from './task-schema'

export const joinSchema = z.strictObject({
  room: z.string().regex(/^[a-z0-9-]{1,40}$/), role: z.enum(['controller', 'sensor']),
})
export type Identity = z.infer<typeof joinSchema>
export const messageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('clock-probe'), sessionId: z.string().min(1), probeId: z.string().min(1) }),
  clockReplySchema,
  z.strictObject({ type: z.literal('start'), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal('stop'), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal('clear'), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal('pull'), sessionId: z.string().min(1), startIndex: z.int().min(0).max(MAX_SAMPLES) }),
  z.strictObject({ type: z.literal('pull-estimates'), sessionId: z.string().min(1), startIndex: z.int().min(0).max(MAX_SAMPLES) }),
  z.strictObject({ type: z.literal('task-start'), sessionId: z.string().min(1), runId: z.string().min(1), taskId: taskIdSchema, mode: experimentModeSchema.default('normal') }),
  z.strictObject({ type: z.literal('task-begin'), sessionId: z.string().min(1), runId: z.string().min(1) }),
  z.strictObject({ type: z.literal('task-answer'), sessionId: z.string().min(1), runId: z.string().min(1) }),
  z.strictObject({
    type: z.literal('status'), ready: z.boolean(), streaming: z.boolean(), visible: z.boolean(), error: z.string(),
    permission: z.enum(['prompt', 'granted', 'denied']),
    receivedEventCount: z.int().nonnegative(), validEventCount: z.int().nonnegative(),
    metadata: metadataSchema.nullable(), completion: completionSchema.nullable(), taskRun: taskRunSchema.nullable(),
    estimationConfig: estimationConfigSchema.nullable(), estimateCount: z.int().min(0).max(MAX_SAMPLES), latestEstimate: estimateSchema.nullable(),
    count: z.int().min(0).max(MAX_SAMPLES), completeAccelerationCount: z.int().min(0).max(MAX_SAMPLES),
    latest: sampleSchema.nullable(), elapsedMs: z.number().finite().nonnegative(),
    sinceLastSampleMs: z.number().finite().nonnegative().nullable(),
  }),
  z.strictObject({ type: z.literal('batch'), sessionId: z.string().min(1),
    startIndex: z.int().min(0).max(MAX_SAMPLES), samples: z.array(sampleSchema).max(BATCH_SIZE) }),
  z.strictObject({ type: z.literal('estimates'), sessionId: z.string().min(1),
    startIndex: z.int().min(0).max(MAX_SAMPLES), estimates: z.array(estimateSchema).max(BATCH_SIZE) }),
])
export type Message = z.infer<typeof messageSchema>
export type PhoneStatus = Extract<Message, { type: 'status' }>
export const presenceSchema = z.strictObject({
  controller: z.boolean(), sensor: z.boolean(), sensorUrls: z.array(z.string()), error: z.string(),
})
export type Presence = z.infer<typeof presenceSchema>
