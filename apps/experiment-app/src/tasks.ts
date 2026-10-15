import { AdaptationPolicy } from '@physical-adaptive/core'
import type { MotionEstimate } from '@physical-adaptive/device-motion'
import { transitTasks, taskTiming, targetTrainIndex, arrivalTimeSchema } from './task-schema'
import type { TrialTaskId, TaskRun, TaskEvent } from './task-schema'
import { uiConfig } from './adaptation'
import type { ExperimentMode, PresentationMetrics, RenderedTaskContext } from './adaptation'

export * from './task-schema'

export function canStartPractice(recordingActive: boolean, tasks: readonly Pick<TaskRun, 'purpose' | 'phase'>[], answeringSurvey: boolean): boolean {
  return recordingActive && !answeringSurvey && tasks.length < 100
    && tasks.every((task) => task.purpose === 'practice' && ['complete', 'aborted'].includes(task.phase))
}

/** Task times are iPhone-local. Presentation means React commit, not physical display scanout. */
export class TransitTrial {
  private readonly run: TaskRun
  private presentedTrainIndex: number | null = null
  private readonly policy: AdaptationPolicy
  private presentedUiKey = ''

  constructor(id: string, sessionId: string, taskId: TrialTaskId, requestedAtMs: number, mode: ExperimentMode = 'normal') {
    this.policy = new AdaptationPolicy(uiConfig)
    this.run = { flow: 'briefing-first', kind: 'next-departure', id, sessionId, taskId, purpose: taskId === 'P1' ? 'practice' : 'main', mode, phase: 'briefing', timing: { ...taskTiming },
      problem: structuredClone(transitTasks[taskId]), requestedAtMs, briefingShownAtMs: null, beginRequestedAtMs: null, startedAtMs: null, hiddenAtMs: null,
      stopConfirmedAtMs: null, answerShownAtMs: null, endedAtMs: null, selectedTrainIndex: null,
      selectedAtMs: null, selectedShownAtMs: null, answer: null, outcome: null, abortReason: null, events: [],
      uiConfig: structuredClone(uiConfig), uiDecision: { decidedAtMs: requestedAtMs, estimateAtMs: null, inputState: 'unknown',
        state: 'stationary', reason: mode === 'normal' ? 'fixed' : 'initial', stale: false }, uiLog: [] }
  }

  get complete(): boolean { return this.run.phase === 'complete' || this.run.phase === 'aborted' }
  snapshot(): TaskRun { return structuredClone(this.run) }

  private log(type: TaskEvent['type'], now: number, fields: Partial<TaskEvent> = {}) {
    if (this.run.events.length >= 499) { this.abort(now, 'event-capacity'); return }
    this.run.events.push({ ...fields, type, atMs: now, phase: this.run.phase })
  }

  updateAdaptation(estimate: Pick<MotionEstimate, 'evaluatedAtMs' | 'stabilizedAtMs' | 'stabilizedState'> | null, now: number): void {
    if (this.complete) return
    const decision = this.policy.resolve(estimate ? { state: estimate.stabilizedState, atMs: estimate.stabilizedAtMs } : null, now)
    const next = { decidedAtMs: now, estimateAtMs: estimate?.evaluatedAtMs ?? null, inputState: estimate?.stabilizedState ?? 'unknown',
      ...decision, ...(this.run.mode === 'normal' ? { state: 'stationary' as const, reason: 'fixed' as const } : {}) }
    const previous = this.run.uiDecision
    if (next.estimateAtMs !== previous.estimateAtMs || next.state !== previous.state || next.reason !== previous.reason || next.stale !== previous.stale) {
      this.run.uiDecision = next
    }
  }

  present(now: number, metrics: PresentationMetrics | null = null, rendered?: RenderedTaskContext): boolean {
    if (rendered && (rendered.phase !== this.run.phase || rendered.decisionKey !== JSON.stringify(this.run.uiDecision)
      || rendered.selectedTrainIndex !== this.run.selectedTrainIndex)) return true
    const before = this.run.phase
    this.advance(now)
    // A deadline may change the model before the old DOM commit finishes. Log the new surface only after its own render.
    if (this.run.phase !== before) return true
    let changed = false
    if (this.run.phase === 'briefing' && this.run.briefingShownAtMs === null) {
      this.run.briefingShownAtMs = now; this.log('briefing-shown', now); changed = true
    }
    if (this.run.phase === 'preparing') {
      this.run.phase = 'viewing'; this.run.startedAtMs = now
      this.log('task-shown', now); changed = true
    }
    if (this.run.phase === 'answering' && this.run.answerShownAtMs === null) {
      this.run.answerShownAtMs = now; this.log('answer-shown', now); changed = true
    }
    if (this.run.phase === 'viewing' && this.run.selectedTrainIndex !== null && this.presentedTrainIndex !== this.run.selectedTrainIndex) {
      this.presentedTrainIndex = this.run.selectedTrainIndex
      this.log('selection-shown', now, { trainIndex: this.run.selectedTrainIndex })
      if (this.run.phase === 'viewing' && this.run.selectedTrainIndex === targetTrainIndex(this.run.problem)) this.run.selectedShownAtMs ??= now
      changed = true
    }
    const key = `${this.run.phase}/${JSON.stringify(this.run.uiDecision)}/${JSON.stringify(metrics)}`
    if (key !== this.presentedUiKey) {
      this.presentedUiKey = key
      if (this.run.uiLog.length >= 2000) {
        if (this.complete) return changed
        this.abort(now, 'ui-log-capacity'); return true
      }
      const information = this.run.phase === 'viewing'
      this.run.uiLog.push({ ...this.run.uiDecision, appliedAtMs: now, phase: this.run.phase,
        appliedState: information ? this.run.uiDecision.state : 'stationary', surface: information ? 'information' : 'common', metrics })
      changed = true
    }
    return changed
  }

  begin(now: number): void {
    if (this.run.phase !== 'briefing' || this.run.briefingShownAtMs === null) return
    this.run.beginRequestedAtMs = now; this.run.phase = 'preparing'
    this.log('view-requested', now)
  }

  advance(now: number): void {
    if (this.run.phase === 'viewing' && now >= this.run.startedAtMs! + this.run.timing.displayMs) {
      this.run.phase = 'waiting-stop'; this.run.hiddenAtMs = now
      this.log('information-hidden', now, this.run.selectedTrainIndex === null ? {} : { trainIndex: this.run.selectedTrainIndex })
    }
    if (this.run.phase === 'answering' && this.run.answerShownAtMs !== null
      && now >= this.run.answerShownAtMs + this.run.timing.answerMs) {
      this.run.phase = 'complete'; this.run.outcome = 'unanswered'; this.run.endedAtMs = now
      this.log('answer-timeout', now)
    }
  }

  select(index: number, now: number): void {
    this.advance(now)
    if (this.run.phase !== 'viewing' || !Number.isInteger(index) || index < 0 || index >= this.run.problem.trains.length) return
    this.run.selectedTrainIndex = index
    this.log('train-selected', now, { trainIndex: index })
    if (this.run.phase === 'viewing' && index === targetTrainIndex(this.run.problem)) this.run.selectedAtMs ??= now
  }

  confirmStopped(now: number): void {
    this.advance(now)
    if (this.run.phase !== 'waiting-stop') return
    this.run.stopConfirmedAtMs = now; this.run.phase = 'answering'; this.log('stop-confirmed', now)
  }

  answer(value: string, now: number): void {
    this.advance(now)
    if (this.run.phase !== 'answering' || this.run.answerShownAtMs === null
      || (value !== 'unknown' && !arrivalTimeSchema.safeParse(value).success)) return
    const correct = this.run.problem.trains[targetTrainIndex(this.run.problem)].arrival
    this.run.answer = value; this.run.outcome = value === 'unknown' ? 'unknown' : value === correct ? 'correct' : 'incorrect'
    this.run.phase = 'complete'; this.run.endedAtMs = now; this.log('answer-submitted', now)
  }

  tap(now: number, x: number, y: number, action: string): void {
    this.advance(now)
    if (this.run.phase === 'viewing' || this.run.phase === 'answering') this.log('tap', now, { x, y, action })
  }

  abort(now: number, reason: string): void {
    if (this.complete) return
    this.run.phase = 'aborted'; this.run.endedAtMs = now; this.run.abortReason = reason
    this.run.events.push({ type: 'aborted', atMs: now, phase: 'aborted' })
  }
}
