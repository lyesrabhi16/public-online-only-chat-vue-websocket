// The rules of the chat, with no Socket.IO in sight so they can be tested on their own:
// who is online, which rooms exist, who is in them, and what is allowed.
// A room can only be entered with its code, and nothing here (or anywhere on the server) stores a message:
// the chat is live only.
import crypto from "node:crypto";

export const LIMITS = {
  nicknameMin: 2,
  nicknameMax: 20,
  roomNameMin: 2,
  roomNameMax: 30,
  textMax: 500,
  rooms: 200,
  membersPerRoom: 200,
  roomsPerUser: 10,
  burst: 5, // messages ...
  windowMs: 5000, // ... per this many milliseconds, per connection
  wrongCodes: 10, // wrong codes allowed ...
  wrongCodesWindowMs: 5 * 60 * 1000, // ... per this many milliseconds, per address
};

// Six characters out of 32 (no 0/O or 1/I, which are easy to mix up): about a billion codes.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

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

/** What somebody typed ("k7m-2qx", " K7M2QX ") as a code, or null when it cannot be one. */
export function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\s_-]+/g, "").toUpperCase();
  return value.length === CODE_LENGTH && [...value].every((c) => CODE_ALPHABET.includes(c)) ? value : null;
}

/** A random code. `pick` (a function from n to a number below n) can be replaced in tests. */
export function generateCode(pick = (n) => crypto.randomInt(n)) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return code;
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

/**
 * Counts the failures of each key (an address) and says when it has had too many for now.
 * It is what stops somebody from trying codes one after the other.
 */
export class FailureLimiter {
  constructor(max = LIMITS.wrongCodes, windowMs = LIMITS.wrongCodesWindowMs, now = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.failures = new Map(); // key -> timestamps
  }

  #recent(key) {
    const now = this.now();
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length) this.failures.set(key, recent);
    else this.failures.delete(key);
    return recent;
  }

  blocked(key) {
    return this.#recent(key).length >= this.max;
  }

  fail(key) {
    const recent = this.#recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }
}

export class Registry {
  constructor(generate = generateCode) {
    this.generate = generate;
    this.users = new Map(); // connection id -> { id, nickname, rooms: Set<room id> }
    this.rooms = new Map(); // room id -> { id, name, code, members: Set<connection id> }
    this.byCode = new Map(); // code -> room id
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

  /**
   * Forgets a person (who disconnected) and takes them out of every room. A room they were alone in stays open for a
   * moment (see closeIfEmpty): a connection that blips must not cost them their room and its code.
   */
  unregister(connectionId) {
    const user = this.users.get(connectionId);
    if (!user) return { user: null, left: [] };
    const left = [...user.rooms].map((roomId) => this.leave(connectionId, roomId, { keepOpen: true })).filter((r) => r.left);
    this.users.delete(connectionId);
    return { user, left };
  }

  // ---- rooms
  summary(room) {
    return { id: room.id, name: room.name, code: room.code, members: room.members.size };
  }

  /** The rooms a person is in. There is no list of all the rooms: you can only get into one with its code. */
  roomsOf(connectionId) {
    const user = this.users.get(connectionId);
    return user ? [...user.rooms].map((id) => this.summary(this.rooms.get(id))) : [];
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

  /** Creates a room and puts its creator in it (a room nobody is in does not exist). Several rooms may share a name: the code tells them apart. */
  createRoom(connectionId, rawName) {
    const user = this.users.get(connectionId);
    if (!user) return { error: "Choose a nickname first." };
    const { value, error } = cleanRoomName(rawName);
    if (error) return { error };
    if (this.rooms.size >= LIMITS.rooms) return { error: "There are too many rooms right now. Try again later." };
    if (user.rooms.size >= LIMITS.roomsPerUser) return { error: `You can be in ${LIMITS.roomsPerUser} rooms at a time.` };
    let code = this.generate();
    for (let attempt = 0; this.byCode.has(code); attempt++) {
      if (attempt > 50) return { error: "Could not make a code. Try again." };
      code = this.generate();
    }
    const room = { id: crypto.randomBytes(6).toString("hex"), name: value, code, members: new Set([connectionId]) };
    this.rooms.set(room.id, room);
    this.byCode.set(code, room.id);
    user.rooms.add(room.id);
    return { room: this.summary(room) };
  }

  /** Gets a person into the room that has this code. `wrongCode` tells the server to count the failure. */
  joinWithCode(connectionId, rawCode) {
    const user = this.users.get(connectionId);
    if (!user) return { error: "Choose a nickname first." };
    const code = normalizeCode(rawCode);
    if (!code) return { error: "That is not a room code. A code has 6 letters and digits.", wrongCode: true };
    const room = this.rooms.get(this.byCode.get(code));
    if (!room) return { error: "No room has this code. A room closes when everyone has left it.", wrongCode: true };
    if (room.members.has(connectionId)) return { room: this.summary(room), already: true };
    if (room.members.size >= LIMITS.membersPerRoom) return { error: "This room is full." };
    if (user.rooms.size >= LIMITS.roomsPerUser) return { error: `You can be in ${LIMITS.roomsPerUser} rooms at a time.` };
    room.members.add(connectionId);
    user.rooms.add(room.id);
    return { room: this.summary(room), already: false };
  }

  /** Takes a person out of a room. The last one out closes it, and its code stops working (unless keepOpen: see unregister). */
  leave(connectionId, roomId, { keepOpen = false } = {}) {
    const user = this.users.get(connectionId);
    const room = this.rooms.get(String(roomId));
    if (!user || !room || !room.members.delete(connectionId)) return { left: false };
    user.rooms.delete(room.id);
    const emptied = room.members.size === 0;
    const removed = emptied && !keepOpen;
    if (removed) this.#delete(room);
    return { left: true, removed, emptied, roomId: room.id, nickname: user.nickname };
  }

  /** Closes a room that is still empty (after the grace period). Answers whether it did. */
  closeIfEmpty(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.members.size > 0) return false;
    this.#delete(room);
    return true;
  }

  #delete(room) {
    this.rooms.delete(room.id);
    this.byCode.delete(room.code);
  }
}
