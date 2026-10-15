import { useLayoutEffect } from 'react'
import { canSubmitSurvey, surveyTitle } from './questionnaire'
import type { QuestionId, SurveyRun } from './questionnaire'

export default function QuestionnaireScreen({ run, onPresent, onAnswer, onSubmit }: {
  run: SurveyRun; onPresent: (id: string) => void
  onAnswer: (id: string, item: QuestionId, value: number | string) => void
  onSubmit: (id: string) => void
}) {
  useLayoutEffect(() => { onPresent(run.id) }, [run.id, onPresent])
  return <div className="questionnaire-screen" role="region" aria-label={surveyTitle[run.target]}>
    <h1>{surveyTitle[run.target]}</h1>
    {run.phase === 'submitted' ? <p role="status">回答を記録しました。実験者がPCで受信を確認します。案内をお待ちください。</p> : <form onSubmit={(event) => { event.preventDefault(); onSubmit(run.id) }}>
      <p>立ち止まった状態で回答してください。回答時間の制限はありません。</p>
      {run.target !== 'final' && <p>直前の3課題について、1「全くそう思わない」〜5「とてもそう思う」で回答してください。</p>}
      {run.items.map((item) => <fieldset key={item.id}>
        <legend>{item.text}{!item.required && '（任意）'}</legend>
        {item.id === 'comment' ? <textarea aria-label={item.text} rows={4} maxLength={2000} value={run.answers.comment ?? ''}
          onChange={(event) => onAnswer(run.id, item.id, event.currentTarget.value)} />
          : <div className="questionnaire-choices">{item.choices.map((choice) => <label key={String(choice.value)}>
            <input type="radio" name={`${run.id}-${item.id}`} checked={run.answers[item.id] === choice.value}
              onChange={() => onAnswer(run.id, item.id, choice.value)} />{choice.label}
          </label>)}</div>}
      </fieldset>)}
      <button className="primary" type="submit" disabled={!canSubmitSurvey(run)}>回答を送信</button>
      <p><small>未回答の項目がある間は送信できません。自由回答は空欄でも送信できます。</small></p>
    </form>}
  </div>
}
