import { expect, it } from 'vitest'
import { surveyItems, surveyRunSchema } from './questionnaire'
import type { SurveyRun, SurveyTarget } from './questionnaire'
import { writeQuestionnaireCsv } from './questionnaire-csv'

function run(target: SurveyTarget, answers: SurveyRun['answers'], submitted = false): SurveyRun {
  return surveyRunSchema.parse({ id: target, sessionId: 'session', instrumentVersion: 1, target,
    linkedIds: target === 'final' ? ['normal', 'automatic'] : ['task1', 'task2', 'task3'],
    items: surveyItems(target), phase: submitted ? 'submitted' : 'answering',
    requestedAtMs: 10, shownAtMs: 11, updatedAtMs: 20, submittedAtMs: submitted ? 20 : null, answers })
}
// All fields are quoted. Read records independently of physical line breaks inside comments.
function records(csv: string) {
  const result: string[][] = []; let row: string[] = []
  for (const match of csv.slice(1).matchAll(/"((?:[^"]|"")*)"(,|\r\n)/g)) {
    row.push(match[1]!.replaceAll('""', '"'))
    if (match[2] === '\r\n') { result.push(row); row = [] }
  }
  return result
}

it('exports 14 question rows with numeric ratings, nonnumeric choices, wording and task links', () => {
  const csv = writeQuestionnaireCsv([
    run('normal', { q1: 1, q2: 2, q3: 3, q4: 4, q5: 5 }, true),
    run('automatic', { q1: 1, q2: 2, q3: 3, q4: 4, q5: 5, q6: 'cannot-judge', q7: 4 }, true),
    run('final', { comparison: 'automatic' }, true),
  ])
  expect(csv.startsWith('\uFEFF')).toBe(true)
  const [header, ...rows] = records(csv)
  expect(rows).toHaveLength(14)
  expect(rows.every((row) => row.length === header!.length)).toBe(true)
  const field = (row: string[], name: string) => row[header!.indexOf(name)]
  expect(field(rows[0]!, 'answer_value')).toBe('1')
  expect(field(rows[0]!, 'linked_ids')).toBe('["task1","task2","task3"]')
  expect(field(rows[5]!, 'condition')).toBe('automatic')
  expect(field(rows[10]!, 'answer_value')).toBe('cannot-judge')
  expect(field(rows[10]!, 'answer_label')).toBe('表示の変化に気づかなかった／判断できない')
  expect(field(rows[10]!, 'answer_status')).toBe('cannot-judge')
  expect(field(rows[12]!, 'answer_value')).toBe('automatic')
  expect(field(rows[12]!, 'answer_label')).toBe('自動で変わる表示')
  expect(field(rows[12]!, 'linked_id_kind')).toBe('condition_survey')
  expect(field(rows[13]!, 'answer_status')).toBe('optional-blank')
})

it('does not impute unfinished ratings and distinguishes an unanswered comment from a submitted blank', () => {
  const draft = run('normal', { q1: 4 })
  const before = structuredClone(draft)
  const [header, ...rows] = records(writeQuestionnaireCsv([draft]))
  const status = header!.indexOf('answer_status'), value = header!.indexOf('answer_value')
  expect(rows[0]![status]).toBe('answered')
  expect(rows[1]![status]).toBe('unanswered')
  expect(rows[1]![value]).toBe('')
  expect(draft).toEqual(before)
  const final = records(writeQuestionnaireCsv([run('final', {})]))
  expect(final[2]![status]).toBe('unanswered')
})

it('preserves Japanese free text, commas, quotes and line breaks as one CSV field', () => {
  const comment = '文字は見えた,"次の電車"\r\n改行も含む。'
  const [header, ...rows] = records(writeQuestionnaireCsv([run('final', { comparison: 'cannot-judge', comment }, true)]))
  expect(rows).toHaveLength(2)
  expect(rows[1]![header!.indexOf('answer_value')]).toBe(comment)
  expect(rows[1]![header!.indexOf('answer_label')]).toBe(comment)
  expect(rows[0]![header!.indexOf('answer_status')]).toBe('cannot-judge')
})
