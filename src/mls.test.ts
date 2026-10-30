import { describe, expect, it } from 'vitest'
import { fromBase64, prove, toBase64, verifyProof } from './crypto'
import { createCommit, createGroup, decodeMlsMessage, defaultCapabilities, defaultLifetime, emptyPskIndex, encodeMlsMessage, generateKeyPackage, getCiphersuiteFromName, getCiphersuiteImpl, joinGroup, makePskIndex, processPrivateMessage, bytesToBase64, type Proposal } from 'ts-mls'
import { AheadError, Group, RefusedError, newCandidate, policy, supported, type Change, type Who } from './mls'

const ada: Who = { id: 'a', nickname: 'Ada' }
const bob: Who = { id: 'b', nickname: 'Bob' }
const cleo: Who = { id: 'c', nickname: 'Cleo' }
const psk = new Uint8Array(32).fill(1)
const handle = 'a'.repeat(64)
const text = (s: string) => new TextEncoder().encode(s)
const read = (b: Uint8Array) => new TextDecoder().decode(b)

/** A server that keeps the first change made on an epoch, as the real one does. */
class Relay {
  epoch = 0
  changes: Change[] = []
  keep = async (change: Change): Promise<boolean> => {
    if (change.base !== this.epoch) return false
    this.epoch++
    this.changes.push(change)
    return true
  }
}

/** `keeper` lets `who` in; every member in `following` follows the commit; and the newcomer joins with the welcome. */
async function letIn(keeper: Group, who: Who, relay: Relay, following: Group[], code = { handle, psk }): Promise<Group> {
  const candidate = await newCandidate(who)
  let welcome = ''
  const kept = await keeper.change({ add: { candidate: candidate.encoded, who, handle: code.handle } }, async (change) => {
    const ok = await relay.keep(change)
    welcome = change.welcome ?? ''
    return ok
  })
  expect(kept).toBe(true)
  const commit = relay.changes.at(-1)!.commit
  for (const member of following) await member.follow(commit)
  return Group.join(candidate, welcome, code.handle, code.psk)
}

describe('a group', () => {
  it('starts with only its creator', async () => {
    const group = await Group.start(ada, handle, psk)
    expect(group.roster()).toEqual([{ ...ada, leaf: 0 }])
    expect(group.epoch).toBe(0)
    expect(group.active).toBe(true)
  })

  it('lets somebody in who knows the code, and both read each other', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    expect(b.roster().map((m) => m.nickname)).toEqual(['Ada', 'Bob']);
    expect(a.epoch).toBe(1)
    expect(b.epoch).toBe(1)
    expect(read(await b.open(await a.seal(text('hello Bob'))))).toBe('hello Bob')
    expect(read(await a.open(await b.seal(text('hello Ada'))))).toBe('hello Ada')
  })

  it('cannot be joined with another code: the welcome is of no use without the PSK', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const candidate = await newCandidate(bob)
    let welcome = ''
    await a.change({ add: { candidate: candidate.encoded, who: bob, handle } }, async (change) => {
      welcome = change.welcome!
      return relay.keep(change)
    })
    await expect(Group.join(candidate, welcome, handle, new Uint8Array(32).fill(2))).rejects.toThrow()
    await expect(Group.join(candidate, welcome, 'b'.repeat(64), psk)).rejects.toThrow() // nor under another handle
    expect(await Group.join(candidate, welcome, handle, psk)).toBeTruthy()
  })

  it('does not let in a key package that is not from the person who asked', async () => {
    const a = await Group.start(ada, handle, psk)
    const eve = await newCandidate({ id: 'e', nickname: 'Eve' })
    await expect(a.change({ add: { candidate: eve.encoded, who: bob, handle } }, async () => true)).rejects.toThrow('not from the person')
    await expect(a.change({ add: { candidate: new Uint8Array([1, 2, 3]), who: bob, handle } }, async () => true)).rejects.toThrow()
    expect(a.epoch).toBe(0)
  })

  it('keeps several members in step through the changes', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    const c = await letIn(a, cleo, relay, [b])
    expect([a.epoch, b.epoch, c.epoch]).toEqual([2, 2, 2])
    for (const [from, others] of [[a, [b, c]], [b, [a, c]], [c, [a, b]]] as const) {
      const sealed = await from.seal(text(`from ${from.self.nickname}`))
      for (const other of others) expect(read(await other.open(sealed))).toBe(`from ${from.self.nickname}`)
    }
  })

  it('reads a message of the epoch before, after a change', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    const late = await b.seal(text('sent before the change'))
    await letIn(a, cleo, relay, [b])
    expect(read(await a.open(late))).toBe('sent before the change')
  })

  it('does not let a newcomer read what was said before they came in', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    const before = await a.seal(text('said before Cleo came'))
    expect(read(await b.open(before))).toBe('said before Cleo came')
    const c = await letIn(a, cleo, relay, [b])
    await expect(c.open(before)).rejects.toThrow() // their group starts at the epoch that let them in
    expect(read(await c.open(await a.seal(text('and after'))))).toBe('and after')
  })

  it('says a message is ahead when its commit has not arrived, and reads it after', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    const c = await letIn(a, cleo, relay, [])
    const early = await c.seal(text('from the next epoch'))
    await expect(b.open(early)).rejects.toBeInstanceOf(AheadError)
    await b.follow(relay.changes.at(-1)!.commit)
    expect(read(await b.open(early))).toBe('from the next epoch')
  })

  it('takes somebody out, who can no longer follow the group', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    const c = await letIn(a, cleo, relay, [b])
    const leaf = a.roster().find((m) => m.id === 'b')!.leaf
    expect(await a.change({ remove: [leaf] }, relay.keep)).toBe(true)
    await c.follow(relay.changes.at(-1)!.commit)
    await b.follow(relay.changes.at(-1)!.commit)
    expect(b.active).toBe(false)
    expect(a.roster().map((m) => m.nickname)).toEqual(['Ada', 'Cleo'])
    const sealed = await a.seal(text('after Bob left'))
    expect(read(await c.open(sealed))).toBe('after Bob left')
    await expect(b.open(sealed)).rejects.toThrow()
  })

  it('does not move on when the server turned the change down, and the other change wins', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    relay.epoch = 5 // somebody else got there first
    const candidate = await newCandidate(cleo)
    expect(await a.change({ add: { candidate: candidate.encoded, who: cleo, handle } }, relay.keep)).toBe(false)
    expect(a.epoch).toBe(1)
    expect(a.roster()).toHaveLength(2)
    expect(read(await b.open(await a.seal(text('still in step'))))).toBe('still in step')
  })

  it('makes nothing of a change that changes nothing', async () => {
    const a = await Group.start(ada, handle, psk)
    expect(await a.change({}, async () => true)).toBe(false)
    expect(await a.change({ remove: [] }, async () => true)).toBe(false)
  })

  it('works out the same keeper everywhere: the oldest member who is still there', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    const c = await letIn(a, cleo, relay, [b])
    expect([a, b, c].map((g) => g.keeper(new Set(['a', 'b', 'c'])))).toEqual(['a', 'a', 'a'])
    expect([a, b, c].map((g) => g.keeper(new Set(['b', 'c'])))).toEqual(['b', 'b', 'b'])
    expect(a.keeper(new Set(['z']))).toBeNull()
  })

  it('refuses a message that is not a commit, and garbage', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    await expect(b.follow(toBase64(new Uint8Array([1, 2, 3])))).rejects.toThrow()
    await expect(b.follow(await a.seal(text('a message, not a commit')))).rejects.toBeInstanceOf(RefusedError)
  })

  it('gives two members a whisper key that the others do not use, and that changes with the epoch', async () => {
    const relay = new Relay()
    const a = await Group.start(ada, handle, psk)
    const b = await letIn(a, bob, relay, [])
    const c = await letIn(a, cleo, relay, [b])
    const [ab, ba, ac] = await Promise.all([a.whisperKey('a', 'b'), b.whisperKey('b', 'a'), a.whisperKey('a', 'c')])
    const probe = new Uint8Array(12)
    const seal = async (k: CryptoKey) => toBase64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: probe }, k, text('x'))))
    expect(await seal(ab.key)).toBe(await seal(ba.key)) // the same key from either end
    expect(await seal(ab.key)).not.toBe(await seal(ac.key)) // another pair, another key
    expect(ab.epoch).toBe(2)
    await letIn(a, { id: 'd', nickname: 'Dina' }, relay, [b, c])
    expect(await seal((await a.whisperKey('a', 'b')).key)).not.toBe(await seal(ab.key))
  })
})

describe('the browser', () => {
  it('is checked for what the encryption needs (Web Crypto with Ed25519)', async () => {
    expect(await supported()).toBe(true)
    const subtle = globalThis.crypto.subtle
    const original = subtle.generateKey.bind(subtle)
    subtle.generateKey = (() => Promise.reject(new Error('NotSupportedError'))) as never
    try {
      expect(await supported()).toBe(false)
    } finally {
      subtle.generateKey = original as never
    }
  })
})

describe('the request to come in', () => {
  it('carries a proof of the code that covers the key package', async () => {
    const key = new Uint8Array(32).fill(3)
    const candidate = await newCandidate(bob)
    const proof = prove(key, candidate.encoded)
    expect(verifyProof(key, candidate.encoded, proof)).toBe(true)
    const other = await newCandidate(bob)
    expect(verifyProof(key, other.encoded, proof)).toBe(false) // a proof cannot be moved onto another key package
    expect(fromBase64(toBase64(candidate.encoded))).toEqual(candidate.encoded)
  })
})

describe('what a commit may contain', () => {
  const incoming = (...kinds: string[]) => ({
    kind: 'commit' as const,
    senderLeafIndex: 0 as never,
    proposals: kinds.map((proposalType) => ({ proposal: { proposalType } as unknown as Proposal, senderLeafIndex: 0 as never })),
  })

  it('lets people in with the code and takes people out', () => {
    expect(policy(incoming('add', 'psk'))).toBe('accept')
    expect(policy(incoming('remove'))).toBe('accept')
    expect(policy(incoming('remove', 'add', 'psk'))).toBe('accept')
  })

  it('turns down somebody added without the code, and anything else', () => {
    expect(policy(incoming('add'))).toBe('reject')
    expect(policy(incoming('add', 'remove'))).toBe('reject')
    for (const other of ['update', 'reinit', 'external_init', 'group_context_extensions']) expect(policy(incoming(other))).toBe('reject')
    expect(policy({ kind: 'proposal', proposal: { proposal: { proposalType: 'add' } as unknown as Proposal, senderLeafIndex: 0 as never } })).toBe('reject')
  })

  it('is applied by the library: a commit that adds somebody with no PSK does not change the group of those who receive it', async () => {
    // two members made by hand, the first of whom then adds a third WITHOUT the PSK
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'))
    const key = (name: string) => generateKeyPackage({ credentialType: 'basic', identity: text(JSON.stringify({ id: name, nickname: name })) }, defaultCapabilities(), defaultLifetime, [], impl)
    const [x, y, z] = [await key('x'), await key('y'), await key('z')]
    const index = (state: Parameters<typeof makePskIndex>[0]) => makePskIndex(state, { [bytesToBase64(text(handle))]: psk })
    let first = await createGroup(text('g'), x.publicPackage, x.privatePackage, [], impl)
    const added = await createCommit({ state: first, cipherSuite: impl, pskIndex: index(first) }, {
      ratchetTreeExtension: true,
      extraProposals: [
        { proposalType: 'add', add: { keyPackage: y.publicPackage } },
        { proposalType: 'psk', psk: { preSharedKeyId: { psktype: 'external', pskId: text(handle), pskNonce: new Uint8Array(32) } } },
      ],
    })
    first = added.newState
    const welcome = decodeMlsMessage(encodeMlsMessage({ welcome: added.welcome!, wireformat: 'mls_welcome', version: 'mls10' }), 0)![0]
    if (welcome.wireformat !== 'mls_welcome') throw new Error('welcome')
    let second = await joinGroup(welcome.welcome, y.publicPackage, y.privatePackage, index(undefined), impl)
    const sneaky = await createCommit({ state: first, cipherSuite: impl, pskIndex: emptyPskIndex }, { extraProposals: [{ proposalType: 'add', add: { keyPackage: z.publicPackage } }] })
    const message = decodeMlsMessage(encodeMlsMessage(sneaky.commit), 0)![0]
    if (message.wireformat !== 'mls_private_message') throw new Error('commit')
    const epochBefore = second.groupContext.epoch
    const outcome = await processPrivateMessage(second, message.privateMessage, index(second), impl, policy).catch(() => null)
    if (outcome?.kind === 'newState') second = outcome.newState
    expect(outcome).toMatchObject({ kind: 'newState', actionTaken: 'reject' })
    expect(second.groupContext.epoch).toBe(epochBefore)
  })
})
