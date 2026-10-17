import { clockResult, representative } from './research-log'
import type { ResearchEvent, ResearchLog } from './research-log'
import type { TaskRun } from './tasks'
import { observationGuide, movementLabels } from './observation-plan'

const labels = { transition: '変化開始', stationary: '静止確認', walking: '歩行確認', running: '走行確認', uncertain: '判定困難', missed: '見落とし・記録不能' }
const instructionLabels = { stationary: '停止を指示した', walking: '歩行を指示した', running: '走行を指示した' }
function eventLabel(event: ResearchEvent) {
  return event.kind === 'instruction' ? instructionLabels[event.value as keyof typeof instructionLabels] : labels[event.value]
}
export default function ObservationPanel({ log, busy, disabled, hidden, onHidden, onCalibrate, run, elapsedMs }: {
  run: TaskRun | null; elapsedMs: number
  log: ResearchLog | null; busy: boolean; disabled: boolean; hidden: boolean
  onHidden: (hidden: boolean) => void
  onCalibrate: () => void
}) {
  const rounds = log?.rounds ?? []
  const last = rounds.at(-1)
  const best = last ? representative(last) : null
  const result = best ? clockResult(best) : null
  const startRound = rounds.find((r) => r.purpose === 'start' && r.endedAtMs !== null && r.exchanges.length)
  const start = startRound ? representative(startRound) : null
  const events = log?.events ?? []
  const guide = observationGuide(run, elapsedMs)
  const observations = events.filter((event) => event.kind === 'observation').length
  const lastTime = (event: ResearchEvent | undefined) => event ? `${(event.controllerAtMs / 1000).toFixed(1)}秒（PC記録時刻）` : ''
  return <section>
    <h2>動作の案内</h2>
    {!guide && <p className="notice" role="status">動作の案内は待機中です。本番課題の回答終了後に、動作が予定どおりだったか確認してください。</p>}
    {guide && <div className="movement-guide" aria-label="予定の動作">
      <p>{run?.phase === 'briefing' || run?.phase === 'preparing' ? '開始時の動作' : 'いま案内する動作（予定）'}</p>
      <p className="movement-current">{movementLabels[guide.state]}</p>
      {guide.next ? <p>次は{guide.next.atMs / 1000}秒で「{movementLabels[guide.next.state]}」
        {guide.elapsedMs !== null && `（あと${Math.max(0, (guide.next.atMs - guide.elapsedMs) / 1000).toFixed(1)}秒）`}</p>
        : <p>{run?.phase === 'waiting-stop' || run?.phase === 'answering' ? '安全に停止してから回答へ進みます。' : '表示終了まで、この動作を続けます。'}</p>}
      <p><small>実際の動作を見て確認してください。予定を正解として自動記録しません。時間はiPhoneの最新報告を基準にしています。</small></p>
    </div>}
    {run?.purpose === 'practice' && <p>練習中です。実験者の案内で動き、実際の足運びだけを確認してください。</p>}
    <p>口頭で案内しながら動作を目視してください。途中のボタン入力は不要です。回答終了後に「予定どおり／ずれあり」を記録します。</p>
    <details className="observation-history"><summary>記録履歴・出力（観察{observations}件／指示{events.length - observations}件）</summary>
      <p>目視確認は端末内保存の対象です。終了後、PCの「保存」から全記録JSONを出力してください。アンケートCSVには含まれません。</p>
      <p>JSONには目視の入力時刻・動作・課題ID・最後に届いた課題段階を記録します。動作予定の設定は observationProtocol、終了後の確認は movementConfirmations、開始状態・回答前の静止確認は research.events に分けます。口頭指示と変化開始の実時刻は入力しません。</p>
      <p><small>以下は最近の5件。全件はJSONの research.events、時刻合わせは research.rounds に保存されます。時刻はPC基準であり、動作開始の正解時刻ではありません。</small></p>
      {events.length ? <ol>{events.slice(-5).map((event, index) => <li key={index}>
        {event.kind === 'instruction' ? '指示' : '観察'}：{eventLabel(event)} ／ {lastTime(event)} ／ {event.reportedPhase ?? '課題外'}
      </li>)}</ol> : <p>まだ記録はありません。</p>}
    </details>
    <details><summary>記録の説明・時刻合わせ</summary>
    <label><input type="checkbox" checked={hidden} onChange={(event) => onHidden(event.currentTarget.checked)} /> 観察用に推定・特徴量・UI状態を隠す</label>
      <p>歩行・走行3歩、静止1秒を基準に足運びを確認します。課題中は監視を優先してください。</p>
      <p>予定と異なる動作は回答終了後の「ずれあり」に残します。過去の時刻を推測で補わず、予定時刻を正確な動作開始時刻とは扱いません。</p>
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
