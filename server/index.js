// The Socket.IO server. A room is entered with its code. It relays messages between the people in a room and keeps no history at all:
// a person who joins late (or reconnects) sees nothing of what was said before.
// What people write is encrypted by their pages with a key made from the room code, so this server relays it and measures it (it does see the room code, from which the key is made: see README, "Encryption").
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server } from "socket.io";
import { createProofs } from "./proof.js";
import { EMOJIS, FailureLimiter, LIMITS, RateLimiter, Registry, classifyBody, isMessageId, refusal } from "./rooms.js";

const GRACE_MS = 60_000; // how long a room stays open after its last person was disconnected

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

/** Serves the built client (the `dist` folder) with a fallback to index.html, and a /health check. */
function requestListener(health, staticDir) {
  const root = staticDir && fs.existsSync(staticDir) ? path.resolve(staticDir) : null;
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await health()));
      return;
    }
    if (!root || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) file = path.join(root, "index.html"); // never leave the folder
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      // the service worker must be able to take over the whole site
      ...(path.basename(file) === "sw.js" ? { "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" } : {}),
    });
    fs.createReadStream(file).pipe(res);
  };
}

/**
 * `corsOrigin`: "*" or a comma-separated list of the web pages allowed to connect (the Vite dev server by default).
 * `trustProxy`: read the visitor's address from X-Forwarded-For, for a server behind a proxy that sets that header itself (see deploy/nginx.conf).
 * Never turn it on for a server that people reach directly: they could write any address they like.
 * `registry` and `wrongCodes` can be replaced by the Redis versions, and `attach(io)` adds the Socket.IO Redis adapter, so that several servers share the chat.
 */
export function createChatServer({
  corsOrigin = "http://localhost:5173,http://127.0.0.1:5173",
  staticDir,
  registry = new Registry(),
  wrongCodes = new FailureLimiter(), // by address: stops anybody from trying codes one after the other
  proofs = createProofs(),
  attach,
  instanceId = crypto.randomUUID().slice(0, 8),
  trustProxy = false,
} = {}) {
  const server = http.createServer(requestListener(async () => ({ status: "ok", instance: instanceId, ...(await registry.stats()) }), staticDir));
  const origins = corsOrigin === "*" ? "*" : corsOrigin.split(",").map((o) => o.trim());
  // a photo or a voice message is the biggest thing a person can send; anything over that is dropped before it is read
  const io = new Server(server, { cors: { origin: origins }, maxHttpBufferSize: LIMITS.mediaBodyMax + 20_000 });
  if (attach) attach(io);

  const key = (roomId) => `room:${roomId}`;
  const reply = (ack, body) => typeof ack === "function" && ack(body);
  const refuse = (ack, r) => reply(ack, { error: r.error, code: r.code, params: r.params });
  const payload = (raw) => (raw !== null && typeof raw === "object" ? raw : {});
  const joinFirst = refusal("not_member", "Join the room first.");

  const announceMembers = async (roomId) => io.to(key(roomId)).emit("room:members", { room: roomId, members: await registry.members(roomId) });
  const announceEvent = (roomId, kind, nickname) => io.to(key(roomId)).emit("room:event", { room: roomId, kind, nickname, at: new Date().toISOString() });
  const announceRoom = (room) => room && io.to(key(room.id)).emit("room:updated", { room });

  /** Tells the rooms that somebody is gone (they disconnected, or their server died). */
  const afterLeaving = async (user, left) => {
    for (const r of left) {
      if (!r.emptied) {
        announceEvent(r.roomId, "leave", user.nickname);
        await announceMembers(r.roomId);
        if (r.newOwner) {
          announceEvent(r.roomId, "owner", r.newOwner.nickname);
          announceRoom(await registry.roomSummary(r.roomId));
        }
      } else {
        // alone in it and gone: the room (and its code) stays open for a minute, in case it was only the connection
        setTimeout(() => registry.closeIfEmpty(r.roomId), GRACE_MS).unref();
      }
    }
  };

  io.on("connection", (socket) => {
    const texts = new RateLimiter();
    const media = new RateLimiter(LIMITS.mediaBurst, LIMITS.mediaWindowMs);
    const small = new RateLimiter(20, 5000); // typing, reactions

    const leaveRoom = async (roomId) => {
      const result = await registry.leave(socket.id, roomId);
      if (!result.left) return false;
      socket.leave(key(roomId));
      if (!result.removed) {
        announceEvent(roomId, "leave", result.nickname);
        await announceMembers(roomId);
        if (result.newOwner) {
          announceEvent(roomId, "owner", result.newOwner.nickname);
          announceRoom(await registry.roomSummary(roomId));
        }
      }
      return true;
    };

    /** The person and the room, when this connection is in that room. */
    const inRoom = async (roomId) => {
      const user = await registry.user(socket.id);
      return user && (await registry.isIn(socket.id, String(roomId))) ? user : null;
    };

    socket.on("hello", async (data, ack) => {
      const { user, error, code, params } = await registry.register(socket.id, payload(data).nickname);
      if (error) return refuse(ack, { error, code, params });
      reply(ack, { ok: true, user: { id: user.id, nickname: user.nickname }, instance: instanceId });
    });

    // A new room: its creator is inside it and runs it, and gets its code, to share with whoever should come in.
    socket.on("room:create", async (data, ack) => {
      const { room, error, code, params } = await registry.createRoom(socket.id, payload(data).name);
      if (error) return refuse(ack, { error, code, params });
      socket.join(key(room.id));
      reply(ack, { ok: true, room, members: await registry.members(room.id) });
    });

    // The only way into a room: its code.
    socket.on("room:join", async (data, ack) => {
      if (!(await registry.user(socket.id))) return refuse(ack, refusal("nickname_required", "Choose a nickname first."));
      const address = (trustProxy && String(socket.handshake.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || socket.handshake.address;
      if (await wrongCodes.blocked(address)) return refuse(ack, refusal("too_many_wrong_codes", "Too many wrong codes. Wait a few minutes before trying again."));
      const { room, error, code, params, already, wrongCode } = await registry.joinWithCode(socket.id, payload(data).code);
      if (wrongCode) await wrongCodes.fail(address);
      if (error) return refuse(ack, { error, code, params });
      socket.join(key(room.id));
      reply(ack, { ok: true, room, members: await registry.members(room.id) });
      if (!already) {
        announceEvent(room.id, "join", (await registry.user(socket.id)).nickname);
        await announceMembers(room.id);
        announceRoom(await registry.roomSummary(room.id)); // what the room is now (the head count, who runs it), not what it was a moment ago
      }
    });

    socket.on("room:leave", async (data, ack) => {
      await leaveRoom(String(payload(data).room));
      reply(ack, { ok: true });
    });

    // ---- what the owner can do
    socket.on("room:lock", async (data, ack) => {
      const { room, locked } = payload(data);
      const result = await registry.setLocked(socket.id, String(room), locked === true);
      if (result.error) return refuse(ack, result);
      announceRoom(result.room);
      reply(ack, { ok: true, room: result.room });
    });

    socket.on("room:kick", async (data, ack) => {
      const { room, id } = payload(data);
      const result = await registry.kick(socket.id, String(room), String(id));
      if (result.error) return refuse(ack, result);
      io.to(result.target.id).emit("room:kicked", { room: String(room) });
      io.in(result.target.id).socketsLeave(key(String(room))); // works from any server of a cluster
      announceEvent(String(room), "kick", result.target.nickname);
      await announceMembers(String(room));
      announceRoom(result.room);
      reply(ack, { ok: true });
    });

    socket.on("room:newcode", async (data, ack) => {
      const result = await registry.newCode(socket.id, String(payload(data).room));
      if (result.error) return refuse(ack, result);
      announceRoom(result.room);
      reply(ack, { ok: true, room: result.room });
    });

    // ---- messages
    socket.on("message", async (data, ack) => {
      const { room, body, replyTo } = payload(data);
      const user = await inRoom(room);
      if (!user) return refuse(ack, joinFirst);
      const sized = classifyBody(body);
      if (sized.error) return refuse(ack, sized);
      if (replyTo !== undefined && replyTo !== null && !isMessageId(replyTo)) return refuse(ack, refusal("bad_reply", "That reply is not valid."));
      if (!(sized.kind === "media" ? media : texts).allow()) return refuse(ack, refusal("too_fast", "You are writing too fast. Wait a moment."));
      const message = {
        id: crypto.randomUUID(),
        room: String(room),
        from: { id: user.id, nickname: user.nickname },
        body,
        replyTo: replyTo ?? null,
        at: new Date().toISOString(),
      };
      io.to(key(message.room)).emit("message", message); // relayed, never stored
      reply(ack, { ok: true, id: message.id, at: message.at, proof: proofs.sign(message.id, message.room, user.nickname) });
    });

    // Only the author can edit or delete a message: the proof the server gave them when it was sent says so.
    socket.on("message:edit", async (data, ack) => {
      const { room, id, proof, body } = payload(data);
      const user = await inRoom(room);
      if (!user) return refuse(ack, joinFirst);
      if (!isMessageId(id) || !proofs.verify(proof, id, String(room), user.nickname)) return refuse(ack, refusal("proof_invalid", "You can only change your own messages."));
      const sized = classifyBody(body, { textOnly: true });
      if (sized.error) return refuse(ack, sized);
      if (!texts.allow()) return refuse(ack, refusal("too_fast", "You are writing too fast. Wait a moment."));
      io.to(key(String(room))).emit("message:edited", { room: String(room), id, body, from: { nickname: user.nickname }, at: new Date().toISOString() });
      reply(ack, { ok: true });
    });

    socket.on("message:delete", async (data, ack) => {
      const { room, id, proof } = payload(data);
      const user = await inRoom(room);
      if (!user) return refuse(ack, joinFirst);
      if (!isMessageId(id) || !proofs.verify(proof, id, String(room), user.nickname)) return refuse(ack, refusal("proof_invalid", "You can only change your own messages."));
      io.to(key(String(room))).emit("message:deleted", { room: String(room), id, from: { nickname: user.nickname } });
      reply(ack, { ok: true });
    });

    socket.on("message:react", async (data, ack) => {
      const { room, id, emoji, on } = payload(data);
      const user = await inRoom(room);
      if (!user) return refuse(ack, joinFirst);
      if (!isMessageId(id) || !EMOJIS.includes(emoji)) return refuse(ack, refusal("bad_reaction", "That reaction is not valid."));
      if (!small.allow()) return refuse(ack, refusal("too_fast", "You are writing too fast. Wait a moment."));
      io.to(key(String(room))).emit("message:reaction", { room: String(room), id, emoji, on: on === true, from: { nickname: user.nickname } });
      reply(ack, { ok: true });
    });

    // A whisper goes to one person of the room (and back to you), not to the others.
    socket.on("whisper", async (data, ack) => {
      const { room, to, body } = payload(data);
      const user = await inRoom(room);
      if (!user) return refuse(ack, joinFirst);
      const sized = classifyBody(body, { textOnly: true });
      if (sized.error) return refuse(ack, sized);
      const target = typeof to === "string" ? await registry.findMember(String(room), to) : null;
      if (!target) return refuse(ack, refusal("unknown_target", "This person is not in the room."));
      if (target.id === socket.id) return refuse(ack, refusal("cannot_whisper_self", "You cannot whisper to yourself."));
      if (!texts.allow()) return refuse(ack, refusal("too_fast", "You are writing too fast. Wait a moment."));
      const whisper = {
        id: crypto.randomUUID(),
        room: String(room),
        from: { id: user.id, nickname: user.nickname },
        to: { id: target.id, nickname: target.nickname },
        body,
        at: new Date().toISOString(),
      };
      io.to(target.id).emit("whisper", whisper);
      socket.emit("whisper", whisper);
      reply(ack, { ok: true, id: whisper.id });
    });

    socket.on("typing", async (data) => {
      const { room, typing } = payload(data);
      const user = await inRoom(room);
      if (!user || !small.allow()) return;
      socket.to(key(String(room))).emit("typing", { room: String(room), nickname: user.nickname, typing: typing === true });
    });

    socket.on("disconnect", async () => {
      const { user, left } = await registry.unregister(socket.id);
      if (user) await afterLeaving(user, left);
    });
  });

  return {
    io,
    registry,
    server,
    instanceId,
    /** What a janitor found when it cleaned up after a server that died: the rooms are told as for any other departure. */
    announceReaped: async (reaped) => {
      for (const { user, left } of reaped) await afterLeaving(user, left);
    },
    /** Starts listening (port 0 picks a free one) and answers with the port. */
    listen: (port = 3000) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => io.close(() => resolve())),
  };
}
