import type { Key } from './i18n'

/** A room you are in, as the server describes it. The server does not know its code: only a hash of it. */
export interface Room {
  id: string
  name: string
  members: number
  locked: boolean
  ownerId: string | null
  /** goes up with every change of the room: of two descriptions, the one with the higher number is the newer */
  rev: number
}

export interface Member {
  id: string
  nickname: string
  owner?: boolean
}

export type MessageKind = 'text' | 'image' | 'audio'

/** A message as the page shows it, once decrypted and checked. */
export interface Msg {
  id: string
  from: Member
  at: string
  mine: boolean
  kind: MessageKind
  text: string // the text, or the caption of a photo
  src?: string // a photo or a voice message, as a data URL
  w?: number
  h?: number
  ms?: number // length of a voice message
  wave?: number[] // its loudness bars, 0 to 100
  replyTo: string | null
  edited: boolean
  deleted: boolean
  unreadable: boolean
  reactions: Record<string, string[]> // emoji -> nicknames
  proof?: string // lets the author edit or delete (only on your own messages)
  whisperTo?: string // nickname of the only person who got it
}

/** What the screen shows: a message, or a notice like "Ada joined" (kept as a key so it follows the language). */
export type Line = { kind: 'message'; msg: Msg } | { kind: 'event'; id: string; at: string; key: Key; params: Record<string, string> }

/** Everything about a room the person is in. It lives in memory only: leaving the room forgets it. */
export interface JoinedRoom {
  room: Room
  /** the code of the room, as the people in it know it: it lets somebody else in */
  code: string
  lines: Line[]
  members: Member[]
  typing: string[]
  unread: number
  mentioned: boolean
  muted: string[] // lowercase nicknames whose messages you chose to hide
}

export type Status = 'connecting' | 'online' | 'offline'
