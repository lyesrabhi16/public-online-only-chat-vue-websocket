// The chat store against the real server, with real sockets and real encryption.
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createChatServer } from '../../server/index.js'
import { deriveKey, encrypt } from '../crypto'
import { locale } from '../i18n'
import type { Msg } from '../types'
import { createChat, type Chat } from './chat'

let server: ReturnType<typeof createChatServer>
let url: string
const chats: Chat[] = []
const raw: ReturnType<typeof connect>[] = []

beforeAll(async () => {
  server = createChatServer({ corsOrigin: '*' })
  url = `http://localhost:${await server.listen(0)}`
})
afterEach(() => {
  locale.value = 'en'
  while (chats.length) chats.pop()!.logout()
  while (raw.length) raw.pop()!.close()
})
afterAll(() => server.close())

const until = async (check: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function person(nickname: string, invite: string | null = null) {
  const chat = createChat(url, connect, invite)
  chats.push(chat)
  expect(await chat.login(nickname)).toBe('')
  return chat
}

/** `owner` makes a room; the others come in with its code. */
async function roomWith(name: string, owner: Chat, ...others: Chat[]) {
  expect(await owner.create(name)).toBe('')
  const room = owner.state.joined[owner.state.active!].room
  for (const other of others) expect(await other.join(room.code)).toBe('')
  return room
}

const messages = (chat: Chat, roomId: string): Msg[] =>
  chat.state.joined[roomId].lines.flatMap((l) => (l.kind === 'message' ? [l.msg] : []))
const lastText = (chat: Chat, roomId: string) => messages(chat, roomId).at(-1)?.text
const arrived = (chat: Chat, roomId: string, text: string) => until(() => messages(chat, roomId).some((m) => m.text === text))

/** A bare connection that is in the room and sees what the server sees. */
async function eavesdropper(code: string, nickname = 'Spy') {
  const socket = connect(url, { transports: ['websocket'], reconnection: false })
  raw.push(socket)
  await new Promise<void>((r) => socket.on('connect', () => r()))
  await new Promise((r) => socket.emit('hello', { nickname }, r))
  const seen: { body: string }[] = []
  socket.on('message', (m) => seen.push(m))
  const joined = await new Promise<{ ok: boolean; room: { id: string } }>((r) => socket.emit('room:join', { code }, r))
  return { socket, seen, roomId: joined.room.id }
}

describe('getting in', () => {
  it('logs in with no room yet, and shows refusals in the language of the page', async () => {
    const ada = await person('Ada S1')
    expect(ada.state.me?.nickname).toBe('Ada S1')
    expect(ada.state.joined).toEqual({})
    const other = createChat(url, connect)
    chats.push(other)
    expect(await other.login('ada s1')).toMatch(/already used/)
    locale.value = 'fr'
    expect(await other.login('ada s1')).toMatch(/déjà utilisé/)
  })

  it('reports a server that cannot be reached', async () => {
    const lost = createChat('http://localhost:1', connect)
    chats.push(lost)
    expect(await lost.login('Nobody')).toBe('Cannot reach the chat server.')
  }, 15000)

  it('goes straight into the room of an invite link, after the nickname', async () => {
    const ada = await person('Ada S2')
    const room = await roomWith('Invite S2', ada)
    const bob = await person('Bob S2', room.code)
    expect(Object.keys(bob.state.joined)).toEqual([room.id])
    expect(bob.state.active).toBe(room.id)
    expect(bob.state.invite).toBeNull()
  })

  it('shows the refusal when the invite link has a wrong code', async () => {
    const bob = await person('Bob S2b', 'ZZZZZZ')
    expect(bob.state.error).toMatch(/No room has this code/)
    expect(bob.state.joined).toEqual({})
  })
})

describe('rooms', () => {
  it('creates a room that you run, with a code, and lets people in with it only', async () => {
    const [ada, bob] = [await person('Ada S3'), await person('Bob S3')]
    const room = await roomWith('Private S3', ada)
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(room.ownerId).toBe(ada.state.me!.id)
    expect(await bob.join('ZZZZZZ')).toMatch(/No room/)
    expect(await bob.join('nope')).toMatch(/not a room code/)
    expect(await bob.join(room.code.toLowerCase())).toBe('')
    await until(() => ada.state.joined[room.id].members.length === 2)
    expect(ada.state.joined[room.id].room.members).toBe(2)
  })

  it('forgets a room when you leave it', async () => {
    const ada = await person('Ada S4')
    await ada.create('Temp S4')
    const id = ada.state.active!
    await ada.leave(id)
    expect(ada.state.active).toBeNull()
    expect(ada.state.joined[id]).toBeUndefined()
  })

  it('cannot send without an open room', async () => {
    const ada = await person('Ada S5')
    expect(await ada.send('hi')).toMatch(/Open a room/)
  })
})

describe('what is said', () => {
  it('goes to the others decrypted, and the server only ever sees ciphertext', async () => {
    const [ada, bob] = [await person('Ada S6'), await person('Bob S6')]
    const room = await roomWith('Secrets S6', ada, bob)
    const spy = await eavesdropper(room.code)
    expect(await ada.send('the launch is at ten')).toBe('')
    await arrived(bob, room.id, 'the launch is at ten')
    expect(messages(bob, room.id).at(-1)).toMatchObject({ mine: false, from: { nickname: 'Ada S6' }, unreadable: false })
    expect(messages(ada, room.id).at(-1)!.mine).toBe(true)
    await until(() => spy.seen.length === 1)
    expect(JSON.stringify(spy.seen)).not.toContain('launch') // even somebody in the room cannot read it without the key
    expect(spy.seen[0].body).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('has no history: somebody who joins later sees no message', async () => {
    const ada = await person('Ada S7')
    const room = await roomWith('Past S7', ada)
    await ada.send('what a secret')
    const late = await person('Late S7')
    await late.join(room.code)
    expect(messages(late, room.id)).toHaveLength(0)
  })

  it('shows what an unreadable message is, instead of showing it', async () => {
    const [ada, bob] = [await person('Ada S8'), await person('Bob S8')]
    const room = await roomWith('Bad S8', ada, bob)
    const key = await deriveKey(room.code)
    const spy = await eavesdropper(room.code, 'Mallory')
    const send = async (payload: unknown) => {
      const body = await encrypt(key, payload)
      return new Promise((r) => spy.socket.emit('message', { room: spy.roomId, body }, r))
    }
    const bad = [
      { k: 'image', src: 'data:text/html;base64,PHNjcmlwdD4=', w: 1, h: 1 }, // not an image
      { k: 'image', src: 'javascript:alert(1)', w: 1, h: 1 },
      { k: 'audio', src: 'https://evil.example/a.webm', ms: 1, wave: [] },
      { k: 'unknown' },
    ]
    for (const payload of bad) await send(payload)
    await sleep(600)
    const received = messages(bob, room.id)
    expect(received).toHaveLength(bad.length)
    expect(received.every((m) => m.unreadable && !m.src)).toBe(true)
    // and a body that is not encrypted with the room key is unreadable too
    await new Promise((r) => spy.socket.emit('message', { room: spy.roomId, body: 'plain text, not encrypted' }, r))
    await until(() => messages(bob, room.id).length === bad.length + 1)
    expect(messages(bob, room.id).at(-1)!.unreadable).toBe(true)
  })

  it('carries photos and voice messages', async () => {
    const [ada, bob] = [await person('Ada S9'), await person('Bob S9')]
    const room = await roomWith('Media S9', ada, bob)
    await ada.sendPhoto({ src: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', w: 800, h: 600 }, 'look')
    await until(() => messages(bob, room.id).some((m) => m.kind === 'image'))
    expect(messages(bob, room.id)[0]).toMatchObject({ kind: 'image', w: 800, h: 600, text: 'look' })
    await ada.sendVoice({ src: 'data:audio/webm;codecs=opus;base64,GkXfow==', ms: 4200, wave: [0, 40, 100] })
    await until(() => messages(bob, room.id).some((m) => m.kind === 'audio'))
    expect(messages(bob, room.id).at(-1)).toMatchObject({ kind: 'audio', ms: 4200, wave: [0, 40, 100] })
  })

  it('replies to a message by its id', async () => {
    const [ada, bob] = [await person('Ada S10'), await person('Bob S10')]
    const room = await roomWith('Replies S10', ada, bob)
    await ada.send('question')
    await arrived(bob, room.id, 'question')
    const question = messages(bob, room.id)[0]
    await bob.send('answer', question.id)
    await arrived(ada, room.id, 'answer')
    expect(messages(ada, room.id).at(-1)!.replyTo).toBe(question.id)
  })

  it('edits and deletes your own messages, for everybody, and refuses to change somebody else’s', async () => {
    const [ada, bob] = [await person('Ada S11'), await person('Bob S11')]
    const room = await roomWith('Edits S11', ada, bob)
    await ada.send('first')
    await arrived(bob, room.id, 'first')
    const mine = messages(ada, room.id)[0]
    await until(() => !!messages(ada, room.id)[0].proof)
    expect(await ada.edit(mine.id, 'second')).toBe('')
    await until(() => lastText(bob, room.id) === 'second' && messages(bob, room.id)[0].edited)
    expect(await bob.edit(mine.id, 'hijack')).toMatch(/only change your own/) // Bob has no proof for it
    expect(await ada.remove(mine.id)).toBe('')
    await until(() => messages(bob, room.id)[0].deleted)
    expect(messages(bob, room.id)[0]).toMatchObject({ text: '', deleted: true })
  })

  it('counts reactions, and takes them back', async () => {
    const [ada, bob] = [await person('Ada S12'), await person('Bob S12')]
    const room = await roomWith('Reactions S12', ada, bob)
    await ada.send('react to me')
    await arrived(bob, room.id, 'react to me')
    const id = messages(bob, room.id)[0].id
    await bob.react(id, '👍')
    await until(() => messages(ada, room.id)[0].reactions['👍']?.length === 1)
    expect(messages(ada, room.id)[0].reactions).toEqual({ '👍': ['Bob S12'] })
    await ada.react(id, '👍')
    await until(() => messages(bob, room.id)[0].reactions['👍']?.length === 2)
    await bob.react(id, '👍')
    await until(() => messages(ada, room.id)[0].reactions['👍']?.length === 1)
    await ada.react(id, '👍')
    await until(() => Object.keys(messages(bob, room.id)[0].reactions).length === 0)
  })

  it('whispers to one person with /w, and the others never see it', async () => {
    const [ada, bob, cleo] = [await person('Ada S13'), await person('Bob S13'), await person('Cleo S13')]
    const room = await roomWith('Whispers S13', ada, bob, cleo)
    await until(() => ada.state.joined[room.id].members.length === 3)
    expect(await ada.send('/w bob s13 psst')).toBe('')
    await arrived(bob, room.id, 'psst')
    await arrived(ada, room.id, 'psst')
    expect(messages(bob, room.id).at(-1)).toMatchObject({ whisperTo: 'Bob S13', mine: false })
    expect(messages(ada, room.id).at(-1)).toMatchObject({ whisperTo: 'Bob S13', mine: true })
    await sleep(300)
    expect(messages(cleo, room.id)).toHaveLength(0)
  })
})

describe('keeping up', () => {
  it('counts unread messages of the rooms you are not looking at, and mentions', async () => {
    const [ada, bob] = [await person('Ada S14'), await person('Bob S14')]
    const one = await roomWith('One S14', ada, bob)
    const two = await roomWith('Two S14', ada, bob) // Bob is looking at this one
    bob.open(two.id)
    await ada.send('quiet one', null)
    ada.open(one.id)
    await ada.send('first for you')
    await ada.send('and @Bob S14, you too')
    await until(() => bob.state.joined[one.id].unread === 2)
    expect(bob.state.joined[one.id].mentioned).toBe(true)
    expect(bob.state.joined[two.id].unread).toBe(0)
    expect(bob.unreadTotal()).toBe(2)
    bob.open(one.id)
    expect(bob.state.joined[one.id]).toMatchObject({ unread: 0, mentioned: false })
  })

  it('does not count what you muted', async () => {
    const [ada, bob] = [await person('Ada S15'), await person('Bob S15')]
    const one = await roomWith('One S15', ada, bob)
    const two = await roomWith('Two S15', ada, bob)
    bob.open(two.id)
    bob.open(one.id)
    bob.toggleMute('ADA S15')
    bob.open(two.id)
    ada.open(one.id)
    await ada.send('muted words')
    await arrived(bob, one.id, 'muted words')
    expect(bob.state.joined[one.id].unread).toBe(0)
    expect(bob.state.joined[one.id].muted).toEqual(['ada s15'])
    bob.open(one.id) // muting applies to the room you are looking at
    bob.toggleMute('Ada S15')
    expect(bob.state.joined[one.id].muted).toEqual([])
  })

  it('shows who is typing, and forgets when they stop', async () => {
    const [ada, bob] = [await person('Ada S16'), await person('Bob S16')]
    const room = await roomWith('Typing S16', ada, bob)
    ada.typing(true)
    await until(() => bob.state.joined[room.id].typing.includes('Ada S16'))
    ada.typing(false)
    await until(() => bob.state.joined[room.id].typing.length === 0)
  })

  it('turns sound and notifications on and off without a browser to ask', async () => {
    const ada = await person('Ada S17')
    ada.setSound(true)
    expect(ada.state.settings.sound).toBe(true)
    expect(await ada.setNotifications(true)).toBe(false) // there is no Notification API here
    expect(ada.state.settings.notifications).toBe(false)
  })
})

describe('running a room', () => {
  it('lets the owner lock the room, with the news and a refusal for newcomers', async () => {
    const [ada, bob, cleo] = [await person('Ada S18'), await person('Bob S18'), await person('Cleo S18')]
    const room = await roomWith('Locked S18', ada, bob)
    expect(await bob.lock(true)).toMatch(/Only the person who runs/)
    expect(await ada.lock(true)).toBe('')
    await until(() => bob.state.joined[room.id].room.locked)
    expect(bob.state.joined[room.id].lines.some((l) => l.kind === 'event' && l.key === 'event.locked')).toBe(true)
    expect(await cleo.join(room.code)).toMatch(/locked/)
    await ada.lock(false)
    expect(await cleo.join(room.code)).toBe('')
  })

  it('lets the owner remove somebody, who is told, and cannot come back', async () => {
    const [ada, bob] = [await person('Ada S19'), await person('Bob S19')]
    const room = await roomWith('Kick S19', ada, bob)
    const bobId = bob.state.me!.id
    expect(await ada.kick(bobId)).toBe('')
    await until(() => !bob.state.joined[room.id])
    expect(bob.state.error).toBe('You were removed from Kick S19.')
    expect(await bob.join(room.code)).toMatch(/removed/)
    await until(() => ada.state.joined[room.id].members.length === 1)
  })

  it('changes the key with the code: those inside keep talking, the old code is useless', async () => {
    const [ada, bob, cleo] = [await person('Ada S20'), await person('Bob S20'), await person('Cleo S20')]
    const room = await roomWith('Rotate S20', ada, bob)
    const oldCode = room.code // the room object itself is updated in place
    expect(await ada.newCode()).toBe('')
    await until(() => bob.state.joined[room.id].room.code !== oldCode)
    const code = ada.state.joined[room.id].room.code
    await until(() => ada.state.joined[room.id].room.code === code)
    await sleep(300) // the new key is derived
    await ada.send('after the change')
    await arrived(bob, room.id, 'after the change')
    expect(bob.state.joined[room.id].lines.some((l) => l.kind === 'event' && l.key === 'event.newCode')).toBe(true)
    expect(await cleo.join(oldCode)).toMatch(/No room has this code/)
    expect(await cleo.join(code)).toBe('')
  })

  it('hands the room to somebody else when its owner leaves', async () => {
    const [ada, bob] = [await person('Ada S21'), await person('Bob S21')]
    const room = await roomWith('Handover S21', ada, bob)
    await ada.leave(room.id)
    await until(() => bob.state.joined[room.id].room.ownerId === bob.state.me!.id)
    expect(bob.state.joined[room.id].lines.some((l) => l.kind === 'event' && l.key === 'event.owner')).toBe(true)
    expect(await bob.lock(true)).toBe('')
  })
})

describe('the connection', () => {
  it('says hello again and goes back into its rooms, with the same code and key, after the connection drops', async () => {
    const [ada, bob] = [await person('Ada S22'), await person('Bob S22')]
    const room = await roomWith('Blip S22', ada, bob)
    server.io.sockets.sockets.forEach((s) => {
      if (s.id === ada.state.me?.id) s.conn.close()
    })
    await until(() => ada.state.status === 'offline')
    await until(() => ada.state.status === 'online' && !!ada.state.joined[room.id]?.lines.some((l) => l.kind === 'event' && l.key === 'event.back'))
    expect(ada.state.joined[room.id].room.code).toBe(room.code)
    expect(await ada.send('I am back')).toBe('')
    await arrived(bob, room.id, 'I am back')
  })
})

/** A socket that only does what a test tells it to: events arrive when the test says so. */
class ControlledSocket {
  connected = true
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
    return this
  }
  once(event: string, fn: (...args: unknown[]) => void) {
    return this.on(event, fn)
  }
  emit() {}
  close() {}
  timeout() {
    return { emit: (event: string, _data: unknown, ack: (err: Error | null, answer: unknown) => void) => ack(null, this.answers[event]) }
  }
  answers: Record<string, unknown> = {}
  arrives(event: string, payload: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(payload)
  }
}

describe('a description of the room that arrives late', () => {
  const room = { id: 'r1', name: 'Study', code: 'K7M2QX', members: 2, locked: false, ownerId: 'a', rev: 5 }

  async function inRoom() {
    const socket = new ControlledSocket()
    socket.answers = {
      hello: { ok: true, user: { id: 'me', nickname: 'Me' } },
      'room:join': { ok: true, room: { ...room }, members: [{ id: 'a', nickname: 'Ada', owner: true }, { id: 'me', nickname: 'Me' }] },
    }
    const chat = createChat('http://nowhere', (() => socket) as never)
    expect(await chat.login('Me')).toBe('')
    expect(await chat.join('K7M2QX')).toBe('')
    return { chat, socket }
  }

  it('does not undo a newer one: the room stays locked', async () => {
    const { chat, socket } = await inRoom()
    socket.arrives('room:updated', { room: { ...room, locked: true, rev: 7 } }) // the owner locked the room
    socket.arrives('room:updated', { room: { ...room, locked: false, rev: 6 } }) // the announcement of somebody joining, a moment older
    expect(chat.state.joined.r1.room).toMatchObject({ locked: true, rev: 7 })
    expect(chat.state.joined.r1.lines.filter((l) => l.kind === 'event' && l.key === 'event.unlocked')).toHaveLength(0)
  })

  it('does not bring back an old code either', async () => {
    const { chat, socket } = await inRoom()
    socket.arrives('room:updated', { room: { ...room, code: 'NEWCOD', rev: 8 } })
    socket.arrives('room:updated', { room: { ...room, rev: 6 } })
    expect(chat.state.joined.r1.room.code).toBe('NEWCOD')
  })

  it('still applies updates that are newer, or the same', async () => {
    const { chat, socket } = await inRoom()
    socket.arrives('room:updated', { room: { ...room, locked: true, rev: 6 } })
    expect(chat.state.joined.r1.room.locked).toBe(true)
    socket.arrives('room:updated', { room: { ...room, locked: true, members: 3, rev: 6 } }) // same revision: the same room, taken in
    expect(chat.state.joined.r1.room.members).toBe(3)
  })
})
