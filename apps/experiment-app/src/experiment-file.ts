import { z } from 'zod'
import { readTransfer, writeTransfer } from './transfer'
import type { ReadableTransfer } from './transfer'
import type { SessionJournal } from './checkpoint'
import { MAX_FILE_BYTES, readRecording } from './recording-schema'

const bundleSchema = z.strictObject({
  format: z.literal('physical-adaptive-experiment-bundle'), version: z.literal(1), records: z.array(z.unknown()).min(2).max(21),
})
function validateChain(records: ReadableTransfer[]) {
  const ids = records.map((r) => r.metadata.sessionId)
  if (new Set(ids).size !== ids.length) throw new Error('計測記録が重複しています。')
  const participant = 'management' in records[0]! ? records[0].management.participant : null
  for (let index = 1; index < records.length; index++) {
    const record = records[index]!
    const context = 'continuation' in record ? record.continuation : undefined
    if (!context || context.previousSessionId !== ids[index - 1]
      || JSON.stringify(context.previousSessionIds) !== JSON.stringify(ids.slice(0, index))
      || JSON.stringify(context.participant) !== JSON.stringify(participant)) throw new Error('続行元の計測記録がそろっていません。')
    const previousTasks: unknown[] = []
    for (const previous of records.slice(0, index)) if ('tasks' in previous) previousTasks.push(...previous.tasks)
    if (JSON.stringify(context.tasks) !== JSON.stringify(previousTasks)) throw new Error('引継ぎ課題と元の記録が一致しません。')
    const previousSurveys: unknown[] = []
    for (const previous of records.slice(0, index)) if ('questionnaires' in previous) previousSurveys.push(...previous.questionnaires.filter((s) => s.phase === 'submitted'))
    if (JSON.stringify(context.questionnaires) !== JSON.stringify(previousSurveys)) throw new Error('引継ぎアンケートと元の記録が一致しません。')
  }
  return records
}
export function readExperimentFile(text: string): ReadableTransfer[] {
  const value = JSON.parse(text)
  if (value?.format !== 'physical-adaptive-experiment-bundle') return [readTransfer(text)]
  return validateChain(bundleSchema.parse(value).records.map((record) => readTransfer(JSON.stringify(record))))
}
export function writeExperimentFile(records: ReadableTransfer[]): string {
  if (records.length === 1) return writeTransfer(records[0]!)
  const value = { format: 'physical-adaptive-experiment-bundle', version: 1, records }
  return JSON.stringify({ ...value, records: readExperimentFile(JSON.stringify(value)) })
}

export async function readSavedFile(file: File, getRecords: () => Promise<ReadableTransfer[]>) {
  let expected: string
  try { expected = writeExperimentFile(await getRecords()) }
  catch { throw new Error('PC側の記録を取得・検証できないため、保存ファイルとの照合ができません。端末内保存の状態を確認して、もう一度お試しください。') }
  try {
    // A continued recording can exceed the normal limit; allow the size we actually export.
    if (file.size > Math.max(MAX_FILE_BYTES, new Blob([expected]).size)) throw new Error('too large')
    const text = await file.text()
    let records: ReadableTransfer[]
    try { records = readExperimentFile(text) }
    catch { return { records: null, recording: readRecording(text), same: false } }
    return { records, recording: null, same: expected === writeExperimentFile(records) }
  } catch { throw new Error('読込みに失敗しました。実測JSONの形式・サイズ・時刻・件数を確認してください。') }
}

/** Parent samples stay in their own checkpoints; load them only for final file export/verification. */
export async function loadExperimentRecords(current: ReadableTransfer, journal: Pick<SessionJournal, 'list' | 'load'>): Promise<ReadableTransfer[]> {
  const records = [current], seen = new Set([current.metadata.sessionId])
  const heads = await journal.list()
  while (true) {
    const latest = records.at(-1)!
    const context = 'continuation' in latest ? latest.continuation : undefined
    if (!context) break
    if (seen.has(context.previousSessionId) || records.length > 20) throw new Error('続行元の参照が不整合です。')
    const head = heads.find((h) => (h.header as { metadata?: { sessionId?: string } })?.metadata?.sessionId === context.previousSessionId)
    const saved = head ? await journal.load(head.key) : null
    if (!saved) throw new Error('続行元の保存記録が見つかりません。記録を保持して確認してください。')
    const header = saved.header as { inference: object }
    const previous = readTransfer(JSON.stringify({ ...header, samples: saved.samples, inference: { ...header.inference, estimates: saved.estimates } }))
    records.push(previous); seen.add(previous.metadata.sessionId)
  }
  return validateChain(records.reverse())
}
