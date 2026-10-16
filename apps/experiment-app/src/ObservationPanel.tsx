import { useEffect, useRef } from 'react'
import { clockResult, representative } from './research-log'
import type { ObservationKind, ResearchEvent, ResearchLog } from './research-log'
import type { TaskRun } from './tasks'
import { observationGuide, movementLabels } from './observation-plan'

const labels = { transition: '変化開始', stationary: '静止確認', walking: '歩行確認', running: '走行確認', uncertain: '判定困難', missed: '見落とし・記録不能' }
const instructionLabels = { stationary: '停止を指示した', walking: '歩行を指示した', running: '走行を指示した' }
const keyLabels: Partial<Record<ObservationKind, string>> = { stationary: '1', walking: '2', running: '3', uncertain: '4', missed: '5' }
function eventLabel(event: ResearchEvent) {
  return event.kind === 'instruction' ? instructionLabels[event.value as keyof typeof instructionLabels] : labels[event.value]
}
const keys: Record<string, ObservationKind> = { Digit1: 'stationary', Digit2: 'walking', Digit3: 'running', Digit4: 'uncertain', Digit5: 'missed' }
export function canRecordObservation(phase: string | null, answeringSurvey: boolean): boolean {
  return !answeringSurvey && phase !== null && ['briefing', 'preparing', 'viewing', 'waiting-stop', 'answering'].includes(phase)
}
export function observationKey(event: Pick<KeyboardEvent, 'code' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>, target: EventTarget | null): ObservationKind | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.isContentEditable || target.closest('input,textarea,select,button,a,[role="button"],[contenteditable]'))) return null
  return keys[event.code] ?? null
}
export default function ObservationPanel({ log, active, busy, disabled, hidden, onHidden, onRecord, onCalibrate, compact = false, run = null, elapsedMs = 0 }: {
  compact?: boolean; run?: TaskRun | null; elapsedMs?: number
  log: ResearchLog | null; active: boolean; busy: boolean; disabled: boolean; hidden: boolean
  onHidden: (hidden: boolean) => void
  onRecord: (value: ObservationKind) => void
  onCalibrate: () => void
}) {
  const record = useRef(onRecord)
  record.current = onRecord
  useEffect(() => {
    if (!active) return
    const listener = (event: KeyboardEvent) => {
      const kind = observationKey(event, event.target)
      if (kind) { event.preventDefault(); record.current(kind) }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [active])
  const rounds = log?.rounds ?? []
  const last = rounds.at(-1)
  const best = last ? representative(last) : null
  const result = best ? clockResult(best) : null
  const startRound = rounds.find((r) => r.purpose === 'start' && r.endedAtMs !== null && r.exchanges.length)
  const start = startRound ? representative(startRound) : null
  const events = log?.events ?? []
  const guide = observationGuide(run, elapsedMs)
  const taskObservation = events.findLast((event) => event.kind === 'observation' && event.taskRunId === run?.id)
  const observations = events.filter((event) => event.kind === 'observation').length
  const lastTime = (event: ResearchEvent | undefined) => event ? `${(event.controllerAtMs / 1000).toFixed(1)}秒（PC記録時刻）` : ''
  return <section>
    <h2>目視確認</h2>
    {!active && <p className="notice" role="status">目視確認の入力は待機中です。次の問題文が表示されると、ボタン・キーで記録できます。</p>}
    {active && guide && <div className="movement-guide" aria-label="予定の動作">
      <p>{run?.phase === 'briefing' || run?.phase === 'preparing' ? '開始時の動作' : 'いま案内する動作（予定）'}</p>
      <p className="movement-current">{movementLabels[guide.state]}</p>
      {guide.next ? <p>次は{guide.next.atMs / 1000}秒で「{movementLabels[guide.next.state]}」
        {guide.elapsedMs !== null && `（あと${Math.max(0, (guide.next.atMs - guide.elapsedMs) / 1000).toFixed(1)}秒）`}</p>
        : <p>{run?.phase === 'waiting-stop' || run?.phase === 'answering' ? '安全に停止してから回答へ進みます。' : '表示終了まで、この動作を続けます。'}</p>}
      <p><small>実際の動作を見て確認してください。予定を正解として自動記録しません。時間はiPhoneの最新報告を基準にしています。</small></p>
    </div>}
    {active && run?.purpose === 'practice' && <p>練習中です。実験者の案内で動き、実際の足運びだけを確認してください。</p>}
    <div className="observation-group">
      <p>動作が変わったら、実際に確認できた状態を1回押してください。予定と違う状態も、そのまま選べます。</p>
      <div className="observation-buttons">{(['stationary', 'walking', 'running'] as const).map((value) => <button key={value}
        className={active && guide?.state === value ? 'primary' : undefined} disabled={!active}
        onClick={() => onRecord(value)}>{value === 'running' ? '走行確認' : labels[value]}<kbd>{keyLabels[value]}</kbd></button>)}</div>
      <p className="observation-latest" role="status">この課題の最後の目視入力：<strong>{taskObservation ? eventLabel(taskObservation) : '未入力'}</strong>{taskObservation && <small> ／ {lastTime(taskObservation)}</small>}</p>
      <p><small>歩行・走行3歩、静止1秒を確認。開始状態と回答前の静止は、PCの課題開始・回答画面へ進むボタンでも記録します。</small></p>
      <div className="controls">{(['uncertain', 'missed'] as const).map((value) => <button key={value} disabled={!active}
        onClick={() => onRecord(value)}>{labels[value]}<kbd> {keyLabels[value]}</kbd></button>)}</div>
      <p><small>キー：1＝静止、2＝歩行、3＝走行、4＝判定困難、5＝見落とし。キー操作前にこの説明文をクリックしてください。</small></p>
    </div>
    <details className="observation-history"><summary>記録履歴・出力（観察{observations}件／指示{events.length - observations}件）</summary>
      <p>目視確認は端末内保存の対象です。終了後、PCの「保存」から全記録JSONを出力してください。アンケートCSVには含まれません。</p>
      <p>JSONには目視の入力時刻・動作・課題ID・最後に届いた課題段階を記録します。動作予定の設定は observationProtocol、確認記録は research.events に分けます。口頭指示と変化開始の実時刻は入力しません。</p>
      <p><small>以下は最近の5件。全件はJSONの research.events、時刻合わせは research.rounds に保存されます。時刻はPC基準であり、動作開始の正解時刻ではありません。</small></p>
      {events.length ? <ol>{events.slice(-5).map((event, index) => <li key={index}>
        {event.kind === 'instruction' ? '指示' : '観察'}：{eventLabel(event)} ／ {lastTime(event)} ／ {event.reportedPhase ?? '課題外'}
      </li>)}</ol> : <p>まだ記録はありません。</p>}
    </details>
    <details open={!compact}><summary>記録の説明・時刻合わせ</summary>
    <label><input type="checkbox" checked={hidden} onChange={(event) => onHidden(event.currentTarget.checked)} /> 観察用に推定・特徴量・UI状態を隠す</label>
      <p>歩行・走行3歩、静止1秒を基準に足運びを確認します。キー操作前に説明文などをクリックし、ボタン・フォームからフォーカスを外してください。長押しは記録しません。</p>
      <p>見落としは気付いた時点で記録し、現在の状態を確認してください。過去の時刻を推測で補いません。予定時刻を動作開始の正解時刻にしません。</p>
    <p>観察・指示：{log?.events.length ?? 0}件。入力時刻はPC基準で保存し、真の動作開始時刻には置き換えません。</p>
    <button disabled={disabled || busy} onClick={onCalibrate}>時刻合わせを再計測（5回）</button>
    <p>{busy ? '時刻合わせ中。課題を開始せずお待ちください。' : last ? `時刻合わせ終了：成功${last.exchanges.length}／${last.attempts}回、失敗${last.failures}回` : '記録開始後、課題を始める前に自動で時刻合わせします。'}</p>
    {result && <p>iPhone時刻に加える補正：{result.offsetMs.toFixed(3)}ms ／ 往復時間（端末内処理時間を除く）：{result.roundTripMs.toFixed(3)}ms</p>}
    {result && start && <p>開始時との差：{(result.offsetMs - clockResult(start).offsetMs).toFixed(3)}ms（通信の揺らぎも含み、時計のずれだけとは断定しません）</p>}
    {last && !busy && !result && <p className="error">時刻合わせが成立していません。接続を確認して再計測してください。</p>}
    <p><small>PC・iPhoneのperformance時計を対応付けます。元の時刻と全通信記録を保持します。往復経路の非対称性や観察入力の反応遅れがあり、完全な同期ではありません。終了後の時刻合わせが終わってからJSONを保存してください。</small></p>
    </details>
  </section>
}
