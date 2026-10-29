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

describe('the chat store', () => {
  it('logs in, knows who it is and lists the rooms', async () => {
    const ada = await person('Ada S1')
    expect(ada.state.me?.nickname).toBe('Ada S1')
    expect(ada.state.status).toBe('online')
    expect(ada.state.rooms.map((r) => r.id)).toContain('general')
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

  it('exchanges messages in a room, and marks your own', async () => {
    const [ada, bob] = [await person('Ada S3'), await person('Bob S3')]
    await ada.open('general')
    await bob.open('general')
    expect(await ada.send('hello Bob')).toBe('')
    await until(() => bob.state.joined.general.lines.some((l) => l.kind === 'message' && l.text === 'hello Bob'))
    const received = bob.state.joined.general.lines.find((l) => l.kind === 'message')!
    expect(received).toMatchObject({ mine: false, from: { nickname: 'Ada S3' } })
    await until(() => ada.state.joined.general.lines.some((l) => l.kind === 'message' && l.mine))
  })

  it('shows who joined, and who is in the room', async () => {
    const ada = await person('Ada S4')
    await ada.open('tech')
    const bob = await person('Bob S4')
    await bob.open('tech')
    await until(() => ada.state.joined.tech.members.length === 2)
    expect(ada.state.joined.tech.lines.some((l) => l.kind === 'event' && l.text === 'Bob S4 joined')).toBe(true)
  })

  it('has no history: somebody who joins later sees no message', async () => {
    const ada = await person('Ada S5')
    await ada.open('random')
    await ada.send('what a secret')
    const late = await person('Late S5')
    await late.open('random')
    expect(late.state.joined.random.lines.some((l) => l.kind === 'message')).toBe(false)
  })

  it('creates a room and goes into it; leaving forgets it', async () => {
    const ada = await person('Ada S6')
    expect(await ada.create('Board games S6')).toBe('')
    expect(ada.state.active).toBe('board-games-s6')
    expect(ada.state.joined['board-games-s6']).toBeTruthy()
    await ada.leave('board-games-s6')
    expect(ada.state.active).toBeNull()
    expect(ada.state.joined['board-games-s6']).toBeUndefined()
  })

  it('answers with the server error when the room name is bad or taken', async () => {
    const ada = await person('Ada S7')
    expect(await ada.create('x')).toMatch(/2 to 30/)
    expect(await ada.create('General')).toMatch(/already exists/)
  })

  it('cannot send without an open room', async () => {
    const ada = await person('Ada S8')
    expect(await ada.send('hi')).toMatch(/Open a room/)
  })

  it('shows who is typing, and forgets when they stop', async () => {
    const [ada, bob] = [await person('Ada S9'), await person('Bob S9')]
    await ada.open('general')
    await bob.open('general')
    ada.typing(true)
    await until(() => bob.state.joined.general.typing.includes('Ada S9'))
    ada.typing(false)
    await until(() => bob.state.joined.general.typing.length === 0)
  })

  it('says hello again and goes back into its rooms after the connection drops', async () => {
    const ada = await person('Ada S10')
    await ada.open('tech')
    // cut the connection from the server side without telling the client; the client reconnects by itself
    server.io.sockets.sockets.forEach((s) => {
      if (s.id === ada.state.me?.id) s.conn.close()
    })
    await until(() => ada.state.status === 'offline')
    await until(() => ada.state.status === 'online' && ada.state.joined.tech.lines.some((l) => l.kind === 'event' && l.text.startsWith('You are back')))
    expect(ada.state.me?.nickname).toBe('Ada S10')
    expect(server.registry.isIn(ada.state.me!.id, 'tech')).toBe(true)
  })
})
