import { useState } from 'react'
import { experimentModeSchema, stateLabels, displayLabels, adaptationReasonLabels } from './adaptation'
import type { ExperimentMode } from './adaptation'
import { taskIdSchema, targetTrainIndex, taskTiming, taskInstructionTiming } from './tasks'
import type { TaskId, TaskRun } from './tasks'

const phases = { briefing: '問題文の確認中', preparing: '候補表示準備中', viewing: '情報表示中', 'waiting-stop': '静止確認待ち', answering: '回答中', complete: '回答終了', aborted: '中止' }

export default function TaskController({ hideInference, run, count, elapsedSeconds, disabled, pending, onStart, onBegin, onConfirmStopped, planned, managed = false, startAllowed = true }: {
  planned?: { taskId: TaskId; mode: ExperimentMode } | null
  managed?: boolean
  startAllowed?: boolean
  hideInference: boolean
  run: TaskRun | null
  count: number
  elapsedSeconds: number
  disabled: boolean
  pending: boolean
  onStart: (taskId: TaskId, mode: ExperimentMode) => void
  onBegin: () => void
  onConfirmStopped: () => void
}) {
  const [selectedTaskId, setTaskId] = useState<TaskId>('A1')
  const [selectedMode, setMode] = useState<ExperimentMode>('normal')
  const taskId = planned?.taskId ?? selectedTaskId
  const mode = planned?.mode ?? selectedMode
  const ui = run?.uiLog.at(-1)
  const inProgress = run !== null && !['complete', 'aborted'].includes(run.phase)
  const taskNumber = taskId.slice(1)
  const selected = run?.selectedTrainIndex != null ? run.problem.trains[run.selectedTrainIndex] : null
  const target = run ? run.problem.trains[targetTrainIndex(run.problem)] : null
  return <section>
    <h2>乗換課題・UI適応の確認</h2>
    <p>センサー記録を開始し、問題文を表示してください。参加者の理解と課題開始時の身体状態を確認してから、計測を開始してください。</p>
    <label>条件 <select value={mode} disabled={managed || inProgress || pending} onChange={(event) => setMode(experimentModeSchema.parse(event.currentTarget.value))}>
      <option value="normal">固定UI</option><option value="automatic">自動適応UI</option>
    </select></label>
    <label>問題 <select value={taskId} disabled={managed || inProgress || pending} onChange={(event) => setTaskId(taskIdSchema.parse(event.currentTarget.value))}>
      {taskIdSchema.options.map((id) => <option key={id} value={id}>{id}</option>)}
    </select></label>
    <p>{taskNumber === '1' ? `課題1：${taskTiming.displayMs / 1000}秒間、静止を維持` : taskNumber === '2' ? `課題2：静止で開始、${taskInstructionTiming.firstMs / 1000}秒で歩行指示、${taskInstructionTiming.secondMs / 1000}秒で停止指示` : `課題3：歩行で開始、${taskInstructionTiming.firstMs / 1000}秒で走行指示、${taskInstructionTiming.secondMs / 1000}秒で歩行指示、${taskTiming.displayMs / 1000}秒で停止指示`}</p>
    <p><small>問題・ボタン配置・時刻の回答入力は暫定です。指示・観察はPCの観察欄で別々に記録します。時刻合わせが完了してから課題を開始してください。</small></p>
    <div className="controls">
      <button className="primary" disabled={!startAllowed || disabled || pending || inProgress || count >= 100} onClick={() => onStart(taskId, mode)}>問題文を表示</button>
      <button className="primary" disabled={disabled || pending || run?.phase !== 'briefing' || run.briefingShownAtMs === null} onClick={onBegin}>理解・開始状態を確認して計測開始</button>
      <button disabled={disabled || pending || run?.phase !== 'waiting-stop'} onClick={onConfirmStopped}>静止を目視確認し、回答画面へ</button>
    </div>
    <p>現在：{run ? `${run.purpose === 'practice' ? '練習 ' : ''}${run.taskId} ／ ${phases[run.phase]}` : '開始前'} ／ PC保持課題数（練習含む）：{count}</p>
    {run?.startedAtMs != null && <p>候補表示開始から：{Math.max(0, elapsedSeconds).toFixed(1)}秒（iPhone報告時点）</p>}
    {run && <>
      {run.startedAtMs === null && <p>計測前です。候補はまだ表示していません。</p>}
      <p>問題文表示／開始指示受信／候補表示（iPhone基準ms）：{run.briefingShownAtMs?.toFixed(3) ?? '—'} ／ {run.beginRequestedAtMs?.toFixed(3) ?? '—'} ／ {run.startedAtMs?.toFixed(3) ?? '—'}</p>
      <p>実行中の条件：{run.mode === 'normal' ? '固定UI' : '自動適応UI'} ／ UI反映ログ：{run.uiLog.length}件</p>
      {!hideInference && <>
      <p>UIへ反映した状態：{ui ? displayLabels[ui.appliedState] : '反映待ち'} ／ 理由：{ui ? adaptationReasonLabels[ui.reason] : '—'} ／ 画面：{ui ? ui.surface === 'information' ? '課題情報' : '共通画面' : '—'}</p>
      {ui && <p>安定化後の入力：{stateLabels[ui.inputState]} ／ 古い推定：{ui.stale ? 'はい' : 'いいえ'} ／ iPhoneのReact反映時刻：{ui.appliedAtMs.toFixed(3)}ms</p>}
      {ui?.metrics && <p>実際の行の高さ：{ui.metrics.rowHeightPx?.toFixed(1) ?? '対象外'}px ／ 文字：{ui.metrics.fontSizePx ?? '対象外'}px</p>}
      <p><small>unknown時は直前表示を{run.uiConfig.unknownHoldMs / 1000}秒維持し、その後通常表示に戻します。回答・待機画面は共通です。</small></p>
      </>}
      <p>正しい電車の初回選択：{run.selectedAtMs === null ? '未操作' : `${((run.selectedAtMs - run.startedAtMs!) / 1000).toFixed(3)}秒`}</p>
      <p>正しい選択の初回表示：{run.selectedShownAtMs === null ? '未表示' : `${((run.selectedShownAtMs - run.startedAtMs!) / 1000).toFixed(3)}秒`}（React反映時点）</p>
      <p>想定現在時刻：{run.problem.now} ／ 出発：{run.problem.from} ／ 目的地：{run.problem.to}</p>
      <p>選択中／最後の電車：{selected ? `${selected.departure}発 → ${selected.arrival}着 ／ ${selected.destination}行き` : '未選択'}</p>
      <p>目標の電車：{target?.departure}発 → {target?.arrival}着 ／ 選択回数：{run.events.filter((event) => event.type === 'train-selected').length} ／ 誤選択：{run.events.filter((event) => event.type === 'train-selected' && event.trainIndex !== targetTrainIndex(run.problem)).length}回</p>
    </>}
    {run?.phase === 'complete' && <p>回答：{run.answer ?? '未回答'} ／ 結果：{run.outcome}</p>}
    {run?.phase === 'aborted' && <p className="error">中止理由：{run.abortReason}</p>}
    <p><small>課題中もセンサー記録は継続します。各課題の終了後に復帰・開始状態を確認し、次の問題を選択してください。最後に記録を停止し、JSONを保存してください。</small></p>
  </section>
}
