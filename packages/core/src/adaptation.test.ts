import { expect, it } from 'vitest'
import { AdaptationPolicy } from './index'

const config = { unknownHoldMs: 1000, maximumEstimateAgeMs: 600 }
it('waits in normal display, follows valid stable context, expires unknown, and recovers', () => {
  const policy = new AdaptationPolicy(config)
  expect(policy.resolve(null, 0)).toMatchObject({ state: 'stationary', reason: 'initial' })
  expect(policy.resolve({ state: 'walking', atMs: 100 }, 110)).toMatchObject({ state: 'walking', reason: 'estimated' })
  expect(policy.resolve({ state: 'running', atMs: 200 }, 210)).toMatchObject({ state: 'running', reason: 'estimated' })
  expect(policy.resolve({ state: 'unknown', atMs: 300 }, 310)).toMatchObject({ state: 'running', reason: 'unknown-hold' })
  expect(policy.resolve({ state: 'unknown', atMs: 1200 }, 1299)).toMatchObject({ state: 'running', reason: 'unknown-hold' })
  expect(policy.resolve({ state: 'unknown', atMs: 1300 }, 1300)).toMatchObject({ state: 'stationary', reason: 'unknown-fallback' })
  expect(policy.resolve({ state: 'walking', atMs: 1400 }, 1400)).toMatchObject({ state: 'walking', reason: 'estimated' })
})
it('does not extend old estimates indefinitely or add a fresh hold after a long update gap', () => {
  const policy = new AdaptationPolicy(config)
  policy.resolve({ state: 'running', atMs: 0 }, 0)
  expect(policy.resolve({ state: 'running', atMs: 0 }, 601)).toEqual({ state: 'running', reason: 'unknown-hold', stale: true })
  expect(policy.resolve({ state: 'running', atMs: 0 }, 1600)).toEqual({ state: 'stationary', reason: 'unknown-fallback', stale: true })
  const delayed = new AdaptationPolicy(config)
  delayed.resolve({ state: 'walking', atMs: 0 }, 0)
  expect(delayed.resolve({ state: 'walking', atMs: 0 }, 5000).state).toBe('stationary')
})
it('accepts a zero hold for callers and rejects invalid configuration and time', () => {
  const policy = new AdaptationPolicy({ ...config, unknownHoldMs: 0 })
  policy.resolve({ state: 'walking', atMs: 10 }, 10)
  expect(policy.resolve({ state: 'unknown', atMs: 11 }, 11).reason).toBe('unknown-fallback')
  expect(() => policy.resolve(null, 5)).toThrow()
  expect(() => policy.resolve({ state: 'running', atMs: 50 }, 20)).toThrow()
  expect(() => new AdaptationPolicy({ ...config, unknownHoldMs: -1 })).toThrow()
})
it('does not revive an expired display when a fresh unknown arrives after a long processing gap', () => {
  const policy = new AdaptationPolicy(config)
  policy.resolve({ state: 'running', atMs: 0 }, 0)
  expect(policy.resolve({ state: 'unknown', atMs: 5000 }, 5000)).toEqual({ state: 'stationary', reason: 'unknown-fallback', stale: false })
})
