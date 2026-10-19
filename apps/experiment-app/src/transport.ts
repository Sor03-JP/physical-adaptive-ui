import { useCallback, useEffect, useRef } from 'react'
import { messageSchema, presenceSchema } from './protocol'
import type { Identity, Message, Presence } from './protocol'

export function useMeasurementTransport(identity: Identity, handlers: {
  message: (message: Message, receivedAtMs: number) => void
  presence: (presence: Presence) => void
  connection: (connected: boolean) => void
  error: (message: string) => void
}) {
  const callbacks = useRef(handlers)
  callbacks.current = handlers
  const connected = useRef(false)
  useEffect(() => {
    const hot = import.meta.hot
    if (!hot) { callbacks.current.connection(false); return }
    const join = () => {
      connected.current = true; callbacks.current.connection(true)
      hot.send('measurement:join', identity)
    }
    const disconnected = () => { connected.current = false; callbacks.current.connection(false) }
    const message = (raw: unknown) => {
      const receivedAtMs = performance.now()
      const parsed = messageSchema.safeParse(raw)
      if (parsed.success) callbacks.current.message(parsed.data, receivedAtMs)
      else callbacks.current.error('通信データの形式を検証できませんでした。未受信件数を確認してください。')
    }
    const presence = (raw: unknown) => {
      const parsed = presenceSchema.safeParse(raw)
      if (parsed.success) callbacks.current.presence(parsed.data)
    }
    hot.on('measurement:message', message)
    hot.on('measurement:presence', presence)
    hot.on('vite:ws:connect', join)
    hot.on('vite:ws:disconnect', disconnected)
    join()
    const retry = window.setInterval(() => {
      if (connected.current) hot.send('measurement:join', identity)
    }, 3000)
    return () => {
      clearInterval(retry); connected.current = false
      hot.off('measurement:message', message); hot.off('measurement:presence', presence)
      hot.off('vite:ws:connect', join); hot.off('vite:ws:disconnect', disconnected)
    }
  }, [identity])
  return useCallback((message: Message) => {
    if (connected.current) import.meta.hot?.send('measurement:message', message)
  }, [])
}
