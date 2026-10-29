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

/** `owner` creates a room, `others` come in with its code. */
async function roomWith(name, owner, ...others) {
  const made = await ask(owner, "room:create", { name });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  for (const other of others) expect((await ask(other, "room:join", { code: made.room.code })).ok).toBe(true);
  return made.room;
}

describe("getting in", () => {
  it("needs a nickname before anything else", async () => {
    const s = await person();
    expect((await ask(s, "room:create", { name: "Room" })).error).toMatch(/nickname/);
    expect((await ask(s, "room:join", { code: "ABCDEF" })).error).toMatch(/nickname/);
    expect((await ask(s, "message", { room: "x", text: "hi" })).error).toMatch(/Join the room/);
  });

  it("answers hello with who you are", async () => {
    const s = await person();
    const answer = await ask(s, "hello", { nickname: "  Ada  " });
    expect(answer.user.nickname).toBe("Ada");
  });

  it("refuses a nickname that is taken, even in another case, or invalid", async () => {
    await person("Ada");
    const other = await person();
    expect((await ask(other, "hello", { nickname: "ADA" })).error).toMatch(/already used/);
    expect((await ask(other, "hello", { nickname: "<b>" })).error).toBeTruthy();
    expect((await ask(other, "hello", "not an object")).error).toBeTruthy();
  });
});

describe("rooms and codes", () => {
  it("a created room has a code, and its creator is inside", async () => {
    const ada = await person("Ada R1");
    const made = await ask(ada, "room:create", { name: "Study group" });
    expect(made.room).toMatchObject({ name: "Study group", members: 1 });
    expect(made.room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(made.members.map((m) => m.nickname)).toEqual(["Ada R1"]);
    expect((await ask(ada, "room:create", { name: "x" })).error).toMatch(/2 to 30/);
  });

  it("can only be entered with its code", async () => {
    const [ada, bob] = [await person("Ada R2"), await person("Bob R2")];
    const room = await roomWith("Secret", ada);
    expect((await ask(bob, "room:join", { room: room.id })).error).toMatch(/not a room code/); // the id is not a way in
    expect((await ask(bob, "room:join", { code: "ZZZZZZ" })).error).toMatch(/No room/);
    expect((await ask(bob, "room:join", {})).error).toMatch(/not a room code/);
    const joined = await ask(bob, "room:join", { code: room.code.toLowerCase() });
    expect(joined.ok).toBe(true);
    expect(joined.members.map((m) => m.nickname)).toEqual(["Ada R2", "Bob R2"]);
  });

  it("are not listed: nothing tells anybody which rooms exist", async () => {
    const bob = await person();
    expect((await ask(bob, "hello", { nickname: "Bob R3" })).rooms).toBeUndefined();
    const seen = record(bob, "rooms");
    const ada = await person("Ada R3");
    await roomWith("Hidden", ada);
    await sleep(150);
    expect(seen).toHaveLength(0);
  });

  it("relay a message to the people in the room only", async () => {
    const [ada, bob, eve] = [await person("Ada R4"), await person("Bob R4"), await person("Eve R4")];
    const room = await roomWith("Chat", ada, bob);
    await roomWith("Other", eve);
    const toBob = record(bob, "message"), toAda = record(ada, "message"), toEve = record(eve, "message");
    const sent = await ask(ada, "message", { room: room.id, text: "hello room" });
    await sleep(100);
    expect(sent.ok).toBe(true);
    expect(toBob[0]).toMatchObject({ room: room.id, text: "hello room", from: { nickname: "Ada R4" } });
    expect(toAda.map((m) => m.id)).toEqual([sent.id]);
    expect(toEve).toHaveLength(0);
  });

  it("do not store anything: somebody who comes in later sees nothing of the past", async () => {
    const ada = await person("Ada R5");
    const room = await roomWith("Past", ada);
    await ask(ada, "message", { room: room.id, text: "secret plan" });
    const late = await person("Late R5");
    const heard = record(late, "message");
    const joined = await ask(late, "room:join", { code: room.code });
    await sleep(100);
    expect(heard).toHaveLength(0);
    expect(JSON.stringify(joined)).not.toContain("secret plan");
  });

  it("refuse a message from somebody who is not in the room", async () => {
    const [ada, bob] = [await person("Ada R6"), await person("Bob R6")];
    const room = await roomWith("Private", ada);
    expect((await ask(bob, "message", { room: room.id, text: "let me in" })).error).toMatch(/Join the room/);
    await ask(bob, "room:join", { code: room.code });
    await ask(bob, "room:leave", { room: room.id });
    expect((await ask(bob, "message", { room: room.id, text: "again" })).error).toMatch(/Join the room/);
  });

  it("validate messages: empty, too long, not text", async () => {
    const ada = await person("Ada R7");
    const room = await roomWith("Rules", ada);
    expect((await ask(ada, "message", { room: room.id, text: "  " })).error).toMatch(/empty/);
    expect((await ask(ada, "message", { room: room.id, text: "x".repeat(LIMITS.textMax + 1) })).error).toMatch(/limited/);
    expect((await ask(ada, "message", { room: room.id, text: { a: 1 } })).error).toMatch(/text/);
    expect((await ask(ada, "message", "garbage")).error).toMatch(/Join the room/);
  });

  it("slow down somebody who writes too fast", async () => {
    const ada = await person("Ada R8");
    const room = await roomWith("Fast", ada);
    const answers = [];
    for (let i = 0; i < LIMITS.burst + 2; i++) answers.push(await ask(ada, "message", { room: room.id, text: `m${i}` }));
    expect(answers.filter((a) => a.ok)).toHaveLength(LIMITS.burst);
    expect(answers.at(-1).error).toMatch(/too fast/);
  });

  it("drop a payload that is far too big instead of relaying it", async () => {
    const [ada, bob] = [await person("Ada R9"), await person("Bob R9")];
    const room = await roomWith("Big", ada, bob);
    const heard = record(bob, "message");
    ada.emit("message", { room: room.id, text: "x".repeat(50_000) });
    await sleep(300);
    expect(heard).toHaveLength(0);
  });

  it("announce who comes in and leaves, and keep the member list up to date", async () => {
    const ada = await person("Ada R10");
    const room = await roomWith("Presence", ada);
    const events = record(ada, "room:event"), members = record(ada, "room:members");
    const bob = await person("Bob R10");
    await ask(bob, "room:join", { code: room.code });
    await sleep(100);
    expect(events.at(-1)).toMatchObject({ room: room.id, kind: "join", nickname: "Bob R10" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada R10", "Bob R10"]);
    bob.close(); // a disconnection counts as leaving
    await sleep(200);
    expect(events.at(-1)).toMatchObject({ kind: "leave", nickname: "Bob R10" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada R10"]);
  });

  it("show a typing indicator to the others in the room", async () => {
    const [ada, bob] = [await person("Ada R11"), await person("Bob R11")];
    const room = await roomWith("Typing", ada, bob);
    const toBob = record(bob, "typing"), toAda = record(ada, "typing");
    ada.emit("typing", { room: room.id, typing: true });
    await sleep(100);
    expect(toBob).toEqual([{ room: room.id, nickname: "Ada R11", typing: true }]);
    expect(toAda).toHaveLength(0);
  });

  it("close when the last person leaves, and the code stops working", async () => {
    const [ada, bob, cleo] = [await person("Ada R12"), await person("Bob R12"), await person("Cleo R12")];
    const room = await roomWith("Closing", ada, bob);
    await ask(ada, "room:leave", { room: room.id });
    expect((await ask(cleo, "room:join", { code: room.code })).ok).toBe(true); // Bob and Cleo keep it open
    await ask(cleo, "room:leave", { room: room.id });
    await ask(bob, "room:leave", { room: room.id }); // the last one leaves on purpose: the room closes at once
    const late = await person("Late R12");
    expect((await ask(late, "room:join", { code: room.code })).error).toMatch(/No room/);
  });

  it("stay open for a moment when their only person is disconnected, so the code still works", async () => {
    const ada = await person("Ada R14");
    const room = await roomWith("Blip", ada);
    ada.close();
    await sleep(200);
    const back = await person("Ada R14");
    expect((await ask(back, "room:join", { code: room.code })).ok).toBe(true);
  });

  it("keep working when a client sends garbage", async () => {
    const ada = await person("Ada R13");
    ada.emit("room:join", 42);
    ada.emit("message", null);
    ada.emit("typing", "no");
    ada.emit("room:create");
    await sleep(200);
    expect((await ask(ada, "room:create", { name: "Still fine" })).ok).toBe(true);
  });
});

describe("guessing codes", () => {
  // its own server: the failures are counted per address, and every test client has the same one
  it("is stopped after too many wrong codes from one address", async () => {
    const own = createChatServer({ corsOrigin: "*" });
    const ownPort = await own.listen(0);
    const open = async (nickname) => {
      const socket = connect(`http://localhost:${ownPort}`, { transports: ["websocket"], reconnection: false });
      clients.push(socket);
      await new Promise((resolve) => socket.on("connect", resolve));
      await ask(socket, "hello", { nickname });
      return socket;
    };
    try {
      const ada = await open("Ada G1");
      const room = (await ask(ada, "room:create", { name: "Guess me" })).room;
      const guesser = await open("Guesser G1");
      const answers = [];
      for (let i = 0; i < LIMITS.wrongCodes + 2; i++) answers.push(await ask(guesser, "room:join", { code: `AAAAA${"BCDEFGHJKLMN"[i]}` }));
      expect(answers.slice(0, LIMITS.wrongCodes).every((a) => /No room/.test(a.error))).toBe(true);
      expect(answers.at(-1).error).toMatch(/Too many wrong codes/);
      // even the right code is refused while blocked
      expect((await ask(guesser, "room:join", { code: room.code })).error).toMatch(/Too many wrong codes/);
    } finally {
      await own.close();
    }
  });
});

describe("http", () => {
  it("answers a health check", async () => {
    const body = await (await fetch(`http://localhost:${port}/health`)).json();
    expect(body.status).toBe("ok");
    expect(typeof body.rooms).toBe("number");
  });

  it("is not a web server when there is no built client", async () => {
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(404);
  });
});
