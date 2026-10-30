// The whole thing with real sockets: a server on a free port and several real clients.
import crypto from "node:crypto";
import { io as connect } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createChatServer } from "./index.js";
import { EMOJIS, LIMITS } from "./rooms.js";

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
const uuid = () => crypto.randomUUID();
// the server only ever sees the handle of a code: here any 64 hex digits will do
let handles = 0;
const fresh = () => crypto.createHash("sha256").update(`handle ${++handles}`).digest("hex");
const base64 = (text) => Buffer.from(text).toString("base64");

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

/** `owner` creates a room, `others` come in with its handle. The room comes back with the handle (the server does not hand it out). */
async function roomWith(name, owner, ...others) {
  const handle = fresh();
  const made = await ask(owner, "room:create", { name, handle });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  for (const other of others) expect((await ask(other, "room:join", { handle })).ok).toBe(true);
  return { ...made.room, handle };
}

describe("getting in", () => {
  it("needs a nickname before anything else", async () => {
    const s = await person();
    expect((await ask(s, "room:create", { name: "Room", handle: fresh() })).code).toBe("nickname_required");
    expect((await ask(s, "room:join", { handle: fresh() })).code).toBe("nickname_required");
    expect((await ask(s, "message", { room: "x", body: "hi" })).code).toBe("not_member");
  });

  it("answers hello with who you are, and refuses a taken or invalid nickname with a code", async () => {
    const s = await person();
    expect((await ask(s, "hello", { nickname: "  Ada R0  " })).user.nickname).toBe("Ada R0");
    const other = await person();
    expect(await ask(other, "hello", { nickname: "ADA r0" })).toMatchObject({ code: "nickname_taken" });
    expect((await ask(other, "hello", { nickname: "<b>" })).code).toBe("nickname_chars");
    expect((await ask(other, "hello", "not an object")).code).toBe("nickname_required");
  });
});

describe("rooms and codes", () => {
  it("a created room is known by the handle of its code, and its creator is inside and runs it", async () => {
    const ada = await person("Ada R1");
    const made = await ask(ada, "room:create", { name: "Study group", handle: fresh() });
    expect(made.room).toMatchObject({ name: "Study group", members: 1, locked: false, ownerId: ada.id });
    expect(JSON.stringify(made)).not.toMatch(/[0-9a-f]{64}/); // the handle is not handed back, to anybody
    expect(made.members).toEqual([{ id: ada.id, nickname: "Ada R1", owner: true }]);
  });

  it("can only be entered with their code, and are not listed", async () => {
    const [ada, bob] = [await person("Ada R2"), await person("Bob R2")];
    const seen = record(bob, "rooms");
    const room = await roomWith("Secret", ada);
    expect((await ask(bob, "room:join", { room: room.id })).code).toBe("code_invalid");
    expect((await ask(bob, "room:join", { handle: "K7M2QXAB" })).code).toBe("code_invalid"); // a code, not its handle
    expect((await ask(bob, "room:join", { handle: fresh() })).code).toBe("code_unknown");
    const joined = await ask(bob, "room:join", { handle: room.handle });
    expect(joined.members.map((m) => m.nickname)).toEqual(["Ada R2", "Bob R2"]);
    expect(seen).toHaveLength(0);
  });

  it("relay a message body to the people in the room only, untouched", async () => {
    const [ada, bob, eve] = [await person("Ada R3"), await person("Bob R3"), await person("Eve R3")];
    const room = await roomWith("Chat", ada, bob);
    await roomWith("Other", eve);
    const toBob = record(bob, "message"), toAda = record(ada, "message"), toEve = record(eve, "message");
    const sent = await ask(ada, "message", { room: room.id, body: "opaque-ciphertext==" });
    await sleep(100);
    expect(sent).toMatchObject({ ok: true });
    expect(toBob[0]).toMatchObject({ room: room.id, body: "opaque-ciphertext==", from: { nickname: "Ada R3" }, replyTo: null });
    expect(toBob[0].proof).toBeUndefined(); // the proof is for the author only
    expect(toAda.map((m) => m.id)).toEqual([sent.id]);
    expect(toEve).toHaveLength(0);
  });

  it("do not store anything: somebody who comes in later sees nothing of the past", async () => {
    const ada = await person("Ada R4");
    const room = await roomWith("Past", ada);
    await ask(ada, "message", { room: room.id, body: "secret-plan" });
    const late = await person("Late R4");
    const heard = record(late, "message");
    const joined = await ask(late, "room:join", { handle: room.handle });
    await sleep(100);
    expect(heard).toHaveLength(0);
    expect(JSON.stringify(joined)).not.toContain("secret-plan");
  });

  it("refuse a message from somebody who is not in the room", async () => {
    const [ada, bob] = [await person("Ada R5"), await person("Bob R5")];
    const room = await roomWith("Private", ada);
    expect((await ask(bob, "message", { room: room.id, body: "let me in" })).code).toBe("not_member");
    await ask(bob, "room:join", { handle: room.handle });
    await ask(bob, "room:leave", { room: room.id });
    expect((await ask(bob, "message", { room: room.id, body: "again" })).code).toBe("not_member");
  });

  it("measure what is sent: empty, not text, too big", async () => {
    const ada = await person("Ada R6");
    const room = await roomWith("Sizes", ada);
    expect((await ask(ada, "message", { room: room.id, body: "" })).code).toBe("body_required");
    expect((await ask(ada, "message", { room: room.id, body: { a: 1 } })).code).toBe("body_required");
    expect((await ask(ada, "message", { room: room.id, body: "x".repeat(LIMITS.mediaBodyMax + 1) })).code ?? "dropped").toMatch(/body_too_large|dropped/);
    expect((await ask(ada, "message", { room: room.id, body: "x".repeat(300_000) })).ok).toBe(true); // a photo-sized message
    expect((await ask(ada, "message", { room: room.id, body: "ok", replyTo: "not-an-id" })).code).toBe("bad_reply");
    expect((await ask(ada, "message", "garbage")).code).toBe("not_member");
  });

  it("slow down somebody who writes too fast, and limit photos separately and harder", async () => {
    const ada = await person("Ada R7");
    const room = await roomWith("Fast", ada);
    const texts = [];
    for (let i = 0; i < LIMITS.burst + 2; i++) texts.push(await ask(ada, "message", { room: room.id, body: `m${i}` }));
    expect(texts.filter((a) => a.ok)).toHaveLength(LIMITS.burst);
    expect(texts.at(-1).code).toBe("too_fast");
    const bob = await person("Bob R7");
    const room2 = await roomWith("Photos", bob);
    const photos = [];
    for (let i = 0; i < LIMITS.mediaBurst + 1; i++) photos.push(await ask(bob, "message", { room: room2.id, body: "p".repeat(10_000) }));
    expect(photos.filter((a) => a.ok)).toHaveLength(LIMITS.mediaBurst);
    expect((await ask(bob, "message", { room: room2.id, body: "short" })).ok).toBe(true); // text has its own allowance
  });

  it("announce who comes in and leaves, and keep the member list up to date", async () => {
    const ada = await person("Ada R8");
    const room = await roomWith("Presence", ada);
    const events = record(ada, "room:event"), members = record(ada, "room:members");
    const bob = await person("Bob R8");
    await ask(bob, "room:join", { handle: room.handle });
    await sleep(100);
    expect(events.at(-1)).toMatchObject({ room: room.id, kind: "join", nickname: "Bob R8" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada R8", "Bob R8"]);
    bob.close();
    await sleep(200);
    expect(events.at(-1)).toMatchObject({ kind: "leave", nickname: "Bob R8" });
    expect(members.at(-1).members.map((m) => m.nickname)).toEqual(["Ada R8"]);
  });

  it("show a typing indicator to the others in the room", async () => {
    const [ada, bob] = [await person("Ada R9"), await person("Bob R9")];
    const room = await roomWith("Typing", ada, bob);
    const toBob = record(bob, "typing"), toAda = record(ada, "typing");
    ada.emit("typing", { room: room.id, typing: true });
    await sleep(100);
    expect(toBob).toEqual([{ room: room.id, nickname: "Ada R9", typing: true }]);
    expect(toAda).toHaveLength(0);
  });

  it("close when the last person leaves on purpose, and stay open a moment after a disconnection", async () => {
    const [ada, bob] = [await person("Ada R10"), await person("Bob R10")];
    const room = await roomWith("Closing", ada);
    await ask(ada, "room:leave", { room: room.id });
    expect((await ask(bob, "room:join", { handle: room.handle })).code).toBe("code_unknown");
    const carl = await person("Carl R10");
    const blip = await roomWith("Blip", carl);
    carl.close();
    await sleep(200);
    expect((await ask(bob, "room:join", { handle: blip.handle })).ok).toBe(true);
  });
});

describe("editing, deleting and reacting", () => {
  it("the author can edit and delete a message, with the proof the server gave", async () => {
    const [ada, bob] = [await person("Ada E1"), await person("Bob E1")];
    const room = await roomWith("Edits", ada, bob);
    const edited = record(bob, "message:edited"), deleted = record(bob, "message:deleted");
    const sent = await ask(ada, "message", { room: room.id, body: "first" });
    expect(sent.proof).toBeTruthy();
    expect((await ask(ada, "message:edit", { room: room.id, id: sent.id, proof: sent.proof, body: "second" })).ok).toBe(true);
    expect((await ask(ada, "message:delete", { room: room.id, id: sent.id, proof: sent.proof })).ok).toBe(true);
    await sleep(100);
    expect(edited[0]).toMatchObject({ id: sent.id, body: "second", from: { nickname: "Ada E1" } });
    expect(deleted[0]).toMatchObject({ id: sent.id });
  });

  it("nobody else can edit or delete it, and a made-up proof does not work", async () => {
    const [ada, bob] = [await person("Ada E2"), await person("Bob E2")];
    const room = await roomWith("Mine", ada, bob);
    const sent = await ask(ada, "message", { room: room.id, body: "mine" });
    expect((await ask(bob, "message:edit", { room: room.id, id: sent.id, proof: sent.proof, body: "hijack" })).code).toBe("proof_invalid"); // even with the real proof
    expect((await ask(bob, "message:delete", { room: room.id, id: sent.id, proof: sent.proof })).code).toBe("proof_invalid");
    expect((await ask(ada, "message:delete", { room: room.id, id: sent.id, proof: "forged" })).code).toBe("proof_invalid");
    expect((await ask(ada, "message:edit", { room: room.id, id: uuid(), proof: sent.proof, body: "x" })).code).toBe("proof_invalid");
    expect((await ask(ada, "message:edit", { room: room.id, id: sent.id, proof: sent.proof, body: "x".repeat(LIMITS.textBodyMax + 1) })).code).toBe("body_too_large");
  });

  it("a proof is good in one room only", async () => {
    const ada = await person("Ada E3");
    const [one, two] = [await roomWith("One", ada), await roomWith("Two", ada)];
    const sent = await ask(ada, "message", { room: one.id, body: "here" });
    expect((await ask(ada, "message:delete", { room: two.id, id: sent.id, proof: sent.proof })).code).toBe("proof_invalid");
  });

  it("anyone in the room can react with an emoji of the list, and take it back", async () => {
    const [ada, bob] = [await person("Ada E4"), await person("Bob E4")];
    const room = await roomWith("Reactions", ada, bob);
    const seen = record(ada, "message:reaction");
    const sent = await ask(ada, "message", { room: room.id, body: "react to me" });
    expect((await ask(bob, "message:react", { room: room.id, id: sent.id, emoji: EMOJIS[0], on: true })).ok).toBe(true);
    expect((await ask(bob, "message:react", { room: room.id, id: sent.id, emoji: EMOJIS[0], on: false })).ok).toBe(true);
    expect((await ask(bob, "message:react", { room: room.id, id: sent.id, emoji: "💩", on: true })).code).toBe("bad_reaction");
    expect((await ask(bob, "message:react", { room: room.id, id: "nope", emoji: EMOJIS[0], on: true })).code).toBe("bad_reaction");
    await sleep(100);
    expect(seen.map((r) => [r.emoji, r.on, r.from.nickname])).toEqual([[EMOJIS[0], true, "Bob E4"], [EMOJIS[0], false, "Bob E4"]]);
    const outsider = await person("Eve E4");
    expect((await ask(outsider, "message:react", { room: room.id, id: sent.id, emoji: EMOJIS[0], on: true })).code).toBe("not_member");
  });

  it("carry a reply to another message by its id", async () => {
    const [ada, bob] = [await person("Ada E5"), await person("Bob E5")];
    const room = await roomWith("Replies", ada, bob);
    const toAda = record(ada, "message");
    const first = await ask(ada, "message", { room: room.id, body: "question" });
    await ask(bob, "message", { room: room.id, body: "answer", replyTo: first.id });
    await sleep(100);
    expect(toAda.at(-1)).toMatchObject({ body: "answer", replyTo: first.id });
  });
});

describe("whispers", () => {
  it("go to one person of the room, and back to the sender, not to the others", async () => {
    const [ada, bob, cleo] = [await person("Ada W1"), await person("Bob W1"), await person("Cleo W1")];
    const room = await roomWith("Whispers", ada, bob, cleo);
    const toBob = record(bob, "whisper"), toAda = record(ada, "whisper"), toCleo = record(cleo, "whisper");
    const sent = await ask(ada, "whisper", { room: room.id, to: "bob w1", body: "psst" });
    await sleep(100);
    expect(sent.ok).toBe(true);
    expect(toBob[0]).toMatchObject({ body: "psst", from: { nickname: "Ada W1" }, to: { nickname: "Bob W1" } });
    expect(toAda).toHaveLength(1);
    expect(toCleo).toHaveLength(0);
  });

  it("need a person who is in the room, and not yourself", async () => {
    const [ada, bob] = [await person("Ada W2"), await person("Bob W2")];
    const room = await roomWith("Nobody", ada);
    expect((await ask(ada, "whisper", { room: room.id, to: "Bob W2", body: "hi" })).code).toBe("unknown_target");
    expect((await ask(ada, "whisper", { room: room.id, to: "Ada W2", body: "hi" })).code).toBe("cannot_whisper_self");
    expect((await ask(bob, "whisper", { room: room.id, to: "Ada W2", body: "hi" })).code).toBe("not_member");
  });
});

describe("running a room", () => {
  it("the owner locks the room, and people who are not in it cannot come in", async () => {
    const [ada, bob, cleo] = [await person("Ada O1"), await person("Bob O1"), await person("Cleo O1")];
    const room = await roomWith("Locked", ada, bob);
    const updates = record(bob, "room:updated");
    expect((await ask(bob, "room:lock", { room: room.id, locked: true })).code).toBe("not_owner");
    expect((await ask(ada, "room:lock", { room: room.id, locked: true })).room.locked).toBe(true);
    await sleep(100);
    expect(updates.at(-1).room.locked).toBe(true);
    expect((await ask(cleo, "room:join", { handle: room.handle })).code).toBe("locked");
    await ask(ada, "room:lock", { room: room.id, locked: false });
    expect((await ask(cleo, "room:join", { handle: room.handle })).ok).toBe(true);
  });

  it("the owner removes somebody, who is told and cannot come back", async () => {
    const [ada, bob] = [await person("Ada O2"), await person("Bob O2")];
    const room = await roomWith("Kick", ada, bob);
    const kicked = record(bob, "room:kicked"), events = record(ada, "room:event"), onBob = record(bob, "message");
    expect((await ask(bob, "room:kick", { room: room.id, id: ada.id })).code).toBe("not_owner");
    expect((await ask(ada, "room:kick", { room: room.id, id: bob.id })).ok).toBe(true);
    await sleep(150);
    expect(kicked).toEqual([{ room: room.id }]);
    expect(events.at(-1)).toMatchObject({ kind: "kick", nickname: "Bob O2" });
    await ask(ada, "message", { room: room.id, body: "bye" });
    await sleep(100);
    expect(onBob).toHaveLength(0); // no longer in the room, even for relays
    expect((await ask(bob, "room:join", { handle: room.handle })).code).toBe("banned");
  });

  it("a new code locks out the old one, and the room is told", async () => {
    const [ada, bob, cleo] = [await person("Ada O3"), await person("Bob O3"), await person("Cleo O3")];
    const room = await roomWith("Rotate", ada, bob);
    const updates = record(bob, "room:updated");
    const next = fresh();
    expect((await ask(bob, "room:newcode", { room: room.id, handle: fresh() })).code).toBe("not_owner");
    expect((await ask(ada, "room:newcode", { room: room.id, handle: "short" })).code).toBe("code_invalid");
    const changed = await ask(ada, "room:newcode", { room: room.id, handle: next });
    await sleep(100);
    expect(changed.ok).toBe(true);
    expect(updates.at(-1).room.rev).toBe(changed.room.rev);
    expect(JSON.stringify(updates)).not.toContain(next);
    expect((await ask(cleo, "room:join", { handle: room.handle })).code).toBe("code_unknown");
    expect((await ask(cleo, "room:join", { handle: next })).ok).toBe(true);
  });

  it("when the owner leaves, somebody else takes over, and the room is told", async () => {
    const [ada, bob] = [await person("Ada O4"), await person("Bob O4")];
    const room = await roomWith("Handover", ada, bob);
    const updates = record(bob, "room:updated"), events = record(bob, "room:event");
    await ask(ada, "room:leave", { room: room.id });
    await sleep(150);
    expect(updates.at(-1).room.ownerId).toBe(bob.id);
    expect(events.some((e) => e.kind === "owner" && e.nickname === "Bob O4")).toBe(true);
    expect((await ask(bob, "room:lock", { room: room.id, locked: true })).ok).toBe(true);
  });
});

describe("the group encryption", () => {
  it("tells the first person of a room that nobody else is there, and the others that someone is", async () => {
    const [ada, bob] = [await person("Ada M1"), await person("Bob M1")];
    const handle = fresh();
    await ask(ada, "room:create", { name: "Group", handle });
    expect(await ask(bob, "room:join", { handle })).toMatchObject({ ok: true, first: false });
    ada.close();
    bob.close();
    await sleep(150);
    const back = await person("Ada M1");
    expect(await ask(back, "room:join", { handle })).toMatchObject({ ok: true, first: true }); // the group is gone with its members: this person starts it again
  });

  it("passes a request to come in to the others of the room, never back to the sender, and never outside", async () => {
    const [ada, bob, eve] = [await person("Ada M2"), await person("Bob M2"), await person("Eve M2")];
    const room = await roomWith("Requests", ada);
    await roomWith("Elsewhere", eve);
    await ask(bob, "room:join", { handle: room.handle });
    const atAda = record(ada, "mls:request"), atBob = record(bob, "mls:request"), atEve = record(eve, "mls:request");
    expect(await ask(bob, "mls:request", { room: room.id, keyPackage: base64("kp"), proof: base64("proof") })).toEqual({ ok: true });
    await sleep(100);
    expect(atAda).toEqual([{ room: room.id, from: { id: bob.id, nickname: "Bob M2" }, keyPackage: base64("kp"), proof: base64("proof") }]);
    expect(atBob).toHaveLength(0);
    expect(atEve).toHaveLength(0);
  });

  it("refuses a request from outside the room, or one that is not base64 text", async () => {
    const [ada, bob] = [await person("Ada M3"), await person("Bob M3")];
    const room = await roomWith("Strict", ada);
    expect((await ask(bob, "mls:request", { room: room.id, keyPackage: base64("kp"), proof: base64("p") })).code).toBe("not_member");
    await ask(bob, "room:join", { handle: room.handle });
    for (const bad of [{ keyPackage: "not base64!", proof: base64("p") }, { keyPackage: base64("kp") }, { keyPackage: "", proof: base64("p") }, { keyPackage: 5, proof: 5 }]) {
      expect((await ask(bob, "mls:request", { room: room.id, ...bad })).code).toBe("bad_mls");
    }
  });

  it("keeps the first change made on an epoch, tells the others, and gives the welcome to the person it is for only", async () => {
    const [ada, bob, cleo] = [await person("Ada M4"), await person("Bob M4"), await person("Cleo M4")];
    const room = await roomWith("Commits", ada, bob, cleo);
    const commitsAtBob = record(bob, "mls:commit"), commitsAtAda = record(ada, "mls:commit");
    const welcomesAtCleo = record(cleo, "mls:welcome"), welcomesAtBob = record(bob, "mls:welcome");
    const accepted = await ask(ada, "mls:commit", { room: room.id, base: 0, commit: base64("c1"), welcome: base64("w1"), to: cleo.id });
    expect(accepted).toEqual({ ok: true, epoch: 1 });
    const late = await ask(bob, "mls:commit", { room: room.id, base: 0, commit: base64("c2") });
    expect(late).toMatchObject({ code: "stale_epoch", epoch: 1 });
    await sleep(100);
    expect(commitsAtBob).toEqual([{ room: room.id, epoch: 1, commit: base64("c1"), from: { id: ada.id, nickname: "Ada M4" } }]);
    expect(commitsAtAda).toHaveLength(0); // the author has it already
    expect(welcomesAtCleo).toEqual([{ room: room.id, epoch: 1, welcome: base64("w1") }]);
    expect(welcomesAtBob).toHaveLength(0);
    expect(await ask(bob, "mls:commit", { room: room.id, base: 1, commit: base64("c3") })).toEqual({ ok: true, epoch: 2 });
  });

  it("refuses a change from outside the room, a welcome for somebody who is not in it, and what is not valid", async () => {
    const [ada, bob, eve] = [await person("Ada M5"), await person("Bob M5"), await person("Eve M5")];
    const room = await roomWith("Strict", ada, bob);
    expect((await ask(eve, "mls:commit", { room: room.id, base: 0, commit: base64("c") })).code).toBe("not_member");
    expect((await ask(ada, "mls:commit", { room: room.id, base: 0, commit: base64("c"), welcome: base64("w"), to: eve.id })).code).toBe("unknown_target");
    expect((await ask(ada, "mls:commit", { room: room.id, base: 0, commit: base64("c"), welcome: base64("w") })).code).toBe("unknown_target");
    for (const bad of [{ base: -1 }, { base: 0.5 }, { base: "0" }, { base: 0, commit: "no!" }, { base: 0, commit: "" }, { base: 0, welcome: "no!", to: bob.id }]) {
      expect((await ask(ada, "mls:commit", { room: room.id, commit: base64("c"), ...bad })).code).toBe("bad_mls");
    }
    expect(await ask(ada, "mls:commit", { room: room.id, base: 0, commit: base64("c") })).toEqual({ ok: true, epoch: 1 }); // none of that moved the epoch
  });
});

describe("robustness", () => {
  it("keeps working when a client sends garbage", async () => {
    const ada = await person("Ada Z1");
    for (const event of ["room:join", "message", "typing", "room:create", "room:newcode", "message:edit", "message:react", "whisper", "room:kick", "mls:request", "mls:commit"]) ada.emit(event, event.length % 2 ? 42 : null);
    await sleep(200);
    expect((await ask(ada, "room:create", { name: "Still fine", handle: fresh() })).ok).toBe(true);
  });

  it("is stopped after too many wrong codes from one address, in its own server", async () => {
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
      const handle = fresh();
      await ask(ada, "room:create", { name: "Guess me", handle });
      const guesser = await open("Guesser G1");
      const answers = [];
      for (let i = 0; i < LIMITS.wrongCodes + 2; i++) answers.push(await ask(guesser, "room:join", { handle: fresh() }));
      expect(answers.slice(0, LIMITS.wrongCodes).every((a) => a.code === "code_unknown")).toBe(true);
      expect(answers.at(-1).code).toBe("too_many_wrong_codes");
      expect((await ask(guesser, "room:join", { handle })).code).toBe("too_many_wrong_codes");
      expect((await ask(guesser, "room:create", { name: "Probe", handle: fresh() })).code).toBe("too_many_wrong_codes"); // creating rooms is no way round it
    } finally {
      await own.close();
    }
  });
});

describe("addresses behind a proxy", () => {
  /** A connection that claims to come from `forwardedFor`, with a nickname. */
  const opener = (port) => async (forwardedFor, nickname) => {
    const socket = connect(`http://localhost:${port}`, { transports: ["websocket"], reconnection: false, extraHeaders: { "X-Forwarded-For": forwardedFor } });
    clients.push(socket);
    await new Promise((resolve) => socket.on("connect", resolve));
    await ask(socket, "hello", { nickname });
    return socket;
  };
  const guess = async (socket) => (await ask(socket, "room:join", { handle: fresh() })).code;

  it("ignores X-Forwarded-For unless told to trust it: claiming another address does not reset the limit", async () => {
    const own = createChatServer({ corsOrigin: "*" });
    const open = opener(await own.listen(0));
    try {
      const first = await open("1.1.1.1", "Guesser A");
      for (let i = 0; i < LIMITS.wrongCodes; i++) await guess(first);
      const second = await open("2.2.2.2", "Guesser B"); // another claimed address, the same real one
      expect(await guess(second)).toBe("too_many_wrong_codes");
    } finally {
      await own.close();
    }
  });

  it("with trustProxy, counts each visitor behind the proxy separately", async () => {
    const own = createChatServer({ corsOrigin: "*", trustProxy: true });
    const open = opener(await own.listen(0));
    try {
      const loud = await open("1.1.1.1", "Loud"), quiet = await open("2.2.2.2", "Quiet");
      for (let i = 0; i < LIMITS.wrongCodes; i++) await ask(loud, "room:join", { handle: fresh() });
      expect((await ask(loud, "room:join", { handle: fresh() })).code).toBe("too_many_wrong_codes");
      expect((await ask(quiet, "room:join", { handle: fresh() })).code).toBe("code_unknown"); // another visitor is not punished
    } finally {
      await own.close();
    }
  });
});

describe("http", () => {
  it("answers a health check with counts, never names or handles", async () => {
    const body = await (await fetch(`http://localhost:${port}/health`)).json();
    expect(body).toMatchObject({ status: "ok", instance: chat.instanceId });
    expect(typeof body.rooms).toBe("number");
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("is not a web server when there is no built client", async () => {
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(404);
  });
});
