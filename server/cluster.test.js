// Two real servers sharing one Redis, with real clients connected to either of them.
// Needs a Redis: REDIS_URL=redis://localhost:6379 npm test   (skipped without it)
import crypto from "node:crypto";
import { io as connect } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatServer } from "./index.js";
import { createProofs } from "./proof.js";
import { createRedisBackend } from "./redis.js";
import { LIMITS } from "./rooms.js";

const url = process.env.REDIS_URL;
const prefix = `cluster:${crypto.randomUUID().slice(0, 8)}:`;
const nodes = [];
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until something that travels between servers has arrived (a fixed delay is not enough when the machine is busy). */
const eventually = async (check, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting: " + check.toString());
    await sleep(25);
  }
};
const ask = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));
// the servers only ever see the handle of a code: any 64 hex digits will do
let handles = 0;
const fresh = () => crypto.createHash("sha256").update(`cluster handle ${++handles}`).digest("hex");
/** Creates a room; it comes back with its handle (the server does not hand it out). */
const makeRoom = async (socket, name) => {
  const handle = fresh();
  const made = await ask(socket, "room:create", { name, handle });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  return { ...made.room, handle };
};
const record = (socket, event) => {
  const seen = [];
  socket.on(event, (x) => seen.push(x));
  return seen;
};

/** A server of the cluster: its own port, the shared Redis, a fast heartbeat so that tests do not wait. */
async function startNode(id, { heartbeat = true, ttl = 1 } = {}) {
  const backend = createRedisBackend({ url, instanceId: id, prefix, heartbeatMs: 250, ttlSeconds: 1 });
  const chat = createChatServer({
    corsOrigin: "*",
    instanceId: id,
    registry: backend.registry,
    wrongCodes: backend.wrongCodes,
    attach: backend.attach,
    proofs: createProofs(await backend.sharedSecret()),
  });
  const port = await chat.listen(0);
  if (heartbeat) backend.start((reaped) => chat.announceReaped(reaped));
  else await backend.registry.heartbeat(ttl); // said once, never renewed: this server is about to "crash"
  const node = { id, chat, backend, port };
  nodes.push(node);
  return node;
}

async function person(node, nickname) {
  const socket = connect(`http://localhost:${node.port}`, { transports: ["websocket"], reconnection: false });
  clients.push(socket);
  await new Promise((resolve) => socket.on("connect", resolve));
  const answer = await ask(socket, "hello", { nickname });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  expect(answer.instance).toBe(node.id);
  return socket;
}

let one, two;
beforeAll(async () => {
  if (!url) return;
  one = await startNode("one");
  two = await startNode("two");
});
beforeEach(async () => {
  // every test connects from this machine, so a test that guesses codes must not leave the others blocked
  const stale = (await one?.backend.redis.keys(`${prefix}wc:*`)) ?? [];
  if (stale.length) await one.backend.redis.del(...stale);
});
afterEach(() => {
  while (clients.length) clients.pop().close();
});
afterAll(async () => {
  for (const node of nodes) {
    await node.chat.close().catch(() => {});
    await sleep(50);
    await node.backend.registry.flush().catch(() => {});
    await node.backend.close().catch(() => {});
  }
});

describe.skipIf(!url)("two servers sharing the chat", () => {
  it("know about each other's people: one nickname, one person", async () => {
    await person(one, "Ada C1");
    const other = connect(`http://localhost:${two.port}`, { transports: ["websocket"], reconnection: false });
    clients.push(other);
    await new Promise((resolve) => other.on("connect", resolve));
    expect((await ask(other, "hello", { nickname: "ada c1" })).code).toBe("nickname_taken");
  });

  it("let somebody join the room of somebody on the other server, with the handle", async () => {
    const ada = await person(one, "Ada C2");
    const bob = await person(two, "Bob C2");
    const room = await makeRoom(ada, "Cluster");
    const joined = await ask(bob, "room:join", { handle: room.handle });
    expect(joined.members.map((m) => m.nickname)).toEqual(["Ada C2", "Bob C2"]);
  });

  it("carry messages, typing, reactions and whispers between the servers", async () => {
    const [ada, bob, cleo] = [await person(one, "Ada C3"), await person(two, "Bob C3"), await person(one, "Cleo C3")];
    const room = await makeRoom(ada, "Talk");
    await ask(bob, "room:join", { handle: room.handle });
    await ask(cleo, "room:join", { handle: room.handle });
    const onBob = record(bob, "message"), onAda = record(ada, "message"), typing = record(bob, "typing");
    const reactions = record(ada, "message:reaction"), whispersBob = record(bob, "whisper"), whispersCleo = record(cleo, "whisper");

    const sent = await ask(ada, "message", { room: room.id, body: "from server one" });
    await ask(bob, "message", { room: room.id, body: "from server two" });
    ada.emit("typing", { room: room.id, typing: true });
    await ask(bob, "message:react", { room: room.id, id: sent.id, emoji: "👍", on: true });
    await ask(ada, "whisper", { room: room.id, to: "Bob C3", body: "psst" });
    await eventually(() => onBob.length === 2 && onAda.length === 2 && typing.length === 1 && reactions.length === 1 && whispersBob.length === 1);
    await sleep(100); // and nothing more arrives for the person who must not get the whisper

    expect(onBob.map((m) => m.body)).toEqual(["from server one", "from server two"]);
    expect(onAda.map((m) => m.body)).toEqual(["from server one", "from server two"]);
    expect(typing).toEqual([{ room: room.id, nickname: "Ada C3", typing: true }]);
    expect(reactions[0]).toMatchObject({ emoji: "👍", from: { nickname: "Bob C3" } });
    expect(whispersBob.map((w) => w.body)).toEqual(["psst"]);
    expect(whispersCleo).toHaveLength(0);
  });

  it("announce who comes in and leaves, across servers", async () => {
    const ada = await person(one, "Ada C4");
    const room = await makeRoom(ada, "Presence");
    const events = record(ada, "room:event"), members = record(ada, "room:members");
    const bob = await person(two, "Bob C4");
    await ask(bob, "room:join", { handle: room.handle });
    await eventually(() => events.at(-1)?.kind === "join" && members.at(-1)?.members.length === 2);
    expect(events.at(-1)).toMatchObject({ kind: "join", nickname: "Bob C4" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada C4", "Bob C4"]);
    bob.close();
    await eventually(() => events.at(-1)?.kind === "leave");
    expect(events.at(-1)).toMatchObject({ kind: "leave", nickname: "Bob C4" });
  });

  it("let the owner on one server lock, remove and re-code for people on the other", async () => {
    const [ada, bob, cleo] = [await person(one, "Ada C5"), await person(two, "Bob C5"), await person(two, "Cleo C5")];
    const room = await makeRoom(ada, "Owner");
    await ask(bob, "room:join", { handle: room.handle });
    const updates = record(bob, "room:updated"), kicked = record(bob, "room:kicked"), toBob = record(bob, "message");
    expect((await ask(ada, "room:lock", { room: room.id, locked: true })).ok).toBe(true);
    await eventually(() => updates.at(-1)?.room.locked === true);
    expect((await ask(cleo, "room:join", { handle: room.handle })).code).toBe("locked");
    expect((await ask(ada, "room:lock", { room: room.id, locked: false })).ok).toBe(true);

    expect((await ask(ada, "room:kick", { room: room.id, id: bob.id })).ok).toBe(true);
    await eventually(() => kicked.length === 1);
    expect(kicked).toEqual([{ room: room.id }]);
    await ask(ada, "message", { room: room.id, body: "after the removal" });
    await sleep(400);
    expect(toBob).toHaveLength(0); // taken out of the room on the other server too
    expect((await ask(bob, "room:join", { handle: room.handle })).code).toBe("banned");

    const next = fresh();
    expect((await ask(ada, "room:newcode", { room: room.id, handle: next })).ok).toBe(true);
    expect((await ask(cleo, "room:join", { handle: room.handle })).code).toBe("code_unknown");
    expect((await ask(cleo, "room:join", { handle: next })).ok).toBe(true);
  });

  it("hand the room to somebody on the other server when its owner leaves", async () => {
    const [ada, bob] = [await person(one, "Ada C6"), await person(two, "Bob C6")];
    const room = await makeRoom(ada, "Handover");
    await ask(bob, "room:join", { handle: room.handle });
    const updates = record(bob, "room:updated");
    await ask(ada, "room:leave", { room: room.id });
    await eventually(() => updates.at(-1)?.room.ownerId === bob.id);
    expect(updates.at(-1).room.ownerId).toBe(bob.id);
    expect((await ask(bob, "room:lock", { room: room.id, locked: true })).ok).toBe(true);
  });

  it("accept a proof on the other server (they share one secret): edit a message after reconnecting elsewhere", async () => {
    const ada = await person(one, "Ada C7");
    const room = await makeRoom(ada, "Proofs");
    const sent = await ask(ada, "message", { room: room.id, body: "first" });
    ada.close();
    await sleep(500); // the old connection is gone, so the nickname is free
    const back = await person(two, "Ada C7"); // the same person, now on the other server
    await ask(back, "room:join", { handle: room.handle });
    const bob = await person(one, "Bob C7");
    await ask(bob, "room:join", { handle: room.handle });
    const edited = record(bob, "message:edited");
    expect((await ask(back, "message:edit", { room: room.id, id: sent.id, proof: sent.proof, body: "second" })).ok).toBe(true);
    await eventually(() => edited.length === 1);
    expect(edited[0]).toMatchObject({ id: sent.id, body: "second" });
  });

  it("count wrong codes across the servers: trying each in turn does not help", async () => {
    const ada = await person(one, "Ada C8");
    const room = await makeRoom(ada, "Guess");
    const guesser1 = await person(one, "Guesser1 C8");
    const guesser2 = await person(two, "Guesser2 C8");
    const answers = [];
    for (let i = 0; i < LIMITS.wrongCodes; i++) answers.push(await ask(i % 2 ? guesser1 : guesser2, "room:join", { handle: fresh() }));
    expect(answers.every((a) => a.code === "code_unknown")).toBe(true);
    expect((await ask(guesser1, "room:join", { handle: room.handle })).code).toBe("too_many_wrong_codes");
    expect((await ask(guesser2, "room:join", { handle: room.handle })).code).toBe("too_many_wrong_codes");
  });

  it("keep one winner when two members on different servers change the group at the same moment", async () => {
    const [ada, bob] = [await person(one, "Ada C10"), await person(two, "Bob C10")];
    const room = await makeRoom(ada, "Race");
    await ask(bob, "room:join", { handle: room.handle });
    const atAda = record(ada, "mls:commit"), atBob = record(bob, "mls:commit");
    const answers = await Promise.all([
      ask(ada, "mls:commit", { room: room.id, base: 0, commit: Buffer.from("from ada").toString("base64") }),
      ask(bob, "mls:commit", { room: room.id, base: 0, commit: Buffer.from("from bob").toString("base64") }),
    ]);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => a.code === "stale_epoch")).toHaveLength(1);
    await eventually(() => atAda.length + atBob.length === 1); // and only the winner's change is passed on, to the other server's person
    expect(atAda.length + atBob.length).toBe(1);
  });

  it("answer a health check with the same counts, each with its own name", async () => {
    await person(one, "Ada C9");
    const [a, b] = await Promise.all([one, two].map(async (n) => (await fetch(`http://localhost:${n.port}/health`)).json()));
    expect(a.instance).toBe("one");
    expect(b.instance).toBe("two");
    expect(a.online).toBe(b.online);
    expect(a.online).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!url)("a server that dies", () => {
  it("is cleaned up after by the others: its people disappear from their rooms and their nicknames come free", async () => {
    const survivor = one;
    const doomed = await startNode("doomed", { heartbeat: false, ttl: 3 });
    const ada = await person(survivor, "Ada D1");
    const room = await makeRoom(ada, "Crash");
    const bob = await person(doomed, "Bob D1");
    await ask(bob, "room:join", { handle: room.handle });
    const events = record(ada, "room:event"), members = record(ada, "room:members");

    // the crash: the server stops without telling the chat anything (its people are not removed, its heartbeat is not renewed)
    doomed.backend.registry.unregister = async () => ({ user: null, left: [] });
    await doomed.chat.close();
    await sleep(300);
    expect((await survivor.backend.registry.members(room.id)).map((m) => m.nickname)).toContain("Bob D1"); // still there: nobody knows yet

    await sleep(3500); // the heartbeat has expired and a janitor has noticed
    expect((await survivor.backend.registry.members(room.id)).map((m) => m.nickname)).toEqual(["Ada D1"]);
    expect(events.at(-1)).toMatchObject({ kind: "leave", nickname: "Bob D1" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada D1"]);
    const again = await person(two, "Bob D1"); // the nickname is free again
    expect(again.connected).toBe(true);
  }, 30_000);
});
