import { z } from 'zod'
import { MAX_SAMPLES, metadataSchema, sampleSchema, legacySampleSchema, completionSchema, hasValidSampleTimes, hasConsistentReceivedIntervals, hasCompleteAcceleration } from './recording-schema'
import type { RecordingMetadata, Completion } from './recording-schema'
import type { MotionSample, MotionEstimate, EstimationConfig } from '@physical-adaptive/device-motion'
import { summarizeMotionWindow } from '@physical-adaptive/device-motion'
import { estimateSchema, estimationConfigSchema, hasValidEstimateTimes } from './estimation'
import { taskRunSchema, previousBriefingTaskRunSchema, previousTaskRunSchema, previousSelectionTaskRunSchema, previousAdaptiveTaskRunSchema, legacyTaskRunSchema } from './task-schema'
import type { TaskRun } from './task-schema'

// Format-compatible empty survey slot; the questionnaire recorder is connected separately.
const surveyListSchema = z.array(z.never()).max(0)

// Preserve the format contract without inventing observation or clock records.
const researchLogSchema = z.strictObject({ clock: z.literal('controller-local-performance'), method: z.literal('four-timestamp-minimum-round-trip'), events: z.array(z.never()).max(0), rounds: z.array(z.never()).max(0) })
const emptyResearch = () => researchLogSchema.parse({ clock: 'controller-local-performance', method: 'four-timestamp-minimum-round-trip', events: [], rounds: [] })

const receiptSchema = z.strictObject({
  startIndex: z.int().nonnegative(), count: z.int().positive(),
  controllerReceivedAtMs: z.number().finite().nonnegative(),
})
const version2TransferBase = z.strictObject({
  format: z.literal('physical-adaptive-motion-transfer'), version: z.literal(2),
  metadata: metadataSchema, completion: completionSchema.nullable(),
  samples: z.array(sampleSchema).max(MAX_SAMPLES),
  controllerTimeOriginMs: z.number().finite().nonnegative(),
  expectedCount: z.int().min(0).max(MAX_SAMPLES), complete: z.boolean(),
  receipts: z.array(receiptSchema).max(MAX_SAMPLES),
})
const version3TransferBase = version2TransferBase.extend({
  version: z.literal(3), inference: z.strictObject({
    config: estimationConfigSchema.nullable(), estimates: z.array(estimateSchema).max(MAX_SAMPLES),
    expectedCount: z.int().min(0).max(MAX_SAMPLES),
  }),
})
const version4TransferBase = version3TransferBase.extend({
  version: z.literal(4), tasks: z.array(legacyTaskRunSchema).max(100),
})
const version7TransferBase = version3TransferBase.extend({
  version: z.literal(7), tasks: z.array(previousBriefingTaskRunSchema).max(100),
})
const version8TransferBase = version7TransferBase.extend({
  version: z.literal(8), research: researchLogSchema,
})
const version9TransferBase = version8TransferBase.extend({ version: z.literal(9), questionnaires: surveyListSchema })
const version10TransferBase = version9TransferBase.extend({ version: z.literal(10), tasks: z.array(taskRunSchema).max(100) })
const currentTransferBase = version10TransferBase
const version6TransferBase = version7TransferBase.extend({
  version: z.literal(6), tasks: z.array(previousAdaptiveTaskRunSchema).max(100),
})
const readableVersion5Base = version7TransferBase.extend({
  version: z.literal(5), tasks: z.array(z.union([previousSelectionTaskRunSchema, previousTaskRunSchema])).max(100),
})
const legacyTransferBase = version2TransferBase.extend({
  version: z.literal(1), samples: z.array(legacySampleSchema).max(MAX_SAMPLES),
})
function validateTransfer(value: z.infer<typeof currentTransferBase> | z.infer<typeof version10TransferBase> | z.infer<typeof version9TransferBase> | z.infer<typeof version8TransferBase> | z.infer<typeof version7TransferBase> | z.infer<typeof version6TransferBase> | z.infer<typeof readableVersion5Base> | z.infer<typeof version4TransferBase> | z.infer<typeof version3TransferBase> | z.infer<typeof version2TransferBase> | z.infer<typeof legacyTransferBase>, context: z.RefinementCtx) {
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
  const inference = 'inference' in value ? value.inference : null
  const inferenceComplete = inference === null || inference.estimates.length === inference.expectedCount
  if (count !== value.samples.length || value.samples.length > value.expectedCount
    || value.complete !== (value.completion !== null && value.samples.length === value.expectedCount && inferenceComplete)) {
    context.addIssue({ code: 'custom', message: '件数または転送完了状態が不整合です。' })
  }
  if (value.version !== 1 && !hasConsistentReceivedIntervals(value.samples)) {
    context.addIssue({ code: 'custom', message: '実受信間隔と受信時刻差が一致しません。' })
  }
  if (inference && (inference.estimates.length > inference.expectedCount
    || (inference.config === null && inference.expectedCount !== 0)
    || !hasValidEstimateTimes(inference.estimates, value.metadata.startedAtMs, value.completion?.endedAtMs))) {
    context.addIssue({ code: 'custom', message: '推定ログの件数・設定・時刻が不整合です。' })
  }
  if (('tasks' in value) && (new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length
    || value.tasks.some((task) => task.sessionId !== value.metadata.sessionId || task.requestedAtMs < value.metadata.startedAtMs))) {
    context.addIssue({ code: 'custom', message: '課題の計測IDが一致しません。' })
  }
}
const transferSchema = currentTransferBase.superRefine(validateTransfer)
const readableTransferSchema = z.discriminatedUnion('version', [currentTransferBase, version9TransferBase, version8TransferBase, version7TransferBase, version6TransferBase, readableVersion5Base, version4TransferBase, version3TransferBase, version2TransferBase, legacyTransferBase])
  .superRefine(validateTransfer)
export type Transfer = z.infer<typeof transferSchema>
export type ReadableTransfer = z.infer<typeof readableTransferSchema>

export class TransferCollector {
  private readonly samples: MotionSample[] = []
  private readonly receipts: Transfer['receipts'] = []
  private completion: Completion | null = null
  private expectedCount = 0
  private completeAccelerationCount = 0
  private readonly estimates: MotionEstimate[] = []
  private expectedEstimateCount = 0
  private readonly estimationConfig: EstimationConfig | null
  private readonly tasks = new Map<string, TaskRun>()





  constructor(readonly metadata: RecordingMetadata, readonly controllerTimeOriginMs: number, config: EstimationConfig | null = null) {
    this.estimationConfig = config ? estimationConfigSchema.parse(config) : null
  }

  get count(): number { return this.samples.length }
  get estimateCount(): number { return this.estimates.length }
  get taskRuns(): TaskRun[] { return structuredClone([...this.tasks.values()]) }
  get taskCount(): number { return this.tasks.size }
  updateTask(task: TaskRun | null): boolean {
    if (task === null || task.sessionId !== this.metadata.sessionId) return false
    const previous = this.tasks.get(task.id)
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(task)) return false
      if (['complete', 'aborted'].includes(previous.phase) && (task.phase !== previous.phase
        || task.answer !== previous.answer || task.outcome !== previous.outcome || task.endedAtMs !== previous.endedAtMs
        || task.abortReason !== previous.abortReason)) return false
      // A phone checkpoint may be older than the last snapshot already received by PC.
      const phases = ['briefing', 'preparing', 'viewing', 'waiting-stop', 'answering', 'complete', 'aborted']
      if (phases.indexOf(task.phase) < phases.indexOf(previous.phase) || task.events.length < previous.events.length
        || task.uiLog.length < previous.uiLog.length
        || JSON.stringify(task.events.slice(0, previous.events.length)) !== JSON.stringify(previous.events)
        || JSON.stringify(task.uiLog.slice(0, previous.uiLog.length)) !== JSON.stringify(previous.uiLog)
        || (task.events.at(-1)?.atMs ?? task.requestedAtMs) < (previous.events.at(-1)?.atMs ?? previous.requestedAtMs)) return false
    }
    if (!this.tasks.has(task.id) && this.tasks.size >= 100) throw new Error('課題記録の上限に達しました。')
    this.tasks.set(task.id, structuredClone(task))
    return true
  }
  get complete(): boolean {
    return this.completion !== null && this.count === this.expectedCount && this.estimateCount === this.expectedEstimateCount
  }

  updateStatus(count: number, completion: Completion | null, estimateCount = 0): void {
    this.expectedCount = Math.max(this.expectedCount, count)
    this.expectedEstimateCount = Math.max(this.expectedEstimateCount, estimateCount)
    if (completion !== null) this.completion = completion
  }

  receiveEstimates(startIndex: number, estimates: MotionEstimate[]): boolean {
    if (!this.estimationConfig || startIndex !== this.estimateCount || estimates.length === 0
      || this.estimateCount + estimates.length > MAX_SAMPLES) return false
    if (!hasValidEstimateTimes(estimates, this.estimates.at(-1)?.evaluatedAtMs ?? this.metadata.startedAtMs,
      this.completion?.endedAtMs)) return false
    this.estimates.push(...estimates)
    this.expectedEstimateCount = Math.max(this.expectedEstimateCount, this.estimateCount)
    return true
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

  private snapshot(includeSamples: boolean): Transfer {
    return {
      format: 'physical-adaptive-motion-transfer', version: 10,
      metadata: this.metadata, completion: this.completion, samples: includeSamples ? this.samples.slice() : [],
      controllerTimeOriginMs: this.controllerTimeOriginMs, expectedCount: this.expectedCount,
      complete: this.complete, receipts: this.receipts.slice(),
      inference: { config: this.estimationConfig, estimates: includeSamples ? this.estimates.slice() : [], expectedCount: this.expectedEstimateCount },
      questionnaires: [], tasks: [...this.tasks.values()], research: emptyResearch(),
    }
  }
  export(): Transfer { return transferSchema.parse(this.snapshot(true)) }
}

export function readTransfer(text: string): ReadableTransfer { return readableTransferSchema.parse(JSON.parse(text)) }
export function writeTransfer(value: ReadableTransfer): string { return JSON.stringify(readableTransferSchema.parse(value)) }
