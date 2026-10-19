import { useState } from 'react'
import type { TaskRun } from './task-schema'
import { latestMovementConfirmation, movementConfirmationSchema, movementSegments } from './movement-confirmation'
import type { MovementConfirmation, MovementConfirmationInput } from './movement-confirmation'

export default function MovementConfirmationPanel({ tasks, history, disabled, onSave }: {
  tasks: TaskRun[]; history: MovementConfirmation[]; disabled: boolean
  onSave: (input: MovementConfirmationInput) => void
}) {
  const completed = tasks.filter((task) => task.purpose === 'main' && task.phase === 'complete')
  if (!completed.length) return null
  const pending = completed.filter((task) => !latestMovementConfirmation(history, task.id))
  const confirmed = completed.filter((task) => latestMovementConfirmation(history, task.id))
  const form = (task: TaskRun) => <ConfirmationForm key={`${task.id}:${history.filter((entry) => entry.taskRunId === task.id).length}`}
    task={task} latest={latestMovementConfirmation(history, task.id)} disabled={disabled} onSave={onSave} />
  return <section className="movement-confirmation" aria-label="課題終了後の動作確認">
    <h3>課題終了後の動作確認</h3>
    <p>候補を表示した15秒間に、指示に応じた動作を実施できたか確認してください。切替時刻を正確に測った記録ではありません。</p>
    {pending.map(form)}
    {confirmed.length > 0 && <details><summary>確認済みの課題を確認・修正（{confirmed.length}件）</summary>
      <p>修正前の内容もJSONに残ります。集計では最後の確認を使います。</p>{confirmed.map(form)}</details>}
  </section>
}

function ConfirmationForm({ task, latest, disabled, onSave }: {
  task: TaskRun; latest?: MovementConfirmation; disabled: boolean; onSave: (input: MovementConfirmationInput) => void
}) {
  const [editing, setEditing] = useState(false)
  const [segments, setSegments] = useState<MovementConfirmation['deviations'][number]['segments']>(latest?.deviations[0]?.segments ?? [])
  const [comment, setComment] = useState(latest?.deviations[0]?.comment ?? '')
  const deviations = [{ segments: task.taskId.endsWith('1') ? ['all' as const] : segments, comment: comment.trim() }]
  const input: MovementConfirmationInput = { taskRunId: task.id, status: 'deviation', deviations }
  const valid = movementConfirmationSchema.safeParse({ ...input, confirmedAtControllerMs: 0 }).success
  return <fieldset disabled={disabled}>
    <legend>{task.mode === 'normal' ? '固定表示' : '自動表示'}・{task.taskId}</legend>
    <p role="status">{latest ? `確認済み：${latest.status === 'as-planned' ? '予定どおり' : 'ずれあり'}` : '未確認'}</p>
    {latest?.deviations.map((deviation, index) => <p key={index}>{deviation.segments.map((segment) => movementSegments[segment]).join('・')}：{deviation.comment}</p>)}
    <div className="controls">
      <button type="button" onClick={() => onSave({ taskRunId: task.id, status: 'as-planned', deviations: [] })}>予定どおり</button>
      <button type="button" aria-expanded={editing} onClick={() => setEditing(!editing)}>ずれあり</button>
    </div>
    {editing && <>
      {!task.taskId.endsWith('1') && <div><p>ずれがあった区間（複数選択可）</p>
        {(Object.keys(movementSegments) as (keyof typeof movementSegments)[]).map((segment) => <label key={segment}>
          <input type="checkbox" checked={segments.includes(segment)} onChange={(event) => setSegments(event.currentTarget.checked
            ? segment === 'all' ? ['all'] : [...segments.filter((value) => value !== 'all'), segment]
            : segments.filter((value) => value !== segment))} /> {movementSegments[segment]}
        </label>)}</div>}
      <label>内容（必須）<textarea value={comment} maxLength={1000} rows={2} placeholder="例：歩行開始の指示が遅れた／途中で立ち止まった"
        onChange={(event) => setComment(event.currentTarget.value)} /></label>
      <button type="button" disabled={!valid} onClick={() => onSave(input)}>確認を保存</button>
    </>}
  </fieldset>
}
