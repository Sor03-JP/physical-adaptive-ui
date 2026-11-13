import { expect, it, vi } from 'vitest'
import { prepareContinuation } from './continuation'
import { readSavedFile, writeExperimentFile } from './experiment-file'
import { MAX_FILE_BYTES, MAX_SAMPLES } from './recording-schema'
import { TransferCollector } from './transfer'

const metadata = { sessionId: 'original', startedAt: '2026-10-16T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }

it('verifies matching files and distinguishes a valid different recording', async () => {
  const collector = new TransferCollector(metadata, 2000)
  collector.research.record({ kind: 'observation', value: 'stationary', controllerAtMs: 100, taskRunId: null, reportedPhase: null })
  const current = collector.export()
  const file = new File([writeExperimentFile([current])], 'saved.json')
  expect((await readSavedFile(file, async () => [current])).same).toBe(true)
  const other = { ...current, metadata: { ...metadata, sessionId: 'other' } }
  expect((await readSavedFile(file, async () => [other])).same).toBe(false)
})

it('rejects a previously matching snapshot if missing sensor data arrives during file reading', async () => {
  const current = new TransferCollector(metadata, 2000)
  current.updateStatus(1, { endedAtMs: 100, stopReason: 'manual' })
  const saved = current.export()
  expect(current.matchesSnapshot(saved)).toBe(true)
  const text = writeExperimentFile([saved])
  const file = new File([text], 'partial.json')
  let finishRead!: (text: string) => void
  const read = vi.spyOn(file, 'text').mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
  const checking = readSavedFile(file, async () => [current.export()])
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  expect(current.receive(0, [{ receivedAtMs: 17, eventTimestampMs: 17, reportedIntervalRaw: null, receivedIntervalMs: null,
    acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: null, rotationRate: null }], 101)).toBe(true)
  finishRead(text)
  const result = await checking
  expect(result.same).toBe(true)
  expect(current.matchesSnapshot(result.records!.at(-1)!)).toBe(false)
  expect(current.matchesSnapshot(current.export())).toBe(true)
})

it('accepts an exported continuation bundle larger than the normal file limit', async () => {
  const root = new TransferCollector(metadata, 2000)
  root.setParticipant({ participantId: 'test01', group: 'G1', rosterId: 'rehearsal' })
  const vector = { x: 0.123456789012345, y: -1.23456789012345, z: 9.87654321098765 }
  const samples = Array.from({ length: MAX_SAMPLES }, (_, index) => ({
    receivedAtMs: index * 17, eventTimestampMs: index * 17 + 0.123456789,
    reportedIntervalRaw: 0.01666666753590107, receivedIntervalMs: index ? 17 : null,
    acceleration: vector, accelerationIncludingGravity: vector,
    rotationRate: { alpha: vector.x, beta: vector.y, gamma: vector.z },
  }))
  expect(root.receive(0, samples, 600000)).toBe(true)
  root.updateStatus(samples.length, { endedAtMs: 600000, stopReason: 'capacity' })
  const original = root.export()
  const context = prepareContinuation(original, '計測上限から続行', 600001, 'unused')
  const resumed = new TransferCollector({ ...metadata, sessionId: 'resumed', timeOriginMs: 900000 }, 2000)
  resumed.continuation = context; resumed.management = structuredClone(context.management)
  expect(resumed.receive(0, samples, 1200000)).toBe(true)
  resumed.updateStatus(samples.length, { endedAtMs: 600000, stopReason: 'manual' })
  const records = [original, resumed.export()]
  const file = new File([writeExperimentFile(records)], 'continued.json')
  expect(file.size).toBeGreaterThan(MAX_FILE_BYTES)
  const result = await readSavedFile(file, async () => records)
  expect(result.same).toBe(true)
  expect(result.records?.map((record) => record.samples.length)).toEqual([MAX_SAMPLES, MAX_SAMPLES])
})

it('rejects unrelated oversized files before reading their contents', async () => {
  const file = new File([' '.repeat(MAX_FILE_BYTES + 1)], 'too-large.json')
  const read = vi.spyOn(file, 'text')
  await expect(readSavedFile(file, async () => [new TransferCollector(metadata, 2000).export()])).rejects.toThrow('形式・サイズ・時刻・件数')
  expect(read).not.toHaveBeenCalled()
})

it('reports PC storage failures separately without blaming or reading the selected file', async () => {
  const file = new File(['{}'], 'saved.json')
  const read = vi.spyOn(file, 'text')
  await expect(readSavedFile(file, async () => { throw new Error('IndexedDB unavailable') })).rejects.toThrow('PC側の記録を取得・検証できない')
  expect(read).not.toHaveBeenCalled()
})

it('rejects malformed files and preserves standalone phone-recording support', async () => {
  const getRecords = async () => [new TransferCollector(metadata, 2000).export()]
  await expect(readSavedFile(new File(['{}'], 'invalid.json'), getRecords)).rejects.toThrow('読込みに失敗')
  const recording = { ...metadata, format: 'physical-adaptive-motion-measurement', version: 2,
    clock: 'device-local-performance', samples: [], endedAtMs: 1, stopReason: 'manual' }
  const result = await readSavedFile(new File([JSON.stringify(recording)], 'phone.json'), getRecords)
  expect(result).toEqual({ records: null, recording, same: false })
})
