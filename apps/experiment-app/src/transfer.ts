import { z } from 'zod'
import { MAX_SAMPLES, metadataSchema, sampleSchema, legacySampleSchema, completionSchema, hasValidSampleTimes, hasConsistentReceivedIntervals, hasCompleteAcceleration } from './recording'
import type { RecordingMetadata, Completion } from './recording'
import type { MotionSample } from '@physical-adaptive/device-motion'
import { summarizeMotionWindow } from '@physical-adaptive/device-motion'

const receiptSchema = z.strictObject({
  startIndex: z.int().nonnegative(), count: z.int().positive(),
  controllerReceivedAtMs: z.number().finite().nonnegative(),
})
const currentTransferBase = z.strictObject({
  format: z.literal('physical-adaptive-motion-transfer'), version: z.literal(2),
  metadata: metadataSchema, completion: completionSchema.nullable(),
  samples: z.array(sampleSchema).max(MAX_SAMPLES),
  controllerTimeOriginMs: z.number().finite().nonnegative(),
  expectedCount: z.int().min(0).max(MAX_SAMPLES), complete: z.boolean(),
  receipts: z.array(receiptSchema).max(MAX_SAMPLES),
})
const legacyTransferBase = currentTransferBase.extend({
  version: z.literal(1), samples: z.array(legacySampleSchema).max(MAX_SAMPLES),
})
function validateTransfer(value: z.infer<typeof currentTransferBase> | z.infer<typeof legacyTransferBase>, context: z.RefinementCtx) {
  if (!hasValidSampleTimes(value.samples, value.metadata.startedAtMs, value.completion?.endedAtMs)) {
    context.addIssue({ code: 'custom', message: 'iPhone側の時刻が不整合です。' })
  }
  let count = 0
  let receivedAt = 0
  for (const receipt of value.receipts) {
    if (receipt.startIndex !== count || receipt.controllerReceivedAtMs < receivedAt) {
      context.addIssue({ code: 'custom', message: 'PC側の受信記録が不整合です。' }); break
    }
    count += receipt.count; receivedAt = receipt.controllerReceivedAtMs
  }
  if (count !== value.samples.length || value.samples.length > value.expectedCount
    || value.complete !== (value.completion !== null && value.samples.length === value.expectedCount)) {
    context.addIssue({ code: 'custom', message: '件数または転送完了状態が不整合です。' })
  }
  if (value.version === 2 && !hasConsistentReceivedIntervals(value.samples)) {
    context.addIssue({ code: 'custom', message: '実受信間隔と受信時刻差が一致しません。' })
  }
}
const transferSchema = currentTransferBase.superRefine(validateTransfer)
const readableTransferSchema = z.discriminatedUnion('version', [currentTransferBase, legacyTransferBase])
  .superRefine(validateTransfer)
export type Transfer = z.infer<typeof transferSchema>
export type ReadableTransfer = z.infer<typeof readableTransferSchema>

export class TransferCollector {
  private readonly samples: MotionSample[] = []
  private readonly receipts: Transfer['receipts'] = []
  private completion: Completion | null = null
  private expectedCount = 0
  private completeAccelerationCount = 0

  constructor(readonly metadata: RecordingMetadata, readonly controllerTimeOriginMs: number) {}

  get count(): number { return this.samples.length }
  get complete(): boolean { return this.completion !== null && this.count === this.expectedCount }

  updateStatus(count: number, completion: Completion | null): void {
    this.expectedCount = Math.max(this.expectedCount, count)
    if (completion !== null) this.completion = completion
  }

  receive(startIndex: number, samples: MotionSample[], receivedAtMs: number): boolean {
    if (startIndex !== this.count || samples.length === 0 || this.count + samples.length > MAX_SAMPLES) return false
    const previous = this.samples.at(-1)
    if (!hasValidSampleTimes(samples, previous?.receivedAtMs ?? this.metadata.startedAtMs, this.completion?.endedAtMs)
      || !hasConsistentReceivedIntervals(samples, previous)) return false
    this.samples.push(...samples)
    this.completeAccelerationCount += samples.filter(hasCompleteAcceleration).length
    this.expectedCount = Math.max(this.expectedCount, this.count)
    this.receipts.push({ startIndex, count: samples.length, controllerReceivedAtMs: receivedAtMs })
    return true
  }

  summary() { return { count: this.count, completeAccelerationCount: this.completeAccelerationCount } }

  features(windowMs: number) {
    const latest = this.samples.at(-1)
    return latest ? summarizeMotionWindow(this.samples, latest.receivedAtMs, windowMs) : null
  }

  export(): Transfer {
    return transferSchema.parse({
      format: 'physical-adaptive-motion-transfer', version: 2,
      metadata: this.metadata, completion: this.completion, samples: this.samples.slice(),
      controllerTimeOriginMs: this.controllerTimeOriginMs, expectedCount: this.expectedCount,
      complete: this.complete, receipts: this.receipts.slice(),
    })
  }
}

export function readTransfer(text: string): ReadableTransfer { return readableTransferSchema.parse(JSON.parse(text)) }
export function writeTransfer(value: ReadableTransfer): string { return JSON.stringify(readableTransferSchema.parse(value)) }
