import type { ExperimentMode } from './adaptation'
import { taskTiming, taskInstructionTiming } from './tasks'
import type { TaskId, TaskRun } from './tasks'

const phases = { briefing: '問題文の確認中', preparing: '候補表示準備中', viewing: '情報表示中', 'waiting-stop': '静止確認待ち', answering: '回答中', complete: '回答終了', aborted: '中止' }

export default function TaskController({ run, count, elapsedSeconds, disabled, pending, onStart, onBegin, onConfirmStopped, planned, startAllowed = true }: {
  planned?: { taskId: TaskId; mode: ExperimentMode } | null
  startAllowed?: boolean
  run: TaskRun | null
  count: number
  elapsedSeconds: number
  disabled: boolean
  pending: boolean
  onStart: (taskId: TaskId, mode: ExperimentMode) => void
  onBegin: () => void
  onConfirmStopped: () => void
}) {
  const taskId = planned?.taskId ?? (run?.taskId !== 'P1' ? run?.taskId : undefined) ?? 'A1'
  const mode = planned?.mode ?? run?.mode ?? 'normal'
  const inProgress = run !== null && !['complete', 'aborted'].includes(run.phase)
  const taskNumber = taskId.slice(1)
  return <section className="task-controls">
    <h3>{mode === 'normal' ? '固定UI' : '自動適応UI'}・{taskId}</h3>
    <p>{taskNumber === '1' ? '静止を維持します。' : taskNumber === '2' ? `静止で開始 → ${taskInstructionTiming.firstMs / 1000}秒で歩行を指示 → ${taskInstructionTiming.secondMs / 1000}秒で停止を指示。` : `歩行で開始 → ${taskInstructionTiming.firstMs / 1000}秒で走行を指示 → ${taskInstructionTiming.secondMs / 1000}秒で歩行を指示 → ${taskTiming.displayMs / 1000}秒で停止を指示。`}</p>
    {inProgress ? <>
      <p className="status" role="status">{phases[run.phase]}</p>
      {run.phase === 'briefing' && <><p>iPhoneの問題文を理解したことと、開始時の身体状態を確認してください。</p>
        <button className="primary" disabled={disabled || pending || run.briefingShownAtMs === null} onClick={onBegin}>理解・開始状態を確認して計測開始</button></>}
      {run.phase === 'preparing' && <p>iPhoneの候補表示を待っています。</p>}
      {run.phase === 'viewing' && <><p className="trial-timer">{Math.max(0, elapsedSeconds).toFixed(1)} <small>／ {run.timing.displayMs / 1000}秒</small></p>
        <p>予定時刻に口頭で動作を指示し、観察・指示欄で実際の時刻を記録してください。</p></>}
      {run.phase === 'waiting-stop' && <><p>情報は非表示です。急停止を求めず、立ち止まったことを目視確認してください。</p>
        <button className="primary" disabled={disabled || pending} onClick={onConfirmStopped}>静止を確認して回答画面へ</button></>}
      {run.phase === 'answering' && <p>iPhoneで回答中です。回答または10秒の期限を待ってください。</p>}
    </> : <><p>開始位置へ戻り、次の課題を始める準備ができたら問題文を表示してください。</p>
      <button className="primary" disabled={!startAllowed || disabled || pending || count >= 100} onClick={() => onStart(taskId, mode)}>問題文を表示</button></>}
  </section>
}
