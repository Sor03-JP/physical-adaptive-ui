import { useEffect, useRef, useState } from 'react'
import { atom, useAtom } from 'jotai'
import type { Identity, Message, PhoneStatus, Presence } from './protocol'
import { useMeasurementTransport } from './transport'
import { MAX_SAMPLES } from './recording'
import { TransferCollector, writeTransfer } from './transfer'

type Command = Extract<Message, { type: 'start' | 'stop' | 'clear' }>
const panelAtom = atom({ phone: null as PhoneStatus | null, received: 0, valid: 0, complete: false, pending: '' })
const number = (value: number | null | undefined) => value == null ? '—' : value.toFixed(3)
const seconds = (value: number) => (value / 1000).toFixed(1)

export default function Controller({ identity }: { identity: Identity }) {
  const [panel, setPanel] = useAtom(panelAtom)
  const [connected, setConnected] = useState(false)
  const [presence, setPresence] = useState<Presence>({ controller: false, sensor: false, sensorUrls: [], error: '' })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const collector = useRef<TransferCollector | null>(null)
  const phone = useRef<PhoneStatus | null>(null)
  const command = useRef<Command | null>(null)

  function refresh() {
    const current = collector.current
    setPanel({ phone: phone.current, received: current?.count ?? 0,
      valid: current?.summary().completeAccelerationCount ?? 0,
      complete: current?.complete ?? false, pending: command.current?.type ?? '' })
  }
  function receive(packet: Message, receivedAtMs: number) {
    if (packet.type === 'status') {
      phone.current = packet
      const metadata = packet.metadata
      if (metadata) {
        if (collector.current && collector.current.metadata.sessionId !== metadata.sessionId) {
          setError('別の記録を受信しました。現在のデータを保存してから、接続先を確認してください。'); return
        }
        collector.current ??= new TransferCollector(metadata, performance.timeOrigin)
        collector.current.updateStatus(packet.count, packet.completion)
      }
      const pending = command.current
      if (pending?.type === 'start' && metadata?.sessionId === pending.sessionId) command.current = null
      if (pending?.type === 'stop' && metadata?.sessionId === pending.sessionId && packet.completion) command.current = null
      if (pending?.type === 'clear' && metadata === null) {
        collector.current = null; command.current = null
      }
      if (packet.error) {
        setError(packet.error)
        if (pending?.type === 'start' && metadata === null) command.current = null
      }
    } else if (packet.type === 'batch' && packet.sessionId === collector.current?.metadata.sessionId) {
      const current = collector.current
      current.receive(packet.startIndex, packet.samples, receivedAtMs)
    }
    refresh()
  }
  const send = useMeasurementTransport(identity, { message: receive, presence: setPresence, connection: setConnected, error: setError })
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (command.current) send(command.current)
      const current = collector.current
      const status = phone.current
      if (current && status?.metadata?.sessionId === current.metadata.sessionId && current.count < status.count) {
        send({ type: 'pull', sessionId: current.metadata.sessionId, startIndex: current.count })
      }
    }, 200)
    const unload = (event: BeforeUnloadEvent) => {
      if (collector.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', unload)
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', unload) }
  }, [send])

  function start() {
    if (collector.current || command.current || !connected || !presence.sensor || !phone.current?.ready) return
    setError(''); setMessage('')
    command.current = { type: 'start', sessionId: crypto.randomUUID() }
    send(command.current); refresh()
  }
  function stop() {
    if (!collector.current || command.current) return
    command.current = { type: 'stop', sessionId: collector.current.metadata.sessionId }
    send(command.current); refresh()
  }
  function clear() {
    if (!collector.current?.complete || command.current) return
    if (!window.confirm('PCとiPhoneの記録を消去します。必要なJSONを保存しましたか？')) return
    command.current = { type: 'clear', sessionId: collector.current.metadata.sessionId }
    send(command.current); refresh(); setMessage('')
  }
  function download() {
    if (!collector.current) return
    try {
      const data = collector.current.export()
      const url = URL.createObjectURL(new Blob([writeTransfer(data)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `motion-${data.metadata.sessionId}${data.complete ? '' : '-partial'}.json`
      document.body.append(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      setError(''); setMessage(data.complete ? 'JSON出力を開始しました。保存ファイルを確認してください。'
        : '途中データを出力しました。停止確認・全件受信が完了したファイルではありません。')
    } catch { setError('出力できませんでした。記録は保持しています。') }
  }

  const status = panel.phone
  const latest = status?.latest
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
        <button className="primary" disabled={unavailable || !status?.ready || !!collector.current || !!panel.pending} onClick={start}>記録開始</button>
        <button disabled={!active || !!panel.pending} onClick={stop}>記録停止</button>
      </div>
      <dl>
        <dt>記録件数：iPhone／PC／未受信</dt><dd>{status?.count ?? 0}／{panel.received}／{Math.max(0, (status?.count ?? 0) - panel.received)} 件</dd>
        <dt>PC記録内で加速度3軸がそろう件数（重力込みを含む）</dt><dd>{panel.valid} 件</dd>
        <dt>iPhone側の記録時間／最終イベントから</dt><dd>{seconds(status?.elapsedMs ?? 0)} 秒／{status?.sinceLastSampleMs == null ? '未受信' : `${seconds(status.sinceLastSampleMs)} 秒（iPhone報告時点）`}</dd>
        <dt>イベント受信時刻差（ms）</dt><dd>{number(latest?.receivedIntervalMs)}</dd>
        <dt>停止理由</dt><dd>{status?.completion?.stopReason ?? '—'}</dd>
      </dl>
      <table><caption>iPhoneから届いた最新のセンサー値</caption><thead><tr><th>種類</th><th>x / α</th><th>y / β</th><th>z / γ</th></tr></thead><tbody>
        <tr><th>加速度<br /><small>m/s²</small></th><td>{number(latest?.acceleration?.x)}</td><td>{number(latest?.acceleration?.y)}</td><td>{number(latest?.acceleration?.z)}</td></tr>
        <tr><th>重力込み<br /><small>m/s²</small></th><td>{number(latest?.accelerationIncludingGravity?.x)}</td><td>{number(latest?.accelerationIncludingGravity?.y)}</td><td>{number(latest?.accelerationIncludingGravity?.z)}</td></tr>
        <tr><th>回転速度<br /><small>°/s</small></th><td>{number(latest?.rotationRate?.alpha)}</td><td>{number(latest?.rotationRate?.beta)}</td><td>{number(latest?.rotationRate?.gamma)}</td></tr>
      </tbody></table>
      <p><small>「—」は欠損・未受信。生データは全件記録し、画面・通信はまとめて更新します。上限{MAX_SAMPLES}件で自動停止します。</small></p>
      <p><small>iPhoneの取得時刻とPCの受信時刻を別々に保存します。時計の補正はまだ行いません。</small></p>
      <div className="controls">
        <button disabled={!collector.current} onClick={download}>{panel.complete ? 'JSONをPCに出力' : '途中データをPCに出力'}</button>
        <button disabled={!panel.complete || !!panel.pending} onClick={clear}>記録を消して次の計測へ</button>
      </div>
      {message && <p className="success" role="status">{message}</p>}
    </section>
  </>
}
