// The group encryption of a room: MLS (RFC 9420), through the ts-mls library.
//
// Every member of a room is a member of one MLS group. The members agree on the keys among themselves; the server only relays
// what they send each other (key packages, commits, welcomes) and puts the changes in order. Messages are encrypted for the
// group, with keys that change at every change of the group (forward secrecy) and that a member who is removed can no longer follow.
//
// Who is let in: the room code goes into the group as a pre-shared key (PSK, see crypto.ts). A member lets somebody in with a
// commit that adds them and mixes the PSK into the keys of the new epoch. Somebody who does not know the code cannot read the
// welcome, and the server, which never sees the code, cannot be let in either.
//
// What this does not do: members are not authenticated beyond that. The credential of a member is the nickname and connection id
// the server told us, so the code is the only thing that vouches for anybody; a member who knows the code can say they are
// anybody else, and ts-mls does not tell us who sent an application message. And it has not been audited (its README says so).
import {
  bytesToBase64,
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  makePskIndex,
  mlsExporter,
  processPrivateMessage,
  zeroOutUint8Array,
  type CiphersuiteImpl,
  type ClientState,
  type IncomingMessageCallback,
  type KeyPackage,
  type PrivateKeyPackage,
  type Proposal,
} from 'ts-mls'
import { aesKey, fromBase64, toBase64 } from './crypto'

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
let suiteImpl: Promise<CiphersuiteImpl> | null = null
const suite = () => (suiteImpl ??= getCiphersuiteImpl(getCiphersuiteFromName(SUITE)))

const utf8 = (text: string) => new TextEncoder().encode(text)

/**
 * Whether this browser can do what the group encryption needs: a secure page (https or localhost, or Web Crypto does not exist) and
 * Ed25519 in it (Chrome 137, Firefox 129, Safari 17 and later). ts-mls signs with the browser's own Ed25519, and does not fall back when it is missing.
 */
export async function supported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    return true
  } catch {
    return false
  }
}

/** Somebody in a room, as the server knows them. */
export interface Who {
  id: string
  nickname: string
}

const encodeIdentity = (who: Who) => utf8(JSON.stringify({ id: who.id, nickname: who.nickname }))

function readIdentity(bytes: Uint8Array): Who | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Who>
    return typeof value.id === 'string' && typeof value.nickname === 'string' ? { id: value.id, nickname: value.nickname } : null
  } catch {
    return null
  }
}

/** Somebody who wants to be let in has made a key package (the public half goes to the members, the private half stays here). */
export interface Candidate {
  who: Who
  publicPackage: KeyPackage
  privatePackage: PrivateKeyPackage
  /** the public half, ready to send */
  encoded: Uint8Array
}

export async function newCandidate(who: Who): Promise<Candidate> {
  const impl = await suite()
  const made = await generateKeyPackage({ credentialType: 'basic', identity: encodeIdentity(who) }, defaultCapabilities(), defaultLifetime, [], impl)
  const encoded = encodeMlsMessage({ keyPackage: made.publicPackage, wireformat: 'mls_key_package', version: 'mls10' })
  return { who, publicPackage: made.publicPackage, privatePackage: made.privatePackage, encoded }
}

/** A message came from the future: the commit that makes it readable has not arrived yet. Keep it and try again after the next commit. */
export class AheadError extends Error {
  constructor() {
    super('the message is for an epoch we have not reached')
  }
}

/** A commit that this page will not apply (it adds somebody without the code, or does something a room never does). */
export class RefusedError extends Error {}

/** What a commit may contain: people coming in (always with the code's PSK), people going out. Nothing else is ever needed in a room. */
export const policy: IncomingMessageCallback = (incoming) => {
  if (incoming.kind !== 'commit') return 'reject'
  const kinds = incoming.proposals.map((p) => p.proposal.proposalType)
  if (!kinds.every((k) => k === 'add' || k === 'remove' || k === 'psk')) return 'reject'
  if (kinds.includes('add') && !kinds.includes('psk')) return 'reject'
  return 'accept'
}

/** What a commit needs to be sent: the epoch it was made on, the commit, and a welcome for the person it lets in. */
export interface Change {
  base: number
  commit: string
  welcome?: string
}

export class Group {
  #state: ClientState
  #impl: CiphersuiteImpl
  #psks = new Map<string, Uint8Array>() // the id of a PSK (the handle of a code) -> the PSK
  #chain: Promise<unknown> = Promise.resolve()
  readonly self: Who

  private constructor(state: ClientState, impl: CiphersuiteImpl, self: Who) {
    this.#state = state
    this.#impl = impl
    this.self = self
  }

  /** A new group with only us in it (we made the room, or came back to an empty one). */
  static async start(self: Who, handle: string, psk: Uint8Array): Promise<Group> {
    const impl = await suite()
    const candidate = await newCandidate(self)
    const state = await createGroup(crypto.getRandomValues(new Uint8Array(16)), candidate.publicPackage, candidate.privatePackage, [], impl)
    const group = new Group(state, impl, self)
    group.addPsk(handle, psk)
    return group
  }

  /** The group we were let into: the welcome that came back for our key package. Throws when it was made without the code we know. */
  static async join(candidate: Candidate, welcome: string, handle: string, psk: Uint8Array): Promise<Group> {
    const impl = await suite()
    const message = decodeMlsMessage(fromBase64(welcome), 0)?.[0]
    if (message?.wireformat !== 'mls_welcome') throw new Error('that is not a welcome')
    const index = makePskIndex(undefined, { [bytesToBase64(utf8(handle))]: psk })
    const state = await joinGroup(message.welcome, candidate.publicPackage, candidate.privatePackage, index, impl)
    const group = new Group(state, impl, candidate.who)
    group.addPsk(handle, psk)
    return group
  }

  /** One thing at a time: the keys move forward with every message and every commit, so none of them may overlap. */
  #run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(work, work)
    this.#chain = result.catch(() => {})
    return result
  }

  /** Remembers the PSK of a code: members need it to follow the commits that let somebody in with that code. */
  addPsk(handle: string, psk: Uint8Array) {
    this.#psks.set(bytesToBase64(utf8(handle)), psk)
  }

  #pskIndex() {
    return makePskIndex(this.#state, Object.fromEntries(this.#psks))
  }

  get epoch(): number {
    return Number(this.#state.groupContext.epoch)
  }

  /** False once we were taken out of the group. */
  get active(): boolean {
    return this.#state.groupActiveState.kind === 'active'
  }

  /** Everybody in the group, in the order of their places (the first place is the oldest). */
  roster(): Array<Who & { leaf: number }> {
    const members: Array<Who & { leaf: number }> = []
    this.#state.ratchetTree.forEach((node, index) => {
      if (index % 2 !== 0 || !node || node.nodeType !== 'leaf' || node.leaf.credential.credentialType !== 'basic') return
      const who = readIdentity(node.leaf.credential.identity)
      if (who) members.push({ ...who, leaf: index / 2 })
    })
    return members
  }

  hasMember(id: string): boolean {
    return this.roster().some((m) => m.id === id)
  }

  /** Who looks after the group among the people who are there: the oldest member that is still present. Everybody works it out the same way. */
  keeper(present: ReadonlySet<string>): string | null {
    return this.roster().find((m) => present.has(m.id))?.id ?? null
  }

  // ---- messages
  /** Encrypts for the group. */
  seal(plain: Uint8Array): Promise<string> {
    return this.#run(async () => {
      const sealed = await createApplicationMessage(this.#state, plain, this.#impl)
      this.#state = sealed.newState
      sealed.consumed.forEach(zeroOutUint8Array)
      return toBase64(encodeMlsMessage({ privateMessage: sealed.privateMessage, wireformat: 'mls_private_message', version: 'mls10' }))
    })
  }

  /** Decrypts what somebody else sealed. Throws AheadError when it is from an epoch we have not reached, and another error when it is not for us at all. */
  open(body: string): Promise<Uint8Array> {
    return this.#run(async () => {
      const message = decodeMlsMessage(fromBase64(body), 0)?.[0]
      if (message?.wireformat !== 'mls_private_message') throw new Error('that is not a private message')
      if (message.privateMessage.epoch > this.#state.groupContext.epoch) throw new AheadError()
      const opened = await processPrivateMessage(this.#state, message.privateMessage, this.#pskIndex(), this.#impl)
      if (opened.kind !== 'applicationMessage') throw new Error('that is not a message')
      this.#state = opened.newState
      opened.consumed.forEach(zeroOutUint8Array)
      return opened.message
    })
  }

  /** A key that exactly two members of this epoch can name (and so can every other member: it only keeps the server out). */
  async whisperKey(a: string, b: string): Promise<{ epoch: number; key: CryptoKey }> {
    const [first, second] = [a, b].sort()
    const state = this.#state
    const raw = await mlsExporter(state.keySchedule.exporterSecret, 'whisper', utf8(`${first}\n${second}`), 32, this.#impl)
    return { epoch: Number(state.groupContext.epoch), key: await aesKey(new Uint8Array(raw)) }
  }

  // ---- changing the group
  /**
   * Lets somebody in and/or takes people out, in one commit. `send` hands the change to the server and answers whether it was kept
   * (the first change made on an epoch wins); our own copy of the group only moves on when it was.
   */
  change(
    changes: { remove?: number[]; add?: { candidate: Uint8Array; who: Who; handle: string } },
    send: (change: Change) => Promise<boolean>,
  ): Promise<boolean> {
    return this.#run(async () => {
      const proposals: Proposal[] = (changes.remove ?? []).map((leaf) => ({ proposalType: 'remove', remove: { removed: leaf } }))
      if (changes.add) {
        const message = decodeMlsMessage(changes.add.candidate, 0)?.[0]
        if (message?.wireformat !== 'mls_key_package') throw new Error('that is not a key package')
        const named = message.keyPackage.leafNode.credential
        const who = named.credentialType === 'basic' ? readIdentity(named.identity) : null
        if (!who || who.id !== changes.add.who.id || who.nickname !== changes.add.who.nickname) throw new Error('the key package is not from the person who asked')
        proposals.push({ proposalType: 'add', add: { keyPackage: message.keyPackage } })
        proposals.push({
          proposalType: 'psk',
          psk: { preSharedKeyId: { psktype: 'external', pskId: utf8(changes.add.handle), pskNonce: crypto.getRandomValues(new Uint8Array(32)) } },
        })
      }
      if (proposals.length === 0) return false
      const base = Number(this.#state.groupContext.epoch)
      const made = await createCommit({ state: this.#state, cipherSuite: this.#impl, pskIndex: this.#pskIndex() }, { extraProposals: proposals, ratchetTreeExtension: true })
      const welcome = made.welcome && toBase64(encodeMlsMessage({ welcome: made.welcome, wireformat: 'mls_welcome', version: 'mls10' }))
      const kept = await send({ base, commit: toBase64(encodeMlsMessage(made.commit)), ...(welcome ? { welcome } : {}) })
      if (kept) {
        this.#state = made.newState
        made.consumed.forEach(zeroOutUint8Array)
      }
      return kept
    })
  }

  /** Follows a change somebody else made. */
  follow(commit: string): Promise<void> {
    return this.#run(async () => {
      const message = decodeMlsMessage(fromBase64(commit), 0)?.[0]
      if (message?.wireformat !== 'mls_private_message') throw new RefusedError('that is not a commit')
      const followed = await processPrivateMessage(this.#state, message.privateMessage, this.#pskIndex(), this.#impl, policy)
      if (followed.kind !== 'newState') throw new RefusedError('that is not a commit')
      if (followed.actionTaken === 'reject') throw new RefusedError('a commit this page does not accept')
      this.#state = followed.newState
      followed.consumed.forEach(zeroOutUint8Array)
    })
  }
}
