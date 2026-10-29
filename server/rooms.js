// The rules of the chat, with no Socket.IO in sight so they can be tested on their own:
// who is online, which rooms exist, who is in them, who runs them, and what is allowed.
// A room can only be entered with its code, and nothing here (or anywhere on the server) stores a message:
// the chat is live only. Every refusal comes with a stable `code` so that the page can show it in its own language.
import crypto from "node:crypto";

export const LIMITS = {
  nicknameMin: 2,
  nicknameMax: 20,
  roomNameMin: 2,
  roomNameMax: 30,
  textBodyMax: 6000, // a text message, encrypted by the page, is this long at most (500 characters + the encryption)
  mediaBodyMax: 450_000, // a photo or a voice message
  rooms: 200,
  membersPerRoom: 200,
  roomsPerUser: 10,
  burst: 5, // text messages ...
  windowMs: 5000, // ... per this many milliseconds, per connection
  mediaBurst: 3, // photos and voice messages ...
  mediaWindowMs: 10_000, // ... per this many milliseconds, per connection
  wrongCodes: 10, // wrong codes allowed ...
  wrongCodesWindowMs: 5 * 60 * 1000, // ... per this many milliseconds, per address
};

/** The reactions that exist. */
export const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

// Six characters out of 32 (no 0/O or 1/I, which are easy to mix up): about a billion codes.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

const NICKNAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A refusal: a sentence for people, a stable code for programs, and the numbers or names the sentence mentions. */
export const refusal = (code, error, params = {}) => ({ error, code, params });

// Each cleaner returns { value } or a refusal.
export function cleanNickname(raw) {
  if (typeof raw !== "string") return refusal("nickname_required", "Choose a nickname.");
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length < LIMITS.nicknameMin || value.length > LIMITS.nicknameMax) {
    return refusal("nickname_length", `A nickname has ${LIMITS.nicknameMin} to ${LIMITS.nicknameMax} characters.`, { min: LIMITS.nicknameMin, max: LIMITS.nicknameMax });
  }
  if (!NICKNAME.test(value)) return refusal("nickname_chars", "A nickname can only contain letters, digits, spaces, dots, dashes and underscores.");
  return { value };
}

export function cleanRoomName(raw) {
  if (typeof raw !== "string") return refusal("room_name_required", "Give the room a name.");
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length < LIMITS.roomNameMin || value.length > LIMITS.roomNameMax) {
    return refusal("room_name_length", `A room name has ${LIMITS.roomNameMin} to ${LIMITS.roomNameMax} characters.`, { min: LIMITS.roomNameMin, max: LIMITS.roomNameMax });
  }
  if (CONTROL.test(value)) return refusal("room_name_chars", "A room name cannot contain control characters.");
  return { value };
}

/**
 * What a message carries is encrypted by the page with a key the server never sees (see src/crypto.ts), so the server
 * cannot read it, only measure it. Short bodies are text and long ones are photos or voice messages; each kind has its own size limit and rate limit.
 */
export function classifyBody(raw, { textOnly = false } = {}) {
  if (typeof raw !== "string" || raw.length === 0) return refusal("body_required", "A message cannot be empty.");
  if (raw.length <= LIMITS.textBodyMax) return { kind: "text" };
  if (textOnly || raw.length > LIMITS.mediaBodyMax) return refusal("body_too_large", "That message is too big.");
  return { kind: "media" };
}

export const isMessageId = (raw) => typeof raw === "string" && UUID.test(raw);

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
 * It is what stops somebody from trying codes one after the other. (Its methods may be asynchronous: see redis.js.)
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

/**
 * Who is online and which rooms exist, in this process's memory. `redis.js` offers the same methods on top of Redis, so
 * that several servers can share the chat. Every method may be awaited.
 */
export class Registry {
  constructor(generate = generateCode) {
    this.generate = generate;
    this.users = new Map(); // connection id -> { id, nickname, rooms: Set<room id> }
    this.rooms = new Map(); // room id -> { id, name, code, members: Set<connection id>, ownerId, locked, known: Set<lowercase nickname>, banned: Set<lowercase nickname> }
    this.byCode = new Map(); // code -> room id
  }

  // ---- people
  register(connectionId, rawNickname) {
    const { value, error, code, params } = cleanNickname(rawNickname);
    if (error) return { error, code, params };
    if (this.users.has(connectionId)) return refusal("already_registered", "You already chose a nickname.");
    const taken = [...this.users.values()].some((u) => u.nickname.toLowerCase() === value.toLowerCase());
    if (taken) return refusal("nickname_taken", `"${value}" is already used by someone online. Pick another nickname.`, { nickname: value });
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
    return { id: room.id, name: room.name, code: room.code, members: room.members.size, locked: room.locked, ownerId: room.ownerId };
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
      .map((u) => ({ id: u.id, nickname: u.nickname, owner: u.id === room.ownerId }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
  }

  isIn(connectionId, roomId) {
    return this.rooms.get(roomId)?.members.has(connectionId) ?? false;
  }

  /** The person with this nickname in this room, if any. */
  findMember(roomId, nickname) {
    const wanted = String(nickname).toLowerCase();
    const room = this.rooms.get(roomId);
    for (const id of room?.members ?? []) {
      const user = this.users.get(id);
      if (user && user.nickname.toLowerCase() === wanted) return { id: user.id, nickname: user.nickname };
    }
    return null;
  }

  /** Creates a room and puts its creator in it, as its owner (a room nobody is in does not exist). Several rooms may share a name: the code tells them apart. */
  createRoom(connectionId, rawName) {
    const user = this.users.get(connectionId);
    if (!user) return refusal("nickname_required", "Choose a nickname first.");
    const { value, error, code: errorCode, params } = cleanRoomName(rawName);
    if (error) return { error, code: errorCode, params };
    if (this.rooms.size >= LIMITS.rooms) return refusal("too_many_rooms", "There are too many rooms right now. Try again later.");
    if (user.rooms.size >= LIMITS.roomsPerUser) return refusal("rooms_per_user", `You can be in ${LIMITS.roomsPerUser} rooms at a time.`, { max: LIMITS.roomsPerUser });
    let code = this.generate();
    for (let attempt = 0; this.byCode.has(code); attempt++) {
      if (attempt > 50) return refusal("code_unavailable", "Could not make a code. Try again.");
      code = this.generate();
    }
    const room = {
      id: crypto.randomBytes(6).toString("hex"),
      name: value,
      code,
      members: new Set([connectionId]),
      ownerId: connectionId,
      locked: false,
      known: new Set([user.nickname.toLowerCase()]),
      banned: new Set(),
    };
    this.rooms.set(room.id, room);
    this.byCode.set(code, room.id);
    user.rooms.add(room.id);
    return { room: this.summary(room) };
  }

  /** Gets a person into the room that has this code. `wrongCode` tells the server to count the failure. */
  joinWithCode(connectionId, rawCode) {
    const user = this.users.get(connectionId);
    if (!user) return refusal("nickname_required", "Choose a nickname first.");
    const code = normalizeCode(rawCode);
    if (!code) return { ...refusal("code_invalid", "That is not a room code. A code has 6 letters and digits."), wrongCode: true };
    const room = this.rooms.get(this.byCode.get(code));
    if (!room) return { ...refusal("code_unknown", "No room has this code. A room closes when everyone has left it."), wrongCode: true };
    if (room.members.has(connectionId)) return { room: this.summary(room), already: true };
    const nick = user.nickname.toLowerCase();
    if (room.banned.has(nick)) return refusal("banned", "You were removed from this room.");
    if (room.locked && !room.known.has(nick)) return refusal("locked", "This room is locked: nobody new can come in.");
    if (room.members.size >= LIMITS.membersPerRoom) return refusal("room_full", "This room is full.");
    if (user.rooms.size >= LIMITS.roomsPerUser) return refusal("rooms_per_user", `You can be in ${LIMITS.roomsPerUser} rooms at a time.`, { max: LIMITS.roomsPerUser });
    room.members.add(connectionId);
    room.known.add(nick);
    if (!room.ownerId || !this.users.has(room.ownerId)) room.ownerId = connectionId; // an empty room the owner left: whoever comes back runs it
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
    let newOwner = null;
    if (room.ownerId === connectionId) {
      // the owner left: the person who has been there longest takes over
      const nextId = [...room.members][0];
      room.ownerId = nextId ?? null;
      const next = nextId && this.users.get(nextId);
      if (next) newOwner = { id: next.id, nickname: next.nickname };
    }
    if (removed) this.#delete(room);
    return { left: true, removed, emptied, roomId: room.id, nickname: user.nickname, newOwner };
  }

  /** Closes a room that is still empty (after the grace period). Answers whether it did. */
  closeIfEmpty(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.members.size > 0) return false;
    this.#delete(room);
    return true;
  }

  // ---- what the owner can do
  #owned(connectionId, roomId) {
    const room = this.rooms.get(String(roomId));
    if (!room || !room.members.has(connectionId)) return refusal("not_member", "Join the room first.");
    if (room.ownerId !== connectionId) return refusal("not_owner", "Only the person who runs the room can do this.");
    return { room };
  }

  setLocked(connectionId, roomId, locked) {
    const { room, error, code, params } = this.#owned(connectionId, roomId);
    if (error) return { error, code, params };
    room.locked = locked === true;
    return { room: this.summary(room) };
  }

  /** Removes somebody from the room, who cannot come back with the code (until the room closes). */
  kick(connectionId, roomId, targetId) {
    const { room, error, code, params } = this.#owned(connectionId, roomId);
    if (error) return { error, code, params };
    if (targetId === connectionId) return refusal("cannot_kick_self", "You cannot remove yourself: leave the room instead.");
    const target = this.users.get(targetId);
    if (!target || !room.members.has(targetId)) return refusal("unknown_target", "This person is not in the room.");
    room.banned.add(target.nickname.toLowerCase());
    this.leave(targetId, room.id);
    return { target: { id: target.id, nickname: target.nickname }, room: this.summary(room) };
  }

  /** A new code for the room: the old one stops working. The people inside are told. */
  newCode(connectionId, roomId) {
    const { room, error, code: errorCode, params } = this.#owned(connectionId, roomId);
    if (error) return { error, code: errorCode, params };
    let code = this.generate();
    for (let attempt = 0; this.byCode.has(code); attempt++) {
      if (attempt > 50) return refusal("code_unavailable", "Could not make a code. Try again.");
      code = this.generate();
    }
    this.byCode.delete(room.code);
    room.code = code;
    this.byCode.set(code, room.id);
    return { room: this.summary(room) };
  }

  /** How many people and rooms there are (never their names). */
  stats() {
    return { online: this.users.size, rooms: this.rooms.size };
  }

  #delete(room) {
    this.rooms.delete(room.id);
    this.byCode.delete(room.code);
  }
}
