import { io, type Socket } from 'socket.io-client'
import { markRaw, reactive } from 'vue'
import { decrypt, deriveKey, encrypt } from '../crypto'
import { errorText, t, type Key } from '../i18n'
import { AUDIO_URL, MAX_VOICE_MS, PHOTO_URL, type Photo, type Voice } from '../media'
import type { JoinedRoom, Line, Member, Msg, Room, Status } from '../types'
import { mentions, parseWhisper } from '../utils'

const MAX_LINES = 500 // per room: the oldest lines scroll away
const TYPING_MS = 4000
const MAX_TEXT = 500

interface Ack {
  ok?: boolean
  error?: string
  code?: string
  params?: Record<string, string | number>
  [key: string]: unknown
}

/** What goes inside an encrypted body. */
type Payload =
  | { k: 'text'; text: string }
  | { k: 'image'; src: string; w: number; h: number; text?: string }
  | { k: 'audio'; src: string; ms: number; wave: number[] }

interface Incoming {
  id: string
  room: string
  from: Member
  body: string
  replyTo?: string | null
  at: string
  to?: Member
}

/**
 * The chat on the client side. Everything is kept in memory: nothing is written to the disk or the browser's
 * storage, because the chat is live only. What people write is encrypted here with a key made from the room code.
 * When the connection drops the server forgets us, so a reconnection says hello again and re-joins the rooms
 * (what was said in between is lost, as it should be).
 */
export function createChat(url?: string, connect: typeof io = io, invite: string | null = null) {
  const state = reactive({
    status: 'offline' as Status,
    me: null as Member | null,
    joined: {} as Record<string, JoinedRoom>,
    active: null as string | null,
    error: '',
    invite: invite as string | null, // a code from an invite link, used once the person has a nickname
    settings: { sound: false, notifications: false },
  })

  let socket: Socket | null = null
  let counter = 0
  let audio: AudioContext | null = null
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const queues = new Map<string, Promise<void>>() // keeps the messages of a room in order while they are decrypted
  const proofs = new Map<string, string>() // proofs of your own messages, in case they arrive before the message does

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

  // ---- reading what arrives
  /** The message as the page shows it. Anything the page cannot trust or understand becomes "unreadable" instead of being shown. */
  async function toMsg(joined: JoinedRoom, m: Incoming): Promise<Msg> {
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
    const payload = await decrypt<Payload>(joined.key, m.body)
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
    if (state.settings.sound && (isHidden() || state.active !== joined.room.id || mention)) beep()
    if (state.settings.notifications && isHidden() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const text = mention ? t('notify.mention', { name: msg.from.nickname, room: joined.room.name }) : t('notify.message', { room: joined.room.name })
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
    const mention = !!state.me && mentions(msg.text, state.me.nickname)
    if (state.active !== roomId || isHidden()) {
      joined.unread++
      if (mention) joined.mentioned = true
      notifyAbout(joined, msg, mention)
    } else if (state.settings.sound && mention) {
      beep()
    }
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
        const joined = state.joined[m.room]
        if (joined) receive(m.room, await toMsg(joined, m))
      })
    }
    s.on('message', onMessage)
    s.on('whisper', onMessage)

    s.on('message:edited', (e: { room: string; id: string; body: string; from: Member }) => {
      enqueue(e.room, async () => {
        const joined = state.joined[e.room]
        const msg = findMsg(e.room, e.id)
        if (!joined || !msg || msg.from.nickname !== e.from.nickname || msg.kind !== 'text') return // only the author changes a message
        const payload = await decrypt<Payload>(joined.key, e.body)
        if (payload?.k === 'text' && typeof payload.text === 'string') {
          msg.text = payload.text.slice(0, MAX_TEXT)
          msg.edited = true
        }
      })
    })
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
    })
    s.on('room:updated', (e: { room: Room }) => {
      const joined = state.joined[e.room.id]
      if (!joined) return
      const before = joined.room
      if (e.room.rev < before.rev) return // an older description of the room, arriving late: what we have is newer
      if (before.locked !== e.room.locked) addLine(before.id, eventLine(e.room.locked ? 'event.locked' : 'event.unlocked'))
      if (before.code !== e.room.code) {
        addLine(before.id, eventLine('event.newCode', { code: e.room.code }))
        void deriveKey(e.room.code).then((key) => (joined.key = markRaw(key))) // the key follows the code
      }
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
          const rejoined = await ask('room:join', { code: joined.room.code })
          if (rejoined.ok) {
            Object.assign(joined.room, rejoined.room as Room)
            joined.members = rejoined.members as Member[]
            addLine(id, eventLine('event.back'))
          } else {
            forget(id) // the room closed while we were away
          }
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

  async function enter(room: Room, members: Member[], first: Key) {
    const existing = state.joined[room.id]
    if (existing) {
      existing.members = members
      Object.assign(existing.room, room)
    } else {
      const key = markRaw(await deriveKey(room.code))
      state.joined[room.id] = { room, key, lines: [eventLine(first)], members, typing: [], unread: 0, mentioned: false, muted: [] }
    }
    state.active = room.id
  }

  /** The only way into a room: its code. Resolves with an error message, or '' when it worked. */
  async function join(code: string): Promise<string> {
    const answer = await ask('room:join', { code })
    if (!answer.ok) return fail(answer)
    await enter(answer.room as Room, answer.members as Member[], 'event.youJoined')
    return ''
  }

  /** A new room: we are in it and run it, and its code is for sharing. */
  async function create(name: string): Promise<string> {
    const answer = await ask('room:create', { name })
    if (!answer.ok) return fail(answer)
    await enter(answer.room as Room, answer.members as Member[], 'event.youCreated')
    return ''
  }

  async function leave(roomId: string) {
    await ask('room:leave', { room: roomId })
    forget(roomId)
  }

  // ---- writing
  const current = () => (state.active ? state.joined[state.active] : undefined)

  async function post(payload: Payload, replyTo: string | null): Promise<string> {
    const joined = current()
    if (!joined) return t('error.open_first')
    const answer = await ask('message', { room: joined.room.id, body: await encrypt(joined.key, payload), replyTo })
    if (!answer.ok) return fail(answer)
    proofs.set(answer.id as string, answer.proof as string)
    const own = findMsg(joined.room.id, answer.id as string)
    if (own) own.proof = answer.proof as string
    return ''
  }

  /** Text; "/w Nickname hello" is a whisper to that person. Resolves with an error message, or ''. */
  async function send(text: string, replyTo: string | null = null): Promise<string> {
    const joined = current()
    if (!joined) return t('error.open_first')
    const whisper = parseWhisper(text, joined.members.filter((m) => m.nickname !== state.me?.nickname).map((m) => m.nickname))
    if (whisper) {
      const answer = await ask('whisper', { room: joined.room.id, to: whisper.to, body: await encrypt(joined.key, { k: 'text', text: whisper.text } satisfies Payload) })
      return answer.ok ? '' : fail(answer)
    }
    return post({ k: 'text', text }, replyTo)
  }

  const sendPhoto = (photo: Photo, caption = '', replyTo: string | null = null) => post({ k: 'image', src: photo.src, w: photo.w, h: photo.h, text: caption }, replyTo)
  const sendVoice = (voice: Voice, replyTo: string | null = null) => post({ k: 'audio', src: voice.src, ms: voice.ms, wave: voice.wave }, replyTo)

  async function edit(messageId: string, text: string): Promise<string> {
    const joined = current()
    const msg = joined && findMsg(joined.room.id, messageId)
    if (!joined || !msg?.proof) return t('error.proof_invalid')
    const answer = await ask('message:edit', { room: joined.room.id, id: messageId, proof: msg.proof, body: await encrypt(joined.key, { k: 'text', text } satisfies Payload) })
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

  async function newCode(): Promise<string> {
    const answer = await ask('room:newcode', { room: state.active })
    return answer.ok ? '' : fail(answer)
  }

  /** Hides (or shows again) the messages of somebody, on your side only. */
  function toggleMute(nickname: string) {
    const joined = current()
    if (!joined) return
    const name = nickname.toLowerCase()
    joined.muted = joined.muted.includes(name) ? joined.muted.filter((n) => n !== name) : [...joined.muted, name]
  }

  // ---- sound and notifications
  function beep() {
    try {
      audio ??= new AudioContext()
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.frequency.value = 880
      gain.gain.setValueAtTime(0.08, audio.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start()
      oscillator.stop(audio.currentTime + 0.25)
    } catch {
      /* no sound available: nothing to do */
    }
  }

  function setSound(on: boolean) {
    state.settings.sound = on
    if (on) beep() // a click is the moment browsers allow sound, and it shows what it will sound like
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
  }

  return { state, login, open, markRead, join, create, leave, send, sendPhoto, sendVoice, edit, remove, react, typing, lock, kick, newCode, toggleMute, setSound, setNotifications, unreadTotal, logout }
}

export type Chat = ReturnType<typeof createChat>

let shared: Chat | null = null

/**
 * The one chat of the page. `VITE_SOCKET_URL` points at the server; in production the server also serves the page, so the address is simply this site.
 * An invite link (https://site/#/join/K7M2QX) carries a code; it is read once and removed from the address bar.
 */
export function useChat(inviteCode: string | null = null): Chat {
  if (!shared) {
    const configured = import.meta.env.VITE_SOCKET_URL as string | undefined
    shared = createChat(configured || (import.meta.env.DEV ? `http://${location.hostname}:3000` : undefined), io, inviteCode)
  }
  return shared
}
