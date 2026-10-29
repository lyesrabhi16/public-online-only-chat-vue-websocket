// The Socket.IO server. A room is entered with its code. It relays messages between the people in a room and keeps no history at all:
// a person who joins late (or reconnects) sees nothing of what was said before.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server } from "socket.io";
import { FailureLimiter, Registry, RateLimiter, cleanText } from "./rooms.js";

const GRACE_MS = 60_000; // how long a room stays open after its last person was disconnected

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

/** Serves the built client (the `dist` folder) with a fallback to index.html, and a /health check. */
function requestListener(registry, staticDir) {
  const root = staticDir && fs.existsSync(staticDir) ? path.resolve(staticDir) : null;
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", online: registry.users.size, rooms: registry.rooms.size }));
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
    });
    fs.createReadStream(file).pipe(res);
  };
}

/** `corsOrigin`: "*" or a comma-separated list of the web pages allowed to connect (the Vite dev server by default). */
export function createChatServer({ corsOrigin = "http://localhost:5173,http://127.0.0.1:5173", staticDir } = {}) {
  const registry = new Registry();
  const wrongCodes = new FailureLimiter(); // by address: stops anybody from trying codes one after the other
  const server = http.createServer(requestListener(registry, staticDir));
  const origins = corsOrigin === "*" ? "*" : corsOrigin.split(",").map((o) => o.trim());
  // a chat message is tiny: refusing big payloads stops anyone from flooding the server with them
  const io = new Server(server, { cors: { origin: origins }, maxHttpBufferSize: 10_000 });
  const key = (roomId) => `room:${roomId}`;
  const reply = (ack, body) => typeof ack === "function" && ack(body);
  const payload = (raw) => (raw !== null && typeof raw === "object" ? raw : {});

  const announceMembers = (roomId) => io.to(key(roomId)).emit("room:members", { room: roomId, members: registry.members(roomId) });
  const announceEvent = (roomId, kind, nickname) =>
    io.to(key(roomId)).emit("room:event", { room: roomId, kind, nickname, at: new Date().toISOString() });

  io.on("connection", (socket) => {
    const limiter = new RateLimiter();
    const typingLimiter = new RateLimiter(20, 5000);

    const leaveRoom = (roomId) => {
      const result = registry.leave(socket.id, roomId);
      if (!result.left) return false;
      socket.leave(key(roomId));
      if (!result.removed) {
        announceEvent(roomId, "leave", result.nickname);
        announceMembers(roomId);
      }
      return true;
    };

    socket.on("hello", (data, ack) => {
      const { user, error } = registry.register(socket.id, payload(data).nickname);
      if (error) return reply(ack, { error });
      reply(ack, { ok: true, user: { id: user.id, nickname: user.nickname } });
    });

    // A new room: its creator is inside it and gets its code, to share with whoever should come in.
    socket.on("room:create", (data, ack) => {
      const { room, error } = registry.createRoom(socket.id, payload(data).name);
      if (error) return reply(ack, { error });
      socket.join(key(room.id));
      reply(ack, { ok: true, room, members: registry.members(room.id) });
    });

    // The only way into a room: its code.
    socket.on("room:join", (data, ack) => {
      if (!registry.user(socket.id)) return reply(ack, { error: "Choose a nickname first." });
      const address = socket.handshake.address;
      if (wrongCodes.blocked(address)) return reply(ack, { error: "Too many wrong codes. Wait a few minutes before trying again." });
      const { room, error, already, wrongCode } = registry.joinWithCode(socket.id, payload(data).code);
      if (wrongCode) wrongCodes.fail(address);
      if (error) return reply(ack, { error });
      socket.join(key(room.id));
      reply(ack, { ok: true, room, members: registry.members(room.id) });
      if (!already) {
        announceEvent(room.id, "join", registry.user(socket.id).nickname);
        announceMembers(room.id);
      }
    });

    socket.on("room:leave", (data, ack) => {
      leaveRoom(String(payload(data).room));
      reply(ack, { ok: true });
    });

    socket.on("message", (data, ack) => {
      const { room, text } = payload(data);
      const user = registry.user(socket.id);
      if (!user || !registry.isIn(socket.id, String(room))) return reply(ack, { error: "Join the room first." });
      const cleaned = cleanText(text);
      if (cleaned.error) return reply(ack, { error: cleaned.error });
      if (!limiter.allow()) return reply(ack, { error: "You are writing too fast. Wait a moment." });
      const message = {
        id: crypto.randomUUID(),
        room: String(room),
        from: { id: user.id, nickname: user.nickname },
        text: cleaned.value,
        at: new Date().toISOString(),
      };
      io.to(key(message.room)).emit("message", message); // relayed, never stored
      reply(ack, { ok: true, id: message.id });
    });

    socket.on("typing", (data) => {
      const { room, typing } = payload(data);
      const user = registry.user(socket.id);
      if (!user || !registry.isIn(socket.id, String(room)) || !typingLimiter.allow()) return;
      socket.to(key(String(room))).emit("typing", { room: String(room), nickname: user.nickname, typing: typing === true });
    });

    socket.on("disconnect", () => {
      const { user, left } = registry.unregister(socket.id);
      if (!user) return;
      for (const r of left) {
        if (!r.emptied) {
          announceEvent(r.roomId, "leave", user.nickname);
          announceMembers(r.roomId);
        } else {
          // alone in it and gone: the room (and its code) stays open for a minute, in case it was only the connection
          setTimeout(() => registry.closeIfEmpty(r.roomId), GRACE_MS).unref();
        }
      }
    });
  });

  return {
    io,
    registry,
    server,
    /** Starts listening (port 0 picks a free one) and answers with the port. */
    listen: (port = 3000) =>
      new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        io.close(() => resolve());
      }),
  };
}
