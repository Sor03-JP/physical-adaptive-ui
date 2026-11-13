import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectMeasurement } from './transport'

const streams: FakeEventSource[] = []
class FakeEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  handlers = new Map<string, (event: { data: string }) => void>()
  close = vi.fn()
  constructor(readonly url: string) { streams.push(this) }
  addEventListener(name: string, handler: (event: { data: string }) => void) { this.handlers.set(name, handler) }
  emit(name: string, data: unknown) { this.handlers.get(name)?.({ data: JSON.stringify(data) }) }
}
let now = 0
beforeEach(() => {
  now = 0; streams.length = 0; vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const callbacks = () => ({ message: vi.fn(), presence: vi.fn(), connection: vi.fn(), error: vi.fn() })

it('receives original phone times after a connection loss without reloading or changing client identity', async () => {
  const handlers = callbacks(), connection = connectMeasurement({ role: 'controller', room: 'a' }, handlers)
  const stream = streams[0]
  stream.onopen!()
  const packet = { type: 'batch', sessionId: 'session', startIndex: 0, samples: [] }
  now = 20; stream.emit('message', packet)
  expect(handlers.message).toHaveBeenLastCalledWith(packet, 20)
  stream.onerror!()
  connection.send({ type: 'stop', sessionId: 'session' })
  expect(fetch).not.toHaveBeenCalled()
  now = 7000; await vi.advanceTimersByTimeAsync(1000)
  const resumed = streams[1]
  expect(stream.close).toHaveBeenCalledOnce()
  expect(resumed.url).toBe(stream.url)
  resumed.onopen!()
  now = 7100; resumed.emit('message', packet)
  expect(handlers.message).toHaveBeenLastCalledWith(packet, 7100)
  connection.send({ type: 'pull', sessionId: 'session', startIndex: 0 })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ type: 'pull', sessionId: 'session', startIndex: 0 })
  resumed.emit('message', { type: 'bad' })
  expect(handlers.error).toHaveBeenCalledOnce()
  connection.close()
  await vi.advanceTimersByTimeAsync(10000)
  expect(streams).toHaveLength(2)
})

it('serializes requests and coalesces retries while a slow POST is in flight', async () => {
  let complete: (value: { ok: boolean }) => void = () => {}
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve as typeof complete }))
  const connection = connectMeasurement({ role: 'controller', room: 'a' }, callbacks())
  streams[0].onopen!()
  connection.send({ type: 'pull', sessionId: 'session', startIndex: 0 })
  connection.send({ type: 'pull-estimates', sessionId: 'session', startIndex: 0 })
  connection.send({ type: 'pull-estimates', sessionId: 'session', startIndex: 100 })
  expect(fetch).toHaveBeenCalledOnce()
  complete({ ok: true }); await vi.advanceTimersByTimeAsync(0)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).startIndex).toBe(100)
  connection.close()
})

it('reconnects failed sends and does not reconnect after disposal', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  const handlers = callbacks(), connection = connectMeasurement({ role: 'sensor', room: 'a' }, handlers)
  streams[0].onopen!()
  connection.send({ type: 'task-history', sessionId: 'session', tasks: [] })
  await vi.advanceTimersByTimeAsync(0)
  expect(streams).toHaveLength(2)
  expect(handlers.connection).toHaveBeenLastCalledWith(false)
  connection.close()
  await vi.advanceTimersByTimeAsync(10000)
  expect(streams).toHaveLength(2)
})
