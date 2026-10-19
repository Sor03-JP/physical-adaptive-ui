import { useEffect, useRef, useState } from 'react'
import { createBrowserMotionSource } from '@physical-adaptive/device-motion'
import type { DeviceMotionSource, MotionSample } from '@physical-adaptive/device-motion'
import { hasCompleteAcceleration, MeasurementRecorder } from './recording'
import type { StopReason } from './recording'
import type { Identity, Message, PhoneStatus } from './protocol'
import { useMeasurementTransport } from './transport'
import { estimationConfig } from './estimation'

export default function Sensor({ identity }: { identity: Identity }) {
  const source = useRef<DeviceMotionSource | null>(null)
  const recorder = useRef<MeasurementRecorder | null>(null)
  const latest = useRef<MotionSample | null>(null)
  const events = useRef({ total: 0, valid: 0 })
  const enabled = useRef(false)
  const streaming = useRef(false)
  const error = useRef('')
  const generation = useRef(0)
  const [connected, setConnected] = useState(false)
  const [controller, setController] = useState(false)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState('貸出前にセンサーの利用を許可してください。')

  function finish(reason: StopReason) {
    recorder.current?.stop(performance.now(), reason)
    source.current?.stop(); streaming.current = false
  }
  function feed() {
    if (streaming.current || !source.current) return
    source.current.start((sample) => {
      latest.current = sample; events.current.total++
      if (hasCompleteAcceleration(sample)) events.current.valid++
      recorder.current?.append(sample)
      if (recorder.current?.completion?.stopReason === 'capacity') finish('capacity')
    })
    streaming.current = true
  }
  function snapshot(): PhoneStatus {
    const now = performance.now()
    const current = recorder.current
    const view = current?.view(now)
    return {
      type: 'status', streaming: streaming.current, visible: !document.hidden, ready: enabled.current && events.current.valid > 0 && !document.hidden,
      permission: source.current?.getPermission() ?? 'prompt', error: error.current,
      receivedEventCount: events.current.total, validEventCount: events.current.valid,
      metadata: current?.metadata ?? null, completion: current?.completion ?? null,
      estimationConfig: current?.estimationConfig ?? null, estimateCount: current?.estimateCount ?? 0,
      latestEstimate: current?.latestEstimate ?? null,
      count: view?.count ?? 0, completeAccelerationCount: view?.completeAccelerationCount ?? 0,
      latest: latest.current, elapsedMs: view?.elapsedMs ?? 0,
      sinceLastSampleMs: latest.current === null ? null : Math.max(0, now - latest.current.receivedAtMs),
    }
  }
  function receive(message: Message) {
    try {
      const current = recorder.current
      if (message.type === 'start') {
        if (current?.metadata.sessionId === message.sessionId) return
        if (current) throw new Error('前の記録をPCで確認・消去してから開始してください。')
        if (!snapshot().ready) throw new Error('センサーの許可・受信確認が完了していません。')
        recorder.current = new MeasurementRecorder({ sessionId: message.sessionId,
          startedAt: new Date().toISOString(), startedAtMs: performance.now(),
          timeOriginMs: performance.timeOrigin, userAgent: navigator.userAgent }, estimationConfig)
        try { feed() } catch (cause) { recorder.current = null; throw cause }
        error.current = ''
      } else if ('sessionId' in message && current && message.sessionId === current.metadata.sessionId) {
        if (message.type === 'stop') finish('manual')
        if (message.type === 'clear') {
          if (current.active) throw new Error('記録停止後に消去してください。')
          recorder.current = null; error.current = ''
        }
        if (message.type === 'pull') send({ type: 'batch', sessionId: message.sessionId,
          startIndex: message.startIndex, samples: current.batch(message.startIndex) })
        if (message.type === 'pull-estimates') send({ type: 'estimates', sessionId: message.sessionId,
          startIndex: message.startIndex, estimates: current.estimateBatch(message.startIndex) })
      }
    } catch (cause) { error.current = cause instanceof Error ? cause.message : '操作を実行できませんでした。' }
    send(snapshot())
  }
  const send = useMeasurementTransport(identity, {
    message: receive,
    presence: (presence) => {
      setController(presence.controller)
      if (presence.error) error.current = presence.error
      send(snapshot())
    },
    connection: setConnected,
    error: (message) => { error.current = message },
  })

  useEffect(() => {
    const generationRef = generation
    const timer = window.setInterval(() => {
      recorder.current?.evaluate(performance.now())
      if (recorder.current?.completion?.stopReason === 'capacity') finish('capacity')
      const current = snapshot()
      send(current)
      setStatus(error.current || (recorder.current?.active ? '記録中です。操作はPCで行います。'
        : current.ready ? '準備済みです。PCから記録を開始できます。' : 'センサーの許可・受信を確認してください。'))
    }, estimationConfig.updateIntervalMs)
    const hidden = () => {
      if (!document.hidden) return
      finish('page-hidden'); enabled.current = false
      send(snapshot())
    }
    const unload = (event: BeforeUnloadEvent) => { if (recorder.current) event.preventDefault() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('beforeunload', unload)
    return () => {
      generationRef.current++; source.current?.stop(); streaming.current = false
      clearInterval(timer); document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('beforeunload', unload)
    }
  }, [send])

  async function enable() {
    const token = ++generation.current
    setPending(true)
    try {
      source.current ??= createBrowserMotionSource()
      const permission = await source.current.requestPermission()
      if (token !== generation.current) return
      if (permission !== 'granted') throw new Error('センサーの利用が許可されませんでした。')
      if (document.hidden) throw new Error('画面を表示してから操作してください。')
      enabled.current = true; error.current = ''; feed()
    } catch (cause) { error.current = cause instanceof Error ? cause.message : '取得を開始できませんでした。' }
    finally { if (token === generation.current) setPending(false) }
  }
  return <section>
    <h2>iPhone：センサー取得</h2>
    <p role="status">{status}</p>
    <p>PC接続：{connected && controller ? '接続済み' : '待機中'}</p>
    <button disabled={pending} onClick={() => void enable()}>センサー利用を許可・準備</button>
    <p>許可後はこの画面を表示したままにしてください。データの確認・開始停止・出力はPCで行います。</p>
    <button onClick={() => { finish('manual'); send(snapshot()) }}>緊急停止</button>
  </section>
}
