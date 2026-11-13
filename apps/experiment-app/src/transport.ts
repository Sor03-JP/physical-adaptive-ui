import { useCallback, useEffect, useRef } from 'react'
import { messageSchema, presenceSchema } from './protocol'
import type { Identity, Message, Presence } from './protocol'

type Handlers = {
  message: (message: Message, receivedAtMs: number) => void
  presence: (presence: Presence) => void
  connection: (connected: boolean) => void
  error: (message: string) => void
}

/** EventSource reconnects without reloading the page or changing the phone clock. */
export function connectMeasurement(identity: Identity, handlers: Handlers) {
  const client = crypto.randomUUID()
  const query = new URLSearchParams({ ...identity, client })
  const lifetime = new AbortController()
  const pending = new Map<Message['type'], Message>()
  let posting = false
  let source: EventSource, connected = false, lastReceived = performance.now()
  const disconnected = () => { connected = false; handlers.connection(false) }
  function connect() {
    source?.close()
    pending.clear()
    disconnected()
    lastReceived = performance.now()
    const current = new EventSource(`/__measurement/events?${query}`)
    source = current
    current.onopen = () => {
      if (source !== current) return
      lastReceived = performance.now(); connected = true; handlers.connection(true)
    }
    current.onerror = () => { if (source === current) disconnected() }
    current.addEventListener('heartbeat', () => { lastReceived = performance.now() })
    for (const event of ['presence', 'message'] as const) current.addEventListener(event, (raw) => {
      if (source !== current) return
      lastReceived = performance.now()
      try {
        const data: unknown = JSON.parse((raw as MessageEvent<string>).data)
        if (event === 'presence') handlers.presence(presenceSchema.parse(data))
        else handlers.message(messageSchema.parse(data), performance.now())
      } catch { handlers.error('通信データの形式を検証できませんでした。未受信件数を確認してください。') }
    })
  }
  connect()
  const watchdog = setInterval(() => {
    if (performance.now() - lastReceived > 6000) connect()
  }, 1000)
  async function post() {
    if (posting) return
    posting = true
    try {
      while (connected && pending.size && !lifetime.signal.aborted) {
        const message = pending.values().next().value!
        pending.delete(message.type)
        const current = source
        try {
          const response = await fetch(`/__measurement/message?client=${client}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
            signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
          })
          if (!response.ok) throw new Error('送信失敗')
        } catch {
          // Existing command/pull loops request unacknowledged work after reconnecting.
          if (!lifetime.signal.aborted && source === current) connect()
          break
        }
      }
    } finally { posting = false }
  }
  return {
    send(message: Message) {
      if (!connected || lifetime.signal.aborted) return
      // Preserve delivery order; coalesce periodic updates instead of growing a queue.
      pending.set(message.type, message)
      void post()
    },
    close() { lifetime.abort(); clearInterval(watchdog); source.close(); disconnected() },
  }
}

export function useMeasurementTransport(identity: Identity, handlers: Handlers) {
  const callbacks = useRef(handlers)
  callbacks.current = handlers
  const transport = useRef<ReturnType<typeof connectMeasurement> | null>(null)
  useEffect(() => {
    const current = connectMeasurement(identity, {
      message: (...args) => callbacks.current.message(...args),
      presence: (value) => callbacks.current.presence(value),
      connection: (value) => callbacks.current.connection(value),
      error: (value) => callbacks.current.error(value),
    })
    transport.current = current
    return () => { transport.current = null; current.close() }
  }, [identity])
  return useCallback((message: Message) => transport.current?.send(message), [])
}
