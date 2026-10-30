// Real chat clients on different servers of a cluster (two servers, one Redis): the group encryption must hold when a commit and a
// message travel through the Redis adapter and can arrive in either order. Needs a Redis: REDIS_URL=redis://localhost:6379 npm test
import crypto from 'node:crypto'
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createChatServer } from '../../server/index.js'
import { createProofs } from '../../server/proof.js'
import { createRedisBackend } from '../../server/redis.js'
import type { Msg } from '../types'
import { createChat, type Chat } from './chat'

const redisUrl = process.env.REDIS_URL
const prefix = `chatcluster:${crypto.randomUUID().slice(0, 8)}:`
const cheap = { t: 1, m: 8 }
/** What the test uses of the Redis backend and of a server (they are plain JavaScript). */
interface Backend {
  registry: { flush(): Promise<void> }
  wrongCodes: unknown
  attach: unknown
  sharedSecret(): Promise<string>
  start(onReaped: (reaped: unknown) => void): void
  close(): Promise<void>
}
interface Server {
  listen(port: number): Promise<number>
  close(): Promise<void>
  announceReaped(reaped: unknown): Promise<void>
}
const makeBackend = createRedisBackend as unknown as (options: Record<string, unknown>) => Backend
const makeServer = createChatServer as unknown as (options: Record<string, unknown>) => Server
const nodes: { chat: Server; backend: Backend; url: string }[] = []
const chats: Chat[] = []

async function startNode(id: string) {
  const backend = makeBackend({ url: redisUrl!, instanceId: id, prefix, heartbeatMs: 250, ttlSeconds: 1 })
  const chat = makeServer({
    corsOrigin: '*',
    instanceId: id,
    registry: backend.registry,
    wrongCodes: backend.wrongCodes,
    attach: backend.attach,
    proofs: createProofs(await backend.sharedSecret()),
  })
  const port = await chat.listen(0)
  backend.start((reaped) => chat.announceReaped(reaped))
  nodes.push({ chat, backend, url: `http://localhost:${port}` })
}

beforeAll(async () => {
  if (!redisUrl) return
  await startNode('one')
  await startNode('two')
})
afterEach(() => {
  while (chats.length) chats.pop()!.logout()
})
afterAll(async () => {
  for (const node of nodes) {
    await node.chat.close().catch(() => {})
    await node.backend.registry.flush().catch(() => {})
    await node.backend.close().catch(() => {})
  }
})

const until = async (check: () => boolean, ms = 8000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}
async function person(nickname: string, server: 0 | 1) {
  const chat = createChat(nodes[server].url, connect, null, { cost: cheap })
  chats.push(chat)
  expect(await chat.login(nickname)).toBe('')
  return chat
}
const texts = (chat: Chat, roomId: string): string[] =>
  chat.state.joined[roomId].lines.flatMap((l) => (l.kind === 'message' ? [l.msg as Msg] : [])).map((m) => (m.unreadable ? '(unreadable)' : m.text))

describe.skipIf(!redisUrl)('people on two servers, in one encrypted group', () => {
  it('join with the code, talk both ways, and keep talking while the group changes', async () => {
    const [ada, bob, cleo, dina] = [await person('Ada K1', 0), await person('Bob K1', 1), await person('Cleo K1', 0), await person('Dina K1', 1)]
    expect(await ada.create('Cluster talk')).toBe('')
    const id = ada.state.active!
    const code = ada.state.joined[id].code
    // two people on each server come in together: the commits of the keeper travel from one server to the other
    expect(await Promise.all([bob.join(code), cleo.join(code), dina.join(code)])).toEqual(['', '', ''])
    const everyone = [ada, bob, cleo, dina]
    await Promise.all(everyone.map((p, i) => p.send(`hello from ${i}`)))
    for (const p of everyone) await until(() => [0, 1, 2, 3].every((i) => texts(p, id).includes(`hello from ${i}`)))
    expect(everyone.every((p) => texts(p, id).every((t) => t !== '(unreadable)'))).toBe(true)

    // somebody leaves while others are writing: the messages made before and after the change are all readable
    const writing = Promise.all([ada.send('one'), ada.send('two'), bob.send('three'), dina.send('four')])
    await cleo.leave(id)
    await writing
    await Promise.all([bob.send('after Cleo'), dina.send('after Cleo too')])
    for (const p of [ada, bob, dina]) await until(() => ['one', 'two', 'three', 'four', 'after Cleo', 'after Cleo too'].every((t) => texts(p, id).includes(t)))
    expect([ada, bob, dina].every((p) => texts(p, id).every((t) => t !== '(unreadable)'))).toBe(true)
  })

  it('lets the next person look after the group when the oldest member leaves, across servers', async () => {
    const [ada, bob, cleo] = [await person('Ada K2', 0), await person('Bob K2', 1), await person('Cleo K2', 0)]
    await ada.create('Cluster handover')
    const id = ada.state.active!
    const code = ada.state.joined[id].code
    expect(await bob.join(code)).toBe('')
    await ada.leave(id)
    await until(() => bob.state.joined[id].members.length === 1)
    expect(await cleo.join(code)).toBe('') // Bob, on the other server, lets her in
    await cleo.send('hello Bob')
    await until(() => texts(bob, id).includes('hello Bob'))
  })
})
