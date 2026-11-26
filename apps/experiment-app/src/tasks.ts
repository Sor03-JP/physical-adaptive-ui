import { AdaptationPolicy } from '@physical-adaptive/core'
import type { MotionEstimate } from '@physical-adaptive/device-motion'
import { delayTaskForSession, transitTasks, taskTiming, previousTaskTiming, targetTrainIndex, arrivalTimeSchema } from './task-schema'
import type { TrialTaskId, TaskRun, TaskEvent } from './task-schema'
import { uiConfig } from './adaptation'
import type { ExperimentMode, PresentationMetrics, RenderedTaskContext } from './adaptation'

export * from './task-schema'

export function taskSnapshots(history: ReadonlyMap<string, TaskRun>, current: TaskRun | null): TaskRun[] {
  const tasks = new Map(history)
  if (current) tasks.set(current.id, current)
  return [...tasks.values()]
}

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

  constructor(id: string, sessionId: string, taskId: TrialTaskId, requestedAtMs: number, mode: ExperimentMode = 'normal', {
    kind = 'earliest-arrival', originalSessionId = sessionId, timing,
  }: { kind?: TaskRun['kind']; originalSessionId?: string; timing?: TaskRun['timing'] } = {}) {
    this.policy = new AdaptationPolicy(uiConfig)
    const initial: Omit<TaskRun, 'kind' | 'problem' | 'timing'> = {
      flow: 'briefing-first', id, sessionId, taskId, purpose: taskId === 'P1' ? 'practice' : 'main', mode, phase: 'briefing',
      requestedAtMs, briefingShownAtMs: null, beginRequestedAtMs: null, startedAtMs: null, hiddenAtMs: null,
      stopConfirmedAtMs: null, answerShownAtMs: null, endedAtMs: null, selectedTrainIndex: null,
      selectedAtMs: null, selectedShownAtMs: null, answer: null, outcome: null, abortReason: null, events: [],
      uiConfig: structuredClone(uiConfig), uiDecision: { decidedAtMs: requestedAtMs, estimateAtMs: null, inputState: 'unknown',
        state: 'stationary', reason: mode === 'normal' ? 'fixed' : 'initial', stale: false }, uiLog: [] }
    this.run = kind === 'earliest-arrival'
      ? { ...initial, kind, timing: { ...(timing ?? taskTiming) }, problem: structuredClone(delayTaskForSession(taskId, originalSessionId)), openTrainIndex: null }
      : { ...initial, kind, timing: { displayMs: timing?.displayMs ?? previousTaskTiming.displayMs, answerMs: timing?.answerMs ?? previousTaskTiming.answerMs },
        problem: structuredClone(transitTasks[taskId]) }
  }

  get complete(): boolean { return this.run.phase === 'complete' || this.run.phase === 'aborted' }
  snapshot(): TaskRun { return structuredClone(this.run) }

  recordCue(type: 'cue-scheduled' | 'cue-cancelled' | 'cue-unavailable', cueKind: 'change' | 'finish', plannedAtMs: number, now: number, audioTimeSeconds?: number): void {
    this.log(type, now, { cueKind, plannedAtMs, ...(audioTimeSeconds === undefined ? {} : { audioTimeSeconds }) })
  }

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
    const openTrainIndex = this.run.kind === 'earliest-arrival' ? this.run.openTrainIndex : null
    if (rendered && (rendered.phase !== this.run.phase || rendered.decisionKey !== JSON.stringify(this.run.uiDecision)
      || rendered.selectedTrainIndex !== this.run.selectedTrainIndex || rendered.openTrainIndex !== openTrainIndex)) return true
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
    const key = `${this.run.phase}/${openTrainIndex}/${JSON.stringify(this.run.uiDecision)}/${JSON.stringify(metrics)}`
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

  begin(now: number, source: 'controller' | 'phone' = 'controller'): void {
    if (this.run.phase !== 'briefing' || this.run.briefingShownAtMs === null) return
    this.run.beginRequestedAtMs = now; this.run.phase = 'preparing'
    this.log('view-requested', now, source === 'phone' ? { action: 'phone-start-confirmed' } : {})
  }

  advance(now: number): void {
    if (this.run.phase === 'viewing' && now >= this.run.startedAtMs! + this.run.timing.displayMs) {
      this.run.phase = 'waiting-stop'; this.run.hiddenAtMs = now
      if (this.run.kind === 'earliest-arrival') this.run.openTrainIndex = null
      this.log('information-hidden', now, this.run.selectedTrainIndex === null ? {} : { trainIndex: this.run.selectedTrainIndex })
    }
    const { answerMs } = this.run.timing
    if (this.run.phase === 'answering' && this.run.answerShownAtMs !== null && answerMs !== null
      && now >= this.run.answerShownAtMs + answerMs) {
      this.run.phase = 'complete'; this.run.outcome = 'unanswered'; this.run.endedAtMs = now
      this.log('answer-timeout', now)
    }
  }

  showDetails(index: number | null, now: number): void {
    this.advance(now)
    if (this.run.kind !== 'earliest-arrival' || this.run.phase !== 'viewing') return
    const trainIndex = index ?? this.run.openTrainIndex
    if (trainIndex === null || !Number.isInteger(trainIndex) || trainIndex < 0 || trainIndex >= this.run.problem.trains.length
      || (index !== null && this.run.openTrainIndex !== null)) return
    this.run.openTrainIndex = index
    this.log(index === null ? 'list-returned' : 'detail-opened', now, { trainIndex })
  }

  select(index: number, now: number): void {
    this.advance(now)
    if (this.run.phase !== 'viewing' || !Number.isInteger(index) || index < 0 || index >= this.run.problem.trains.length
      || (this.run.kind === 'earliest-arrival' && (this.run.openTrainIndex !== index || this.run.selectedTrainIndex === index))) return
    this.run.selectedTrainIndex = index
    this.log('train-selected', now, { trainIndex: index })
    if (this.run.phase === 'viewing' && index === targetTrainIndex(this.run.problem)) this.run.selectedAtMs ??= now
  }

  confirmStopped(now: number, source: 'controller' | 'phone' = 'controller'): void {
    this.advance(now)
    if (this.run.phase !== 'waiting-stop') return
    this.run.stopConfirmedAtMs = now; this.run.phase = 'answering'; this.log('stop-confirmed', now, source === 'phone' ? { action: 'phone' } : {})
  }

  answer(value: string, now: number): void {
    this.advance(now)
    if (this.run.phase !== 'answering' || this.run.answerShownAtMs === null
      || (value !== 'unknown' && !arrivalTimeSchema.safeParse(value).success)) return
    const { kind, problem, selectedTrainIndex } = this.run
    const answerIndex = kind === 'earliest-arrival' ? selectedTrainIndex : targetTrainIndex(problem)
    this.run.answer = value
    if (value === 'unknown') this.run.outcome = 'unknown'
    else if (answerIndex !== null) this.run.outcome = value === problem.trains[answerIndex].arrival ? 'correct' : 'incorrect'
    this.run.phase = 'complete'; this.run.endedAtMs = now; this.log('answer-submitted', now)
  }

  tap(now: number, x: number, y: number, action: string): void {
    this.advance(now)
    if (this.run.phase === 'viewing' || this.run.phase === 'answering') this.log('tap', now, { x, y, action })
  }

  abort(now: number, reason: string): void {
    if (this.complete) return
    this.run.phase = 'aborted'; this.run.endedAtMs = now; this.run.abortReason = reason
    if (this.run.kind === 'earliest-arrival') this.run.openTrainIndex = null
    this.run.events.push({ type: 'aborted', atMs: now, phase: 'aborted' })
  }
}
