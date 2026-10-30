import { io, type Socket } from 'socket.io-client'
import { reactive } from 'vue'
import { COST, canonicalCode, decrypt, deriveSecrets, encrypt, fromBase64, generateCode, isCode, prove, toBase64, verifyProof, type Cost, type Secrets } from '../crypto'
import { errorText, t, type Key } from '../i18n'
import { AUDIO_URL, MAX_VOICE_MS, PHOTO_URL, type Photo, type Voice } from '../media'
import { AheadError, Group, newCandidate, supported, type Change, type Candidate } from '../mls'
import type { JoinedRoom, Line, Member, Msg, Room, Status } from '../types'
import { mentions, mentionsEveryone, parseWhisper } from '../utils'

const MAX_LINES = 500 // per room: the oldest lines scroll away
const TYPING_MS = 4000
const MAX_TEXT = 500
const ADMISSION_MS = 20_000 // how long somebody who came in waits for the members to let them into the group
const REQUEST_EVERY_MS = 4000 // and how often they ask again, in case the member who looks after the group changed meanwhile
const REMEMBERED = 200 // bodies we sent and are waiting to see come back (we cannot decrypt our own messages)

interface Ack {
  ok?: boolean
  error?: string
  code?: string
  params?: Record<string, string | number>
  [key: string]: unknown
}

/** What goes inside an encrypted body. 'code' is not a message: the owner tells the members the new code of the room. */
type Payload =
  | { k: 'text'; text: string }
  | { k: 'image'; src: string; w: number; h: number; text?: string }
  | { k: 'audio'; src: string; ms: number; wave: number[] }
  | { k: 'code'; code: string }

interface Incoming {
  id: string
  room: string
  from: Member
  body: string
  replyTo?: string | null
  at: string
  to?: Member
}

/** Somebody's request to be let into the group, as the server passed it on. */
interface Request {
  from: Member
  keyPackage: string
  proof: string
}

/** An exchange of the group encryption that arrived before we were let in: kept to be applied once we are. */
interface Buffered {
  commits: { epoch: number; commit: string }[]
  messages: Incoming[]
}

/** What the page keeps of a room beyond what it shows: the group encryption and the secrets of the code. Never in the reactive state. */
interface Live {
  group: Group
  secrets: Secrets
  requests: Map<string, Request>
  keeping: boolean
  again: boolean
  waiting: Incoming[] // messages from an epoch we have not reached yet
  ahead: Map<number, string> // commits that came before the one we are waiting for
}

const LATER = Symbol('later')

/**
 * The chat on the client side. Everything is kept in memory: nothing is written to the disk or the browser's
 * storage, because the chat is live only. What people write is encrypted here, for the members of the room, with MLS (see mls.ts);
 * the server never sees the room code, only a hash of it. When the connection drops the server forgets us, so a reconnection says hello
 * again and re-joins the rooms and the groups (what was said in between is lost, as it should be).
 */
export interface ChatOptions {
  /** the cost of turning a code into its secrets: only tests lower it */
  cost?: Cost
  admissionMs?: number
  requestEveryMs?: number
}

export function createChat(url?: string, connect: typeof io = io, invite: string | null = null, options: ChatOptions = {}) {
  const cost = options.cost ?? COST
  const admissionMs = options.admissionMs ?? ADMISSION_MS
  const requestEveryMs = options.requestEveryMs ?? REQUEST_EVERY_MS
  const state = reactive({
    status: 'offline' as Status,
    me: null as Member | null,
    joined: {} as Record<string, JoinedRoom>,
    active: null as string | null,
    error: '',
    invite: invite as string | null, // a code from an invite link, used once the person has a nickname
    settings: { sound: false, mentionSound: true, notifications: false },
  })

  let socket: Socket | null = null
  let counter = 0
  let audio: AudioContext | null = null
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const queues = new Map<string, Promise<void>>() // keeps the messages of a room in order while they are decrypted
  const proofs = new Map<string, string>() // proofs of your own messages, in case they arrive before the message does
  const lives = new Map<string, Live>() // the group encryption of each room we are in
  const buffered = new Map<string, Buffered>() // rooms we have entered and are not yet let into
  const admissions = new Map<string, (welcome: string) => void>() // a room where we wait for a welcome
  const sent = new Map<string, Payload>() // what we sent, by its encrypted body: our own messages come back to us, and we cannot decrypt them

  const ask = (event: string, data?: unknown) =>
    new Promise<Ack>((resolve) => {
      if (!socket) return resolve({ code: 'not_connected' })
      socket.timeout(8000).emit(event, data, (err: Error | null, answer: Ack) => resolve(err ? { code: 'no_answer' } : answer))
    })

  const fail = (answer: Ack) => errorText(answer)
  const isHidden = () => typeof document !== 'undefined' && document.hidden

  const eventLine = (key: Key, params: Record<string, string> = {}, at = new Date().toISOString()): Line => ({ kind: 'event', id: `e${++counter}`, at, key, params })

  function addLine(roomId: string, line: Line) {
    const joined = state.joined[roomId]
    if (!joined) return
    joined.lines.push(line)
    if (joined.lines.length > MAX_LINES) joined.lines.splice(0, joined.lines.length - MAX_LINES)
  }

  const findMsg = (roomId: string, id: string): Msg | undefined => {
    for (const line of state.joined[roomId]?.lines ?? []) if (line.kind === 'message' && line.msg.id === id) return line.msg
    return undefined
  }

  const enqueue = (roomId: string, work: () => Promise<void>) => {
    queues.set(roomId, (queues.get(roomId) ?? Promise.resolve()).then(work, work))
  }

  // ---- the group encryption
  const utf8 = (text: string) => new TextEncoder().encode(text)

  /** What we sent, until it comes back to us. */
  function remember(body: string, payload: Payload) {
    sent.set(body, payload)
    if (sent.size > REMEMBERED) sent.delete(sent.keys().next().value!)
  }

  /**
   * What a body says: ours (kept when we sent it), or decrypted. LATER when it is from an epoch we have not reached
   * (its commit is still on the way), and null when it is not for us, not from a member, or not valid.
   */
  async function read(live: Live, m: { from: { id?: string; nickname: string }; body: string; to?: Member }): Promise<Payload | null | typeof LATER> {
    if (m.from.nickname === state.me?.nickname) return sent.get(m.body) ?? null
    try {
      if (m.to) {
        const [mark, epoch, body] = m.body.split('.')
        if (mark !== 'w' || !m.from.id || !body) return null
        if (Number(epoch) > live.group.epoch) return LATER
        if (Number(epoch) !== live.group.epoch) return null
        const { key } = await live.group.whisperKey(m.from.id, m.to.id)
        return await decrypt<Payload>(key, body)
      }
      if (!m.from.id || !live.group.hasMember(m.from.id)) return null
      return JSON.parse(new TextDecoder().decode(await live.group.open(m.body))) as Payload
    } catch (error) {
      return error instanceof AheadError ? LATER : null
    }
  }

  /** Hands a change of the group to the server. True when it was kept (the first change made on an epoch is the only one). */
  const submit = async (roomId: string, change: Change, to?: string): Promise<boolean> => {
    const answer = await ask('mls:commit', { room: roomId, ...change, ...(change.welcome ? { to } : {}) })
    return answer.ok === true
  }

  /**
   * The member who looks after the group (the oldest one who is still here) lets in whoever asked and has proved they know the code,
   * and takes out those who are gone. Everybody works out the same keeper; if two make a change at once the server keeps the first and
   * the other follows it and looks again.
   */
  async function keep(roomId: string) {
    const live = lives.get(roomId)
    const joined = state.joined[roomId]
    if (!live || !joined || !state.me) return
    if (live.keeping) {
      live.again = true
      return
    }
    live.keeping = true
    try {
      do {
        live.again = false
        let round = await keepRound(roomId, live, joined, state.me.id)
        while (round === 'again') round = await keepRound(roomId, live, joined, state.me.id)
      } while (live.again)
    } finally {
      live.keeping = false
    }
  }

  /** The first request that can be honoured. The ones that cannot are dropped: from somebody who is gone or in the group already, or who does not know the code. */
  function pickRequest(live: Live, present: ReadonlySet<string>): Request | undefined {
    let next: Request | undefined
    for (const request of live.requests.values()) {
      const honourable = !live.group.hasMember(request.from.id) && present.has(request.from.id) && verifyProof(live.secrets.admissionKey, fromBase64(request.keyPackage), request.proof)
      if (!honourable) live.requests.delete(request.from.id)
      else next ??= request
    }
    return next
  }

  /** One change of the group by the keeper: lets in one person, takes out the ones who are gone. 'again' when there may be more to do. */
  async function keepRound(roomId: string, live: Live, joined: JoinedRoom, myId: string): Promise<'again' | 'done'> {
    const present = new Set(joined.members.map((m) => m.id))
    if (live.group.keeper(present) !== myId) return 'done'
    const gone = live.group.roster().filter((m) => !present.has(m.id)).map((m) => m.leaf)
    const next = pickRequest(live, present)
    if (gone.length === 0 && !next) return 'done'
    let kept: boolean
    try {
      const add = next && { candidate: fromBase64(next.keyPackage), who: { id: next.from.id, nickname: next.from.nickname }, handle: live.secrets.handle }
      kept = await live.group.change({ remove: gone, ...(add ? { add } : {}) }, (change) => submit(roomId, change, next?.from.id))
    } catch {
      if (next) live.requests.delete(next.from.id) // a request that cannot be honoured is dropped
      return 'again'
    }
    if (!kept) return 'done' // somebody else's change won: it is on its way, and we look again when it has been applied
    if (next) live.requests.delete(next.from.id)
    return 'again'
  }

  /** Follows a change of the group that arrived, then whatever was waiting for it. */
  async function follow(roomId: string, live: Live, epoch: number, commit: string) {
    if (epoch <= live.group.epoch) return // we have it already
    if (epoch > live.group.epoch + 1) {
      live.ahead.set(epoch, commit) // one before it has not arrived yet
      return
    }
    try {
      await live.group.follow(commit)
    } catch {
      return void resync(roomId) // we fell out of step with the group: come in again
    }
    for (let next = live.ahead.get(live.group.epoch + 1); next; next = live.ahead.get(live.group.epoch + 1)) {
      live.ahead.delete(live.group.epoch + 1)
      try {
        await live.group.follow(next)
      } catch {
        return void resync(roomId)
      }
    }
    if (!live.group.active) return void resync(roomId) // taken out of the group (while the server still has us in the room)
    const later = live.waiting.splice(0)
    for (const m of later) await deliver(roomId, m)
    void keep(roomId)
  }

  /** Reads one message or whisper of a room and shows it. */
  async function deliver(roomId: string, m: Incoming) {
    const live = lives.get(roomId)
    const joined = state.joined[roomId]
    if (!live || !joined) return
    const payload = await read(live, m)
    if (payload === LATER) {
      live.waiting.push(m)
      if (live.waiting.length > REMEMBERED) live.waiting.shift()
      return
    }
    if (payload?.k === 'code') return void (await applyCode(roomId, live, joined, m.from, payload.code))
    receive(roomId, toMsg(m, payload))
  }

  /** The owner made a new code: the members learn it here, and keep its PSK to follow the commits that let people in with it. */
  async function applyCode(roomId: string, live: Live, joined: JoinedRoom, from: Member, code: unknown) {
    if (from.id !== joined.room.ownerId || from.id === state.me?.id || typeof code !== 'string' || !isCode(code)) return // only the owner changes the code
    const secrets = await deriveSecrets(code, cost)
    live.group.addPsk(secrets.handle, secrets.psk)
    live.secrets = secrets
    joined.code = canonicalCode(code)
    addLine(roomId, eventLine('event.newCode', { code: joined.code }))
  }

  /** Waits for the welcome of the members, asking again now and then. Null when nobody let us in. */
  async function admission(roomId: string, secrets: Secrets): Promise<Group | null> {
    const candidate = await newCandidate({ id: state.me!.id, nickname: state.me!.nickname })
    const welcome = await new Promise<string | null>((resolve) => {
      const finish = (value: string | null) => {
        clearTimeout(giveUp)
        clearInterval(again)
        admissions.delete(roomId)
        resolve(value)
      }
      const request = () => void ask('mls:request', { room: roomId, keyPackage: toBase64(candidate.encoded), proof: prove(secrets.admissionKey, candidate.encoded) })
      const giveUp = setTimeout(() => finish(null), admissionMs)
      const again = setInterval(request, requestEveryMs)
      admissions.set(roomId, (w) => finish(w))
      request()
    })
    if (!welcome) return null
    return joinWith(candidate, welcome, secrets).catch(() => null)
  }

  const joinWith = (candidate: Candidate, welcome: string, secrets: Secrets) => Group.join(candidate, welcome, secrets.handle, secrets.psk)

  /**
   * Enters the group of a room we just joined on the server: we start it (nobody else is there), or the members let us in.
   * Answers the group and the messages that came while we waited (to be shown once the room is on the screen), or null when nobody let us in.
   */
  async function establish(roomId: string, secrets: Secrets, first: boolean): Promise<{ live: Live; early: Incoming[] } | null> {
    buffered.set(roomId, { commits: [], messages: [] })
    const group = first ? await Group.start({ id: state.me!.id, nickname: state.me!.nickname }, secrets.handle, secrets.psk) : await admission(roomId, secrets)
    const early = buffered.get(roomId)
    buffered.delete(roomId)
    if (!group) return null
    const live: Live = { group, secrets, requests: new Map(), keeping: false, again: false, waiting: [], ahead: new Map() }
    lives.set(roomId, live)
    for (const c of early?.commits ?? []) await follow(roomId, live, c.epoch, c.commit)
    return { live, early: early?.messages ?? [] }
  }

  /** The group of a room fell apart for us (we were taken out, or lost a step): ask to be let in again. */
  async function resync(roomId: string) {
    const live = lives.get(roomId)
    const joined = state.joined[roomId]
    if (!live || !joined) return
    lives.delete(roomId)
    addLine(roomId, eventLine('event.resync'))
    const again = await establish(roomId, live.secrets, false)
    if (!again) {
      state.error = t('error.not_admitted')
      void ask('room:leave', { room: roomId })
      return forget(roomId)
    }
    for (const m of again.early) await deliver(roomId, m)
    void keep(roomId)
  }

  // ---- reading what arrives
  /** The message as the page shows it. Anything the page cannot trust or understand becomes "unreadable" instead of being shown. */
  function toMsg(m: Incoming, payload: Payload | null): Msg {
    const msg: Msg = {
      id: m.id,
      from: m.from,
      at: m.at,
      mine: m.from.nickname === state.me?.nickname,
      kind: 'text',
      text: '',
      replyTo: m.replyTo ?? null,
      edited: false,
      deleted: false,
      unreadable: false,
      reactions: {},
      whisperTo: m.to?.nickname,
    }
    if (payload?.k === 'text' && typeof payload.text === 'string') {
      msg.text = payload.text.slice(0, MAX_TEXT)
    } else if (payload?.k === 'image' && typeof payload.src === 'string' && PHOTO_URL.test(payload.src)) {
      Object.assign(msg, { kind: 'image', src: payload.src, w: Number(payload.w) || 0, h: Number(payload.h) || 0, text: String(payload.text ?? '').slice(0, MAX_TEXT) })
    } else if (payload?.k === 'audio' && typeof payload.src === 'string' && AUDIO_URL.test(payload.src)) {
      const wave = Array.isArray(payload.wave) ? payload.wave.slice(0, 64).map((v) => (typeof v === 'number' ? Math.min(100, Math.max(0, v)) : 0)) : []
      Object.assign(msg, { kind: 'audio', src: payload.src, ms: Math.min(Math.max(Number(payload.ms) || 0, 0), MAX_VOICE_MS), wave })
    } else {
      msg.unreadable = true
    }
    if (msg.mine) msg.proof = proofs.get(m.id)
    return msg
  }

  function notifyAbout(joined: JoinedRoom, msg: Msg, mention: boolean) {
    if (state.settings.notifications && isHidden() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const params = { name: msg.from.nickname, room: joined.room.name }
      const text = mention ? t(mentionsEveryone(msg.text) ? 'notify.mentionAll' : 'notify.mention', params) : t('notify.message', params)
      new Notification(text, { tag: joined.room.id }) // never the text of the message itself
    }
  }

  /** A message that arrived: shown, and counted as unread when you are not looking at it. */
  function receive(roomId: string, msg: Msg) {
    const joined = state.joined[roomId]
    if (!joined) return
    addLine(roomId, { kind: 'message', msg })
    if (msg.mine || joined.muted.includes(msg.from.nickname.toLowerCase())) return
    joined.typing = joined.typing.filter((n) => n !== msg.from.nickname)
    const mention = !!state.me && mentions(msg.text, state.me.nickname) // by name, or "@all"
    const away = state.active !== roomId || isHidden()
    if (away) {
      joined.unread++
      if (mention) joined.mentioned = true
      notifyAbout(joined, msg, mention)
    }
    // being mentioned has a sound of its own, on unless you turned it off; the plain beep is for any new message you are not looking at
    if (mention && state.settings.mentionSound) chime()
    else if (state.settings.sound && (away || mention)) beep()
  }

  function bind(s: Socket) {
    s.on('connect', () => {
      // not the first connection: the server has forgotten us
      if (state.me) void resume(state.me.nickname)
      else state.status = 'online'
    })
    s.on('disconnect', () => {
      state.status = 'offline'
    })
    s.on('connect_error', () => {
      state.status = 'offline'
    })

    const onMessage = (m: Incoming) => {
      enqueue(m.room, async () => {
        const early = buffered.get(m.room)
        if (early) early.messages.push(m) // we are not in the group yet: it is read once we are
        else await deliver(m.room, m)
      })
    }
    s.on('message', onMessage)
    s.on('whisper', onMessage)

    s.on('message:edited', (e: { room: string; id: string; body: string; from: Member }) => {
      enqueue(e.room, async () => {
        const live = lives.get(e.room)
        const msg = findMsg(e.room, e.id)
        if (!live || !msg || msg.from.nickname !== e.from.nickname || msg.kind !== 'text') return // only the author changes a message
        const payload = await read(live, e)
        if (payload && payload !== LATER && payload.k === 'text' && typeof payload.text === 'string') {
          msg.text = payload.text.slice(0, MAX_TEXT)
          msg.edited = true
        }
      })
    })

    // ---- the group encryption: who asks to come in, how the group changes, the welcome that lets us in
    s.on('mls:request', (e: { room: string } & Request) => {
      const live = lives.get(e.room)
      if (!live || typeof e.keyPackage !== 'string' || typeof e.proof !== 'string' || !e.from?.id) return
      live.requests.set(e.from.id, { from: e.from, keyPackage: e.keyPackage, proof: e.proof })
      void keep(e.room)
    })
    s.on('mls:commit', (e: { room: string; epoch: number; commit: string }) => {
      enqueue(e.room, async () => {
        const live = lives.get(e.room)
        if (live) await follow(e.room, live, e.epoch, e.commit)
        else buffered.get(e.room)?.commits.push({ epoch: e.epoch, commit: e.commit })
      })
    })
    s.on('mls:welcome', (e: { room: string; welcome: string }) => admissions.get(e.room)?.(e.welcome))
    s.on('message:deleted', (e: { room: string; id: string; from: Member }) => {
      enqueue(e.room, async () => {
        const msg = findMsg(e.room, e.id)
        if (!msg || msg.from.nickname !== e.from.nickname) return
        Object.assign(msg, { deleted: true, text: '', src: undefined, kind: 'text', reactions: {} })
      })
    })
    s.on('message:reaction', (e: { room: string; id: string; emoji: string; on: boolean; from: Member }) => {
      const msg = findMsg(e.room, e.id)
      if (!msg || msg.deleted) return
      const who = (msg.reactions[e.emoji] ?? []).filter((n) => n !== e.from.nickname)
      if (e.on) who.push(e.from.nickname)
      if (who.length) msg.reactions[e.emoji] = who
      else delete msg.reactions[e.emoji]
    })

    s.on('room:event', (e: { room: string; kind: 'join' | 'leave' | 'kick' | 'owner'; nickname: string; at: string }) => {
      if ((e.kind === 'join' || e.kind === 'leave') && e.nickname === state.me?.nickname) return // "You joined" is shown by us
      const key = { join: 'event.joined', leave: 'event.left', kick: 'event.kicked', owner: 'event.owner' }[e.kind] as Key
      addLine(e.room, eventLine(key, { name: e.nickname }, e.at))
    })
    s.on('room:members', (e: { room: string; members: Member[] }) => {
      const joined = state.joined[e.room]
      if (!joined) return
      joined.members = e.members
      joined.room.members = e.members.length
      void keep(e.room) // somebody left: the keeper takes them out of the group
    })
    s.on('room:updated', (e: { room: Room }) => {
      const joined = state.joined[e.room.id]
      if (!joined) return
      const before = joined.room
      if (e.room.rev < before.rev) return // an older description of the room, arriving late: what we have is newer
      if (before.locked !== e.room.locked) addLine(before.id, eventLine(e.room.locked ? 'event.locked' : 'event.unlocked'))
      Object.assign(joined.room, e.room)
    })
    s.on('room:kicked', (e: { room: string }) => {
      const joined = state.joined[e.room]
      if (!joined) return
      state.error = t('error.kicked', { name: joined.room.name })
      forget(e.room)
    })
    s.on('typing', (e: { room: string; nickname: string; typing: boolean }) => {
      const joined = state.joined[e.room]
      if (!joined) return
      const key = `${e.room}:${e.nickname}`
      clearTimeout(typingTimers.get(key))
      joined.typing = joined.typing.filter((n) => n !== e.nickname)
      if (e.typing) {
        joined.typing.push(e.nickname)
        typingTimers.set(key, setTimeout(() => (joined.typing = joined.typing.filter((n) => n !== e.nickname)), TYPING_MS))
      }
    })
  }

  function forget(roomId: string) {
    delete state.joined[roomId]
    queues.delete(roomId)
    lives.delete(roomId)
    buffered.delete(roomId)
    admissions.get(roomId)?.('') // nobody is waiting for a welcome any more
    admissions.delete(roomId)
    if (state.active === roomId) state.active = null
  }

  /** Opens the connection if needed and waits until it is up. */
  function ensureConnected(): Promise<void> {
    if (!socket) {
      state.status = 'connecting'
      socket = connect(url, { transports: ['websocket'] })
      bind(socket)
    }
    const s = socket
    if (s.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('unreachable')), 8000)
      s.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Picks a nickname (and goes into the room of an invite link, if there was one). Resolves with an error message, or '' when it worked. */
  async function login(nickname: string): Promise<string> {
    state.error = ''
    try {
      await ensureConnected()
    } catch {
      return t('error.unreachable')
    }
    const answer = await ask('hello', { nickname })
    if (!answer.ok) return fail(answer)
    state.me = answer.user as Member
    state.status = 'online'
    if (state.invite) {
      const code = state.invite
      state.invite = null
      state.error = await join(code)
    }
    return ''
  }

  /** After a lost connection: say hello again and go back into the rooms we were in. The old nickname may take a few seconds to be released. */
  async function resume(nickname: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const answer = await ask('hello', { nickname })
      if (answer.ok) {
        state.me = answer.user as Member
        state.status = 'online'
        for (const id of Object.keys(state.joined)) {
          const joined = state.joined[id]
          const secrets = lives.get(id)?.secrets
          const rejoined = secrets ? await ask('room:join', { handle: secrets.handle }) : { ok: false }
          if (!rejoined.ok) {
            forget(id) // the room closed while we were away
            continue
          }
          lives.delete(id) // the old connection's place in the group is empty now (somebody removes it): we ask for a new one
          Object.assign(joined.room, rejoined.room as Room)
          joined.members = rejoined.members as Member[]
          const again = await establish(id, secrets!, rejoined.first === true)
          if (!again) {
            state.error = t('error.not_admitted')
            void ask('room:leave', { room: id })
            forget(id)
            continue
          }
          addLine(id, eventLine('event.back'))
          for (const m of again.early) await deliver(id, m)
          void keep(id)
        }
        return
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    state.me = null // somebody else took the nickname: back to the first screen
    state.joined = {}
    state.active = null
    state.error = t('error.nickname_lost')
  }

  // ---- rooms
  /** Shows a room we are already in. */
  function open(roomId: string) {
    if (!state.joined[roomId]) return
    state.active = roomId
    markRead(roomId)
  }

  /** You looked at the room: what was unread no longer is. */
  function markRead(roomId: string) {
    const joined = state.joined[roomId]
    if (joined && !isHidden()) {
      joined.unread = 0
      joined.mentioned = false
    }
  }

  async function enter(room: Room, members: Member[], code: string, entered: { live: Live; early: Incoming[] }, first: Key) {
    state.joined[room.id] = { room, code, lines: [eventLine(first)], members, typing: [], unread: 0, mentioned: false, muted: [] }
    state.active = room.id
    for (const m of entered.early) await deliver(room.id, m)
    void keep(room.id)
  }

  /** The only way into a room: its code. Resolves with an error message, or '' when it worked. */
  async function join(raw: string): Promise<string> {
    if (!isCode(raw)) return fail({ code: 'code_invalid' })
    if (!(await supported())) return t('error.browser')
    const code = canonicalCode(raw)
    const already = Object.entries(state.joined).find(([, j]) => j.code === code)
    if (already) {
      open(already[0])
      return ''
    }
    const secrets = await deriveSecrets(code, cost) // about a second: it is what makes guessing codes expensive
    const answer = await ask('room:join', { handle: secrets.handle })
    if (!answer.ok) return fail(answer)
    const room = answer.room as Room
    const entered = await establish(room.id, secrets, answer.first === true)
    if (!entered) {
      void ask('room:leave', { room: room.id })
      return t('error.not_admitted')
    }
    await enter(room, answer.members as Member[], code, entered, 'event.youJoined')
    return ''
  }

  /** A new room: we are in it and run it, and its code is for sharing. */
  async function create(name: string): Promise<string> {
    if (!(await supported())) return t('error.browser')
    const code = generateCode()
    const secrets = await deriveSecrets(code, cost)
    const answer = await ask('room:create', { name, handle: secrets.handle })
    if (!answer.ok) return fail(answer)
    const room = answer.room as Room
    const entered = await establish(room.id, secrets, true)
    if (!entered) return t('error.not_admitted')
    await enter(room, answer.members as Member[], code, entered, 'event.youCreated')
    return ''
  }

  async function leave(roomId: string) {
    await ask('room:leave', { room: roomId })
    forget(roomId)
  }

  // ---- writing
  const current = () => (state.active ? state.joined[state.active] : undefined)

  /** Encrypts for the group and sends. */
  async function post(payload: Payload, replyTo: string | null, roomId = state.active): Promise<string> {
    const live = roomId ? lives.get(roomId) : undefined
    if (!roomId || !live) return t('error.open_first')
    let body: string
    try {
      body = await live.group.seal(utf8(JSON.stringify(payload)))
    } catch {
      return t('error.encryption')
    }
    remember(body, payload)
    const answer = await ask('message', { room: roomId, body, replyTo })
    if (!answer.ok) return fail(answer)
    proofs.set(answer.id as string, answer.proof as string)
    const own = findMsg(roomId, answer.id as string)
    if (own) own.proof = answer.proof as string
    return ''
  }

  /** Text; "/w Nickname hello" is a whisper to that person. Resolves with an error message, or ''. */
  async function send(text: string, replyTo: string | null = null): Promise<string> {
    const joined = current()
    const live = state.active ? lives.get(state.active) : undefined
    if (!joined || !live || !state.me) return t('error.open_first')
    const whisper = parseWhisper(text, joined.members.filter((m) => m.nickname !== state.me?.nickname).map((m) => m.nickname))
    if (whisper) {
      const target = joined.members.find((m) => m.nickname.toLowerCase() === whisper.to.toLowerCase())
      if (!target) return t('error.unknown_target')
      const payload: Payload = { k: 'text', text: whisper.text }
      const { epoch, key } = await live.group.whisperKey(state.me.id, target.id)
      const body = `w.${epoch}.${await encrypt(key, payload)}`
      remember(body, payload)
      const answer = await ask('whisper', { room: joined.room.id, to: whisper.to, body })
      return answer.ok ? '' : fail(answer)
    }
    return post({ k: 'text', text }, replyTo)
  }

  const sendPhoto = (photo: Photo, caption = '', replyTo: string | null = null) => post({ k: 'image', src: photo.src, w: photo.w, h: photo.h, text: caption }, replyTo)
  const sendVoice = (voice: Voice, replyTo: string | null = null) => post({ k: 'audio', src: voice.src, ms: voice.ms, wave: voice.wave }, replyTo)

  async function edit(messageId: string, text: string): Promise<string> {
    const joined = current()
    const live = state.active ? lives.get(state.active) : undefined
    const msg = joined && findMsg(joined.room.id, messageId)
    if (!joined || !live || !msg?.proof) return t('error.proof_invalid')
    const payload: Payload = { k: 'text', text }
    let body: string
    try {
      body = await live.group.seal(utf8(JSON.stringify(payload)))
    } catch {
      return t('error.encryption')
    }
    remember(body, payload)
    const answer = await ask('message:edit', { room: joined.room.id, id: messageId, proof: msg.proof, body })
    return answer.ok ? '' : fail(answer)
  }

  async function remove(messageId: string): Promise<string> {
    const joined = current()
    const msg = joined && findMsg(joined.room.id, messageId)
    if (!joined || !msg?.proof) return t('error.proof_invalid')
    const answer = await ask('message:delete', { room: joined.room.id, id: messageId, proof: msg.proof })
    return answer.ok ? '' : fail(answer)
  }

  async function react(messageId: string, emoji: string): Promise<string> {
    const joined = current()
    const msg = joined && findMsg(joined.room.id, messageId)
    if (!joined || !msg || !state.me) return ''
    const on = !(msg.reactions[emoji] ?? []).includes(state.me.nickname)
    const answer = await ask('message:react', { room: joined.room.id, id: messageId, emoji, on })
    return answer.ok ? '' : fail(answer)
  }

  function typing(on: boolean) {
    if (state.active) socket?.emit('typing', { room: state.active, typing: on })
  }

  // ---- running a room
  async function lock(locked: boolean): Promise<string> {
    const answer = await ask('room:lock', { room: state.active, locked })
    return answer.ok ? '' : fail(answer)
  }

  async function kick(memberId: string): Promise<string> {
    const answer = await ask('room:kick', { room: state.active, id: memberId })
    return answer.ok ? '' : fail(answer)
  }

  /** A new code: the old one stops finding the room. The owner chooses it here; the members learn it through the group. */
  async function newCode(): Promise<string> {
    const joined = current()
    const live = state.active ? lives.get(state.active) : undefined
    if (!joined || !live) return t('error.open_first')
    const code = generateCode()
    const secrets = await deriveSecrets(code, cost)
    const answer = await ask('room:newcode', { room: joined.room.id, handle: secrets.handle })
    if (!answer.ok) return fail(answer)
    live.group.addPsk(secrets.handle, secrets.psk)
    live.secrets = secrets
    joined.code = code
    addLine(joined.room.id, eventLine('event.newCode', { code }))
    return post({ k: 'code', code }, null, joined.room.id)
  }

  /** Hides (or shows again) the messages of somebody, on your side only. */
  function toggleMute(nickname: string) {
    const joined = current()
    if (!joined) return
    const name = nickname.toLowerCase()
    joined.muted = joined.muted.includes(name) ? joined.muted.filter((n) => n !== name) : [...joined.muted, name]
  }

  // ---- sound and notifications
  /** One note: `start` and `length` in seconds from now. */
  function tone(context: AudioContext, frequency: number, start: number, length: number, volume: number) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const at = context.currentTime + start
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(volume, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + length)
  }

  /** Plays notes, if the browser lets us. */
  function play(notes: [frequency: number, start: number, length: number, volume: number][]) {
    try {
      audio ??= new AudioContext()
      for (const [frequency, start, length, volume] of notes) tone(audio, frequency, start, length, volume)
    } catch {
      /* no sound available: nothing to do */
    }
  }

  /** A new message: one note. */
  const beep = () => play([[880, 0, 0.25, 0.08]])

  /** You were mentioned: two notes going up, so that it cannot be mistaken for the beep of a message. */
  const chime = () =>
    play([
      [660, 0, 0.16, 0.12],
      [990, 0.13, 0.32, 0.12],
    ])

  function setSound(on: boolean) {
    state.settings.sound = on
    if (on) beep() // a click is the moment browsers allow sound, and it shows what it will sound like
  }

  function setMentionSound(on: boolean) {
    state.settings.mentionSound = on
    if (on) chime()
  }

  /** Asks the browser for permission. Answers whether notifications are on. */
  async function setNotifications(on: boolean): Promise<boolean> {
    if (!on || typeof Notification === 'undefined') {
      state.settings.notifications = false
      return false
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    state.settings.notifications = permission === 'granted'
    return state.settings.notifications
  }

  /** How many messages wait in all the rooms. */
  const unreadTotal = () => Object.values(state.joined).reduce((sum, j) => sum + j.unread, 0)

  function logout() {
    socket?.close()
    socket = null
    state.me = null
    state.joined = {}
    state.active = null
    state.status = 'offline'
    queues.clear()
    proofs.clear()
    lives.clear()
    buffered.clear()
    admissions.clear()
    sent.clear()
  }

  return { state, login, open, markRead, join, create, leave, send, sendPhoto, sendVoice, edit, remove, react, typing, lock, kick, newCode, toggleMute, setSound, setMentionSound, setNotifications, unreadTotal, logout }
}

export type Chat = ReturnType<typeof createChat>

let shared: Chat | null = null

/**
 * The one chat of the page. `VITE_SOCKET_URL` points at the server; in production the server also serves the page, so the address is simply this site.
 * An invite link (https://site/#/join/K7M2QXAB9T) carries a code; it is read once and removed from the address bar.
 */
export function useChat(inviteCode: string | null = null): Chat {
  if (!shared) {
    const configured = import.meta.env.VITE_SOCKET_URL as string | undefined
    shared = createChat(configured || (import.meta.env.DEV ? `http://${location.hostname}:3000` : undefined), io, inviteCode)
  }
  return shared
}
