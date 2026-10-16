import { useEffect, useRef } from 'react'
import { clockResult, representative } from './research-log'
import type { ObservationKind, ResearchEvent, ResearchLog } from './research-log'

const labels = { transition: '変化開始', stationary: '静止確認', walking: '歩行確認', running: '走行確認', uncertain: '判定困難', missed: '見落とし・記録不能' }
const instructionLabels = { stationary: '停止を指示した', walking: '歩行を指示した', running: '走行を指示した' }
const keyLabels: Partial<Record<ObservationKind, string>> = { transition: 'Space', stationary: '1', walking: '2', running: '3', uncertain: '4' }
function eventLabel(event: ResearchEvent) {
  return event.kind === 'instruction' ? instructionLabels[event.value as keyof typeof instructionLabels] : labels[event.value]
}
const keys: Record<string, ObservationKind> = { Space: 'transition', Digit1: 'stationary', Digit2: 'walking', Digit3: 'running', Digit4: 'uncertain' }
export function canRecordObservation(phase: string | null, answeringSurvey: boolean): boolean {
  return !answeringSurvey && phase !== null && ['briefing', 'preparing', 'viewing', 'waiting-stop', 'answering'].includes(phase)
}
export function observationKey(event: Pick<KeyboardEvent, 'code' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>, target: EventTarget | null): ObservationKind | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.isContentEditable || target.closest('input,textarea,select,button,a,[role="button"],[contenteditable]'))) return null
  return keys[event.code] ?? null
}
export default function ObservationPanel({ log, active, busy, disabled, hidden, onHidden, onRecord, onCalibrate, compact = false }: {
  compact?: boolean
  log: ResearchLog | null; active: boolean; busy: boolean; disabled: boolean; hidden: boolean
  onHidden: (hidden: boolean) => void
  onRecord: (kind: ResearchEvent['kind'], value: ObservationKind) => void
  onCalibrate: () => void
}) {
  const record = useRef(onRecord)
  record.current = onRecord
  useEffect(() => {
    if (!active) return
    const listener = (event: KeyboardEvent) => {
      const kind = observationKey(event, event.target)
      if (kind) { event.preventDefault(); record.current('observation', kind) }
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
  const observed = events.findLast((event) => event.kind === 'observation')
  const instructed = events.findLast((event) => event.kind === 'instruction')
  const observations = events.filter((event) => event.kind === 'observation').length
  const lastTime = (event: ResearchEvent | undefined) => event ? `${(event.controllerAtMs / 1000).toFixed(1)}秒（PC記録時刻）` : ''
  return <section>
    <h2>{compact ? '観察・指示を記録' : '目視観察・時刻合わせ'}</h2>
    {!active && <p className="notice" role="status">観察・指示の入力は待機中です。次の問題文が表示されると、ボタン・キーで記録できます。</p>}
    {!compact && <>
    <label><input type="checkbox" checked={hidden} onChange={(event) => onHidden(event.currentTarget.checked)} /> 観察用に推定・特徴量・UI状態を隠す</label>
    <p>足運びを見て入力してください。指示や自動判定から観察状態を決めません。歩行・走行3歩、静止1秒はリハーサル用の候補基準です。</p>
    <p>キー：Space＝変化開始、1＝静止、2＝歩行、3＝走行、4＝判定困難。長押しは記録しません。フォーム・ボタンにフォーカスがある間はキー入力を無効にします。キーで記録する前に、この説明文などをクリックしてください。</p>
    </>}
    <div className="observation-group">
    <h3>目視した動作</h3>
    <p className="observation-latest" role="status">最後の観察：<strong>{observed ? eventLabel(observed) : '未入力'}</strong>{observed && <small> ／ {lastTime(observed)}</small>}</p>
    <p><small>変わり始めたら「変化開始」→ 足運びを継続確認して「静止・歩行・走行」を記録。</small></p>
    <div className="observation-buttons">{Object.entries(labels).map(([value, label]) => <button key={value} disabled={!active}
      data-observation={value} onClick={() => onRecord('observation', value as ObservationKind)}>{label}{keyLabels[value as ObservationKind] && <kbd>{keyLabels[value as ObservationKind]}</kbd>}</button>)}</div>
    <p><small>歩行・走行は3歩、静止は1秒を確認。キー操作前にこの説明文をクリックしてください。</small></p>
    </div>
    {!compact && <p>記録を忘れた場合は、気付いた時点で「見落とし・記録不能」を記録し、改めて現在の状態を確認して入力してください。過去の時刻は推測で補いません。</p>}
    <div className="observation-group">
    <h3>口頭で出した指示</h3>
    <p className="observation-latest" role="status">最後の指示：<strong>{instructed ? eventLabel(instructed) : '未入力'}</strong>{instructed && <small> ／ {lastTime(instructed)}</small>}</p>
    <p><small>実際に声をかけた時点で押します。観察状態は別に記録してください。</small></p>
    <div className="observation-buttons">{(['stationary', 'walking', 'running'] as const).map((value) => <button key={value} disabled={!active}
      onClick={() => onRecord('instruction', value)}>{instructionLabels[value]}</button>)}</div>
    </div>
    <details className="observation-history"><summary>記録履歴・出力（観察{observations}件／指示{events.length - observations}件）</summary>
      <p>観察・指示は端末内保存の対象です。終了後、PCの「保存」から全記録JSONを出力してください。アンケートCSVには含まれません。</p>
      <p>JSONには、入力時刻・指示／観察の区分・動作・対応する課題ID・iPhoneから最後に届いた課題段階が入ります。時刻合わせの記録も同じJSONに含まれます。</p>
      <p><small>以下は最近の5件。全件はJSONの research.events、時刻合わせは research.rounds に保存されます。時刻はPC基準であり、動作開始の正解時刻ではありません。</small></p>
      {events.length ? <ol>{events.slice(-5).map((event, index) => <li key={index}>
        {event.kind === 'instruction' ? '指示' : '観察'}：{eventLabel(event)} ／ {lastTime(event)} ／ {event.reportedPhase ?? '課題外'}
      </li>)}</ol> : <p>まだ記録はありません。</p>}
    </details>
    <details open={!compact}><summary>記録の説明・時刻合わせ</summary>
    {compact && <><label><input type="checkbox" checked={hidden} onChange={(event) => onHidden(event.currentTarget.checked)} /> 観察用に推定・特徴量・UI状態を隠す</label>
      <p>歩行・走行3歩、静止1秒を基準に足運びを確認します。キー操作前に説明文などをクリックし、ボタン・フォームからフォーカスを外してください。長押しは記録しません。</p>
      <p>見落としは気付いた時点で記録し、現在の状態を確認してください。過去の時刻を推測で補いません。指示と観察は別々に記録します。</p></>}
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
