import { z } from 'zod'
import { BATCH_SIZE, MAX_SAMPLES, metadataSchema, sampleSchema, completionSchema } from './recording'

export const joinSchema = z.strictObject({
  room: z.string().regex(/^[a-z0-9-]{1,40}$/), role: z.enum(['controller', 'sensor']),
})
export type Identity = z.infer<typeof joinSchema>
export const messageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('start'), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal('stop'), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal('clear'), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal('pull'), sessionId: z.string().min(1), startIndex: z.int().min(0).max(MAX_SAMPLES) }),
  z.strictObject({
    type: z.literal('status'), ready: z.boolean(), streaming: z.boolean(), visible: z.boolean(), error: z.string(),
    permission: z.enum(['prompt', 'granted', 'denied']),
    receivedEventCount: z.int().nonnegative(), validEventCount: z.int().nonnegative(),
    metadata: metadataSchema.nullable(), completion: completionSchema.nullable(),
    count: z.int().min(0).max(MAX_SAMPLES), completeAccelerationCount: z.int().min(0).max(MAX_SAMPLES),
    latest: sampleSchema.nullable(), elapsedMs: z.number().finite().nonnegative(),
    sinceLastSampleMs: z.number().finite().nonnegative().nullable(),
  }),
  z.strictObject({ type: z.literal('batch'), sessionId: z.string().min(1),
    startIndex: z.int().min(0).max(MAX_SAMPLES), samples: z.array(sampleSchema).max(BATCH_SIZE) }),
])
export type Message = z.infer<typeof messageSchema>
export type PhoneStatus = Extract<Message, { type: 'status' }>
export const presenceSchema = z.strictObject({
  controller: z.boolean(), sensor: z.boolean(), sensorUrls: z.array(z.string()), error: z.string(),
})
export type Presence = z.infer<typeof presenceSchema>
