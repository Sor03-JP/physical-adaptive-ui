import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { arrivalTimeSchema, isDelayedTrain, minutesBetween } from './tasks'
import type { CSSProperties, ReactNode } from 'react'
import type { PresentationMetrics, RenderedTaskContext } from './adaptation'
import type { TaskRun } from './tasks'
import { movementPlanText } from './observation-plan'

export default function TransitTaskScreen({ run, onPresent, onAdvance, onShowDetails, onSelectTrain, onAnswer, onTap, onPracticeBegin, onPracticeConfirm, onPracticeFinish, onConfirmStopped, audioControls, onBegin, error = '', pending = false }: {
  run: TaskRun
  onPresent: (metrics: PresentationMetrics, rendered: RenderedTaskContext) => void
  onAdvance: () => void
  onShowDetails: (index: number | null) => void
  onSelectTrain: (index: number) => void
  onAnswer: (value: string) => void
  onTap: (x: number, y: number, action: string) => void
  onPracticeBegin?: () => void
  onPracticeConfirm?: () => void
  onPracticeFinish?: () => void
  onConfirmStopped?: () => void
  audioControls?: ReactNode
  onBegin?: () => void
  error?: string; pending?: boolean
}) {
  const firstRow = useRef<HTMLButtonElement | null>(null)
  const detailArrival = useRef<HTMLElement | null>(null)
  const [digits, setDigits] = useState('')
  const [unknown, setUnknown] = useState(false)
  const practice = run.purpose === 'practice'
  const task = run.problem
  const openTrainIndex = run.kind === 'earliest-arrival' ? run.openTrainIndex : null
  const openTrain = run.kind === 'earliest-arrival' && openTrainIndex !== null ? run.problem.trains[openTrainIndex] : null
  const delayed = openTrain !== null && isDelayedTrain(openTrain)
  const briefingVisible = run.phase === 'briefing'
  const informationVisible = run.phase === 'preparing' || run.phase === 'viewing'
  const arrival = digits.length === 4 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : ''
  const validAnswer = unknown || arrivalTimeSchema.safeParse(arrival).success
  const appliedState = informationVisible ? run.uiDecision.state : 'stationary'
  const profile = run.uiConfig.profiles[appliedState]
  const decisionKey = JSON.stringify(run.uiDecision)
  useLayoutEffect(() => {
    const row = firstRow.current
    const text = row ?? detailArrival.current
    onPresent({ rowHeightPx: row?.getBoundingClientRect().height ?? null,
      fontSizePx: text ? Number.parseFloat(getComputedStyle(text).fontSize) : null,
      viewportHeightPx: window.innerHeight }, { phase: run.phase, decisionKey, selectedTrainIndex: run.selectedTrainIndex, openTrainIndex })
  }, [run.id, run.phase, run.selectedTrainIndex, decisionKey, openTrainIndex, onPresent])
  const deadline = run.phase === 'viewing' && run.startedAtMs !== null ? run.startedAtMs + run.timing.displayMs
    : run.phase === 'answering' && run.answerShownAtMs !== null ? run.answerShownAtMs + run.timing.answerMs : null
  useEffect(() => {
    if (deadline === null) return
    const timer = window.setTimeout(onAdvance, Math.max(0, deadline - performance.now()))
    return () => clearTimeout(timer)
  }, [deadline, onAdvance])
  function enterDigit(value: number) {
    setUnknown(false); setDigits((current) => (unknown ? '' : current).concat(value.toString()).slice(0, 4))
  }
  return <div className="task-screen" data-purpose={run.purpose} data-phase={run.phase} data-physical-state={appliedState}
    style={{ '--task-row-height': `${profile.rowHeightPx}px`, '--task-row-font': `${profile.fontSizePx}px` } as CSSProperties} onPointerDown={(event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-task-action]') : null
    onTap(event.clientX, event.clientY, target?.getAttribute('data-task-action') ?? 'outside')
  }}>
    {error && <p className="error callout" role="alert">{error}</p>}
    {briefingVisible || informationVisible ? <div className="task-information">
      <h1>{practice && '練習：'}{run.kind === 'earliest-arrival'
        ? `今から乗れる便のうち、${task.to}駅に最も早く着く便を選んでください。`
        : `${task.to}行きで次に発車する電車を選び、到着時刻を確認してください。`}</h1>
      <div className="task-context">
        <p>想定現在時刻：<strong>{task.now}</strong></p>
        <p>出発：{task.from}駅 ／ 目的地：{task.to}駅</p>
      </div>
      {informationVisible && run.kind === 'earliest-arrival' && (openTrain && openTrainIndex !== null ? <>
        <section className="task-route-details">
          <header className="task-route-detail-header">
            <h2>{openTrain.line}</h2>
            <span className="task-route-status" data-delayed={delayed || undefined}>{delayed ? '遅延' : '定刻'}</span>
            <p>見込み所要時間 <strong>{minutesBetween(openTrain.departure, openTrain.arrival)}分</strong></p>
          </header>
          <dl className="task-route-timeline">
            <div>
              <dt><small>発車見込み</small>{task.from}駅</dt>
              <dd><strong>{openTrain.departure}</strong>
                {openTrain.scheduledDeparture !== undefined && openTrain.scheduledDeparture !== openTrain.departure &&
                  <small>{`定刻 ${openTrain.scheduledDeparture}・${minutesBetween(openTrain.scheduledDeparture, openTrain.departure)}分遅れ`}</small>}</dd>
            </div>
            <div>
              <dt><small>到着見込み</small>{task.to}駅</dt>
              <dd><strong ref={detailArrival}>{openTrain.arrival}</strong>
                {openTrain.scheduledArrival !== openTrain.arrival &&
                  <small>{`定刻 ${openTrain.scheduledArrival}・${minutesBetween(openTrain.scheduledArrival, openTrain.arrival)}分遅れ`}</small>}</dd>
            </div>
          </dl>
        </section>
        <div className="task-route-actions">
          <button data-task-action="route-back" onClick={() => onShowDetails(null)}>一覧に戻る</button>
          <button className="primary" data-task-action={`route-select-${openTrainIndex}`} disabled={run.selectedTrainIndex === openTrainIndex}
            onClick={() => onSelectTrain(openTrainIndex)}>{run.selectedTrainIndex === openTrainIndex ? '選択済み' : 'この便を選ぶ'}</button>
        </div>
      </> : <ul className="task-trains task-routes" aria-label="路線の候補">
        {run.problem.trains.map((train, index) => {
          const delayed = isDelayedTrain(train)
          const selected = run.selectedTrainIndex === index
          const departure = train.scheduledDeparture
          return <li key={train.line}>
            <button ref={index === 0 ? firstRow : undefined} className="task-train task-route" data-selected={selected || undefined}
              data-task-action={`route-open-${index}`} onClick={() => onShowDetails(index)}>
              <strong>{departure === undefined ? '—' : `${minutesBetween(departure, train.scheduledArrival)}分`}</strong>
              <span className="task-route-status" data-delayed={delayed || undefined}>{delayed ? '遅延' : '定刻'}{selected && '・選択済み'}</span>
              <span className="task-route-times">{`予定 ${departure ?? '—'} 発 → ${train.scheduledArrival} 着`}</span>
              <span className="task-route-meta">{task.from}駅 <strong>{train.line}</strong></span>
            </button>
          </li>
        })}
      </ul>)}
      {informationVisible && run.kind === 'next-departure' && <>
        <p className="task-line">{run.problem.line}</p>
        <div className="task-train-columns" aria-hidden="true"><span>発車</span><span>到着</span><span>行先</span></div>
        <ul className="task-trains" aria-label="電車の候補">
          {run.problem.trains.map((train, index) => <li key={train.departure}>
            <button ref={index === 0 ? firstRow : undefined} className="task-train" aria-pressed={run.selectedTrainIndex === index}
              data-task-action={`train-${index}`} onClick={() => onSelectTrain(index)}>
              <span>{train.departure}</span><span>{train.arrival}</span><span>{train.destination}</span>
            </button>
          </li>)}
        </ul>
      </>}
      {!informationVisible && <>
        {run.kind === 'earliest-arrival' && <p>一部の路線が遅延しています。一覧には定刻を表示します。詳細で到着見込みを比べて「この便を選ぶ」を押し、選んだ便の到着見込み時刻を覚えてください。</p>}
        <div className="callout">
          <strong>この課題の動作</strong>
          <p>{movementPlanText(run.taskId, run.timing.displayMs)}</p>
        </div>
        <p>中止したいときは、安全に立ち止まって実験者に伝えてください。</p>
        <p>{practice ? '問題を理解したら、下のボタンで練習を開始してください。' : '問題を理解できたら実験者にお知らせください。'}開始後に候補が表示されます。</p>
      </>}
    </div> : run.phase === 'answering' ? <>
      <h1>{practice && '練習：'}到着時刻を回答</h1>
      <p>{run.kind === 'earliest-arrival' ? '選んだ便の到着見込み時刻を' : '指定された行先へ次に発車する電車の到着時刻を'}
        {run.timing.answerMs / 1000}秒以内に4桁で入力してください（例：09:30 → 0930）。</p>
      <div className="answer-pad">
        <div className="answer-display">
          <span>入力した到着時刻</span>
          <p className="task-answer" aria-live="polite">{unknown ? '分からない' : `${digits.padEnd(4, '－').slice(0, 2)}:${digits.padEnd(4, '－').slice(2)}`}</p>
        </div>
        <div className="task-keypad">
          {Array.from({ length: 9 }, (_, i) => i + 1).map((value) =>
            <button key={value} data-task-action={`answer-${value}`} onClick={() => enterDigit(value)}>{value}</button>)}
          <button data-task-action="answer-clear" onClick={() => { setDigits(''); setUnknown(false) }}>消去</button>
          <button data-task-action="answer-0" onClick={() => enterDigit(0)}>0</button>
          <button data-task-action="answer-delete" onClick={() => { setDigits((current) => current.slice(0, -1)); setUnknown(false) }}>1字戻す</button>
        </div>
      </div>
      <div className="answer-actions">
        <button aria-pressed={unknown} data-task-action="answer-unknown" onClick={() => { setUnknown((current) => !current); setDigits('') }}>分からない</button>
        <button className="primary" data-task-action="submit" disabled={!validAnswer} onClick={() => { if (validAnswer) onAnswer(unknown ? 'unknown' : arrival) }}>回答送信</button>
      </div>
    </> : <>
      <h1>{run.phase === 'waiting-stop' ? '安全に立ち止まってください' : run.phase === 'aborted' ? '中止しました' : '回答を終了しました'}</h1>
      <p>{run.phase === 'waiting-stop' ? practice ? '立ち止まってから、下の「立ち止まったので回答へ」を押してください。' : '立ち止まったら、実験者の停止確認をお待ちください。'
        : run.phase === 'aborted' ? '操作をやめて、実験者にお知らせください。'
        : practice ? '下の「練習を閉じる」を押してください。' : 'この課題は終了です。次の問題やアンケートは実験者が表示します。このまま案内をお待ちください。'}</p>
    </>}
    {briefingVisible && audioControls}
    {!practice && briefingVisible && onBegin && <button className="primary" data-task-action="phone-begin"
      disabled={pending || run.briefingShownAtMs === null} onClick={onBegin}>実験者の開始状態の確認を受けて開始</button>}
    {practice && run.phase === 'briefing' && <>
      <p>{run.kind === 'earliest-arrival' ? '路線をタップすると詳細が開きます。「一覧に戻る」で比較でき、選び直しもできます。' : '行をタップすると選択でき、選び直せます。'}
        {run.timing.displayMs / 1000}秒後に情報が消えたら、安全に立ち止まってから到着時刻を4桁で回答します。</p>
      <button className="primary" data-task-action="practice-begin" disabled={run.briefingShownAtMs === null} onClick={onPracticeBegin}>理解したので練習を開始</button>
    </>}
    {practice && run.phase === 'waiting-stop' && <button className="primary" data-task-action="practice-confirm" onClick={onPracticeConfirm}>立ち止まったので回答へ</button>}
    {!practice && run.phase === 'waiting-stop' && <button className="primary" data-task-action="confirm-stopped" onClick={onConfirmStopped}>実験者用：停止を確認して回答へ</button>}
    {practice && ['complete', 'aborted'].includes(run.phase) && <button data-task-action="practice-finish" onClick={onPracticeFinish}>練習を閉じる</button>}
  </div>
}
