import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PreviewServer, ViteDevServer } from 'vite'
import { measurementRelay } from './relay'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach((close) => close()) })
function harness(preview = false) {
  let middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
  const server = { middlewares: { use: (handler: typeof middleware) => { middleware = handler } },
    resolvedUrls: { network: ['https://192.168.1.10:5173/'] } }
  const plugin = measurementRelay()
  const hook = preview ? plugin.configurePreviewServer : plugin.configureServer
  if (typeof hook !== 'function') throw new Error('missing server hook')
  hook.call({} as never, server as ViteDevServer & PreviewServer)
  function request(method: string, path: string, body = '', headers = {}) {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path,
      headers: { host: '192.168.1.10:5173', origin: 'https://192.168.1.10:5173', 'content-type': 'application/json', ...headers }, socket: { encrypted: true } })
    const emitter = new EventEmitter()
    const res = Object.assign(emitter, { statusCode: 0, headersSent: false, destroyed: false, writableLength: 0,
      chunks: [] as string[], headers: {} as Record<string, string>,
      writeHead(code: number, headers = {}) { this.statusCode = code; this.headers = headers; this.headersSent = true; return this },
      write(chunk: string) { this.chunks.push(chunk); return true },
      end() { this.destroyed = true; emitter.emit('close'); emitter.emit('finish'); return this },
      destroy() { return this.end() },
    })
    const finished = new Promise<void>((resolve) => res.once('finish', resolve))
    middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => { res.writeHead(404).end() })
    cleanups.push(() => res.destroy())
    return { res, finished, events: (event: string) => res.chunks.filter((s) => s.startsWith(`event: ${event}\n`)).map((s) => JSON.parse(s.split('data: ')[1])) }
  }
  let id = 0
  function join(role: string, room = 'a', client = `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`) {
    return { ...request('GET', `/__measurement/events?role=${role}&room=${room}&client=${client}`), client }
  }
  async function post(client: string, data: unknown, headers = {}) {
    const result = request('POST', `/__measurement/message?client=${client}`, JSON.stringify(data), headers)
    await result.finished
    return result.res.statusCode
  }
  return { join, post, request }
}

it.each([false, true])('isolates rooms and validates roles in development/preview (%s)', async (preview) => {
  const h = harness(preview), pc = h.join('controller'), phone = h.join('sensor'), other = h.join('sensor', 'b')
  expect(await h.post(pc.client, { type: 'start', sessionId: 'one' })).toBe(204)
  expect(phone.events('message')).toEqual([{ type: 'start', sessionId: 'one', participant: null }])
  expect(other.events('message')).toEqual([])
  expect(await h.post(phone.client, { type: 'start', sessionId: 'wrong-role' })).toBe(403)
  expect(pc.events('message')).toEqual([])
  expect(await h.post(pc.client, { type: 'unknown' })).toBe(400)
  expect(await h.post(pc.client, { type: 'stop', sessionId: 'one' }, { origin: 'https://evil.example' })).toBe(403)
  expect(await h.post(pc.client, { type: 'stop', sessionId: 'one' }, { origin: undefined })).toBe(403)
})

it('reconnects the same client, rejects duplicate roles, and only forwards to the replacement stream', async () => {
  const h = harness(), pc = h.join('controller'), phone = h.join('sensor')
  expect(pc.events('presence').at(-1)).toMatchObject({ sensor: true, sensorUrls: ['https://192.168.1.10:5173/?role=sensor&room=a'] })
  const duplicate = h.join('sensor')
  expect(duplicate.events('presence').at(-1).error).toContain('既に')
  const reconnected = h.join('sensor', 'a', phone.client)
  expect(phone.res.destroyed).toBe(true)
  expect(reconnected.events('presence').at(-1)).toMatchObject({ sensor: true, controller: true, error: '' })
  await h.post(pc.client, { type: 'stop', sessionId: 'one' })
  expect(phone.events('message')).toEqual([])
  expect(reconnected.events('message')).toEqual([{ type: 'stop', sessionId: 'one' }])
  reconnected.res.destroy()
  expect(pc.events('presence').at(-1).sensor).toBe(false)
  expect(await h.post(phone.client, { type: 'stop', sessionId: 'one' })).toBe(409)
})

it('rejects cross-site streams and closes blocked streams instead of retaining unbounded data', () => {
  const h = harness()
  const crossSite = h.request('GET', '/__measurement/events?room=a&role=sensor&client=00000000-0000-4000-8000-000000000001', '', { 'sec-fetch-site': 'cross-site' })
  expect(crossSite.res.statusCode).toBe(403)
  const pc = h.join('controller')
  pc.res.writableLength = 21 * 1024 * 1024
  h.join('sensor')
  expect(pc.res.destroyed).toBe(true)
})
