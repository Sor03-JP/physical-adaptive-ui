import type { ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { joinSchema, messageSchema } from '../src/protocol'
import type { Identity } from '../src/protocol'
import { MAX_FILE_BYTES } from '../src/recording-schema'

/** Local experiment harness; the same routes serve development and built screens. */
export function measurementRelay(): Plugin {
  const install = (server: ViteDevServer | PreviewServer) => {
    const members = new Map<string, { identity: Identity; response: ServerResponse }>()
    const send = (response: ServerResponse, event: string, data: unknown) => {
      if (response.writableLength > MAX_FILE_BYTES) { response.destroy(); return }
      if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const notify = (room: string) => {
      const peers = [...members.values()].filter((member) => member.identity.room === room)
      const sensorUrls = (server.resolvedUrls?.network ?? []).map((base) => {
        const url = new URL(base)
        url.searchParams.set('role', 'sensor'); url.searchParams.set('room', room)
        return url.toString()
      })
      for (const { response } of peers) send(response, 'presence', {
        controller: peers.some(({ identity }) => identity.role === 'controller'),
        sensor: peers.some(({ identity }) => identity.role === 'sensor'), sensorUrls, error: '',
      })
    }
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/__measurement/')) { next(); return }
      // Do not let another website read experiment data or issue controller commands.
      const host = request.headers.host ?? request.headers[':authority']
      if ((request.headers.origin && request.headers.origin !== `${'encrypted' in request.socket ? 'https' : 'http'}://${host}`)
        || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
        response.writeHead(403).end(); return
      }
      const client = url.searchParams.get('client') ?? ''
      if (!/^[a-f0-9-]{36}$/.test(client)) { response.writeHead(400).end(); return }
      if (request.method === 'GET' && url.pathname === '/__measurement/events') {
        const parsed = joinSchema.safeParse({ room: url.searchParams.get('room'), role: url.searchParams.get('role') })
        if (!parsed.success) { response.writeHead(400).end(); return }
        const identity = parsed.data
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' })
        response.write('retry: 1000\n\n')
        const duplicate = [...members].some(([id, member]) => id !== client && member.identity.room === identity.room && member.identity.role === identity.role)
        if (duplicate) {
          send(response, 'presence', { controller: false, sensor: false, sensorUrls: [], error: '同じ接続コードで同じ役割の画面が既に開いています。重複するタブを閉じてください。' })
          response.end(); return
        }
        members.get(client)?.response.end()
        members.set(client, { identity, response })
        notify(identity.room)
        const heartbeat = setInterval(() => send(response, 'heartbeat', null), 2000)
        response.on('close', () => {
          clearInterval(heartbeat)
          if (members.get(client)?.response !== response) return
          members.delete(client); notify(identity.room)
        })
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/__measurement/message') { response.writeHead(404).end(); return }
      if (!request.headers.origin || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return }
      const member = members.get(client)
      if (!member) { response.writeHead(409).end(); return }
      void (async () => {
        let size = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          size += chunk.length
          if (size > MAX_FILE_BYTES) { response.writeHead(413).end(); return }
          chunks.push(Buffer.from(chunk))
        }
        const parsed = messageSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()))
        if (!parsed.success) { response.writeHead(400).end(); return }
        const fromSensor = ['status', 'batch', 'estimates', 'task-history'].includes(parsed.data.type)
        if (fromSensor !== (member.identity.role === 'sensor')) { response.writeHead(403).end(); return }
        for (const peer of members.values()) if (peer.identity.room === member.identity.room && peer.identity.role !== member.identity.role) {
          send(peer.response, 'message', parsed.data)
        }
        response.writeHead(204).end()
      })().catch(() => { if (!response.headersSent) response.writeHead(400).end() })
    })
    server.httpServer?.on('close', () => { for (const { response } of members.values()) response.destroy(); members.clear() })
  }
  return { name: 'measurement-relay', configureServer: install, configurePreviewServer: install }
}
