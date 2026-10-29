// The chat store against the real server, with real sockets.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createChatServer } from '../../server/index.js'
import { createChat, type Chat } from './chat'

let server: ReturnType<typeof createChatServer>
let url: string
const chats: Chat[] = []

beforeAll(async () => {
  server = createChatServer({ corsOrigin: '*' })
  url = `http://localhost:${await server.listen(0)}`
})
afterEach(() => {
  while (chats.length) chats.pop()!.logout()
})
afterAll(() => server.close())

const until = async (check: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function person(nickname: string) {
  const chat = createChat(url)
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

describe('the chat store', () => {
  it('logs in and knows who it is, with no room yet', async () => {
    const ada = await person('Ada S1')
    expect(ada.state.me?.nickname).toBe('Ada S1')
    expect(ada.state.status).toBe('online')
    expect(ada.state.joined).toEqual({})
  })

  it('refuses a nickname that is taken', async () => {
    await person('Ada S2')
    const other = createChat(url)
    chats.push(other)
    expect(await other.login('ada s2')).toMatch(/already used/)
    expect(other.state.me).toBeNull()
  })

  it('reports a server that cannot be reached', async () => {
    const lost = createChat('http://localhost:1')
    chats.push(lost)
    expect(await lost.login('Nobody')).toMatch(/Cannot reach/)
  }, 15000)

  it('creates a room, is inside it, and gets its code', async () => {
    const ada = await person('Ada S3')
    expect(await ada.create('Study group S3')).toBe('')
    const joined = ada.state.joined[ada.state.active!]
    expect(joined.room.name).toBe('Study group S3')
    expect(joined.room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(joined.members.map((m) => m.nickname)).toEqual(['Ada S3'])
  })

  it('answers with the server error when the room name is bad', async () => {
    const ada = await person('Ada S4')
    expect(await ada.create('x')).toMatch(/2 to 30/)
  })

  it('lets somebody in with the code, and only with the code', async () => {
    const [ada, bob] = [await person('Ada S5'), await person('Bob S5')]
    await ada.create('Private S5')
    const code = ada.state.joined[ada.state.active!].room.code
    expect(await bob.join('ZZZZZZ')).toMatch(/No room/)
    expect(await bob.join('nope')).toMatch(/not a room code/)
    expect(Object.keys(bob.state.joined)).toHaveLength(0)
    expect(await bob.join(code.toLowerCase())).toBe('')
    expect(bob.state.active).toBe(ada.state.active)
    await until(() => ada.state.joined[ada.state.active!].members.length === 2)
    expect(ada.state.joined[ada.state.active!].lines.some((l) => l.kind === 'event' && l.text === 'Bob S5 joined')).toBe(true)
  })

  it('exchanges messages in a room, and marks your own', async () => {
    const [ada, bob] = [await person('Ada S6'), await person('Bob S6')]
    const room = await roomWith('Chat S6', ada, bob)
    expect(await ada.send('hello Bob')).toBe('')
    await until(() => bob.state.joined[room.id].lines.some((l) => l.kind === 'message' && l.text === 'hello Bob'))
    expect(bob.state.joined[room.id].lines.find((l) => l.kind === 'message')).toMatchObject({ mine: false, from: { nickname: 'Ada S6' } })
    await until(() => ada.state.joined[room.id].lines.some((l) => l.kind === 'message' && l.mine))
  })

  it('has no history: somebody who joins later sees no message', async () => {
    const ada = await person('Ada S7')
    const room = await roomWith('Past S7', ada)
    await ada.send('what a secret')
    const late = await person('Late S7')
    await late.join(room.code)
    expect(late.state.joined[room.id].lines.some((l) => l.kind === 'message')).toBe(false)
  })

  it('forgets a room when you leave it', async () => {
    const ada = await person('Ada S8')
    await ada.create('Temp S8')
    const id = ada.state.active!
    await ada.leave(id)
    expect(ada.state.active).toBeNull()
    expect(ada.state.joined[id]).toBeUndefined()
  })

  it('cannot send without an open room', async () => {
    const ada = await person('Ada S9')
    expect(await ada.send('hi')).toMatch(/Open a room/)
  })

  it('shows who is typing, and forgets when they stop', async () => {
    const [ada, bob] = [await person('Ada S10'), await person('Bob S10')]
    const room = await roomWith('Typing S10', ada, bob)
    ada.typing(true)
    await until(() => bob.state.joined[room.id].typing.includes('Ada S10'))
    ada.typing(false)
    await until(() => bob.state.joined[room.id].typing.length === 0)
  })

  it('says hello again and goes back into its rooms, with the same code, after the connection drops', async () => {
    const ada = await person('Ada S11')
    const room = await roomWith('Blip S11', ada)
    // cut the connection from the server side without telling the client; the client reconnects by itself
    server.io.sockets.sockets.forEach((s) => {
      if (s.id === ada.state.me?.id) s.conn.close()
    })
    await until(() => ada.state.status === 'offline')
    await until(() => ada.state.status === 'online' && ada.state.joined[room.id]?.lines.some((l) => l.kind === 'event' && l.text.startsWith('You are back')))
    expect(ada.state.me?.nickname).toBe('Ada S11')
    expect(ada.state.joined[room.id].room.code).toBe(room.code)
    expect(server.registry.isIn(ada.state.me!.id, room.id)).toBe(true)
  })
})
