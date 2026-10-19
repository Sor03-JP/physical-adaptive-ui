import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { observationGuide } from './observation-plan'
import ObservationPanel from './ObservationPanel'
import { TransitTrial } from './tasks'
import { ResearchRecorder } from './research-log'

function trial(id: 'A1' | 'A2' | 'A3' | 'P1') {
  const t = new TransitTrial('trial', 'session', id, 0, 'automatic')
  t.present(1); t.begin(2); t.present(3)
  return t
}

it('shows the planned movements at the 4s, 11s and 15s boundaries', () => {
  const still = trial('A1').snapshot(), walk = trial('A2').snapshot(), jog = trial('A3').snapshot()
  expect(observationGuide(still, 14999)).toMatchObject({ state: 'stationary', next: null })
  for (const [time, state] of [[0, 'stationary'], [3999, 'stationary'], [4000, 'walking'], [10999, 'walking'], [11000, 'stationary']] as const)
    expect(observationGuide(walk, time)?.state).toBe(state)
  for (const [time, state] of [[0, 'walking'], [4000, 'running'], [11000, 'walking'], [15000, 'stationary']] as const)
    expect(observationGuide(jog, time)?.state).toBe(state)
  expect(observationGuide(jog, 5000)?.next).toEqual({ atMs: 11000, state: 'walking' })
  expect(observationGuide({ ...jog, phase: 'briefing' }, 12000)).toMatchObject({ state: 'walking', elapsedMs: null })
  for (const phase of ['waiting-stop', 'answering'] as const)
    expect(observationGuide({ ...jog, phase }, 0)).toMatchObject({ state: 'stationary', next: null })
  expect(observationGuide({ ...jog, phase: 'complete' }, 0)).toBeNull()
  expect(observationGuide(trial('P1').snapshot(), 5000)).toBeNull()
})

it('does not infer confirmations from the schedule and keeps conflicting observations visible', () => {
  const run = trial('A2').snapshot(), log = new ResearchRecorder()
  log.record({ kind: 'observation', value: 'stationary', controllerAtMs: 5500, taskRunId: run.id, reportedPhase: 'viewing' })
  const before = log.snapshot(), noop = () => {}
  const html = renderToStaticMarkup(<ObservationPanel log={before} run={run} elapsedMs={5000}
    hidden onHidden={noop} />)
  expect(html).toContain('いま案内する動作（予定）')
  expect(html).toContain('movement-current">歩行')
  expect(html).toContain('観察：静止確認')
  expect(html).not.toContain('を指示した</button>')
  expect(html).not.toContain('変化開始</button>')
  expect(html).not.toContain('aria-pressed="true"')
  expect(log.snapshot()).toEqual(before)
  const empty = renderToStaticMarkup(<ObservationPanel log={null} run={run} elapsedMs={12000}
    hidden onHidden={noop} />)
  expect(empty).toContain('まだ記録はありません。')
})
