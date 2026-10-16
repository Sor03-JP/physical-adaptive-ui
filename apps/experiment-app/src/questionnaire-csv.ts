import { surveyListSchema } from './questionnaire'
import type { Participant } from './management'
import type { SurveyRun } from './questionnaire'

const columns = [
  'participant_id', 'assignment_group', 'roster_id', 'session_id', 'survey_id', 'condition', 'survey_status', 'linked_id_kind', 'linked_ids',
  'instrument_version', 'question_id', 'question', 'answer_status', 'answer_value', 'answer_label',
  'requested_at_phone_ms', 'shown_at_phone_ms', 'submitted_at_phone_ms',
]
const cell = (value: string | number | null) => `"${String(value ?? '').replaceAll('"', '""')}"`

/** One row per applicable question. Original answers are preserved without scoring or imputation. */
export function writeQuestionnaireCsv(runs: SurveyRun[], participant: Participant | null = null): string {
  const rows: (string | number | null)[][] = [columns]
  const sessions = new Map<string, SurveyRun[]>()
  for (const run of runs) sessions.set(run.sessionId, [...(sessions.get(run.sessionId) ?? []), run])
  // Each session allows one survey per condition; an interrupted survey in a previous session remains separate.
  for (const run of [...sessions.values()].flatMap((session) => surveyListSchema.parse(session))) {
    for (const item of run.items) {
      const value = run.answers[item.id]
      const optionalBlank = !item.required && run.phase === 'submitted' && (value === undefined || value === '')
      const status = optionalBlank ? 'optional-blank' : value === undefined ? 'unanswered'
        : value === 'cannot-judge' && item.id !== 'comment' ? 'cannot-judge' : 'answered'
      const label = value === undefined ? '' : item.id === 'comment' ? String(value)
        : item.choices.find((choice) => choice.value === value)!.label
      rows.push([participant?.participantId ?? '', participant?.group ?? '', participant?.rosterId ?? '', run.sessionId, run.id, run.target, run.phase,
        run.target === 'final' ? 'condition_survey' : 'task_run', JSON.stringify(run.linkedIds),
        run.instrumentVersion, item.id, item.text, status, value ?? '', label,
        run.requestedAtMs, run.shownAtMs, run.submittedAtMs])
    }
  }
  // UTF-8 BOM for Japanese spreadsheet imports; quote every field, including embedded newlines.
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
