import { z } from 'zod'
import type { TaskRun } from './task-schema'

export const surveyTargetSchema = z.enum(['normal', 'automatic', 'final'])
export type SurveyTarget = z.infer<typeof surveyTargetSchema>
const answerSchema = z.union([z.number().int().min(1).max(5), z.string().max(2000)])
const questionIdSchema = z.enum(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'comparison', 'comment'])
export type QuestionId = z.infer<typeof questionIdSchema>
const itemSchema = z.strictObject({
  id: questionIdSchema, text: z.string(), required: z.boolean(),
  choices: z.array(z.strictObject({ value: answerSchema, label: z.string() })).max(6),
})
export type SurveyItem = z.infer<typeof itemSchema>
const ratingChoices = [1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) }))
const common = [
  '必要な乗換情報を見つけやすかった。',
  '選びたい電車の行を狙いどおりに押せた。',
  '画面の発車時刻・到着時刻は読み取りやすかった。',
  '必要な情報を素早く確認できた。',
  '情報を確認するために、強く集中する必要があった。',
  '身体の動きに対して、表示が変わるタイミングは適切だった。',
  '表示の変化が、情報確認や操作の妨げになった。',
]
export function surveyItems(target: SurveyTarget): SurveyItem[] {
  if (target === 'final') return [
    { id: 'comparison', text: '全体として、どちらの表示で情報を確認しやすかったですか？', required: true, choices: [
      { value: 'normal', label: '固定表示' }, { value: 'automatic', label: '自動で変わる表示' },
      { value: 'no-difference', label: '差を感じない' }, { value: 'cannot-judge', label: '判断できない' },
    ] },
    { id: 'comment', text: '確認しにくかった点や、表示の変化で気になった点があれば教えてください。', required: false, choices: [] },
  ]
  return common.slice(0, target === 'normal' ? 5 : 7).map((text, i) => ({ id: `q${i + 1}` as QuestionId,
    text, required: true, choices: i < 5 ? ratingChoices : [...ratingChoices,
      { value: 'cannot-judge', label: '表示の変化に気づかなかった／判断できない' }],
  }))
}
const time = z.number().finite().nonnegative()
export const surveyRunSchema = z.strictObject({
  id: z.string().min(1), sessionId: z.string().min(1), instrumentVersion: z.literal(1),
  target: surveyTargetSchema, linkedIds: z.array(z.string().min(1)).min(2).max(3),
  items: z.array(itemSchema).min(2).max(7),
  phase: z.enum(['answering', 'submitted']),
  requestedAtMs: time, shownAtMs: time.nullable(), updatedAtMs: time, submittedAtMs: time.nullable(),
  answers: z.partialRecord(questionIdSchema, answerSchema),
}).superRefine((run, ctx) => {
  if (JSON.stringify(run.items) !== JSON.stringify(surveyItems(run.target)))
    ctx.addIssue({ code: 'custom', message: 'アンケートの設問・選択肢が形式バージョンと一致しません。' })
  if (run.linkedIds.length !== (run.target === 'final' ? 2 : 3) || new Set(run.linkedIds).size !== run.linkedIds.length)
    ctx.addIssue({ code: 'custom', message: 'アンケートの対応IDが不整合です。' })
  if (run.updatedAtMs < run.requestedAtMs || (run.shownAtMs !== null && (run.shownAtMs < run.requestedAtMs || run.shownAtMs > run.updatedAtMs))
    || (run.phase === 'submitted') !== (run.submittedAtMs !== null)
    || (run.submittedAtMs !== null && (run.shownAtMs === null || run.submittedAtMs < run.shownAtMs || run.submittedAtMs !== run.updatedAtMs))
    || (run.shownAtMs === null && Object.keys(run.answers).length > 0))
    ctx.addIssue({ code: 'custom', message: 'アンケートの表示・回答時刻が不整合です。' })
  for (const [id, value] of Object.entries(run.answers)) {
    const item = run.items.find((q) => q.id === id)
    if (!item || (item.id === 'comment' ? typeof value !== 'string' : !item.choices.some((choice) => choice.value === value)))
      ctx.addIssue({ code: 'custom', message: 'アンケートの回答が選択肢と一致しません。' })
  }
  if (run.phase === 'submitted' && run.items.some((item) => item.required && run.answers[item.id] === undefined))
    ctx.addIssue({ code: 'custom', message: '必要な項目が未回答です。' })
})
export type SurveyRun = z.infer<typeof surveyRunSchema>
export const surveyListSchema = z.array(surveyRunSchema).max(3).superRefine((runs, ctx) => {
  if (new Set(runs.map((r) => r.target)).size !== runs.length || new Set(runs.map((r) => r.id)).size !== runs.length
    || runs.filter((r) => r.phase === 'answering').length > 1)
    ctx.addIssue({ code: 'custom', message: 'アンケートの重複・同時回答があります。' })
})
export const surveyTitle = { normal: '固定UIのアンケート', automatic: '自動適応UIのアンケート', final: '両条件終了後のアンケート' }
export function canSubmitSurvey(run: SurveyRun) {
  return run.phase === 'answering' && run.shownAtMs !== null && run.items.every((item) => !item.required || run.answers[item.id] !== undefined)
}

type SurveyTask = Pick<TaskRun, 'id' | 'sessionId' | 'taskId' | 'mode' | 'phase' | 'endedAtMs'> & { purpose?: 'main' | 'practice' }

/** Pick one complete A/B block; never combine tasks from different sets. */
export function conditionTaskIds(tasks: readonly SurveyTask[], mode: 'normal' | 'automatic'): string[] {
  const blocks = ['A', 'B'].map((set) => ['1', '2', '3'].map((n) =>
    tasks.findLast((t) => t.purpose !== 'practice' && t.mode === mode && t.taskId === `${set}${n}` && t.phase === 'complete')))
    .filter((block) => block.every((t) => t !== undefined))
    .sort((a, b) => Math.max(...b.map((t) => t!.endedAtMs!)) - Math.max(...a.map((t) => t!.endedAtMs!)))
  return blocks[0]?.map((t) => t!.id) ?? []
}
export function validSurveyLinks(run: SurveyRun, runs: readonly SurveyRun[], tasks: readonly SurveyTask[], previousSessionIds: readonly string[] = []) {
  if (run.target === 'final') {
    const linked = run.linkedIds.map((id) => runs.find((r) => r.id === id && r.phase === 'submitted' && r.target !== 'final'))
    return linked.every((r) => r !== undefined && (r.sessionId === run.sessionId ? r.submittedAtMs! <= run.requestedAtMs : previousSessionIds.includes(r.sessionId)))
      && new Set(linked.map((r) => r?.target)).size === 2
  }
  const linked = run.linkedIds.map((id) => tasks.find((t) => t.id === id))
  return linked.every((t) => t !== undefined && t.purpose !== 'practice' && t.taskId !== 'P1' && t.mode === run.target && t.phase === 'complete' && (t.sessionId === run.sessionId ? t.endedAtMs! <= run.requestedAtMs : previousSessionIds.includes(t.sessionId)))
    && new Set(linked.map((t) => t?.taskId[0])).size === 1
    && new Set(linked.map((t) => t?.taskId[1])).size === 3
}
export class QuestionnaireBook {
  private readonly runs = new Map<string, SurveyRun>()
  private activeId: string | null = null
  private readonly previous: { questionnaires: SurveyRun[]; previousSessionIds: string[] }
  constructor(previous: { questionnaires: SurveyRun[]; previousSessionIds: string[] } = { questionnaires: [], previousSessionIds: [] }) { this.previous = previous }
  snapshot(): SurveyRun[] { return structuredClone([...this.runs.values()]) }
  get active(): SurveyRun | null { return structuredClone(this.runs.get(this.activeId ?? '') ?? null) }
  get answering(): boolean { return this.active?.phase === 'answering' }
  dismiss() { if (!this.answering) this.activeId = null }
  open(id: string, sessionId: string, target: SurveyTarget, linkedIds: string[], now: number, tasks: readonly SurveyTask[]) {
    const existing = this.runs.get(id)
    if (existing) {
      if (existing.sessionId !== sessionId || existing.target !== target || JSON.stringify(existing.linkedIds) !== JSON.stringify(linkedIds))
        throw new Error('アンケートの再送内容が一致しません。')
      return // Do not reset answers or reopen a submitted survey on retry.
    }
    if (this.answering || [...this.previous.questionnaires, ...this.snapshot()].some((r) => r.target === target)) throw new Error('現在のアンケートを終了してください。同じ条件は再回答できません。')
    const run = surveyRunSchema.parse({ id, sessionId, target, linkedIds, instrumentVersion: 1, items: surveyItems(target),
      phase: 'answering', requestedAtMs: now, updatedAtMs: now, shownAtMs: null, submittedAtMs: null, answers: {} })
    if (!validSurveyLinks(run, [...this.previous.questionnaires, ...this.snapshot()], tasks, this.previous.previousSessionIds)) throw new Error('対応する3課題、または両条件のアンケートが終了していません。')
    this.runs.set(id, run); this.activeId = id
  }
  present(id: string, now: number) {
    const run = this.runs.get(id)
    if (!run || id !== this.activeId || run.shownAtMs !== null || now < run.updatedAtMs) return
    run.shownAtMs = now; run.updatedAtMs = now
  }
  answer(id: string, itemId: QuestionId, value: number | string, now: number) {
    const run = this.runs.get(id)
    if (!run || id !== this.activeId || run.phase !== 'answering' || run.shownAtMs === null || now < run.updatedAtMs) return
    const next = surveyRunSchema.parse({ ...run, updatedAtMs: now, answers: { ...run.answers, [itemId]: value } })
    this.runs.set(id, next)
  }
  submit(id: string, now: number) {
    const run = this.runs.get(id)
    if (!run || id !== this.activeId || !canSubmitSurvey(run) || now < run.updatedAtMs) return
    this.runs.set(id, surveyRunSchema.parse({ ...run, phase: 'submitted', submittedAtMs: now, updatedAtMs: now }))
  }
}
