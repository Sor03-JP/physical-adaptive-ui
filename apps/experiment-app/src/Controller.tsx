import { useEffect, useRef, useState } from 'react'
import { atom, useAtom } from 'jotai'
import SavedRecording from './SavedRecording'
import FeaturePreview from './FeaturePreview'
import TaskController from './TaskController'
import ObservationPanel from './ObservationPanel'
import type { ObservationKind, ResearchEvent } from './research-log'
import { stateLabels } from './adaptation'
import type { ExperimentMode } from './adaptation'
import type { TaskId } from './tasks'
import type { Identity, Message, PhoneStatus, Presence } from './protocol'
import { useMeasurementTransport } from './transport'
import { MAX_SAMPLES } from './recording'
import { TransferCollector, writeTransfer } from './transfer'

type Command = Extract<Message, { type: 'start' | 'stop' | 'clear' | 'task-start' | 'task-begin' | 'task-answer' }>
const panelAtom = atom({ phone: null as PhoneStatus | null, received: 0, estimates: 0, valid: 0, complete: false, pending: '' })
const number = (value: number | null | undefined) => value == null ? '—' : value.toFixed(3)
const seconds = (value: number) => (value / 1000).toFixed(1)

export default function Controller({ identity }: { identity: Identity }) {
  const [panel, setPanel] = useAtom(panelAtom)
  const [connected, setConnected] = useState(false)
  const [presence, setPresence] = useState<Presence>({ controller: false, sensor: false, sensorUrls: [], error: '' })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [hideInference, setHideInference] = useState(true)
  const collector = useRef<TransferCollector | null>(null)
  const phone = useRef<PhoneStatus | null>(null)
  const command = useRef<Command | null>(null)
  const verified = useRef(false)

  function controllerNow() { return performance.now() }
  function refresh() {
    const current = collector.current
    if (current && phone.current?.metadata?.sessionId === current.metadata.sessionId && phone.current.completion && !current.research.busy
      && !current.research.snapshot().rounds.some((r) => r.purpose === 'end')) {
      current.research.begin('end', controllerNow()); verified.current = false
    }
    setPanel({ phone: phone.current, received: current?.count ?? 0,
      estimates: current?.estimateCount ?? 0,
      valid: current?.summary().completeAccelerationCount ?? 0,
      complete: current?.complete ?? false, pending: command.current?.type ?? '' })
  }
  function receive(packet: Message, receivedAtMs: number) {
    if (packet.type === 'clock-reply') {
      if (collector.current?.research.receive(packet, receivedAtMs)) verified.current = false
    } else if (packet.type === 'status') {
      phone.current = packet
      const metadata = packet.metadata
      if (metadata) {
        if (collector.current && collector.current.metadata.sessionId !== metadata.sessionId) {
          setError('別の記録を受信しました。現在のデータを保存してから、接続先を確認してください。'); return
        }
        if (!collector.current) {
          collector.current = new TransferCollector(metadata, performance.timeOrigin, packet.estimationConfig)
          collector.current.research.begin('start', receivedAtMs)
        }
        collector.current.updateStatus(packet.count, packet.completion, packet.estimateCount)
        if (collector.current.updateTask(packet.taskRun)) verified.current = false
      }
      const pending = command.current
      if (pending?.type === 'start' && metadata?.sessionId === pending.sessionId) command.current = null
      if (pending?.type === 'stop' && metadata?.sessionId === pending.sessionId && packet.completion) command.current = null
      if (pending?.type === 'task-start' && packet.taskRun?.id === pending.runId) command.current = null
      if (pending?.type === 'task-begin' && packet.taskRun?.id === pending.runId && packet.taskRun.phase !== 'briefing') command.current = null
      if (pending?.type === 'task-answer' && packet.taskRun?.id === pending.runId && packet.taskRun.phase !== 'waiting-stop') command.current = null
      if (pending?.type === 'clear' && metadata === null) { collector.current = null; command.current = null; verified.current = false }
      if (packet.error) {
        setError(packet.error)
        if (pending?.type === 'start' && metadata === null) command.current = null
        if (pending?.type === 'task-start' || pending?.type === 'task-begin' || pending?.type === 'task-answer') command.current = null
      }
    } else if (packet.type === 'batch' && packet.sessionId === collector.current?.metadata.sessionId) {
      const current = collector.current
      const accepted = current.receive(packet.startIndex, packet.samples, receivedAtMs)
      if (accepted) verified.current = false
    } else if (packet.type === 'estimates' && packet.sessionId === collector.current?.metadata.sessionId) {
      if (collector.current.receiveEstimates(packet.startIndex, packet.estimates)) verified.current = false
    }
    refresh()
  }
  const send = useMeasurementTransport(identity, { message: receive, presence: setPresence, connection: setConnected, error: setError })
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (command.current) send(command.current)
      const current = collector.current
      const status = phone.current
      if (current) {
        const probe = current.research.poll(controllerNow())
        if (probe) send(probe)
        if (current.research.busy || probe) verified.current = false
        refresh()
      }
      if (current && status?.metadata?.sessionId === current.metadata.sessionId && current.count < status.count) {
        send({ type: 'pull', sessionId: current.metadata.sessionId, startIndex: current.count })
      }
      if (current && status?.metadata?.sessionId === current.metadata.sessionId && current.estimateCount < status.estimateCount) {
        send({ type: 'pull-estimates', sessionId: current.metadata.sessionId, startIndex: current.estimateCount })
      }
    }, 200)
    const unload = (event: BeforeUnloadEvent) => {
      if (collector.current && !verified.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', unload)
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', unload) }
  }, [send])

  function start() {
    if (collector.current || command.current || !connected || !presence.sensor || !phone.current?.ready) return
    verified.current = false; setError(''); setMessage('')
    command.current = { type: 'start', sessionId: crypto.randomUUID() }
    send(command.current); refresh()
  }
  function stop() {
    if (!collector.current || command.current) return
    command.current = { type: 'stop', sessionId: collector.current.metadata.sessionId }
    send(command.current); refresh()
  }
  function recordResearch(kind: ResearchEvent['kind'], value: ObservationKind) {
    const current = collector.current
    if (!current || phone.current?.completion || phone.current?.metadata?.sessionId !== current.metadata.sessionId) return
    try {
      const run = phone.current.taskRun
      current.research.record({ kind, value, controllerAtMs: controllerNow(), taskRunId: run?.id ?? null, reportedPhase: run?.phase ?? null })
      verified.current = false; refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '観察を記録できませんでした。') }
  }
  function calibrate() {
    const current = collector.current
    if (!current || current.research.busy || !connected || !presence.sensor) return
    current.research.begin(phone.current?.completion ? 'end' : current.research.hasStartCalibration ? 'manual' : 'start', controllerNow())
    verified.current = false; refresh()
  }
  function startTask(taskId: TaskId, mode: ExperimentMode) {
    const current = collector.current
    if (!current || command.current || !phone.current?.metadata || phone.current.completion || !connected || !presence.sensor) return
    setError(''); verified.current = false
    command.current = { type: 'task-start', sessionId: current.metadata.sessionId, runId: crypto.randomUUID(), taskId, mode }
    send(command.current); refresh()
  }
  function beginTask() {
    const run = phone.current?.taskRun
    if (!run || run.phase !== 'briefing' || run.briefingShownAtMs === null || command.current || collector.current?.research.busy) return
    command.current = { type: 'task-begin', sessionId: run.sessionId, runId: run.id }
    send(command.current); refresh()
  }
  function confirmStopped() {
    const run = phone.current?.taskRun
    if (!run || run.phase !== 'waiting-stop' || command.current) return
    recordResearch('observation', 'stationary')
    command.current = { type: 'task-answer', sessionId: run.sessionId, runId: run.id }
    send(command.current); refresh()
  }
  function clear() {
    if (!collector.current?.complete || command.current || collector.current.research.busy) return
    if (!verified.current && !window.confirm('現在の記録を終了し、次の計測へ進みます。必要なJSONを保存しましたか？')) return
    command.current = { type: 'clear', sessionId: collector.current.metadata.sessionId }
    send(command.current); refresh(); setMessage('')
  }
  function download() {
    if (!collector.current || collector.current.research.busy) return
    try {
      const data = collector.current.export()
      const blob = new Blob([writeTransfer(data)], { type: 'application/json' })
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = `motion-${data.metadata.sessionId}${data.complete ? '' : '-partial'}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      setError(''); setMessage('JSONを出力しました。停止・全件受信後に読み戻して確認してください。')
    } catch { setError('出力できませんでした。記録は保持しています。') }
  }

  const status = panel.phone
  const latest = status?.latest
  const estimate = status?.latestEstimate
  const active = status?.metadata != null && status.completion === null
  const unavailable = !connected || !presence.sensor
  return <>
    <section>
      <h2>接続・準備確認</h2>
      <p role="status">サーバー：{connected ? '接続済み' : '切断／開発サーバー未接続'} ／ iPhone：{presence.sensor && connected ? '接続済み' : '未接続'}</p>
      <p>iPhone画面：{status ? status.visible ? '表示中' : '非表示' : '未確認'} ／ センサー取得：{status ? status.streaming ? '取得中' : '停止中' : '未確認'}</p>
      <p>センサー許可：{status?.permission ?? '未確認'} ／ 加速度3軸の受信確認：{status?.ready ? '準備済み' : '未完了'}</p>
      <p>iPhoneの受信イベント：{status?.receivedEventCount ?? 0}件 ／ 加速度3軸あり：{status?.validEventCount ?? 0}件</p>
      {presence.sensorUrls.map((url) => <p key={url}><a href={url}>iPhoneで開くURL：{url}</a></p>)}
      {!presence.sensorUrls.length && <p>LAN公開で起動し、iPhoneでNetworkのHTTPS URLに「?role=sensor&amp;room={identity.room}」を付けて開いてください。</p>}
      {(presence.error || error) && <p className="error" role="alert">{presence.error || error}</p>}
      {unavailable && collector.current && <p className="notice">通信が途切れています。既にPCで受信したデータは保持しています。iPhoneのページを閉じず、同じ接続コードで再接続してください。</p>}
    </section>
    <section>
      <h2>PCから記録</h2>
      <p className="status" role="status">{panel.pending ? `操作の応答待ち：${panel.pending}` : active ? '記録中' : panel.complete ? '停止・全件受信済み' : collector.current ? '停止確認または転送待ち' : '開始前'}</p>
      <div className="controls">
        <button className="primary" disabled={unavailable || !status?.ready || !!collector.current || !!panel.pending || reading} onClick={start}>記録開始</button>
        <button disabled={!active || !!panel.pending} onClick={stop}>記録停止</button>
      </div>
      <dl>
        <dt>記録件数：iPhone／PC／未受信</dt><dd>{status?.count ?? 0}／{panel.received}／{Math.max(0, (status?.count ?? 0) - panel.received)} 件</dd>
        <dt>PC記録内で加速度3軸がそろう件数（重力込みを含む）</dt><dd>{panel.valid} 件</dd>
        <dt>iPhone側の記録時間／最終イベントから</dt><dd>{seconds(status?.elapsedMs ?? 0)} 秒／{status?.sinceLastSampleMs == null ? '未受信' : `${seconds(status.sinceLastSampleMs)} 秒（iPhone報告時点）`}</dd>
        <dt>イベント受信時刻差（ms）</dt><dd>{number(latest?.receivedIntervalMs)}</dd>
        <dt>停止理由</dt><dd>{status?.completion?.stopReason ?? '—'}</dd>
      </dl>
      {!hideInference && <table><caption>iPhoneから届いた最新のセンサー値</caption><thead><tr><th>種類</th><th>x / α</th><th>y / β</th><th>z / γ</th></tr></thead><tbody>
        <tr><th>加速度<br /><small>m/s²</small></th><td>{number(latest?.acceleration?.x)}</td><td>{number(latest?.acceleration?.y)}</td><td>{number(latest?.acceleration?.z)}</td></tr>
        <tr><th>重力込み<br /><small>m/s²</small></th><td>{number(latest?.accelerationIncludingGravity?.x)}</td><td>{number(latest?.accelerationIncludingGravity?.y)}</td><td>{number(latest?.accelerationIncludingGravity?.z)}</td></tr>
        <tr><th>回転速度<br /><small>°/s</small></th><td>{number(latest?.rotationRate?.alpha)}</td><td>{number(latest?.rotationRate?.beta)}</td><td>{number(latest?.rotationRate?.gamma)}</td></tr>
      </tbody></table>}
      <p><small>「—」は欠損・未受信。生データは全件記録し、画面・通信はまとめて更新します。上限{MAX_SAMPLES}件で自動停止します。</small></p>
      <p><small>iPhoneの取得時刻とPCの受信時刻を別々に保存します。元の時刻と時刻合わせの通信記録を保持します。補正値は別途記録し、生データの時刻は書き換えません。</small></p>
      <div className="controls">
        <button disabled={!collector.current || reading || collector.current.research.busy} onClick={download}>{panel.complete ? 'JSONをPCに出力' : '途中データをPCに出力'}</button>
        <button disabled={!panel.complete || !!panel.pending || reading || collector.current?.research.busy} onClick={clear}>記録を保管して次の計測へ</button>
      </div>
      {message && <p className="success" role="status">{message}</p>}
    </section>
    <ObservationPanel log={collector.current?.research.snapshot() ?? null} active={active && !!collector.current}
      busy={collector.current?.research.busy ?? false} disabled={!collector.current || unavailable || (status?.taskRun != null && !['briefing', 'complete', 'aborted'].includes(status.taskRun.phase))}
      hidden={hideInference} onHidden={setHideInference} onRecord={recordResearch} onCalibrate={calibrate} />
    <TaskController hideInference={hideInference} run={status?.taskRun ?? null} count={collector.current?.taskCount ?? 0}
      elapsedSeconds={status?.taskRun?.startedAtMs != null ? ((status.metadata?.startedAtMs ?? 0) + status.elapsedMs - status.taskRun.startedAtMs) / 1000 : 0}
      disabled={unavailable || !active || reading || !collector.current?.research.hasStartCalibration || collector.current.research.busy} pending={!!panel.pending} onStart={startTask} onBegin={beginTask} onConfirmStopped={confirmStopped} />
    {!hideInference && <>
    <FeaturePreview collector={collector.current} />
    <section>
      <h2>自動状態推定（暫定設定）</h2>
      <p>Classifier（今回の判定）：{estimate ? stateLabels[estimate.classifiedState] : '判定前'} ／ Stabilizer（安定化後）：{estimate ? stateLabels[estimate.stabilizedState] : '判定前'}</p>
      <p>判定理由：{status?.latestEstimate?.classificationReason ?? '—'} ／ 安定化：{status?.latestEstimate?.stabilizationReason ?? '—'}</p>
      <p>推定ログ：iPhone {status?.estimateCount ?? 0}件 ／ PC {panel.estimates}件 ／ 未受信 {Math.max(0, (status?.estimateCount ?? 0) - panel.estimates)}件</p>
      <p>判定時刻（iPhone基準）：{number(status?.latestEstimate?.evaluatedAtMs)} ms ／ RMS：{number(status?.latestEstimate?.features.acceleration?.rootMeanSquare)} m/s²</p>
      {estimate?.stationaryFeatures && <p>静止確認用（{status?.estimationConfig?.stationaryWindowMs}ms）のRMS：{number(estimate.stationaryFeatures.acceleration?.rootMeanSquare)} m/s²</p>}
      <p><small>記録中のみiPhoneで推定します。停止後は最後の結果を表示します。これは実測調整用で、本番の性能は未評価です。課題の自動適応条件では、この安定化後の状態を表示へ反映します。</small></p>
      {status?.estimationConfig && <details><summary>今回の推定設定</summary><pre>{JSON.stringify(status.estimationConfig, null, 2)}</pre></details>}
    </section>
    </>}
    <SavedRecording key={status?.metadata?.sessionId ?? 'empty'} collector={collector} active={active}
      reading={reading || (collector.current?.research.busy ?? false)} setReading={setReading} onVerified={() => { verified.current = true; refresh() }} />
  </>
}
