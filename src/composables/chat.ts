import { io, type Socket } from 'socket.io-client'
import { reactive } from 'vue'
import type { JoinedRoom, Line, Member, Room, ServerMessage, Status } from '../types'

const MAX_LINES = 500 // per room: the oldest lines scroll away
const TYPING_MS = 4000

interface Ack {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

/**
 * The chat on the client side. Everything is kept in memory: nothing is written to the disk or the browser's
 * storage, because the chat is live only. When the connection drops the server forgets us, so a reconnection
 * says hello again and re-joins the rooms (what was said in between is lost, as it should be).
 */
export function createChat(url?: string, connect: typeof io = io) {
  const state = reactive({
    status: 'offline' as Status,
    me: null as Member | null,
    joined: {} as Record<string, JoinedRoom>,
    active: null as string | null,
    error: '',
  })

  let socket: Socket | null = null
  let counter = 0
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const ask = (event: string, data?: unknown) =>
    new Promise<Ack>((resolve) => {
      if (!socket) return resolve({ error: 'You are not connected.' })
      socket.timeout(8000).emit(event, data, (err: Error | null, answer: Ack) => resolve(err ? { error: 'The server did not answer.' } : answer))
    })

  const addLine = (roomId: string, line: Line) => {
    const joined = state.joined[roomId]
    if (!joined) return
    joined.lines.push(line)
    if (joined.lines.length > MAX_LINES) joined.lines.splice(0, joined.lines.length - MAX_LINES)
  }
  const eventLine = (text: string, at = new Date().toISOString()): Line => ({ kind: 'event', id: `e${++counter}`, text, at })

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
    s.on('message', (m: ServerMessage) => {
      addLine(m.room, { kind: 'message', id: m.id, from: m.from, text: m.text, at: m.at, mine: m.from.nickname === state.me?.nickname })
      const joined = state.joined[m.room]
      if (joined) joined.typing = joined.typing.filter((n) => n !== m.from.nickname)
    })
    s.on('room:event', (e: { room: string; kind: 'join' | 'leave'; nickname: string; at: string }) => {
      if (e.nickname === state.me?.nickname) return // "You joined" is shown by us, not announced back
      addLine(e.room, eventLine(`${e.nickname} ${e.kind === 'join' ? 'joined' : 'left'}`, e.at))
    })
    s.on('room:members', (e: { room: string; members: Member[] }) => {
      const joined = state.joined[e.room]
      if (joined) joined.members = e.members
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
      const timer = setTimeout(() => reject(new Error('Cannot reach the chat server.')), 8000)
      s.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Picks a nickname. Resolves with an error message, or '' when it worked. */
  async function login(nickname: string): Promise<string> {
    state.error = ''
    try {
      await ensureConnected()
    } catch (e) {
      return (e as Error).message
    }
    const answer = await ask('hello', { nickname })
    if (answer.error) return answer.error
    state.me = answer.user as Member
    state.status = 'online'
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
            joined.room = rejoined.room as Room
            joined.members = rejoined.members as Member[]
            joined.lines.push(eventLine('You are back. Anything said while you were away is gone.'))
          } else {
            // the room closed while we were away
            delete state.joined[id]
            if (state.active === id) state.active = Object.keys(state.joined)[0] ?? null
          }
        }
        return
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    state.me = null // somebody else took the nickname: back to the first screen
    state.joined = {}
    state.active = null
    state.error = 'You were disconnected and your nickname was taken. Choose another one.'
  }

  /** Shows a room we are already in. */
  function open(roomId: string) {
    if (state.joined[roomId]) state.active = roomId
  }

  function enter(room: Room, members: Member[], first: string) {
    const existing = state.joined[room.id]
    if (existing) {
      existing.members = members
    } else {
      state.joined[room.id] = { room, lines: [eventLine(first)], members, typing: [] }
    }
    state.active = room.id
  }

  /** The only way into a room: its code. Resolves with an error message, or '' when it worked. */
  async function join(code: string): Promise<string> {
    const answer = await ask('room:join', { code })
    if (answer.error) return answer.error
    enter(answer.room as Room, answer.members as Member[], 'You joined. Messages in this room are live only: nobody can see what was said before you came.')
    return ''
  }

  async function leave(roomId: string) {
    await ask('room:leave', { room: roomId })
    delete state.joined[roomId]
    if (state.active === roomId) state.active = null
  }

  /** A new room: we are in it, and its code is for sharing. */
  async function create(name: string): Promise<string> {
    const answer = await ask('room:create', { name })
    if (answer.error) return answer.error
    enter(answer.room as Room, answer.members as Member[], 'Room created. Share its code to let people in. The room closes when everybody has left it.')
    return ''
  }

  async function send(text: string): Promise<string> {
    if (!state.active) return 'Open a room first.'
    const answer = await ask('message', { room: state.active, text })
    return answer.error ?? ''
  }

  function typing(on: boolean) {
    if (state.active) socket?.emit('typing', { room: state.active, typing: on })
  }

  function logout() {
    socket?.close()
    socket = null
    state.me = null
    state.joined = {}
    state.active = null
    state.status = 'offline'
  }

  return { state, login, open, join, leave, create, send, typing, logout }
}

export type Chat = ReturnType<typeof createChat>

let shared: Chat | null = null

/** The one chat of the page. `VITE_SOCKET_URL` points at the server; in production the server also serves the page, so the address is simply this site. */
export function useChat(): Chat {
  if (!shared) {
    const configured = import.meta.env.VITE_SOCKET_URL as string | undefined
    shared = createChat(configured || (import.meta.env.DEV ? `http://${location.hostname}:3000` : undefined))
  }
  return shared
}
