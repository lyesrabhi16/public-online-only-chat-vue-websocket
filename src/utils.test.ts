import { describe, expect, it } from 'vitest'
import { EMOJIS as SERVER_EMOJIS } from '../server/rooms.js'
import { EMOJIS, clock, codeFromHash, colorFor, formatTime, groupCode, inviteLink, mentions, parseWhisper, peopleLabel, splitMentions, typingLabel } from './utils'

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
    expect(groupCode('K7M2QXAB')).toBe('K7M2 QXAB')
    expect(groupCode('SHORT')).toBe('SHORT') // not a code: left as it is
  })

  it('leaves anything else alone', () => {
    expect(groupCode('abc')).toBe('abc')
  })
})

describe('mentions', () => {
  const names = ['Ada', 'Ada Lovelace', 'Bob']

  it('cuts a message into text and @mentions, preferring the longest nickname', () => {
    expect(splitMentions('hi @Ada Lovelace and @bob!', names)).toEqual([
      { text: 'hi ' },
      { text: '@Ada Lovelace', mention: 'Ada Lovelace' },
      { text: ' and ' },
      { text: '@bob', mention: 'Bob' },
      { text: '!' },
    ])
  })

  it('does not cut a word that merely starts like a nickname', () => {
    expect(splitMentions('@Adam is here', ['Ada'])).toEqual([{ text: '@Adam is here' }])
  })

  it('leaves a message without @ alone, and survives special characters in nicknames', () => {
    expect(splitMentions('nothing', names)).toEqual([{ text: 'nothing' }])
    expect(splitMentions('hi @a.b+c (d)', ['a.b+c (d)'])[1].mention).toBe('a.b+c (d)')
  })

  it('knows when you are mentioned', () => {
    expect(mentions('hello @ada', 'Ada')).toBe(true)
    expect(mentions('hello Ada', 'Ada')).toBe(false)
  })
})

describe('whispers', () => {
  const names = ['Ada', 'Ada Lovelace', 'Bob']

  it('reads /w Nickname message, with the longest matching nickname', () => {
    expect(parseWhisper('/w Bob psst, listen', names)).toEqual({ to: 'Bob', text: 'psst, listen' })
    expect(parseWhisper('/w Ada Lovelace hello', names)).toEqual({ to: 'Ada Lovelace', text: 'hello' })
    expect(parseWhisper('/whisper ada hi', names)).toEqual({ to: 'Ada', text: 'hi' })
  })

  it('is not a whisper without a message, or for somebody who is not here, or for a normal message', () => {
    expect(parseWhisper('/w Bob', names)).toBeNull()
    expect(parseWhisper('/w Eve hi', names)).toBeNull()
    expect(parseWhisper('w Bob hi', names)).toBeNull()
    expect(parseWhisper('hello /w Bob hi', names)).toBeNull()
  })
})

describe('invite links', () => {
  it('carry the code after the #, in capitals', () => {
    expect(inviteLink('K7M2QXAB', 'https://chat.example/')).toBe('https://chat.example/#/join/K7M2QXAB')
    expect(codeFromHash('#/join/k7m2qxab')).toBe('K7M2QXAB')
  })

  it('are ignored when they are not an invite', () => {
    for (const hash of ['', '#', '#/join/', '#/join/K7M2QXA', '#/join/K7M2QX', '#/join/K7M2QXABC', '#/join/K7M2QXAB/extra', '#/other/K7M2QXAB']) expect(codeFromHash(hash), hash).toBeNull()
  })
})

describe('small helpers', () => {
  it('format a length of time', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(4200)).toBe('0:04')
    expect(clock(83_000)).toBe('1:23')
  })

  it('offer exactly the reactions the server accepts', () => {
    expect(EMOJIS).toEqual(SERVER_EMOJIS)
  })
})
