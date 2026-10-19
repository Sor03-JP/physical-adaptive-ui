import { expect, it, vi } from 'vitest'
import type { ViteDevServer, WebSocketClient } from 'vite'
import { measurementRelay } from './relay'

function harness() {
  const handlers = new Map<string, (data: unknown, client: WebSocketClient) => void>()
  const hook = measurementRelay().configureServer
  if (typeof hook !== 'function') throw new Error('missing server hook')
  const server = { ws: { on: (name: string, handler: (data: unknown, client: WebSocketClient) => void) => handlers.set(name, handler) },
    resolvedUrls: { network: ['https://192.168.1.10:5173/'] } }
  hook.call({} as never, server as unknown as ViteDevServer)
  function client() {
    let close = () => {}
    const fake = { send: vi.fn(), socket: { on: (_: string, callback: () => void) => { close = callback } } }
    const value = fake as unknown as WebSocketClient
    return { value, send: fake.send, close: () => close() }
  }
  const emit = (name: string, data: unknown, client: WebSocketClient) => handlers.get(name)!(data, client)
  return { client, emit }
}

it('isolates rooms and only allows controller commands to reach the paired sensor', () => {
  const h = harness(), pc = h.client(), phone = h.client(), other = h.client()
  h.emit('measurement:join', { room: 'a', role: 'controller' }, pc.value)
  h.emit('measurement:join', { room: 'a', role: 'sensor' }, phone.value)
  h.emit('measurement:join', { room: 'b', role: 'sensor' }, other.value)
  pc.send.mockClear(); phone.send.mockClear(); other.send.mockClear()
  h.emit('measurement:message', { type: 'start', sessionId: 'one' }, pc.value)
  expect(phone.send).toHaveBeenCalledWith('measurement:message', { type: 'start', sessionId: 'one', participant: null })
  expect(other.send).not.toHaveBeenCalled()
  h.emit('measurement:message', { type: 'start', sessionId: 'wrong-role' }, phone.value)
  expect(pc.send).not.toHaveBeenCalled()
})

it('rejects duplicate roles, removes disconnected peers, and provides the iPhone connection URL', () => {
  const h = harness(), pc = h.client(), duplicate = h.client()
  h.emit('measurement:join', { room: 'a', role: 'controller' }, pc.value)
  expect(pc.send).toHaveBeenLastCalledWith('measurement:presence', expect.objectContaining({
    sensorUrls: ['https://192.168.1.10:5173/?role=sensor&room=a'],
  }))
  h.emit('measurement:join', { room: 'a', role: 'controller' }, duplicate.value)
  expect(duplicate.send).toHaveBeenLastCalledWith('measurement:presence', expect.objectContaining({ error: expect.stringContaining('既に') }))
  pc.close()
  h.emit('measurement:join', { room: 'a', role: 'controller' }, duplicate.value)
  expect(duplicate.send).toHaveBeenLastCalledWith('measurement:presence', expect.objectContaining({ error: '', controller: true }))
})
