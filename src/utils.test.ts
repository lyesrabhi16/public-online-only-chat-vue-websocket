import { describe, expect, it } from 'vitest'
import { colorFor, formatTime, groupCode, peopleLabel, typingLabel } from './utils'

describe('colorFor', () => {
  it('gives the same colour to the same name, whatever the case', () => {
    expect(colorFor('Ada')).toBe(colorFor('ada'))
  })

  it('usually gives different people different colours', () => {
    const colours = new Set(['Ada', 'Bob', 'Chloé', 'Dmitri', 'Eve', 'Farid'].map(colorFor))
    expect(colours.size).toBeGreaterThan(3)
  })

  it('is a valid hsl() colour', () => {
    expect(colorFor('x')).toMatch(/^hsl\(\d{1,3} 62% 48%\)$/)
  })
})

describe('formatTime', () => {
  it('shows hours and minutes', () => {
    expect(formatTime('2026-10-29T21:36:25.000Z')).toMatch(/\d{1,2}.\d{2}/)
  })

  it('answers nothing for a date it cannot read', () => {
    expect(formatTime('not a date')).toBe('')
  })
})

describe('labels', () => {
  it('count the people in a room', () => {
    expect(peopleLabel(0)).toBe('Nobody here yet')
    expect(peopleLabel(1)).toBe('1 person here')
    expect(peopleLabel(7)).toBe('7 people here')
  })

  it('say who is typing', () => {
    expect(typingLabel([])).toBe('')
    expect(typingLabel(['Ada'])).toBe('Ada is typing…')
    expect(typingLabel(['Ada', 'Bob'])).toBe('Ada and Bob are typing…')
    expect(typingLabel(['Ada', 'Bob', 'Eve'])).toBe('Several people are typing…')
  })
})

describe('groupCode', () => {
  it('splits a code in two to be read aloud', () => {
    expect(groupCode('K7M2QX')).toBe('K7M 2QX')
  })

  it('leaves anything else alone', () => {
    expect(groupCode('abc')).toBe('abc')
  })
})
