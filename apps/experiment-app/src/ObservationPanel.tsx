import { useEffect, useRef } from 'react'
import { clockResult, representative } from './research-log'
import type { ObservationKind, ResearchEvent, ResearchLog } from './research-log'

const labels = { transition: '変化開始', stationary: '静止確認', walking: '歩行確認', running: '走行確認', uncertain: '判定困難', missed: '見落とし・記録不能' }
const keys: Record<string, ObservationKind> = { Space: 'transition', Digit1: 'stationary', Digit2: 'walking', Digit3: 'running', Digit4: 'uncertain' }
export function observationKey(event: Pick<KeyboardEvent, 'code' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>, target: EventTarget | null): ObservationKind | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.isContentEditable || target.closest('input,textarea,select,button,a,[role="button"],[contenteditable]'))) return null
  return keys[event.code] ?? null
}
export default function ObservationPanel({ log, active, busy, disabled, hidden, onHidden, onRecord, onCalibrate }: {
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
  return <section>
    <h2>目視観察・時刻合わせ</h2>
    <label><input type="checkbox" checked={hidden} onChange={(event) => onHidden(event.currentTarget.checked)} /> 観察用に推定・特徴量・UI状態を隠す</label>
    <p>足運びを見て入力してください。指示や自動判定から観察状態を決めません。歩行・走行3歩、静止1秒はリハーサル用の候補基準です。</p>
    <p>キー：Space＝変化開始、1＝静止、2＝歩行、3＝走行、4＝判定困難。長押しは記録しません。フォーム・ボタンにフォーカスがある間はキー入力を無効にします。キーで記録する前に、この説明文などをクリックしてください。</p>
    <div className="controls">{Object.entries(labels).map(([value, label]) => <button key={value} disabled={!active}
      onClick={() => onRecord('observation', value as ObservationKind)}>{label}</button>)}</div>
    <p>記録を忘れた場合は、気付いた時点で「見落とし・記録不能」を記録し、改めて現在の状態を確認して入力してください。過去の時刻は推測で補いません。</p>
    <p>口頭で指示を出した時点を、観察とは別に記録します。予定時刻の自動記録ではありません。</p>
    <div className="controls">{(['stationary', 'walking', 'running'] as const).map((value) => <button key={value} disabled={!active}
      onClick={() => onRecord('instruction', value)}>{value === 'stationary' ? '停止' : value === 'walking' ? '歩行' : '走行'}を指示した</button>)}</div>
    <p>観察・指示：{log?.events.length ?? 0}件。入力時刻はPC基準で保存し、真の動作開始時刻には置き換えません。</p>
    <ol>{log?.events.slice(-5).map((event, index) => <li key={index}>{event.controllerAtMs.toFixed(1)}ms：{event.kind === 'instruction' ? '指示' : '観察'} ／ {labels[event.value]} ／ {event.reportedPhase ?? '課題外'}（iPhoneから最後に届いた段階）</li>)}</ol>
    <button disabled={disabled || busy} onClick={onCalibrate}>時刻合わせを再計測（5回）</button>
    <p>{busy ? '時刻合わせ中。課題を開始せずお待ちください。' : last ? `時刻合わせ終了：成功${last.exchanges.length}／${last.attempts}回、失敗${last.failures}回` : '記録開始後、課題を始める前に自動で時刻合わせします。'}</p>
    {result && <p>iPhone時刻に加える補正：{result.offsetMs.toFixed(3)}ms ／ 往復時間（端末内処理時間を除く）：{result.roundTripMs.toFixed(3)}ms</p>}
    {result && start && <p>開始時との差：{(result.offsetMs - clockResult(start).offsetMs).toFixed(3)}ms（通信の揺らぎも含み、時計のずれだけとは断定しません）</p>}
    {last && !busy && !result && <p className="error">時刻合わせが成立していません。接続を確認して再計測してください。</p>}
    <p><small>PC・iPhoneのperformance時計を対応付けます。元の時刻と全通信記録を保持します。往復経路の非対称性や観察入力の反応遅れがあり、完全な同期ではありません。終了後の時刻合わせが終わってからJSONを保存してください。</small></p>
  </section>
}
