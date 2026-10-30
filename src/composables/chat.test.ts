// The chat store against the real server, with real sockets and real encryption (MLS between the pages, Argon2 at the lowest cost).
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createChatServer } from '../../server/index.js'
import { deriveSecrets, prove, toBase64, type Secrets } from '../crypto'
import { locale } from '../i18n'
import { Group, newCandidate } from '../mls'
import type { Msg } from '../types'
import { createChat, type Chat } from './chat'

let server: ReturnType<typeof createChatServer>
let url: string
const cheap = { t: 1, m: 8 } // the real cost is about a second a code
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
  const chat = createChat(url, connect, invite, { cost: cheap })
  chats.push(chat)
  expect(await chat.login(nickname)).toBe('')
  return chat
}

/** `owner` makes a room; the others come in with its code. The room comes back with its code (the server does not know it). */
async function roomWith(name: string, owner: Chat, ...others: Chat[]) {
  expect(await owner.create(name)).toBe('')
  const joined = owner.state.joined[owner.state.active!]
  for (const other of others) expect(await other.join(joined.code)).toBe('')
  return { ...joined.room, code: joined.code }
}

const messages = (chat: Chat, roomId: string): Msg[] =>
  chat.state.joined[roomId].lines.flatMap((l) => (l.kind === 'message' ? [l.msg] : []))
const lastText = (chat: Chat, roomId: string) => messages(chat, roomId).at(-1)?.text
const arrived = (chat: Chat, roomId: string, text: string) => until(() => messages(chat, roomId).some((m) => m.text === text))

const ask = <T = Record<string, any>>(socket: ReturnType<typeof connect>, event: string, data: unknown) => new Promise<T>((r) => socket.emit(event, data, r))

/** A bare connection that is in the room (it knows the code) and sees what the server sees, but is never let into the group. */
async function eavesdropper(code: string, nickname = 'Spy') {
  const socket = connect(url, { transports: ['websocket'], reconnection: false })
  raw.push(socket)
  await new Promise<void>((r) => socket.on('connect', () => r()))
  await ask(socket, 'hello', { nickname })
  const seen: { body: string }[] = []
  socket.on('message', (m) => seen.push(m))
  const secrets = await deriveSecrets(code, cheap)
  const joined = await ask<{ ok: boolean; room: { id: string } }>(socket, 'room:join', { handle: secrets.handle })
  return { socket, seen, roomId: joined.room.id, secrets }
}

/** Somebody who knows the code and is let into the group like anyone, but writes whatever they like: the page of everyone else must cope. */
async function insider(code: string, nickname: string) {
  const socket = connect(url, { transports: ['websocket'], reconnection: false })
  raw.push(socket)
  await new Promise<void>((r) => socket.on('connect', () => r()))
  const hello = await ask<{ user: { id: string } }>(socket, 'hello', { nickname })
  const secrets = await deriveSecrets(code, cheap)
  const joined = await ask<{ ok: boolean; room: { id: string } }>(socket, 'room:join', { handle: secrets.handle })
  const roomId = joined.room.id
  const candidate = await newCandidate({ id: hello.user.id, nickname })
  const welcome = new Promise<string>((r) => socket.once('mls:welcome', (e: { welcome: string }) => r(e.welcome)))
  const commits: { epoch: number; commit: string }[] = []
  socket.on('mls:commit', (e) => commits.push(e))
  const bodies: string[] = []
  socket.on('message', (m) => bodies.push(m.body))
  await ask(socket, 'mls:request', { room: roomId, keyPackage: toBase64(candidate.encoded), proof: prove(secrets.admissionKey, candidate.encoded) })
  const group = await Group.join(candidate, await welcome, secrets.handle, secrets.psk)
  return { socket, group, roomId, id: hello.user.id, commits, bodies }
}

/** What the server has about a room: the in-memory registry of the test server. */
const serverRoom = (roomId: string) => (server.registry as unknown as { rooms: Map<string, { epoch: number; handle: string }> }).rooms.get(roomId)!

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
    const bob = await person('Bob S2b', 'ZZZZZZZZ')
    expect(bob.state.error).toMatch(/No room has this code/)
    expect(bob.state.joined).toEqual({})
  })
})

describe('rooms', () => {
  it('creates a room that you run, with a code, and lets people in with it only', async () => {
    const [ada, bob] = [await person('Ada S3'), await person('Bob S3')]
    const room = await roomWith('Private S3', ada)
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(room.ownerId).toBe(ada.state.me!.id)
    expect(await bob.join('ZZZZZZZZ')).toMatch(/No room/)
    expect(await bob.join('nope')).toMatch(/not a room code/)
    expect(await bob.join(room.code.slice(0, 7))).toMatch(/not a room code/)
    expect(await bob.join(`${room.code.slice(0, 4)}-${room.code.slice(4)}`.toLowerCase())).toBe('')
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
    const mallory = await insider(room.code, 'Mallory') // a member, so these are well encrypted: what is inside is not to be trusted
    const send = async (payload: unknown) => {
      const body = await mallory.group.seal(new TextEncoder().encode(JSON.stringify(payload)))
      return ask(mallory.socket, 'message', { room: mallory.roomId, body })
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
    // and a body that is not encrypted for the group is unreadable too
    await ask(mallory.socket, 'message', { room: mallory.roomId, body: 'plain text, not encrypted' })
    await until(() => messages(bob, room.id).length === bad.length + 1)
    expect(messages(bob, room.id).at(-1)!.unreadable).toBe(true)
  })

  it('does not show what somebody sent who knows the code but was never let into the group', async () => {
    const [ada, bob] = [await person('Ada S8b'), await person('Bob S8b')]
    const room = await roomWith('Outsider S8b', ada, bob)
    const spy = await eavesdropper(room.code, 'Mallory')
    await ask(spy.socket, 'message', { room: spy.roomId, body: 'AAAA' })
    await ask(spy.socket, 'message', { room: spy.roomId, body: 'not a group message at all' })
    await sleep(500)
    expect(messages(bob, room.id).every((m) => m.unreadable)).toBe(true)
    expect(messages(ada, room.id).every((m) => m.unreadable)).toBe(true)
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

  it('changes the code: those inside keep talking and learn it through the group, the old code finds nothing, the new one lets people in', async () => {
    const [ada, bob, cleo, dina] = [await person('Ada S20'), await person('Bob S20'), await person('Cleo S20'), await person('Dina S20')]
    const room = await roomWith('Rotate S20', ada, bob)
    const oldCode = room.code
    expect(await ada.newCode()).toBe('')
    const code = ada.state.joined[room.id].code
    expect(code).not.toBe(oldCode)
    await until(() => bob.state.joined[room.id].code === code)
    await ada.send('after the change')
    await arrived(bob, room.id, 'after the change')
    expect(bob.state.joined[room.id].lines.some((l) => l.kind === 'event' && l.key === 'event.newCode')).toBe(true)
    expect(messages(bob, room.id).some((m) => m.text.includes(code))).toBe(false) // the news of the code is not a message
    expect(await cleo.join(oldCode)).toMatch(/No room has this code/)
    expect(await cleo.join(code)).toBe('') // and Bob, who learnt the code, let her in as well as Ada would
    await bob.send('hello Cleo')
    await arrived(cleo, room.id, 'hello Cleo')
    await ada.leave(room.id)
    await until(() => bob.state.joined[room.id].room.ownerId === bob.state.me!.id)
    expect(await dina.join(code)).toBe('') // Bob has the new code too, and looks after the group now
  })

  it('only takes a new code from the person who runs the room', async () => {
    const [ada, bob] = [await person('Ada S20b'), await person('Bob S20b')]
    const room = await roomWith('Rotate S20b', ada, bob)
    const before = bob.state.joined[room.id].code
    // Ada is the owner: a member who is not cannot make the others change the code, even with a well-formed message
    const mallory = await insider(room.code, 'Mallory S20b')
    await ask(mallory.socket, 'message', { room: mallory.roomId, body: await mallory.group.seal(new TextEncoder().encode(JSON.stringify({ k: 'code', code: 'ZZZZZZZZ' }))) })
    await sleep(500)
    expect(bob.state.joined[room.id].code).toBe(before)
    expect(ada.state.joined[room.id].code).toBe(before)
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
    expect(ada.state.joined[room.id].code).toBe(room.code)
    expect(await ada.send('I am back')).toBe('')
    await arrived(bob, room.id, 'I am back')
  })
})

describe('the group encryption', () => {
  it('never lets the server learn the code: it holds a handle, and the handle is not the code', async () => {
    const [ada, bob] = [await person('Ada G1'), await person('Bob G1')]
    const room = await roomWith('Secret G1', ada, bob)
    await ada.send('hello')
    await arrived(bob, room.id, 'hello')
    const held = serverRoom(room.id)
    const everything = JSON.stringify([...(server.registry as unknown as { rooms: Map<string, unknown> }).rooms.values()], (_, v) => (v instanceof Set ? [...v] : v))
    expect(held.handle).toMatch(/^[0-9a-f]{64}$/)
    expect(held.handle).toBe((await deriveSecrets(room.code, cheap)).handle)
    expect(everything.toUpperCase()).not.toContain(room.code)
  })

  it('moves the group one step for each person who comes in', async () => {
    const [ada, bob, cleo] = [await person('Ada G2'), await person('Bob G2'), await person('Cleo G2')]
    const room = await roomWith('Steps G2', ada)
    expect(serverRoom(room.id).epoch).toBe(0)
    await bob.join(room.code)
    expect(serverRoom(room.id).epoch).toBe(1)
    await cleo.join(room.code)
    expect(serverRoom(room.id).epoch).toBe(2)
    await cleo.send('three of us')
    await arrived(ada, room.id, 'three of us')
    await arrived(bob, room.id, 'three of us')
  })

  it('does not let in somebody who asks with a proof of a code they do not know', async () => {
    const [ada, bob] = [await person('Ada G3'), await person('Bob G3')]
    const room = await roomWith('Proof G3', ada, bob)
    const spy = await eavesdropper(room.code, 'Mallory G3') // in the room on the server (it has the handle), but no proof is good
    const candidate = await newCandidate({ id: spy.socket.id!, nickname: 'Mallory G3' })
    const welcomes: unknown[] = []
    spy.socket.on('mls:welcome', (w) => welcomes.push(w))
    const wrong = await deriveSecrets('ZZZZZZZZ', cheap)
    await ask(spy.socket, 'mls:request', { room: spy.roomId, keyPackage: toBase64(candidate.encoded), proof: prove(wrong.admissionKey, candidate.encoded) })
    await ask(spy.socket, 'mls:request', { room: spy.roomId, keyPackage: toBase64(candidate.encoded), proof: toBase64(new Uint8Array(32)) })
    // and a proof that is good, but for another key package, cannot be moved onto this one
    const other = await newCandidate({ id: spy.socket.id!, nickname: 'Mallory G3' })
    await ask(spy.socket, 'mls:request', { room: spy.roomId, keyPackage: toBase64(candidate.encoded), proof: prove(spy.secrets.admissionKey, other.encoded) })
    await sleep(800)
    expect(welcomes).toHaveLength(0)
    expect(serverRoom(room.id).epoch).toBe(1) // Bob came in: nothing since
    await ada.send('still just us')
    await arrived(bob, room.id, 'still just us')
  })

  it('lets in several people who arrive at the same moment', async () => {
    const people = await Promise.all(['Ada G4', 'Bob G4', 'Cleo G4', 'Dina G4', 'Eli G4'].map((n) => person(n)))
    const [ada, ...others] = people
    const room = await roomWith('Rush G4', ada)
    const results = await Promise.all(others.map((p) => p.join(room.code)))
    expect(results).toEqual(['', '', '', ''])
    expect(serverRoom(room.id).epoch).toBe(4)
    for (const [i, p] of people.entries()) await p.send(`hello from ${i}`)
    for (const p of people) for (let i = 0; i < people.length; i++) await arrived(p, room.id, `hello from ${i}`)
  })

  it('takes the people who left out of the group, and the others carry on', async () => {
    const [ada, bob, cleo] = [await person('Ada G5'), await person('Bob G5'), await person('Cleo G5')]
    const room = await roomWith('Leave G5', ada, bob, cleo)
    expect(serverRoom(room.id).epoch).toBe(2)
    await bob.leave(room.id)
    await until(() => serverRoom(room.id).epoch === 3) // Ada, who looks after the group, took Bob out
    await ada.send('after Bob')
    await arrived(cleo, room.id, 'after Bob')
    await ada.leave(room.id)
    await until(() => serverRoom(room.id).epoch === 4) // and Cleo took Ada out
    expect(await cleo.send('only me')).toBe('')
  })

  it('takes out a person whose connection dropped, not only those who left on purpose, and lets their page back in', async () => {
    const [ada, bob] = [await person('Ada G6'), await person('Bob G6')]
    const room = await roomWith('Drop G6', ada, bob)
    server.io.sockets.sockets.forEach((s) => {
      if (s.id === bob.state.me?.id) s.conn.close()
    })
    await until(() => serverRoom(room.id).epoch >= 3) // Bob went (epoch 2), and his page came back as a new member (3)
    await until(() => bob.state.status === 'online' && !!bob.state.joined[room.id]?.lines.some((l) => l.kind === 'event' && l.key === 'event.back'))
    expect(await bob.send('back again')).toBe('')
    await arrived(ada, room.id, 'back again')
  })

  it('stops a member who was removed from following the group', async () => {
    const [ada, bob] = [await person('Ada G7'), await person('Bob G7')]
    const room = await roomWith('Kick G7', ada, bob)
    const mallory = await insider(room.code, 'Mallory G7')
    const spy = await eavesdropper(room.code, 'Eve G7') // still in the room: sees what the server relays, and hands it to Mallory
    const commits: { epoch: number; commit: string }[] = []
    spy.socket.on('mls:commit', (c) => commits.push(c))
    expect(await ada.kick(mallory.id)).toBe('')
    await until(() => serverRoom(room.id).epoch >= 3 && commits.length > 0) // Ada took them out of the group
    const bodiesBefore = mallory.bodies.length
    expect(await ada.send('after the removal')).toBe('')
    await arrived(bob, room.id, 'after the removal')
    await until(() => spy.seen.length > 0)
    await sleep(300)
    expect(mallory.bodies.length).toBe(bodiesBefore) // the server no longer sends it to them
    // even if they get hold of what was relayed, they cannot read it: it is for an epoch they are not in
    await expect(mallory.group.open(spy.seen.at(-1)!.body)).rejects.toThrow()
    // and the commit that removed them takes them out of their own copy of the group as well
    for (const c of commits) await mallory.group.follow(c.commit).catch(() => {})
    expect(mallory.group.active).toBe(false)
    await expect(mallory.group.open(spy.seen.at(-1)!.body)).rejects.toThrow()
  })

  it('starts the group again for the first person to come back to a room that emptied', async () => {
    const ada = await person('Ada G8')
    const room = await roomWith('Blip G8', ada)
    server.io.sockets.sockets.forEach((s) => {
      if (s.id === ada.state.me?.id) s.conn.close()
    })
    await until(() => ada.state.status === 'offline')
    await until(() => ada.state.status === 'online' && !!ada.state.joined[room.id]?.lines.some((l) => l.kind === 'event' && l.key === 'event.back'))
    expect(await ada.send('alone but back')).toBe('')
    const bob = await person('Bob G8')
    expect(await bob.join(room.code)).toBe('')
    await ada.send('hello Bob')
    await arrived(bob, room.id, 'hello Bob')
  })

  it('tells somebody when nobody lets them in, instead of leaving them waiting, and takes them out of the room again', async () => {
    // a room whose only member never answers: it is a bare connection that does not run the group
    const ghost = connect(url, { transports: ['websocket'], reconnection: false })
    raw.push(ghost)
    await new Promise<void>((r) => ghost.on('connect', () => r()))
    await ask(ghost, 'hello', { nickname: 'Ghost G9' })
    const secrets: Secrets = await deriveSecrets('K7M2QXAB', cheap)
    const made = await ask<{ room: { id: string } }>(ghost, 'room:create', { name: 'Away G9', handle: secrets.handle })
    const bob = createChat(url, connect, null, { cost: cheap, admissionMs: 600, requestEveryMs: 200 })
    chats.push(bob)
    expect(await bob.login('Bob G9')).toBe('')
    expect(await bob.join('K7M2QXAB')).toMatch(/Nobody in the room let you in/)
    expect(bob.state.joined).toEqual({})
    await until(() => (server.registry as unknown as { rooms: Map<string, { members: Set<string> }> }).rooms.get(made.room.id)!.members.size === 1)
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
  const room = { id: 'r1', name: 'Study', members: 2, locked: false, ownerId: 'a', rev: 5 }

  async function inRoom() {
    const socket = new ControlledSocket()
    socket.answers = {
      hello: { ok: true, user: { id: 'me', nickname: 'Me' } },
      'room:join': { ok: true, first: true, room: { ...room }, members: [{ id: 'a', nickname: 'Ada', owner: true }, { id: 'me', nickname: 'Me' }] },
    }
    const chat = createChat('http://nowhere', (() => socket) as never, null, { cost: cheap })
    expect(await chat.login('Me')).toBe('')
    expect(await chat.join('K7M2QXAB')).toBe('')
    return { chat, socket }
  }

  it('does not undo a newer one: the room stays locked', async () => {
    const { chat, socket } = await inRoom()
    socket.arrives('room:updated', { room: { ...room, locked: true, rev: 7 } }) // the owner locked the room
    socket.arrives('room:updated', { room: { ...room, locked: false, rev: 6 } }) // the announcement of somebody joining, a moment older
    expect(chat.state.joined.r1.room).toMatchObject({ locked: true, rev: 7 })
    expect(chat.state.joined.r1.lines.filter((l) => l.kind === 'event' && l.key === 'event.unlocked')).toHaveLength(0)
  })

  it('does not bring back an old owner either', async () => {
    const { chat, socket } = await inRoom()
    socket.arrives('room:updated', { room: { ...room, ownerId: 'me', rev: 8 } })
    socket.arrives('room:updated', { room: { ...room, rev: 6 } })
    expect(chat.state.joined.r1.room.ownerId).toBe('me')
  })

  it('still applies updates that are newer, or the same', async () => {
    const { chat, socket } = await inRoom()
    socket.arrives('room:updated', { room: { ...room, locked: true, rev: 6 } })
    expect(chat.state.joined.r1.room.locked).toBe(true)
    socket.arrives('room:updated', { room: { ...room, locked: true, members: 3, rev: 6 } }) // same revision: the same room, taken in
    expect(chat.state.joined.r1.room.members).toBe(3)
  })
})
