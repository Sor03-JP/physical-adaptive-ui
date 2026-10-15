import { z } from 'zod'
import { experimentModeSchema } from './adaptation'
import type { TaskRun, TaskId } from './task-schema'
import type { SurveyRun, SurveyTarget } from './questionnaire'

export const groupSchema = z.enum(['G1', 'G2', 'G3', 'G4'])
export type Group = z.infer<typeof groupSchema>
export const assignments = {
  G1: [{ mode: 'normal', set: 'A' }, { mode: 'automatic', set: 'B' }],
  G2: [{ mode: 'automatic', set: 'B' }, { mode: 'normal', set: 'A' }],
  G3: [{ mode: 'normal', set: 'B' }, { mode: 'automatic', set: 'A' }],
  G4: [{ mode: 'automatic', set: 'A' }, { mode: 'normal', set: 'B' }],
} as const
export const participantSchema = z.strictObject({
  participantId: z.string().regex(/^(?:p|test)\d{2,3}$/), group: groupSchema, rosterId: z.string().min(1),
})
export type Participant = z.infer<typeof participantSchema>
export const rosterSchema = z.strictObject({
  id: z.string().min(1), createdAt: z.string().datetime(),
  entries: z.array(participantSchema).length(10),
}).refine((r) => new Set(r.entries.map((p) => p.participantId)).size === 10
  && r.entries.every((p, i) => p.participantId === `p${String(i + 1).padStart(2, '0')}` && p.rosterId === r.id)
  && ['G1', 'G2', 'G3', 'G4'].every((g, i) => r.entries.filter((p) => p.group === g).length === [3, 2, 2, 3][i]), '10名の割当が不整合です。')
export type Roster = z.infer<typeof rosterSchema>
export function createRoster(id: string, createdAt: string, random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32): Roster {
  const groups: Group[] = ['G1', 'G1', 'G1', 'G2', 'G2', 'G3', 'G3', 'G4', 'G4', 'G4']
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    if (j < 0 || j > i) throw new Error('乱数が不正です。')
    ;[groups[i], groups[j]] = [groups[j]!, groups[i]!]
  }
  return rosterSchema.parse({ id, createdAt, entries: groups.map((group, i) => ({ participantId: `p${String(i + 1).padStart(2, '0')}`, group, rosterId: id })) })
}
export const failureCategorySchema = z.enum(['app-stopped', 'task-not-shown', 'log-unavailable', 'connection-failure'])
export const failureLabels = { 'app-stopped': 'アプリ停止', 'task-not-shown': '課題表示の不成立', 'log-unavailable': '必要ログの回収不能', 'connection-failure': '接続不成立' }
const time = z.number().finite().nonnegative()
export const failureSchema = z.strictObject({ originalRunId: z.string().min(1), category: failureCategorySchema,
  reason: z.string().trim().min(1).max(1000), recordedAtControllerMs: time })
export type Failure = z.infer<typeof failureSchema>
export const retrySchema = failureSchema.extend({ retryRunId: z.string().min(1), consentConfirmed: z.literal(true), requestedAtControllerMs: time })
export type Retry = z.infer<typeof retrySchema>
export const managementSchema = z.strictObject({
  controllerRestarts: z.array(z.strictObject({ timeOriginMs: time, controllerAtMs: time })).max(100),
  participant: participantSchema.nullable(), failures: z.array(failureSchema).max(100), retries: z.array(retrySchema).max(100),
}).refine((m) => new Set(m.failures.map((f) => f.originalRunId)).size === m.failures.length
  && new Set(m.retries.map((r) => r.originalRunId)).size === m.retries.length
  && new Set(m.retries.map((r) => r.retryRunId)).size === m.retries.length
  && m.retries.every((r) => r.originalRunId !== r.retryRunId && !m.retries.some((other) => other.retryRunId === r.originalRunId)
    && m.failures.some((f) => f.originalRunId === r.originalRunId && f.category === r.category && f.reason === r.reason)
    && r.requestedAtControllerMs >= r.recordedAtControllerMs), '再実施の対応・回数が不整合です。')
export type Management = z.infer<typeof managementSchema>
export const emptyManagement = (): Management => ({ participant: null, failures: [], retries: [], controllerRestarts: [] })
export function assessableTasks(tasks: readonly TaskRun[], management: Management) {
  return tasks.filter((t) => !management.failures.some((f) => f.originalRunId === t.id))
}
export type NextStep = { kind: 'practice' | 'done' } | { kind: 'task'; taskId: TaskId; mode: z.infer<typeof experimentModeSchema> }
  | { kind: 'active'; runId: string } | { kind: 'survey'; target: SurveyTarget }
export function nextStep(participant: Participant, tasks: readonly TaskRun[], surveys: readonly SurveyRun[], management: Management): NextStep {
  const active = tasks.findLast((t) => !['complete', 'aborted'].includes(t.phase))
  if (active) return { kind: 'active', runId: active.id }
  const answering = surveys.find((s) => s.phase === 'answering')
  if (answering) return { kind: 'survey', target: answering.target }
  if (!tasks.some((t) => t.purpose === 'practice' && t.phase === 'complete')) return { kind: 'practice' }
  const valid = assessableTasks(tasks, management)
  for (const block of assignments[participant.group]) {
    for (const number of ['1', '2', '3']) {
      const taskId = `${block.set}${number}` as TaskId
      if (!valid.some((t) => t.purpose === 'main' && t.mode === block.mode && t.taskId === taskId && t.phase === 'complete'))
        return { kind: 'task', taskId, mode: block.mode }
    }
    if (!surveys.some((s) => s.target === block.mode && s.phase === 'submitted')) return { kind: 'survey', target: block.mode }
  }
  return surveys.some((s) => s.target === 'final' && s.phase === 'submitted') ? { kind: 'done' } : { kind: 'survey', target: 'final' }
}
