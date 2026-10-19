import { z } from 'zod'

const time = z.number().finite().nonnegative()
export const observedStateSchema = z.enum(['stationary', 'walking', 'running'])
export const observationProtocolSchema = z.strictObject({
  method: z.enum(['state-confirmation', 'post-task-confirmation']),
  instructionTiming: z.strictObject({ firstMs: z.number().positive(), secondMs: z.number().positive() })
    .refine((timing) => timing.secondMs > timing.firstMs, '動作予定の時刻順が不整合です。'),
})
export type ObservationProtocol = z.infer<typeof observationProtocolSchema>
export const researchEventSchema = z.strictObject({
  kind: z.enum(['observation', 'instruction']),
  value: z.enum(['transition', 'stationary', 'walking', 'running', 'uncertain', 'missed']),
  controllerAtMs: time,
  taskRunId: z.string().nullable(),
  reportedPhase: z.string().nullable(),
}).refine((event) => event.kind === 'observation' || observedStateSchema.safeParse(event.value).success,
  '指示には静止・歩行・走行を指定してください。')
export type ResearchEvent = z.infer<typeof researchEventSchema>
export const researchLogSchema = z.object({
  clock: z.literal('controller-local-performance'),
  events: z.array(researchEventSchema).max(5000),
}).superRefine((log, ctx) => {
  if (log.events.some((e, i) => i > 0 && e.controllerAtMs < log.events[i - 1]!.controllerAtMs))
    ctx.addIssue({ code: 'custom', message: '観察・指示の記録順が不整合です。' })
})
export type ResearchLog = z.infer<typeof researchLogSchema>
/** PC-owned records. Observation timestamps are input times, never inferred movement onsets. */
export class ResearchRecorder {
  private data: ResearchLog = { clock: 'controller-local-performance', events: [] }
  snapshot(): ResearchLog { return structuredClone(this.data) }
  restore(data: ResearchLog) { this.data = researchLogSchema.parse(data) }
  record(event: ResearchEvent) {
    const parsed = researchEventSchema.parse(event)
    if (this.data.events.length >= 5000) throw new Error('観察・指示ログの上限に達しました。')
    if (parsed.controllerAtMs < (this.data.events.at(-1)?.controllerAtMs ?? 0)) throw new Error('PC時刻が逆行しています。')
    this.data.events.push(parsed)
  }
}
