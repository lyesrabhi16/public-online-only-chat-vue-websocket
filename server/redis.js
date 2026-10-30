// The same chat state as Registry (rooms.js), kept in Redis, so that several servers can run side by side behind a load balancer:
// who is online, which rooms exist, who is in them and who runs them. Every change that must not be interrupted (taking a nickname,
// entering a room that has one place left, closing a room when its last person leaves) is a Lua script, which Redis runs as one step.
//
// Messages are still never stored: Redis only holds the rooms, who is in them and counters. What people say travels through
// the Socket.IO Redis adapter (pub/sub) and is gone as soon as it is delivered.
//
// A server that dies without saying goodbye would leave its people "online" for ever. Each server therefore refreshes a heartbeat
// key that expires; the survivors notice a missing heartbeat and remove that server's people (reapDead).
import crypto from "node:crypto";
import { Redis } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { LIMITS, cleanNickname, cleanRoomName, generateCode, normalizeCode, refusal } from "./rooms.js";

const GRACE_MS = 70_000; // an emptied room stays a little longer than the server's own 60 s timer, which closes it
const HEARTBEAT_MS = 5000;
const HEARTBEAT_TTL_S = 15;

// ---- the Lua shared by the scripts
const PRELUDE = `
local p = ARGV[1]
local function k(a, b) return p .. a .. ':' .. b end
local function str(v) if v == false or v == nil then return '' end return v end

local function summary(rid)
  local r = redis.call('HGETALL', k('r', rid))
  if #r == 0 then return nil end
  local h = {}
  for i = 1, #r, 2 do h[r[i]] = r[i + 1] end
  return { id = rid, name = h.name, code = h.code, members = redis.call('ZCARD', k('m', rid)), locked = h.locked == '1', ownerId = h.owner ~= '' and h.owner or cjson.null, rev = tonumber(h.rev or '0') }
end

local function drop(rid)
  local code = redis.call('HGET', k('r', rid), 'code')
  if code then redis.call('DEL', k('c', code)) end
  redis.call('DEL', k('r', rid), k('m', rid), k('known', rid), k('ban', rid))
  redis.call('SREM', k('rooms', ''), rid)
end

local function persist(rid)
  local code = redis.call('HGET', k('r', rid), 'code')
  redis.call('PERSIST', k('r', rid))
  redis.call('PERSIST', k('known', rid))
  redis.call('PERSIST', k('ban', rid))
  if code then redis.call('PERSIST', k('c', code)) end
end

local function leave(conn, rid, keep, grace)
  if redis.call('ZREM', k('m', rid), conn) == 0 then return { left = false } end
  redis.call('SREM', k('ur', conn), rid)
  local nick = str(redis.call('HGET', k('u', conn), 'nick'))
  local newOwner = cjson.null
  if redis.call('HGET', k('r', rid), 'owner') == conn then
    local nxt = redis.call('ZRANGE', k('m', rid), 0, 0)[1]
    redis.call('HSET', k('r', rid), 'owner', nxt or '')
    if nxt then newOwner = { id = nxt, nickname = str(redis.call('HGET', k('u', nxt), 'nick')) } end
  end
  redis.call('HINCRBY', k('r', rid), 'rev', 1)
  local emptied = redis.call('ZCARD', k('m', rid)) == 0
  local removed = false
  if emptied then
    if keep then
      local code = redis.call('HGET', k('r', rid), 'code')
      redis.call('PEXPIRE', k('r', rid), grace)
      redis.call('PEXPIRE', k('known', rid), grace)
      redis.call('PEXPIRE', k('ban', rid), grace)
      if code then redis.call('PEXPIRE', k('c', code), grace) end
    else
      drop(rid)
      removed = true
    end
  end
  return { left = true, removed = removed, emptied = emptied, roomId = rid, nickname = nick, newOwner = newOwner }
end
`;

const SCRIPTS = {
  register: `${PRELUDE}
    local conn, nick, lower, inst = ARGV[2], ARGV[3], ARGV[4], ARGV[5]
    if redis.call('EXISTS', k('u', conn)) == 1 then return cjson.encode({ err = 'already_registered' }) end
    if not redis.call('SET', k('n', lower), conn, 'NX') then return cjson.encode({ err = 'nickname_taken' }) end
    redis.call('HSET', k('u', conn), 'nick', nick, 'lower', lower, 'inst', inst)
    redis.call('SADD', k('iu', inst), conn)
    redis.call('SADD', k('users', ''), conn)
    return cjson.encode({ ok = true })`,

  unregister: `${PRELUDE}
    local conn, inst, grace = ARGV[2], ARGV[3], tonumber(ARGV[4])
    local nick = redis.call('HGET', k('u', conn), 'nick')
    if not nick then return cjson.encode({ none = true }) end
    local left = {}
    for _, rid in ipairs(redis.call('SMEMBERS', k('ur', conn))) do
      local r = leave(conn, rid, true, grace)
      if r.left then left[#left + 1] = r end
    end
    redis.call('DEL', k('n', str(redis.call('HGET', k('u', conn), 'lower'))), k('u', conn), k('ur', conn))
    redis.call('SREM', k('iu', inst), conn)
    redis.call('SREM', k('users', ''), conn)
    return cjson.encode({ user = { id = conn, nickname = nick }, left = left })`,

  createRoom: `${PRELUDE}
    local conn, name, code, rid, maxRooms, maxPerUser = ARGV[2], ARGV[3], ARGV[4], ARGV[5], tonumber(ARGV[6]), tonumber(ARGV[7])
    local nick = redis.call('HGET', k('u', conn), 'lower')
    if not nick then return cjson.encode({ err = 'nickname_required' }) end
    if redis.call('SCARD', k('rooms', '')) >= maxRooms then
      for _, id in ipairs(redis.call('SMEMBERS', k('rooms', ''))) do   -- rooms whose grace period is over are gone: forget them
        if redis.call('EXISTS', k('r', id)) == 0 then redis.call('SREM', k('rooms', ''), id) end
      end
      if redis.call('SCARD', k('rooms', '')) >= maxRooms then return cjson.encode({ err = 'too_many_rooms' }) end
    end
    if redis.call('SCARD', k('ur', conn)) >= maxPerUser then return cjson.encode({ err = 'rooms_per_user' }) end
    if not redis.call('SET', k('c', code), rid, 'NX') then return cjson.encode({ err = 'code_collision' }) end
    redis.call('HSET', k('r', rid), 'name', name, 'code', code, 'owner', conn, 'locked', '0', 'rev', '1')
    redis.call('ZADD', k('m', rid), redis.call('INCR', k('seq', '')), conn)
    redis.call('SADD', k('known', rid), nick)
    redis.call('SADD', k('rooms', ''), rid)
    redis.call('SADD', k('ur', conn), rid)
    return cjson.encode({ room = summary(rid) })`,

  join: `${PRELUDE}
    local conn, code, maxMembers, maxPerUser = ARGV[2], ARGV[3], tonumber(ARGV[4]), tonumber(ARGV[5])
    local lower = redis.call('HGET', k('u', conn), 'lower')
    if not lower then return cjson.encode({ err = 'nickname_required' }) end
    local rid = redis.call('GET', k('c', code))
    if not rid then return cjson.encode({ err = 'code_unknown', wrong = true }) end
    if redis.call('ZSCORE', k('m', rid), conn) then return cjson.encode({ room = summary(rid), already = true }) end
    if redis.call('SISMEMBER', k('ban', rid), lower) == 1 then return cjson.encode({ err = 'banned' }) end
    if redis.call('HGET', k('r', rid), 'locked') == '1' and redis.call('SISMEMBER', k('known', rid), lower) == 0 then return cjson.encode({ err = 'locked' }) end
    if redis.call('ZCARD', k('m', rid)) >= maxMembers then return cjson.encode({ err = 'room_full' }) end
    if redis.call('SCARD', k('ur', conn)) >= maxPerUser then return cjson.encode({ err = 'rooms_per_user' }) end
    persist(rid)
    redis.call('ZADD', k('m', rid), redis.call('INCR', k('seq', '')), conn)
    redis.call('SADD', k('known', rid), lower)
    redis.call('SADD', k('ur', conn), rid)
    local owner = str(redis.call('HGET', k('r', rid), 'owner'))
    if owner == '' or not redis.call('ZSCORE', k('m', rid), owner) then redis.call('HSET', k('r', rid), 'owner', conn) end
    redis.call('HINCRBY', k('r', rid), 'rev', 1)
    return cjson.encode({ room = summary(rid), already = false })`,

  leave: `${PRELUDE}
    return cjson.encode(leave(ARGV[2], ARGV[3], ARGV[4] == '1', tonumber(ARGV[5])))`,

  closeIfEmpty: `${PRELUDE}
    local rid = ARGV[2]
    if redis.call('EXISTS', k('r', rid)) == 1 and redis.call('ZCARD', k('m', rid)) == 0 then drop(rid) return 1 end
    return 0`,

  setLocked: `${PRELUDE}
    local conn, rid, locked = ARGV[2], ARGV[3], ARGV[4]
    if not redis.call('ZSCORE', k('m', rid), conn) then return cjson.encode({ err = 'not_member' }) end
    if redis.call('HGET', k('r', rid), 'owner') ~= conn then return cjson.encode({ err = 'not_owner' }) end
    redis.call('HSET', k('r', rid), 'locked', locked)
    redis.call('HINCRBY', k('r', rid), 'rev', 1)
    return cjson.encode({ room = summary(rid) })`,

  kick: `${PRELUDE}
    local conn, rid, target = ARGV[2], ARGV[3], ARGV[4]
    if not redis.call('ZSCORE', k('m', rid), conn) then return cjson.encode({ err = 'not_member' }) end
    if redis.call('HGET', k('r', rid), 'owner') ~= conn then return cjson.encode({ err = 'not_owner' }) end
    if target == conn then return cjson.encode({ err = 'cannot_kick_self' }) end
    if not redis.call('ZSCORE', k('m', rid), target) then return cjson.encode({ err = 'unknown_target' }) end
    local nick = str(redis.call('HGET', k('u', target), 'nick'))
    redis.call('SADD', k('ban', rid), str(redis.call('HGET', k('u', target), 'lower')))
    leave(target, rid, false, 0)
    return cjson.encode({ target = { id = target, nickname = nick }, room = summary(rid) })`,

  newCode: `${PRELUDE}
    local conn, rid, code = ARGV[2], ARGV[3], ARGV[4]
    if not redis.call('ZSCORE', k('m', rid), conn) then return cjson.encode({ err = 'not_member' }) end
    if redis.call('HGET', k('r', rid), 'owner') ~= conn then return cjson.encode({ err = 'not_owner' }) end
    if not redis.call('SET', k('c', code), rid, 'NX') then return cjson.encode({ err = 'code_collision' }) end
    redis.call('DEL', k('c', redis.call('HGET', k('r', rid), 'code')))
    redis.call('HSET', k('r', rid), 'code', code)
    redis.call('HINCRBY', k('r', rid), 'rev', 1)
    return cjson.encode({ room = summary(rid) })`,

  // a counter of wrong codes per address, with an expiry
  fail: `local key, window = ARGV[1], tonumber(ARGV[2])
    local n = redis.call('INCR', key)
    if n == 1 then redis.call('PEXPIRE', key, window) end
    return n`,
};

/** A list that came out of Lua: an empty one arrives as {} (Lua cannot tell an empty list from an empty object). */
const list = (value) => (Array.isArray(value) ? value : []);

const fix = (result) => {
  if (result.err) {
    const params = result.err === "rooms_per_user" ? { max: LIMITS.roomsPerUser } : {};
    return { ...refusal(result.err, undefined, params), ...(result.wrong ? { wrongCode: true } : {}) };
  }
  return result;
};

/** The same methods as Registry (rooms.js), on Redis. Every one of them is asynchronous. */
export class RedisRegistry {
  /** `prefix` separates this chat from anything else in the same Redis (and tests from each other). */
  constructor(redis, { instanceId = crypto.randomUUID().slice(0, 8), prefix = "chat:", generate = generateCode } = {}) {
    this.redis = redis;
    this.instanceId = instanceId;
    this.prefix = prefix;
    this.generate = generate;
    for (const [name, lua] of Object.entries(SCRIPTS)) {
      if (!redis[`chat_${name}`]) redis.defineCommand(`chat_${name}`, { numberOfKeys: 0, lua });
    }
  }

  #key = (a, b = "") => `${this.prefix}${a}:${b}`;

  async #run(name, ...args) {
    return JSON.parse(await this.redis[`chat_${name}`](this.prefix, ...args));
  }

  // ---- people
  async register(connectionId, rawNickname) {
    const { value, error, code, params } = cleanNickname(rawNickname);
    if (error) return { error, code, params };
    const result = fix(await this.#run("register", connectionId, value, value.toLowerCase(), this.instanceId));
    if (result.code === "nickname_taken") return { ...result, ...refusal("nickname_taken", undefined, { nickname: value }) };
    return result.ok ? { user: { id: connectionId, nickname: value, rooms: new Set() } } : result;
  }

  async user(connectionId) {
    const nick = await this.redis.hget(this.#key("u", connectionId), "nick");
    return nick ? { id: connectionId, nickname: nick } : undefined;
  }

  async unregister(connectionId) {
    const result = await this.#run("unregister", connectionId, this.instanceId, GRACE_MS);
    return result.none ? { user: null, left: [] } : { user: result.user, left: list(result.left) };
  }

  // ---- rooms
  async roomSummary(roomId) {
    const room = await this.redis.hgetall(this.#key("r", roomId));
    if (!room.name) return null;
    return {
      id: roomId,
      name: room.name,
      code: room.code,
      members: await this.redis.zcard(this.#key("m", roomId)),
      locked: room.locked === "1",
      ownerId: room.owner || null,
      rev: Number(room.rev ?? 0),
    };
  }

  async roomsOf(connectionId) {
    const ids = await this.redis.smembers(this.#key("ur", connectionId));
    return (await Promise.all(ids.map((id) => this.roomSummary(id)))).filter(Boolean);
  }

  async members(roomId) {
    const ids = await this.redis.zrange(this.#key("m", roomId), 0, -1);
    if (ids.length === 0) return [];
    const owner = await this.redis.hget(this.#key("r", roomId), "owner");
    const nicknames = await Promise.all(ids.map((id) => this.redis.hget(this.#key("u", id), "nick")));
    return ids
      .map((id, i) => ({ id, nickname: nicknames[i], owner: id === owner }))
      .filter((m) => m.nickname)
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
  }

  async isIn(connectionId, roomId) {
    return (await this.redis.zscore(this.#key("m", String(roomId)), connectionId)) !== null;
  }

  async findMember(roomId, nickname) {
    const wanted = String(nickname).toLowerCase();
    const found = (await this.members(roomId)).find((m) => m.nickname.toLowerCase() === wanted);
    return found ? { id: found.id, nickname: found.nickname } : null;
  }

  async createRoom(connectionId, rawName) {
    const { value, error, code: errorCode, params } = cleanRoomName(rawName);
    if (error) return { error, code: errorCode, params };
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = fix(
        await this.#run("createRoom", connectionId, value, this.generate(), crypto.randomBytes(6).toString("hex"), LIMITS.rooms, LIMITS.roomsPerUser),
      );
      if (result.code !== "code_collision") return result;
    }
    return refusal("code_unavailable");
  }

  async joinWithCode(connectionId, rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) {
      if (!(await this.user(connectionId))) return refusal("nickname_required");
      return { ...refusal("code_invalid", "That is not a room code. A code has 6 letters and digits."), wrongCode: true };
    }
    return fix(await this.#run("join", connectionId, code, LIMITS.membersPerRoom, LIMITS.roomsPerUser));
  }

  async leave(connectionId, roomId, { keepOpen = false } = {}) {
    return this.#run("leave", connectionId, String(roomId), keepOpen ? "1" : "0", GRACE_MS);
  }

  async closeIfEmpty(roomId) {
    return (await this.#run("closeIfEmpty", roomId)) === 1;
  }

  // ---- what the owner can do
  async setLocked(connectionId, roomId, locked) {
    return fix(await this.#run("setLocked", connectionId, String(roomId), locked === true ? "1" : "0"));
  }

  async kick(connectionId, roomId, targetId) {
    return fix(await this.#run("kick", connectionId, String(roomId), String(targetId)));
  }

  async newCode(connectionId, roomId) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = fix(await this.#run("newCode", connectionId, String(roomId), this.generate()));
      if (result.code !== "code_collision") return result;
    }
    return refusal("code_unavailable");
  }

  async stats() {
    return { online: await this.redis.scard(this.#key("users")), rooms: await this.redis.scard(this.#key("rooms")) };
  }

  // ---- surviving a server that dies
  /** Says "this server is alive" (the key expires if nobody says it again). */
  async heartbeat(ttlSeconds = HEARTBEAT_TTL_S) {
    await this.redis.set(this.#key("inst", this.instanceId), "1", "EX", ttlSeconds);
    await this.redis.sadd(this.#key("insts"), this.instanceId);
  }

  /**
   * Removes the people of every server that stopped saying it is alive. Answers what was removed (as unregister does), so that
   * the caller can tell the rooms. Two servers noticing the same death at the same time are kept apart by a short lock.
   */
  async reapDead() {
    const reaped = [];
    for (const other of await this.redis.smembers(this.#key("insts"))) {
      if (other === this.instanceId || (await this.redis.exists(this.#key("inst", other)))) continue;
      if (!(await this.redis.set(this.#key("lock", other), this.instanceId, "EX", 30, "NX"))) continue;
      for (const conn of await this.redis.smembers(this.#key("iu", other))) {
        const result = await this.#run("unregister", conn, other, GRACE_MS);
        if (!result.none) reaped.push({ user: result.user, left: list(result.left) });
      }
      await this.redis.srem(this.#key("insts"), other);
      await this.redis.del(this.#key("iu", other), this.#key("lock", other));
    }
    return reaped;
  }

  /**
   * A clean shutdown: the heartbeat is withdrawn at once, so the other servers clean up anything left of the people of this one
   * right away, instead of waiting for the heartbeat to expire.
   */
  async goodbye() {
    await this.redis.del(this.#key("inst", this.instanceId));
  }

  /** Test helper: deletes everything under this prefix. */
  async flush() {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length) await this.redis.del(...keys);
  }
}

/** The wrong-code counter, shared by every server: the same address cannot try its guesses on each of them in turn. */
export class RedisFailureLimiter {
  constructor(redis, { prefix = "chat:", max = LIMITS.wrongCodes, windowMs = LIMITS.wrongCodesWindowMs } = {}) {
    this.redis = redis;
    this.prefix = prefix;
    this.max = max;
    this.windowMs = windowMs;
    if (!redis.chat_fail) redis.defineCommand("chat_fail", { numberOfKeys: 0, lua: SCRIPTS.fail });
  }

  async blocked(address) {
    return Number((await this.redis.get(`${this.prefix}wc:${address}`)) ?? 0) >= this.max;
  }

  async fail(address) {
    await this.redis.chat_fail(`${this.prefix}wc:${address}`, this.windowMs);
  }
}

/**
 * Everything a server needs to join a cluster: the registry, the wrong-code counter, the adapter that carries messages between
 * servers, the secret that makes the proofs of one server valid on the others, and a heartbeat with a janitor.
 */
export function createRedisBackend({ url, instanceId = crypto.randomUUID().slice(0, 8), prefix = "chat:", heartbeatMs = HEARTBEAT_MS, ttlSeconds = HEARTBEAT_TTL_S } = {}) {
  const redis = new Redis(url);
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  const registry = new RedisRegistry(redis, { instanceId, prefix });
  const wrongCodes = new RedisFailureLimiter(redis, { prefix });
  let timer;
  return {
    redis,
    registry,
    wrongCodes,
    instanceId,
    /** Connects the Socket.IO server to the others through Redis. */
    attach: (io) => io.adapter(createAdapter(pub, sub)),
    /** One secret for all servers, made by whichever starts first (so nobody has to configure it). */
    async sharedSecret() {
      await redis.set(`${prefix}secret`, crypto.randomBytes(32).toString("hex"), "NX");
      return redis.get(`${prefix}secret`);
    },
    /** Starts the heartbeat, and the janitor that cleans up after servers that died; `onReaped` tells the rooms about the people removed. */
    start(onReaped) {
      const beat = async () => {
        try {
          await registry.heartbeat(ttlSeconds);
          const reaped = await registry.reapDead();
          if (reaped.length) await onReaped(reaped);
        } catch (e) {
          console.error("heartbeat failed:", e.message);
        }
      };
      void beat();
      timer = setInterval(beat, heartbeatMs);
      timer.unref();
    },
    async close() {
      clearInterval(timer);
      await registry.goodbye().catch(() => {});
      await Promise.allSettled([redis.quit(), pub.quit(), sub.quit()]);
    },
  };
}
