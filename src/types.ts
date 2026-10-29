/** A room you are in. Its code is what lets somebody else in. */
export interface Room {
  id: string
  name: string
  code: string
}

export interface Member {
  id: string
  nickname: string
}

/** What the server relays: a message, and who is in a room. */
export interface ServerMessage {
  id: string
  room: string
  from: Member
  text: string
  at: string
}

/** What the screen shows: a message, or a line like "Ada joined". */
export type Line =
  | { kind: 'message'; id: string; from: Member; text: string; at: string; mine: boolean }
  | { kind: 'event'; id: string; text: string; at: string }

/** Everything about a room the person is in. It lives in memory only: leaving the room forgets it. */
export interface JoinedRoom {
  room: Room
  lines: Line[]
  members: Member[]
  typing: string[]
}

export type Status = 'connecting' | 'online' | 'offline'
