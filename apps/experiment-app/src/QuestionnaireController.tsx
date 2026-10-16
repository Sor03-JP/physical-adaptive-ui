import { conditionTaskIds, surveyTitle } from './questionnaire'
import type { SurveyRun, SurveyTarget } from './questionnaire'
import type { TaskRun } from './task-schema'

export default function QuestionnaireController({ runs, tasks, disabled, onOpen, onExport, allowedTarget, focused = false, readOnly = false }: {
  focused?: boolean; readOnly?: boolean
  runs: SurveyRun[]; tasks: TaskRun[]; disabled: boolean
  allowedTarget?: SurveyTarget | null
  onExport?: () => void
  onOpen: (target: SurveyTarget, linkedIds: string[]) => void
}) {
  const answering = runs.some((r) => r.phase === 'answering')
  const linked = runs.filter((r) => r.target !== 'final' && r.phase === 'submitted').map((r) => r.id)
  if (focused) {
    const current = runs.find((r) => r.target === allowedTarget)
    const target = allowedTarget
    if (!target) return null
    const ids = target === 'final' ? linked : conditionTaskIds(tasks, target)
    return <section className="survey-controls"><h3>{surveyTitle[target]}</h3>
      {current ? <p className="status" role="status">{current.phase === 'submitted' ? '回答を受信しました。' : `iPhoneで回答中です（${current.items.filter((item) => item.required && current.answers[item.id] !== undefined).length}／${current.items.filter((item) => item.required).length}項目入力）。送信を待ってください。`}</p>
        : <><p>立ち止まったことを目視確認してから、iPhoneにアンケートを表示します。</p>
          <button className="primary" disabled={disabled || answering || ids.length !== (target === 'final' ? 2 : 3)} onClick={() => onOpen(target, ids)}>静止を確認してアンケートを表示</button></>}
    </section>
  }
  return <section>
    <h2>アンケート</h2>
    <p>2条件とアンケートを同じ記録内で実施します。各条件の3課題が終了したら、静止を目視確認して表示してください。回答中は次の課題を開始できません。</p>
    {!readOnly && <div className="controls">{(['normal', 'automatic'] as const).map((mode) => {
      const ids = conditionTaskIds(tasks, mode)
      return <button key={mode} disabled={(allowedTarget !== undefined && allowedTarget !== mode) || disabled || answering || ids.length !== 3 || runs.some((r) => r.target === mode)}
        onClick={() => onOpen(mode, ids)}>静止を確認し、{mode === 'normal' ? '固定UI後（5項目）' : '自動適応UI後（7項目）'}を表示</button>
    })}
      <button disabled={(allowedTarget !== undefined && allowedTarget !== 'final') || disabled || answering || linked.length !== 2 || runs.some((r) => r.target === 'final')}
        onClick={() => onOpen('final', linked)}>静止を確認し、最後の比較・自由回答を表示</button>
    </div>}
    {onExport && <button disabled={!runs.length} onClick={onExport}>アンケートCSVをPCに出力</button>}
    {runs.map((run) => <details key={run.id} open={run.phase === 'answering'}>
      <summary>{surveyTitle[run.target]}：{run.phase === 'submitted' ? '回答済み・PC受信済み' : '回答中'}（{Object.keys(run.answers).length}項目受信）</summary>
      <p>対応ID：{run.linkedIds.join(' ／ ')}</p>
      <dl>{run.items.map((item) => <div key={item.id}><dt>{item.text}</dt><dd>{run.answers[item.id] === undefined ? '未回答'
        : item.id === 'comment' ? String(run.answers[item.id]) || '空欄'
          : item.choices.find((choice) => choice.value === run.answers[item.id])?.label}</dd></div>)}</dl>
    </details>)}
    <p><small>設問ごとの回答を保存します。合計点や正誤は表示しません。CSVは1設問1行で、数値・判断できない・未回答・任意欄の空欄を区別します。回答途中もJSON・CSVに残り、「回答済み」とは区別します。</small></p>
  </section>
}
