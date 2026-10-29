// The rules of the chat, with no Socket.IO in sight so they can be tested on their own:
// who is online, which public rooms exist, who is in them, and what is allowed.
// Nothing here (or anywhere on the server) ever stores a message: the chat is live only.
import crypto from "node:crypto";

export const LIMITS = {
  nicknameMin: 2,
  nicknameMax: 20,
  roomNameMin: 2,
  roomNameMax: 30,
  textMax: 500,
  rooms: 50,
  membersPerRoom: 200,
  roomsPerUser: 10,
  burst: 5, // messages ...
  windowMs: 5000, // ... per this many milliseconds, per connection
};

const NICKNAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;

// Each cleaner returns { value } or { error }.
export function cleanNickname(raw) {
  if (typeof raw !== "string") return { error: "Choose a nickname." };
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length < LIMITS.nicknameMin || value.length > LIMITS.nicknameMax) {
    return { error: `A nickname has ${LIMITS.nicknameMin} to ${LIMITS.nicknameMax} characters.` };
  }
  if (!NICKNAME.test(value)) return { error: "A nickname can only contain letters, digits, spaces, dots, dashes and underscores." };
  return { value };
}

export function cleanRoomName(raw) {
  if (typeof raw !== "string") return { error: "Give the room a name." };
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length < LIMITS.roomNameMin || value.length > LIMITS.roomNameMax) {
    return { error: `A room name has ${LIMITS.roomNameMin} to ${LIMITS.roomNameMax} characters.` };
  }
  if (CONTROL.test(value)) return { error: "A room name cannot contain control characters." };
  return { value };
}

export function cleanText(raw) {
  if (typeof raw !== "string") return { error: "A message must be text." };
  const value = raw.replace(/\r\n/g, "\n").trim();
  if (value.length === 0) return { error: "A message cannot be empty." };
  if (value.length > LIMITS.textMax) return { error: `A message is limited to ${LIMITS.textMax} characters.` };
  return { value };
}

/** "Movie night!" -> "movie-night" (accents removed); falls back to random letters for names with no usable character. */
export function slugify(name) {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return slug || crypto.randomBytes(4).toString("hex");
}

/** At most `burst` events every `windowMs`; `now` can be replaced in tests. */
export class RateLimiter {
  constructor(burst = LIMITS.burst, windowMs = LIMITS.windowMs, now = Date.now) {
    this.burst = burst;
    this.windowMs = windowMs;
    this.now = now;
    this.times = [];
  }

  allow() {
    const now = this.now();
    while (this.times.length && now - this.times[0] >= this.windowMs) this.times.shift();
    if (this.times.length >= this.burst) return false;
    this.times.push(now);
    return true;
  }
}

export const DEFAULT_ROOMS = [
  ["general", "General"],
  ["random", "Random"],
  ["tech", "Tech talk"],
];

export class Registry {
  constructor() {
    this.users = new Map(); // connection id -> { id, nickname, rooms: Set<room id> }
    this.rooms = new Map(); // room id -> { id, name, permanent, members: Set<connection id> }
    for (const [id, name] of DEFAULT_ROOMS) this.rooms.set(id, { id, name, permanent: true, members: new Set() });
  }

  // ---- people
  register(connectionId, rawNickname) {
    const { value, error } = cleanNickname(rawNickname);
    if (error) return { error };
    if (this.users.has(connectionId)) return { error: "You already chose a nickname." };
    const taken = [...this.users.values()].some((u) => u.nickname.toLowerCase() === value.toLowerCase());
    if (taken) return { error: `"${value}" is already used by someone online. Pick another nickname.` };
    const user = { id: connectionId, nickname: value, rooms: new Set() };
    this.users.set(connectionId, user);
    return { user };
  }

  user(connectionId) {
    return this.users.get(connectionId);
  }

  /** Forgets a person and takes them out of every room. Returns what changed, so the server can tell the others. */
  unregister(connectionId) {
    const user = this.users.get(connectionId);
    if (!user) return { user: null, left: [] };
    const left = [...user.rooms].map((roomId) => this.leave(connectionId, roomId)).filter((r) => r.left);
    this.users.delete(connectionId);
    return { user, left };
  }

  // ---- rooms
  summary(room) {
    return { id: room.id, name: room.name, members: room.members.size, permanent: room.permanent };
  }

  list() {
    return [...this.rooms.values()].map((r) => this.summary(r)).sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
  }

  members(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.members]
      .map((id) => this.users.get(id))
      .filter(Boolean)
      .map((u) => ({ id: u.id, nickname: u.nickname }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
  }

  isIn(connectionId, roomId) {
    return this.rooms.get(roomId)?.members.has(connectionId) ?? false;
  }

  createRoom(rawName) {
    const { value, error } = cleanRoomName(rawName);
    if (error) return { error };
    if ([...this.rooms.values()].some((r) => r.name.toLowerCase() === value.toLowerCase())) return { error: "A room with this name already exists." };
    if (this.rooms.size >= LIMITS.rooms) return { error: "There are too many rooms right now. Join an existing one." };
    let id = slugify(value);
    for (let n = 2; this.rooms.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    const room = { id, name: value, permanent: false, members: new Set() };
    this.rooms.set(id, room);
    return { room: this.summary(room) };
  }

  /** A room created by somebody and left empty is removed (the default ones stay). */
  removeIfAbandoned(roomId) {
    const room = this.rooms.get(roomId);
    if (room && !room.permanent && room.members.size === 0) {
      this.rooms.delete(roomId);
      return true;
    }
    return false;
  }

  join(connectionId, roomId) {
    const user = this.users.get(connectionId);
    const room = this.rooms.get(String(roomId));
    if (!user) return { error: "Choose a nickname first." };
    if (!room) return { error: "This room no longer exists." };
    if (room.members.has(connectionId)) return { room: this.summary(room), already: true };
    if (room.members.size >= LIMITS.membersPerRoom) return { error: "This room is full." };
    if (user.rooms.size >= LIMITS.roomsPerUser) return { error: `You can be in ${LIMITS.roomsPerUser} rooms at a time.` };
    room.members.add(connectionId);
    user.rooms.add(room.id);
    return { room: this.summary(room), already: false };
  }

  leave(connectionId, roomId) {
    const user = this.users.get(connectionId);
    const room = this.rooms.get(String(roomId));
    if (!user || !room || !room.members.delete(connectionId)) return { left: false };
    user.rooms.delete(room.id);
    const removed = this.removeIfAbandoned(room.id);
    return { left: true, removed, roomId: room.id, nickname: user.nickname };
  }
}
