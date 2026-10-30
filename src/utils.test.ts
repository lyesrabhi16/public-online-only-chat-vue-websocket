import { describe, expect, it } from 'vitest'
import { EMOJIS as SERVER_EMOJIS } from '../server/rooms.js'
import { EMOJIS, clock, codeFromHash, colorFor, formatTime, groupCode, inviteLink, mentionCandidates, mentionEnd, mentionQuery, mentions, mentionsByName, mentionsEveryone, parseWhisper, peopleLabel, splitMentions, typingLabel } from './utils'

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
    expect(groupCode('K7M2QXAB9T')).toBe('K7M2Q XAB9T')
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

  it('reads @all as a mention of everybody, in any case', () => {
    expect(splitMentions('hey @all, and @ALL!', names)).toEqual([
      { text: 'hey ' },
      { text: '@all', all: true },
      { text: ', and ' },
      { text: '@ALL', all: true },
      { text: '!' },
    ])
    expect(splitMentions('@all', [])).toEqual([{ text: '@all', all: true }])
    expect(mentions('@all please read', 'Bob')).toBe(true)
    expect(mentionsEveryone('@all please read')).toBe(true)
    expect(mentionsEveryone('@bob please read')).toBe(false)
  })

  it('does not take a word that merely starts with "all", or an @ inside a word', () => {
    expect(mentionsEveryone('@allison and @allow')).toBe(false)
    expect(splitMentions('@Allan', ['Allan'])).toEqual([{ text: '@Allan', mention: 'Allan' }]) // a nickname that starts like "all" is still a person
    expect(mentionsEveryone('write to me@all.com')).toBe(false)
    expect(mentions('mail ada@Ada.com', 'Ada')).toBe(false)
    expect(mentionsEveryone('(@all)')).toBe(true) // punctuation around it is fine
  })

  it('reads a hyphen or a period that goes on into a word as part of that word, but not one that ends a sentence', () => {
    expect(mentionsEveryone('@all-hands today')).toBe(false)
    expect(mentionsEveryone('@all.hands')).toBe(false)
    expect(mentionsEveryone('Hello @all.')).toBe(true)
    expect(mentionsEveryone('Hello @all, see you')).toBe(true)
    expect(mentionsEveryone('Hello @all - see you')).toBe(true)
    expect(mentionsByName('@Bob.Smith hi', 'Bob', ['Bob'])).toBe(false)
    expect(mentionsByName('Thanks @Bob.', 'Bob', ['Bob'])).toBe(true)
  })

  it('is read the same way by everybody in the room: a nickname that starts like "all" is that person', () => {
    const room = ['Ada', 'all-star', 'Bob']
    expect(mentions('@all-star lunch?', 'Ada', room)).toBe(false)
    expect(mentions('@all-star lunch?', 'all-star', room)).toBe(true)
    expect(mentionsEveryone('@all-star lunch?', room)).toBe(false)
    expect(mentions('@all lunch?', 'Ada', room)).toBe(true)
    expect(mentions('@all lunch?', 'all-star', room)).toBe(true)
  })

  it('never takes "all" for a nickname: it is the word for everybody (a user of an older server could still have it)', () => {
    expect(splitMentions('@all', ['all'])).toEqual([{ text: '@all', all: true }])
    expect(mentionsByName('@all', 'all', ['all'])).toBe(false)
    expect(mentionCandidates('', ['all', 'Ada'])).toEqual(['all', 'Ada']) // listed once
  })

  it('only counts your name in a whisper, never "@all": mentionsByName leaves it out', () => {
    expect(mentionsByName('@all psst', 'Ada', ['Ada'])).toBe(false)
    expect(mentionsByName('@Ada psst', 'Ada', ['Ada'])).toBe(true)
  })
})

describe('where a mention ends', () => {
  const room = ['Ada', 'Ada Lovelace', 'Bob']

  it('is the end of the name when the caret is inside one, so that a suggestion replaces all of it', () => {
    expect(mentionEnd('ask @Ada Lovelace about it', 4, 7, room)).toBe(17)
    expect(mentionEnd('ask @all today', 4, 6, room)).toBe(8)
  })

  it('is the caret when what follows is not a name that was typed', () => {
    expect(mentionEnd('hi @bo', 3, 6, room)).toBe(6)
    expect(mentionEnd('hi @Adam', 3, 6, ['Ada'])).toBe(6) // "Adam" is another word, not "Ada" with a tail
    expect(mentionEnd('hi @', 3, 4, room)).toBe(4)
  })
})

describe('typing a mention', () => {
  it('finds the @ before the caret, and what has been typed after it', () => {
    expect(mentionQuery('hello @', 7)).toEqual({ start: 6, query: '' })
    expect(mentionQuery('hello @bo', 9)).toEqual({ start: 6, query: 'bo' })
    expect(mentionQuery('@Ada Lov', 8)).toEqual({ start: 0, query: 'Ada Lov' }) // a nickname can have spaces
    expect(mentionQuery('hi @bob and then @', 18)).toEqual({ start: 17, query: '' })
  })

  it('only looks before the caret', () => {
    expect(mentionQuery('hello @bo and more', 9)).toEqual({ start: 6, query: 'bo' })
    expect(mentionQuery('hello @bo and more', 5)).toBeNull()
  })

  it('finds nothing when there is no @ being typed', () => {
    expect(mentionQuery('hello', 5)).toBeNull()
    expect(mentionQuery('me@all', 6)).toBeNull() // inside a word
    expect(mentionQuery('@x'.repeat(2) + ' ' + 'y'.repeat(30), 35)).toBeNull()
    expect(mentionQuery('@ada!', 5)).toBeNull() // "!" cannot be part of a nickname
  })

  it('offers "all" first, then the names that start with what was typed', () => {
    const names = ['Bob', 'Ada', 'Ada Lovelace', 'Cleo']
    expect(mentionCandidates('', names)).toEqual(['all', 'Ada', 'Ada Lovelace', 'Bob', 'Cleo'])
    expect(mentionCandidates('a', names)).toEqual(['all', 'Ada', 'Ada Lovelace'])
    expect(mentionCandidates('ADA L', names)).toEqual(['Ada Lovelace'])
    expect(mentionCandidates('bo', names)).toEqual(['Bob'])
    expect(mentionCandidates('al', names)).toEqual(['all'])
  })

  it('offers nothing once what was typed cannot be a name any more', () => {
    expect(mentionCandidates('zz', ['Ada'])).toEqual([])
    expect(mentionCandidates('Ada can you', ['Ada'])).toEqual([])
    expect(mentionCandidates('', [])).toEqual(['all'])
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
    expect(inviteLink('K7M2QXAB9T', 'https://chat.example/')).toBe('https://chat.example/#/join/K7M2QXAB9T')
    expect(codeFromHash('#/join/k7m2qxab9t')).toBe('K7M2QXAB9T')
  })

  it('are ignored when they are not an invite', () => {
    for (const hash of ['', '#', '#/join/', '#/join/K7M2QXAB9', '#/join/K7M2QXA', '#/join/K7M2QXAB9TC', '#/join/K7M2QXAB9T/extra', '#/other/K7M2QXAB9T']) expect(codeFromHash(hash), hash).toBeNull()
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
