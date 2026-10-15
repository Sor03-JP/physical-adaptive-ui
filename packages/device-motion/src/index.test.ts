import { describe, expect, it, vi } from 'vitest'
import { DeviceMotionSource, snapshotMotionEvent } from './index'
import type { MotionEnvironment, MotionEventData } from './index'

const event: MotionEventData = {
  timeStamp: 12, interval: 16, acceleration: { x: 0, y: null, z: 1 },
  accelerationIncludingGravity: null, rotationRate: null,
}

function environment(overrides: Partial<MotionEnvironment> = {}) {
  const remove = vi.fn()
  let handler: ((event: MotionEventData) => void) | undefined
  const value: MotionEnvironment = {
    secure: true, supported: true, now: () => 42,
    listen: (listener) => { handler = listener; return remove }, ...overrides,
  }
  return { value, remove, emit: () => handler?.(event) }
}

describe('DeviceMotionSource', () => {
  it('requires secure context and permission before attaching a listener', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const listen = vi.fn()
    const source = new DeviceMotionSource(environment({ secure: false, requestPermission, listen }).value)
    await expect(source.requestPermission()).rejects.toThrow('HTTPS')
    expect(requestPermission).not.toHaveBeenCalled()
    expect(() => source.start(vi.fn())).toThrow('許可')
    expect(listen).not.toHaveBeenCalled()
  })

  it('does not collect after permission denial and rejects unsupported devices', async () => {
    const source = new DeviceMotionSource(environment({ requestPermission: async () => 'denied' }).value)
    expect(await source.requestPermission()).toBe('denied')
    expect(() => source.start(vi.fn())).toThrow('許可')
    await expect(new DeviceMotionSource(environment({ supported: false }).value).requestPermission())
      .rejects.toThrow('対応')
  })

  it('requests permission synchronously and propagates browser permission errors', async () => {
    const requestPermission = vi.fn().mockRejectedValue(new Error('user gesture required'))
    const source = new DeviceMotionSource(environment({ requestPermission }).value)
    const result = source.requestPermission()
    expect(requestPermission).toHaveBeenCalledOnce()
    await expect(result).rejects.toThrow('user gesture required')
  })

  it('allows browsers without a permission method and removes listeners exactly once', async () => {
    const env = environment()
    const source = new DeviceMotionSource(env.value)
    await source.requestPermission()
    const listener = vi.fn()
    const stop = source.start(listener)
    env.emit()
    expect(listener).toHaveBeenCalledWith({ eventTimestampMs: 12, intervalMs: 16, receivedAtMs: 42,
      acceleration: { x: 0, y: null, z: 1 }, accelerationIncludingGravity: null, rotationRate: null })
    expect(() => source.start(listener)).toThrow('既に')
    stop(); source.stop(); stop()
    expect(env.remove).toHaveBeenCalledOnce()
    const stopAgain = source.start(listener)
    stop()
    expect(env.remove).toHaveBeenCalledOnce()
    stopAgain()
    expect(env.remove).toHaveBeenCalledTimes(2)
  })
})

it('keeps missing values distinct from real zeroes and snapshots event values', () => {
  const acceleration = { x: 0, y: null, z: Number.NaN }
  const sample = snapshotMotionEvent({ ...event, interval: Number.NaN, acceleration }, 50)
  acceleration.x = 99
  expect(sample.acceleration).toEqual({ x: 0, y: null, z: null })
  expect(sample.accelerationIncludingGravity).toBeNull()
  expect(sample.intervalMs).toBeNull()
})
