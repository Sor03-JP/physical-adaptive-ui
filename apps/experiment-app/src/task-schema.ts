import { z } from 'zod'
import { experimentModeSchema, uiConfigSchema, uiDecisionSchema, uiLogSchema } from './adaptation'

export const taskIdSchema = z.enum(['A1', 'A2', 'A3', 'B1', 'B2', 'B3'])
export type TaskId = z.infer<typeof taskIdSchema>
export const trialTaskIdSchema = z.enum([...taskIdSchema.options, 'P1'])
export type TrialTaskId = z.infer<typeof trialTaskIdSchema>
export const arrivalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const trainSchema = z.strictObject({ departure: arrivalTimeSchema, arrival: arrivalTimeSchema, destination: z.string().min(1) })

/** The draft tasks are same-day direct trips: a different destination does not serve the target. */
export function targetTrainIndex(problem: { now: string; to: string; trains: readonly z.infer<typeof trainSchema>[] }): number {
  return problem.trains.findIndex((train) => train.departure > problem.now && train.destination === problem.to)
}
const problemSchema = z.strictObject({
  from: z.string().min(1), to: z.string().min(1), line: z.string().min(1), now: arrivalTimeSchema,
  trains: z.array(trainSchema).length(5),
}).superRefine((problem, context) => {
  if (targetTrainIndex(problem) < 0 || problem.trains.some((train, index) => train.arrival <= train.departure
    || (index > 0 && train.departure <= problem.trains[index - 1].departure))) {
    context.addIssue({ code: 'custom', message: '確認用時刻表の時刻順または目的地への次の電車が不整合です。' })
  }
})
export type TransitTask = z.infer<typeof problemSchema>
const problem = (from: string, to: string, line: string, now: string, times: readonly (readonly [string, string, string])[]): TransitTask => problemSchema.parse({
  from, to, line, now, trains: times.map(([departure, arrival, destination]) => ({ departure, arrival, destination })),
})
// Fictional rehearsal data. Displayed times stay fixed; difficulty/equivalence are not validated.
export const transitTasks: Record<TrialTaskId, TransitTask> = {
  P1: problem('緑丘', '中央公園', '緑丘線', '09:05', [
    ['09:02', '09:16', '中央公園'], ['09:08', '09:20', '港北'], ['09:12', '09:26', '中央公園'], ['09:18', '09:32', '中央公園'], ['09:24', '09:38', '中央公園'],
  ]),
  A1: problem('青葉', '南町', '青葉線', '10:25', [
    ['10:24', '10:38', '南町'], ['10:28', '10:39', '北浜'], ['10:34', '10:48', '南町'], ['10:40', '10:54', '南町'], ['10:46', '11:00', '南町'],
  ]),
  A2: problem('北野', '中原', '北野線', '11:17', [
    ['11:16', '11:32', '中原'], ['11:26', '11:42', '中原'], ['11:30', '11:44', '高田'], ['11:36', '11:52', '中原'], ['11:46', '12:02', '中原'],
  ]),
  A3: problem('山手', '大町', '山手・大町線', '13:36', [
    ['13:35', '13:53', '大町'], ['13:39', '13:52', '川原'], ['13:42', '14:00', '桜田'], ['13:45', '14:03', '大町'], ['13:51', '14:09', '大町'],
  ]),
  B1: problem('若葉', '東町', '若葉線', '10:27', [
    ['10:26', '10:40', '東町'], ['10:30', '10:41', '北浜'], ['10:36', '10:50', '東町'], ['10:42', '10:56', '東町'], ['10:48', '11:02', '東町'],
  ]),
  B2: problem('南野', '本町', '南野線', '11:19', [
    ['11:18', '11:34', '本町'], ['11:28', '11:44', '本町'], ['11:32', '11:46', '高野'], ['11:38', '11:54', '本町'], ['11:48', '12:04', '本町'],
  ]),
  B3: problem('海田', '新町', '海田線', '13:38', [
    ['13:37', '13:55', '新町'], ['13:41', '13:54', '岩原'], ['13:44', '14:02', '花田'], ['13:47', '14:05', '新町'], ['13:53', '14:11', '新町'],
  ]),
}
export const taskTiming = Object.freeze({ displayMs: 15_000, answerMs: 10_000 })
export const taskInstructionTiming = Object.freeze({ firstMs: 4_000, secondMs: 11_000 })
const time = z.number().finite().nonnegative()
const phase = z.enum(['preparing', 'viewing', 'waiting-stop', 'answering', 'complete', 'aborted'])
const eventSchema = z.strictObject({
  type: z.enum(['task-shown', 'train-selected', 'selection-shown', 'information-hidden', 'stop-confirmed', 'answer-shown', 'answer-submitted', 'answer-timeout', 'aborted', 'tap']),
  atMs: time, phase, trainIndex: z.int().min(0).max(4).optional(),
  x: z.number().finite().optional(), y: z.number().finite().optional(), action: z.string().optional(),
})
const selectionTaskBase = z.strictObject({
  kind: z.literal('next-departure'), id: z.string().min(1), sessionId: z.string().min(1), taskId: taskIdSchema, mode: z.literal('normal'), phase,
  problem: problemSchema,
  timing: z.strictObject({ displayMs: z.number().positive(), answerMs: z.number().positive() }),
  requestedAtMs: time, startedAtMs: time.nullable(), hiddenAtMs: time.nullable(),
  stopConfirmedAtMs: time.nullable(), answerShownAtMs: time.nullable(), endedAtMs: time.nullable(),
  selectedTrainIndex: z.int().min(0).max(4).nullable(), selectedAtMs: time.nullable(), selectedShownAtMs: time.nullable(),
  answer: z.union([arrivalTimeSchema, z.literal('unknown')]).nullable(),
  outcome: z.enum(['correct', 'incorrect', 'unknown', 'unanswered']).nullable(),
  abortReason: z.string().nullable(), events: z.array(eventSchema).max(500),
})
function validateTaskTimes(value: Omit<z.infer<typeof selectionTaskBase>, 'mode' | 'phase' | 'events' | 'taskId'> & { events: readonly { atMs: number }[] }, context: z.RefinementCtx) {
  const times = [value.requestedAtMs, value.startedAtMs, value.hiddenAtMs, value.stopConfirmedAtMs, value.answerShownAtMs, value.endedAtMs]
    .filter((t): t is number => t !== null)
  if (times.some((t, i) => i > 0 && t < times[i - 1])
    || value.events.some((e, i) => e.atMs < (value.events[i - 1]?.atMs ?? value.requestedAtMs))
    || (value.selectedAtMs !== null && (value.startedAtMs === null || value.selectedAtMs < value.startedAtMs
      || (value.hiddenAtMs !== null && value.selectedAtMs > value.hiddenAtMs)))
    || (value.selectedShownAtMs !== null && (value.selectedAtMs === null || value.selectedShownAtMs < value.selectedAtMs
      || (value.hiddenAtMs !== null && value.selectedShownAtMs > value.hiddenAtMs)))) {
    context.addIssue({ code: 'custom', message: '課題ログの時刻順が不整合です。' })
  }
}
export const previousSelectionTaskRunSchema = selectionTaskBase.superRefine(validateTaskTimes)
const adaptiveTaskBase = selectionTaskBase.extend({
  mode: experimentModeSchema, uiConfig: uiConfigSchema, uiDecision: uiDecisionSchema,
  uiLog: z.array(uiLogSchema).max(2000),
})
function validateUiTimes(value: { requestedAtMs: number; uiLog: z.infer<typeof uiLogSchema>[] }, context: z.RefinementCtx) {
  if (value.uiLog.some((entry, index) => entry.appliedAtMs < entry.decidedAtMs
    || entry.decidedAtMs < value.requestedAtMs
    || (entry.estimateAtMs !== null && entry.estimateAtMs > entry.decidedAtMs)
    || entry.appliedAtMs < (value.uiLog[index - 1]?.appliedAtMs ?? value.requestedAtMs))) {
    context.addIssue({ code: 'custom', message: 'UI反映ログの時刻が不整合です。' })
  }
}
export const previousAdaptiveTaskRunSchema = adaptiveTaskBase.superRefine(validateTaskTimes).superRefine(validateUiTimes)
const currentPhase = z.enum(['briefing', ...phase.options])
const currentEventSchema = eventSchema.extend({
  type: z.enum(['briefing-shown', 'view-requested', ...eventSchema.shape.type.options]), phase: currentPhase,
})
const briefingTaskBase = adaptiveTaskBase.extend({
  flow: z.literal('briefing-first'), phase: currentPhase,
  briefingShownAtMs: time.nullable(), beginRequestedAtMs: time.nullable(),
  events: z.array(currentEventSchema).max(500),
})
function validateBriefingTimes(value: z.infer<typeof briefingTaskBase> | (Omit<z.infer<typeof briefingTaskBase>, 'taskId'> & { taskId: TrialTaskId }), context: z.RefinementCtx) {
  const times = [value.requestedAtMs, value.briefingShownAtMs, value.beginRequestedAtMs, value.startedAtMs]
    .filter((t): t is number => t !== null)
  if (times.some((t, index) => index > 0 && t < times[index - 1])
    || (value.beginRequestedAtMs !== null && value.briefingShownAtMs === null)
    || (value.startedAtMs !== null && value.beginRequestedAtMs === null)
    || (value.phase === 'briefing' && (value.beginRequestedAtMs !== null || value.startedAtMs !== null))) {
    context.addIssue({ code: 'custom', message: '問題文表示・開始操作・候補表示の時刻が不整合です。' })
  }
}
export const previousBriefingTaskRunSchema = briefingTaskBase.superRefine(validateTaskTimes).superRefine(validateUiTimes).superRefine(validateBriefingTimes)
export const taskRunSchema = briefingTaskBase.extend({
  taskId: trialTaskIdSchema, purpose: z.enum(['main', 'practice']),
}).superRefine(validateTaskTimes).superRefine(validateUiTimes).superRefine(validateBriefingTimes).superRefine((run, context) => {
  if ((run.taskId === 'P1') !== (run.purpose === 'practice')) context.addIssue({ code: 'custom', message: '練習と本番の課題区分が一致しません。' })
})
export type TaskRun = z.infer<typeof taskRunSchema>
export type TaskEvent = z.infer<typeof currentEventSchema>

// Read-only schema for the earlier next-train task. Its kind distinguishes it within version 5.
const previousTrainSchema = z.strictObject({ departure: arrivalTimeSchema, arrival: arrivalTimeSchema })
const previousProblemSchema = z.strictObject({
  from: z.string().min(1), to: z.string().min(1), line: z.string().min(1),
  trains: z.array(previousTrainSchema).length(3), initialTrainIndex: z.literal(1), targetTrainIndex: z.literal(2),
}).superRefine((problem, context) => {
  if (problem.trains.some((train, index) => train.arrival <= train.departure
    || (index > 0 && (train.departure <= problem.trains[index - 1].departure || train.arrival <= problem.trains[index - 1].arrival)))) {
    context.addIssue({ code: 'custom', message: '確認用時刻表の時刻順が不整合です。' })
  }
})
const previousEventSchema = z.strictObject({
  type: z.enum(['task-shown', 'train-changed', 'timetable-shown', 'information-hidden', 'stop-confirmed', 'answer-shown', 'answer-submitted', 'answer-timeout', 'aborted', 'tap']),
  atMs: time, phase, trainIndex: z.int().min(0).max(2).optional(), direction: z.union([z.literal(-1), z.literal(1)]).optional(),
  x: z.number().finite().optional(), y: z.number().finite().optional(), action: z.string().optional(),
})
export const previousTaskRunSchema = z.strictObject({
  kind: z.literal('next-train'), id: z.string().min(1), sessionId: z.string().min(1), taskId: taskIdSchema, mode: z.literal('normal'), phase,
  problem: previousProblemSchema,
  timing: z.strictObject({ displayMs: z.number().positive(), answerMs: z.number().positive() }),
  requestedAtMs: time, startedAtMs: time.nullable(), hiddenAtMs: time.nullable(),
  stopConfirmedAtMs: time.nullable(), answerShownAtMs: time.nullable(), endedAtMs: time.nullable(),
  selectedTrainIndex: z.int().min(0).max(2), changedAtMs: time.nullable(), changedShownAtMs: time.nullable(),
  answer: z.union([arrivalTimeSchema, z.literal('unknown')]).nullable(),
  outcome: z.enum(['correct', 'incorrect', 'unknown', 'unanswered']).nullable(),
  abortReason: z.string().nullable(), events: z.array(previousEventSchema).max(500),
}).superRefine((value, context) => {
  const times = [value.requestedAtMs, value.startedAtMs, value.hiddenAtMs, value.stopConfirmedAtMs, value.answerShownAtMs, value.endedAtMs]
    .filter((t): t is number => t !== null)
  if (times.some((t, i) => i > 0 && t < times[i - 1])
    || value.events.some((e, i) => e.atMs < (value.events[i - 1]?.atMs ?? value.requestedAtMs))
    || (value.changedAtMs !== null && (value.startedAtMs === null || value.changedAtMs < value.startedAtMs
      || (value.hiddenAtMs !== null && value.changedAtMs > value.hiddenAtMs)))
    || (value.changedShownAtMs !== null && (value.changedAtMs === null || value.changedShownAtMs < value.changedAtMs
      || (value.hiddenAtMs !== null && value.changedShownAtMs > value.hiddenAtMs)))) {
    context.addIssue({ code: 'custom', message: '課題ログの時刻順が不整合です。' })
  }
})
// Read-only schema for platform-task JSON exported by the earlier prototype (version 4).
const legacyEventSchema = z.strictObject({
  type: z.enum(['task-shown', 'route-opened', 'detail-shown', 'list-returned', 'information-hidden', 'stop-confirmed', 'answer-shown', 'answer-submitted', 'answer-timeout', 'aborted', 'tap']),
  atMs: time, phase, routeIndex: z.int().min(0).max(2).optional(),
  x: z.number().finite().optional(), y: z.number().finite().optional(), action: z.string().optional(),
})
export const legacyTaskRunSchema = z.strictObject({
  id: z.string().min(1), sessionId: z.string().min(1), taskId: taskIdSchema, mode: z.literal('normal'), phase,
  problem: z.strictObject({ target: z.string().min(1), routes: z.array(z.strictObject({
    from: z.string().min(1), to: z.string().min(1), departure: z.string().regex(/^\d{2}:\d{2}$/), platform: z.int().min(1).max(9),
  })).length(3) }),
  timing: z.strictObject({ displayMs: z.number().positive(), answerMs: z.number().positive() }),
  requestedAtMs: time, startedAtMs: time.nullable(), hiddenAtMs: time.nullable(),
  stopConfirmedAtMs: time.nullable(), answerShownAtMs: time.nullable(), endedAtMs: time.nullable(),
  selectedRoute: z.int().min(0).max(2).nullable(), reachedAtMs: time.nullable(),
  answer: z.union([z.int().min(1).max(9), z.literal('unknown')]).nullable(),
  outcome: z.enum(['correct', 'incorrect', 'unknown', 'unanswered']).nullable(),
  abortReason: z.string().nullable(), events: z.array(legacyEventSchema).max(500),
}).superRefine((value, context) => {
  const times = [value.requestedAtMs, value.startedAtMs, value.hiddenAtMs, value.stopConfirmedAtMs, value.answerShownAtMs, value.endedAtMs]
    .filter((t): t is number => t !== null)
  if (times.some((t, i) => i > 0 && t < times[i - 1])
    || value.events.some((e, i) => e.atMs < (value.events[i - 1]?.atMs ?? value.requestedAtMs))) {
    context.addIssue({ code: 'custom', message: '課題ログの時刻順が不整合です。' })
  }
})
