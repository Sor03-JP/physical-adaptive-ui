import { z } from 'zod'
import { emptyManagement, managementSchema, assessableTasks } from './management'
import type { Participant, Management, Failure, Retry } from './management'
import type { LoadedCheckpoint, CheckpointDelta } from './checkpoint'
import { surveyListSchema, validSurveyLinks } from './questionnaire'
import type { SurveyRun } from './questionnaire'
import { ResearchRecorder, researchLogSchema, observationProtocolSchema } from './research-log'
import { currentObservationProtocol } from './observation-plan'
import { MAX_SAMPLES, metadataSchema, sampleSchema, legacySampleSchema, completionSchema, hasValidSampleTimes, hasConsistentReceivedIntervals, hasCompleteAcceleration } from './recording-schema'
import type { RecordingMetadata, Completion } from './recording-schema'
import type { MotionSample, MotionEstimate, EstimationConfig } from '@physical-adaptive/device-motion'
import { summarizeMotionWindow } from '@physical-adaptive/device-motion'
import { estimateSchema, estimationConfigSchema, hasValidEstimateTimes } from './estimation'
import { taskRunSchema, previousBriefingTaskRunSchema, previousTaskRunSchema, previousSelectionTaskRunSchema, previousAdaptiveTaskRunSchema, legacyTaskRunSchema } from './task-schema'
import type { TaskRun } from './task-schema'

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
const version11TransferBase = version10TransferBase.extend({ version: z.literal(11), management: managementSchema,
  recovery: z.strictObject({ phoneSavedThroughMs: z.number().finite().nonnegative(), detectedAt: z.string().datetime() }).nullable(),
})
const currentTransferBase = version11TransferBase.extend({ version: z.literal(12), observationProtocol: observationProtocolSchema.nullable() })
const version6TransferBase = version7TransferBase.extend({
  version: z.literal(6), tasks: z.array(previousAdaptiveTaskRunSchema).max(100),
})
const readableVersion5Base = version7TransferBase.extend({
  version: z.literal(5), tasks: z.array(z.union([previousSelectionTaskRunSchema, previousTaskRunSchema])).max(100),
})
const legacyTransferBase = version2TransferBase.extend({
  version: z.literal(1), samples: z.array(legacySampleSchema).max(MAX_SAMPLES),
})
function validateTransfer(value: z.infer<typeof currentTransferBase> | z.infer<typeof version11TransferBase> | z.infer<typeof version10TransferBase> | z.infer<typeof version9TransferBase> | z.infer<typeof version8TransferBase> | z.infer<typeof version7TransferBase> | z.infer<typeof version6TransferBase> | z.infer<typeof readableVersion5Base> | z.infer<typeof version4TransferBase> | z.infer<typeof version3TransferBase> | z.infer<typeof version2TransferBase> | z.infer<typeof legacyTransferBase>, context: z.RefinementCtx) {
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
  if ('management' in value && (value.management.failures.some((f) => !value.tasks.some((t) => t.id === f.originalRunId && t.purpose === 'main'))
    || value.management.retries.some((r) => {
      const original = value.tasks.find((t) => t.id === r.originalRunId)
      const retry = value.tasks.find((t) => t.id === r.retryRunId)
      return !original || (retry && (retry.taskId !== original.taskId || retry.mode !== original.mode || retry.purpose !== 'main'))
    }))) context.addIssue({ code: 'custom', message: '再実施と元課題の対応が不整合です。' })
  if ('questionnaires' in value && value.questionnaires.some((run) => run.sessionId !== value.metadata.sessionId
    || run.requestedAtMs < value.metadata.startedAtMs || !validSurveyLinks(run, value.questionnaires, value.tasks))) {
    context.addIssue({ code: 'custom', message: 'アンケートと課題・計測記録の対応が不整合です。' })
  }
  if ('research' in value && value.research.rounds.some((r) => r.exchanges.some((s) => s.phoneTimeOriginMs !== value.metadata.timeOriginMs))) {
    context.addIssue({ code: 'custom', message: '時刻合わせのiPhone時計が記録と一致しません。' })
  }
  if ('research' in value && value.research.events.some((e) => e.taskRunId !== null && !value.tasks.some((t) => t.id === e.taskRunId))) {
    context.addIssue({ code: 'custom', message: '観察ログの課題IDが記録と一致しません。' })
  }
  if (('tasks' in value) && (new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length
    || value.tasks.some((task) => task.sessionId !== value.metadata.sessionId || task.requestedAtMs < value.metadata.startedAtMs))) {
    context.addIssue({ code: 'custom', message: '課題の計測IDが一致しません。' })
  }
}
const transferSchema = currentTransferBase.superRefine(validateTransfer)
const readableTransferSchema = z.discriminatedUnion('version', [currentTransferBase, version11TransferBase, version10TransferBase, version9TransferBase, version8TransferBase, version7TransferBase, version6TransferBase, readableVersion5Base, version4TransferBase, version3TransferBase, version2TransferBase, legacyTransferBase])
  .superRefine(validateTransfer)
export type Transfer = z.infer<typeof transferSchema>
export type ReadableTransfer = z.infer<typeof readableTransferSchema>

export function checkpointTransfer(saved: LoadedCheckpoint): Transfer {
  const header = saved.header as Transfer
  const data = readTransfer(JSON.stringify({ ...header, samples: saved.samples, inference: { ...header.inference, estimates: saved.estimates } }))
  if (data.version === 11) return { ...data, version: 12, observationProtocol: null }
  if (data.version !== 12) throw new Error('保存データの復旧形式が一致しません。')
  return data
}

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

  private questionnaires: SurveyRun[] = []

  management: Management = emptyManagement()
  recovery: Transfer['recovery'] = null
  observationProtocol: Transfer['observationProtocol'] = structuredClone(currentObservationProtocol)

  readonly research: ResearchRecorder

  constructor(readonly metadata: RecordingMetadata, readonly controllerTimeOriginMs: number, config: EstimationConfig | null = null) {
    this.research = new ResearchRecorder(metadata.sessionId, metadata.timeOriginMs)
    this.estimationConfig = config ? estimationConfigSchema.parse(config) : null
  }

  static restore(saved: LoadedCheckpoint, currentTimeOriginMs: number, now: number): TransferCollector {
    const data = checkpointTransfer(saved)
    const collector = new TransferCollector(data.metadata, data.controllerTimeOriginMs, data.inference.config)
    collector.samples.push(...data.samples); collector.estimates.push(...data.inference.estimates)
    collector.receipts.push(...data.receipts); collector.expectedCount = data.expectedCount
    collector.expectedEstimateCount = data.inference.expectedCount; collector.completion = data.completion
    collector.completeAccelerationCount = data.samples.filter(hasCompleteAcceleration).length
    data.tasks.forEach((t) => collector.tasks.set(t.id, t)); collector.questionnaires = data.questionnaires
    collector.management = data.management; collector.recovery = data.recovery; collector.observationProtocol = data.observationProtocol
    const resumedAtMs = now + currentTimeOriginMs - data.controllerTimeOriginMs
    collector.research.restore(data.research, resumedAtMs)
    collector.management.controllerRestarts.push({ timeOriginMs: currentTimeOriginMs, controllerAtMs: resumedAtMs })
    return collector
  }
  setParticipant(participant: Participant | null) {
    if (this.management.participant && JSON.stringify(this.management.participant) !== JSON.stringify(participant)) throw new Error('参加者情報が記録と一致しません。')
    this.management.participant = participant
  }
  markFailure(failure: Failure) {
    if (!this.tasks.has(failure.originalRunId) || this.tasks.get(failure.originalRunId)!.purpose !== 'main') throw new Error('本番の元課題が見つかりません。')
    const existing = this.management.failures.find((f) => f.originalRunId === failure.originalRunId)
    if (existing) throw new Error('この課題の不成立理由は記録済みです。')
    this.management = managementSchema.parse({ ...this.management, failures: [...this.management.failures, failure] })
  }
  requestRetry(retry: Retry) {
    const original = this.tasks.get(retry.originalRunId)
    if (!original || !['complete', 'aborted'].includes(original.phase)) throw new Error('元課題を終了・中断してから再実施してください。')
    this.management = managementSchema.parse({ ...this.management, retries: [...this.management.retries, retry] })
  }
  get assessableTaskRuns(): TaskRun[] { return assessableTasks(this.taskRuns, this.management) }
  checkpoint(sampleStart: number, estimateStart: number): CheckpointDelta {
    return { sessionId: this.metadata.sessionId, header: this.snapshot(false), sampleStart, estimateStart,
      samples: this.samples.slice(sampleStart), estimates: this.estimates.slice(estimateStart) }
  }
  get count(): number { return this.samples.length }
  get estimateCount(): number { return this.estimates.length }
  get taskRuns(): TaskRun[] { return structuredClone([...this.tasks.values()]) }
  get surveyRuns(): SurveyRun[] { return structuredClone(this.questionnaires) }
  updateQuestionnaires(runs: SurveyRun[]): boolean {
    const parsed = surveyListSchema.parse(runs)
    if (parsed.some((run) => run.sessionId !== this.metadata.sessionId || !validSurveyLinks(run, parsed, this.taskRuns))) return false
    // Ignore stale snapshots; submitted answers are immutable.
    if (this.questionnaires.some((old) => {
      const next = parsed.find((r) => r.id === old.id)
      return !next || next.updatedAtMs < old.updatedAtMs || (old.phase === 'submitted' && JSON.stringify(next) !== JSON.stringify(old))
    })) return false
    if (JSON.stringify(parsed) === JSON.stringify(this.questionnaires)) return false
    this.questionnaires = structuredClone(parsed)
    return true
  }
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
    if (completion !== null) this.completion = completion.stopReason === 'recovered-after-reload'
      ? { ...completion, endedAtMs: Math.max(completion.endedAtMs, this.samples.at(-1)?.receivedAtMs ?? 0, this.estimates.at(-1)?.stabilizedAtMs ?? 0) } : completion
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
      format: 'physical-adaptive-motion-transfer', version: 12, observationProtocol: structuredClone(this.observationProtocol), management: structuredClone(this.management), recovery: this.recovery,
      metadata: this.metadata, completion: this.completion, samples: includeSamples ? this.samples.slice() : [],
      controllerTimeOriginMs: this.controllerTimeOriginMs, expectedCount: this.expectedCount,
      complete: this.complete, receipts: this.receipts.slice(),
      inference: { config: this.estimationConfig, estimates: includeSamples ? this.estimates.slice() : [], expectedCount: this.expectedEstimateCount },
      questionnaires: this.surveyRuns, tasks: [...this.tasks.values()], research: this.research.snapshot(),
    }
  }
  export(): Transfer { return transferSchema.parse(this.snapshot(true)) }
}

export function readTransfer(text: string): ReadableTransfer { return readableTransferSchema.parse(JSON.parse(text)) }
export function writeTransfer(value: ReadableTransfer): string { return JSON.stringify(readableTransferSchema.parse(value)) }
