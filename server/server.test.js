// The whole thing with real sockets: a server on a free port and several real clients.
import { io as connect } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createChatServer } from "./index.js";
import { LIMITS } from "./rooms.js";

let chat, port;
const clients = [];

beforeAll(async () => {
  chat = createChatServer({ corsOrigin: "*" });
  port = await chat.listen(0);
});
afterEach(() => {
  while (clients.length) clients.pop().close();
});
afterAll(() => chat.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));
const record = (socket, event) => {
  const seen = [];
  socket.on(event, (x) => seen.push(x));
  return seen;
};

/** A connected client that has chosen a nickname. */
async function person(nickname) {
  const socket = connect(`http://localhost:${port}`, { transports: ["websocket"], reconnection: false });
  clients.push(socket);
  await new Promise((resolve) => socket.on("connect", resolve));
  if (nickname) {
    const answer = await ask(socket, "hello", { nickname });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  }
  return socket;
}

describe("getting in", () => {
  it("needs a nickname before anything else", async () => {
    const s = await person();
    expect((await ask(s, "rooms:list")).error).toMatch(/nickname/);
    expect((await ask(s, "room:join", { room: "general" })).error).toMatch(/nickname/);
    expect((await ask(s, "message", { room: "general", text: "hi" })).error).toMatch(/Join the room/);
  });

  it("answers hello with who you are and the rooms", async () => {
    const s = await person();
    const answer = await ask(s, "hello", { nickname: "  Ada  " });
    expect(answer.user.nickname).toBe("Ada");
    expect(answer.rooms.map((r) => r.id)).toEqual(expect.arrayContaining(["general", "random", "tech"]));
  });

  it("refuses a nickname that is taken, even in another case", async () => {
    await person("Ada");
    const other = await person();
    expect((await ask(other, "hello", { nickname: "ADA" })).error).toMatch(/already used/);
    expect((await ask(other, "hello", { nickname: "<b>" })).error).toBeTruthy();
    expect((await ask(other, "hello", "not an object")).error).toBeTruthy();
  });
});

describe("rooms", () => {
  it("relay a message to the people in the room only", async () => {
    const [ada, bob, eve] = [await person("Ada R1"), await person("Bob R1"), await person("Eve R1")];
    await ask(ada, "room:join", { room: "general" });
    await ask(bob, "room:join", { room: "general" });
    await ask(eve, "room:join", { room: "random" });
    const toBob = record(bob, "message"), toAda = record(ada, "message"), toEve = record(eve, "message");
    const sent = await ask(ada, "message", { room: "general", text: "hello room" });
    await sleep(100);
    expect(sent.ok).toBe(true);
    expect(toBob).toHaveLength(1);
    expect(toBob[0]).toMatchObject({ room: "general", text: "hello room", from: { nickname: "Ada R1" } });
    expect(toAda.map((m) => m.id)).toEqual([sent.id]); // the sender gets it from the room too
    expect(toEve).toHaveLength(0);
  });

  it("do not store anything: somebody who joins later sees nothing of the past", async () => {
    const ada = await person("Ada R2");
    await ask(ada, "room:join", { room: "tech" });
    await ask(ada, "message", { room: "tech", text: "secret plan" });
    const late = await person("Late R2");
    const heard = record(late, "message");
    const joined = await ask(late, "room:join", { room: "tech" });
    await sleep(100);
    expect(heard).toHaveLength(0);
    expect(JSON.stringify(joined)).not.toContain("secret plan");
  });

  it("refuse a message from somebody who is not in the room", async () => {
    const ada = await person("Ada R3");
    expect((await ask(ada, "message", { room: "general", text: "hi" })).error).toMatch(/Join the room/);
    await ask(ada, "room:join", { room: "general" });
    await ask(ada, "room:leave", { room: "general" });
    expect((await ask(ada, "message", { room: "general", text: "hi" })).error).toMatch(/Join the room/);
  });

  it("validate messages: empty, too long, not text", async () => {
    const ada = await person("Ada R4");
    await ask(ada, "room:join", { room: "general" });
    expect((await ask(ada, "message", { room: "general", text: "  " })).error).toMatch(/empty/);
    expect((await ask(ada, "message", { room: "general", text: "x".repeat(LIMITS.textMax + 1) })).error).toMatch(/limited/);
    expect((await ask(ada, "message", { room: "general", text: { a: 1 } })).error).toMatch(/text/);
    expect((await ask(ada, "message", "garbage")).error).toMatch(/Join the room/);
  });

  it("slow down somebody who writes too fast", async () => {
    const ada = await person("Ada R5");
    await ask(ada, "room:join", { room: "general" });
    const answers = [];
    for (let i = 0; i < LIMITS.burst + 2; i++) answers.push(await ask(ada, "message", { room: "general", text: `m${i}` }));
    expect(answers.filter((a) => a.ok)).toHaveLength(LIMITS.burst);
    expect(answers.at(-1).error).toMatch(/too fast/);
  });

  it("drop a payload that is far too big instead of relaying it", async () => {
    const ada = await person("Ada R6");
    const bob = await person("Bob R6");
    await ask(ada, "room:join", { room: "general" });
    await ask(bob, "room:join", { room: "general" });
    const heard = record(bob, "message");
    ada.emit("message", { room: "general", text: "x".repeat(50_000) });
    await sleep(300);
    expect(heard).toHaveLength(0);
  });

  it("announce who joins and leaves, and keep the member list up to date", async () => {
    const ada = await person("Ada R7");
    await ask(ada, "room:join", { room: "tech" });
    const events = record(ada, "room:event"), members = record(ada, "room:members");
    const bob = await person("Bob R7");
    await ask(bob, "room:join", { room: "tech" });
    await sleep(100);
    expect(events.at(-1)).toMatchObject({ room: "tech", kind: "join", nickname: "Bob R7" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada R7", "Bob R7"]);
    bob.close(); // a disconnection counts as leaving
    await sleep(200);
    expect(events.at(-1)).toMatchObject({ kind: "leave", nickname: "Bob R7" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada R7"]);
  });

  it("show a typing indicator to the others in the room", async () => {
    const ada = await person("Ada R8");
    const bob = await person("Bob R8");
    await ask(ada, "room:join", { room: "random" });
    await ask(bob, "room:join", { room: "random" });
    const toBob = record(bob, "typing"), toAda = record(ada, "typing");
    ada.emit("typing", { room: "random", typing: true });
    await sleep(100);
    expect(toBob).toEqual([{ room: "random", nickname: "Ada R8", typing: true }]);
    expect(toAda).toHaveLength(0);
  });

  it("can be created, are announced to everybody, and vanish when empty", async () => {
    const ada = await person("Ada R9");
    const bob = await person("Bob R9");
    const updates = record(bob, "rooms");
    expect((await ask(ada, "room:create", { name: "x" })).error).toBeTruthy();
    const made = await ask(ada, "room:create", { name: "Chess club R9" });
    expect(made.room).toMatchObject({ id: "chess-club-r9", members: 0, permanent: false });
    expect((await ask(bob, "room:create", { name: "chess CLUB r9" })).error).toMatch(/already exists/);
    await ask(ada, "room:join", { room: made.room.id });
    await sleep(100);
    expect(updates.at(-1).find((r) => r.id === made.room.id).members).toBe(1);
    await ask(ada, "room:leave", { room: made.room.id });
    await sleep(100);
    expect(updates.at(-1).some((r) => r.id === made.room.id)).toBe(false);
    expect((await ask(bob, "room:join", { room: made.room.id })).error).toMatch(/no longer exists/);
  });

  it("keep working when a client sends garbage", async () => {
    const ada = await person("Ada R10");
    ada.emit("room:join", 42);
    ada.emit("message", null);
    ada.emit("typing", "no");
    ada.emit("room:create");
    await sleep(200);
    expect((await ask(ada, "rooms:list")).ok).toBe(true);
  });
});

describe("http", () => {
  it("answers a health check", async () => {
    const body = await (await fetch(`http://localhost:${port}/health`)).json();
    expect(body.status).toBe("ok");
    expect(body.rooms).toBeGreaterThanOrEqual(3);
  });

  it("is not a web server when there is no built client", async () => {
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(404);
  });
});
