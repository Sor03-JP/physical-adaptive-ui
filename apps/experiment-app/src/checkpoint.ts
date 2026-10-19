import type { MotionSample, MotionEstimate } from '@physical-adaptive/device-motion'

export interface CheckpointDelta {
  sessionId: string; header: unknown; sampleStart: number; estimateStart: number
  samples: MotionSample[]; estimates: MotionEstimate[]
}
export interface StoredCheckpoint {
  key: string; savedAt: string; header: unknown; sampleCount: number; estimateCount: number
}
export interface LoadedCheckpoint extends StoredCheckpoint { samples: MotionSample[]; estimates: MotionEstimate[] }
let opening: Promise<IDBDatabase> | null = null
function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('physical-adaptive-experiment', 1)
    request.onupgradeneeded = () => {
      for (const name of ['heads', 'chunks', 'settings']) request.result.createObjectStore(name)
    }
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null }; resolve(request.result) }
    request.onerror = () => { opening = null; reject(request.error) }
    request.onblocked = () => { opening = null; reject(new Error('別タブが保存領域の更新を妨げています。')) }
  })
  return opening
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
}
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('保存を完了できませんでした。'))
    transaction.onerror = () => reject(transaction.error)
  })
}
export async function readSetting(key: string): Promise<unknown> {
  return request((await database()).transaction('settings').objectStore('settings').get(key))
}
export async function saveSetting(key: string, value: unknown): Promise<void> {
  const tx = (await database()).transaction('settings', 'readwrite'); const done = committed(tx)
  tx.objectStore('settings').put(value, key); await done
}
// A single transaction prevents two tabs from creating different allocation tables.
export async function getOrCreateSetting(key: string, create: () => unknown): Promise<unknown> {
  const tx = (await database()).transaction('settings', 'readwrite'); const done = committed(tx)
  const store = tx.objectStore('settings'); const pending = store.get(key)
  let value: unknown
  pending.onsuccess = () => {
    try { value = pending.result ?? create(); if (pending.result == null) store.put(value, key) }
    catch { tx.abort() }
  }
  await done; return value
}
export class SessionJournal {
  private readonly prefix: string
  constructor(role: 'controller' | 'sensor', room: string) { this.prefix = `${role}:${room}` }
  async save(delta: CheckpointDelta): Promise<StoredCheckpoint> {
    const key = `${this.prefix}:${delta.sessionId}`
    const tx = (await database()).transaction(['heads', 'chunks', 'settings'], 'readwrite')
    const done = committed(tx)
    const heads = tx.objectStore('heads')
    // All writes for a checkpoint, including its active pointer, commit together.
    let saved!: StoredCheckpoint
    const previousRequest = heads.get(key)
    previousRequest.onsuccess = () => {
      const previous = previousRequest.result as StoredCheckpoint | undefined
      if ((previous?.sampleCount ?? 0) !== delta.sampleStart || (previous?.estimateCount ?? 0) !== delta.estimateStart) { tx.abort(); return }
      if (delta.samples.length) tx.objectStore('chunks').put(delta.samples, [key, 'samples', delta.sampleStart])
      if (delta.estimates.length) tx.objectStore('chunks').put(delta.estimates, [key, 'estimates', delta.estimateStart])
      const head: StoredCheckpoint = { key, savedAt: new Date().toISOString(), header: delta.header,
        sampleCount: delta.sampleStart + delta.samples.length, estimateCount: delta.estimateStart + delta.estimates.length }
      saved = head
      heads.put(head, key); tx.objectStore('settings').put(key, `active:${this.prefix}`)
    }
    await done
    return saved
  }
  async active(): Promise<LoadedCheckpoint | null> {
    const key = await readSetting(`active:${this.prefix}`)
    return typeof key === 'string' ? this.load(key) : null
  }
  async load(key: string): Promise<LoadedCheckpoint | null> {
    const tx = (await database()).transaction(['heads', 'chunks'])
    const headRequest = request(tx.objectStore('heads').get(key))
    const samplesRequest = request(tx.objectStore('chunks').getAll(IDBKeyRange.bound([key, 'samples', 0], [key, 'samples', Number.MAX_SAFE_INTEGER])))
    const estimatesRequest = request(tx.objectStore('chunks').getAll(IDBKeyRange.bound([key, 'estimates', 0], [key, 'estimates', Number.MAX_SAFE_INTEGER])))
    const [head, samples, estimates] = await Promise.all([headRequest, samplesRequest, estimatesRequest]) as [StoredCheckpoint | undefined, MotionSample[][], MotionEstimate[][]]
    if (!head) return null
    const result = { ...head, samples: samples.flat(), estimates: estimates.flat() }
    if (result.samples.length !== head.sampleCount || result.estimates.length !== head.estimateCount) throw new Error('保存データの件数が一致しません。')
    return result
  }
  async archive(): Promise<void> { await saveSetting(`active:${this.prefix}`, null) }
  async list(): Promise<StoredCheckpoint[]> {
    const heads = await request((await database()).transaction('heads').objectStore('heads').getAll()) as StoredCheckpoint[]
    return heads.filter((h) => h.key.startsWith(`${this.prefix}:`)).reverse()
  }
}
