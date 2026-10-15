import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { arrivalTimeSchema } from './tasks'
import type { CSSProperties } from 'react'
import type { PresentationMetrics, RenderedTaskContext } from './adaptation'
import type { TaskRun } from './tasks'

export default function TransitTaskScreen({ run, onPresent, onAdvance, onSelectTrain, onAnswer, onTap, onStop, onPracticeBegin, onPracticeConfirm, onPracticeFinish }: {
  run: TaskRun
  onPresent: (metrics: PresentationMetrics, rendered: RenderedTaskContext) => void
  onAdvance: () => void
  onSelectTrain: (index: number) => void
  onAnswer: (value: string) => void
  onTap: (x: number, y: number, action: string) => void
  onPracticeBegin?: () => void
  onPracticeConfirm?: () => void
  onPracticeFinish?: () => void
  onStop: () => void
}) {
  const firstRow = useRef<HTMLButtonElement | null>(null)
  const [digits, setDigits] = useState('')
  const [unknown, setUnknown] = useState(false)
  const practice = run.purpose === 'practice'
  const task = run.problem
  const briefingVisible = run.phase === 'briefing'
  const informationVisible = run.phase === 'preparing' || run.phase === 'viewing'
  const arrival = digits.length === 4 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : ''
  const validAnswer = unknown || arrivalTimeSchema.safeParse(arrival).success
  const appliedState = informationVisible ? run.uiDecision.state : 'stationary'
  const profile = run.uiConfig.profiles[appliedState]
  useLayoutEffect(() => {
    const row = firstRow.current
    onPresent({ rowHeightPx: row?.getBoundingClientRect().height ?? null,
      fontSizePx: row ? Number.parseFloat(getComputedStyle(row).fontSize) : null,
      viewportHeightPx: window.innerHeight }, { phase: run.phase, decisionKey: JSON.stringify(run.uiDecision), selectedTrainIndex: run.selectedTrainIndex })
  }, [run.id, run.phase, run.selectedTrainIndex, run.uiDecision.decidedAtMs, run.uiDecision.state, run.uiDecision.reason, run.uiDecision.stale, onPresent])
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
    {briefingVisible || informationVisible ? <div className="task-information">
      <h1>{practice && '練習：'}{task.to}行きで次に発車する電車を選び、到着時刻を確認してください。</h1>
      <div className="task-context">
        <p>想定現在時刻：<strong>{task.now}</strong></p>
        <p>出発：{task.from}駅 ／ 目的地：{task.to}駅</p>
      </div>
      {informationVisible ? <>
      <p className="task-line">{task.line}</p>
      <div className="task-train-columns" aria-hidden="true"><span>発車</span><span>到着</span><span>行先</span></div>
      <ul className="task-trains" aria-label="電車の候補">
        {task.trains.map((train, index) => <li key={train.departure}>
          <button ref={index === 0 ? firstRow : undefined} className="task-train" aria-pressed={run.selectedTrainIndex === index}
            data-task-action={`train-${index}`} onClick={() => onSelectTrain(index)}>
            <span>{train.departure}</span><span>{train.arrival}</span><span>{train.destination}</span>
          </button>
        </li>)}
      </ul>
      </> : <p>{practice ? '問題を理解したら、下のボタンで練習を開始してください。' : '問題を理解できたら実験者にお知らせください。'}開始後に電車の候補が表示されます。</p>}
    </div> : run.phase === 'answering' ? <>
      <h1>{practice && '練習：'}指定された行先へ次に発車する電車の到着時刻を回答してください。</h1>
      <p className="task-answer" aria-live="polite">{unknown ? '分からない' : `${digits.padEnd(4, '－').slice(0, 2)}:${digits.padEnd(4, '－').slice(2)}`}</p>
      <p>時・分を4桁で入力してください。</p>
      <div className="task-keypad">
        {Array.from({ length: 9 }, (_, i) => i + 1).map((value) =>
          <button key={value} data-task-action={`answer-${value}`} onClick={() => enterDigit(value)}>{value}</button>)}
        <button data-task-action="answer-clear" onClick={() => { setDigits(''); setUnknown(false) }}>消去</button>
        <button data-task-action="answer-0" onClick={() => enterDigit(0)}>0</button>
        <button data-task-action="answer-delete" onClick={() => { setDigits((current) => current.slice(0, -1)); setUnknown(false) }}>1字戻す</button>
      </div>
      <div className="controls">
        <button aria-pressed={unknown} data-task-action="answer-unknown" onClick={() => { setUnknown((current) => !current); setDigits('') }}>分からない</button>
        <button className="primary" data-task-action="submit" disabled={!validAnswer} onClick={() => { if (validAnswer) onAnswer(unknown ? 'unknown' : arrival) }}>回答送信</button>
      </div>
    </> : <>
      <h1>{run.phase === 'waiting-stop' ? '情報の表示を終了しました' : run.phase === 'aborted' ? '中止しました' : '回答を終了しました'}</h1>
      <p>{run.phase === 'waiting-stop' ? practice ? '安全に立ち止まったことを確認してから、回答へ進んでください。' : '安全に立ち止まり、実験者の案内をお待ちください。' : '実験者の案内をお待ちください。'}</p>
    </>}
    {practice && run.phase === 'briefing' && <>
      <p>行をタップすると選択でき、選び直せます。{run.timing.displayMs / 1000}秒後に情報が消えたら、安全に立ち止まってから到着時刻を4桁で回答します。身体の動きは実験者の指示に従ってください。</p>
      <button className="primary" data-task-action="practice-begin" disabled={run.briefingShownAtMs === null} onClick={onPracticeBegin}>理解したので練習を開始</button>
    </>}
    {practice && run.phase === 'waiting-stop' && <button className="primary" data-task-action="practice-confirm" onClick={onPracticeConfirm}>立ち止まったので回答へ</button>}
    {practice && ['complete', 'aborted'].includes(run.phase) && <button data-task-action="practice-finish" onClick={onPracticeFinish}>練習を閉じる</button>}
    {!['complete', 'aborted'].includes(run.phase) && <footer><button data-task-action="emergency-stop" onClick={onStop}>実験を中止</button></footer>}
  </div>
}
