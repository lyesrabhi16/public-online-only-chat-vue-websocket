import { describe, expect, it } from 'vitest'
import { BARS, downsample, level, toHeights } from './waveform'

describe('waveform', () => {
  it('silence is flat and loud sound fills the bar; quiet speech stays visible', () => {
    expect(level(0)).toBe(0)
    expect(level(1)).toBe(1)
    expect(level(-1)).toBe(0)
    expect(level(0.02)).toBeGreaterThan(0.15)
    expect(level(0.3)).toBeGreaterThan(level(0.02))
  })

  it('keeps the loudest of each slice', () => {
    expect(downsample([0.1, 0.9, 0.2, 0.3, 0, 0.5], 3)).toEqual([90, 30, 50])
  })

  it('stretches a short recording and flattens an empty one', () => {
    expect(downsample([1, 0], 4)).toHaveLength(4)
    expect(downsample([], 5)).toEqual([0, 0, 0, 0, 0])
    expect(downsample([0.5])).toHaveLength(BARS)
  })

  it('turns the bars of a message into heights, whatever junk was sent', () => {
    expect(toHeights([0, 50, 100])).toEqual([0, 0.5, 1])
    expect(toHeights([-20, 250, 'x', null, NaN])).toEqual([0, 1, 0, 0, 0])
    expect(toHeights('nope')).toEqual([])
    expect(toHeights([])).toEqual([])
    expect(toHeights(Array(500).fill(10))).toHaveLength(64)
  })
})
