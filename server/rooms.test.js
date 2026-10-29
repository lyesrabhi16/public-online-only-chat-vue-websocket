import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  FailureLimiter,
  LIMITS,
  RateLimiter,
  Registry,
  classifyBody,
  cleanNickname,
  cleanRoomName,
  generateCode,
  isMessageId,
  normalizeCode,
} from "./rooms.js";

describe("nicknames and room names", () => {
  it("nicknames are trimmed and have their spaces collapsed", () => {
    expect(cleanNickname("  Ada   Lovelace ").value).toBe("Ada Lovelace");
    expect(cleanNickname("Élodie_42").value).toBe("Élodie_42");
  });

  it.each([["a"], ["x".repeat(21)], ["  "], ["<script>"], ["-dash first"], [42], [null], [{ a: 1 }]])("refuse the nickname %j, with a code", (raw) => {
    const result = cleanNickname(raw);
    expect(result.error).toBeTruthy();
    expect(result.code).toMatch(/^nickname_/);
  });

  it("room names are 2 to 30 characters without control characters", () => {
    expect(cleanRoomName("Movie   night").value).toBe("Movie night");
    expect(cleanRoomName("x").code).toBe("room_name_length");
    expect(cleanRoomName("y".repeat(31)).params).toEqual({ min: 2, max: 30 });
    expect(cleanRoomName("bad\u0007name").code).toBe("room_name_chars");
    expect(cleanRoomName(["a"]).code).toBe("room_name_required");
  });
});

describe("what a message carries", () => {
  it("is measured, not read: short is text, long is a photo or a voice message", () => {
    expect(classifyBody("x".repeat(100))).toEqual({ kind: "text" });
    expect(classifyBody("x".repeat(LIMITS.textBodyMax))).toEqual({ kind: "text" });
    expect(classifyBody("x".repeat(LIMITS.textBodyMax + 1))).toEqual({ kind: "media" });
    expect(classifyBody("x".repeat(LIMITS.mediaBodyMax))).toEqual({ kind: "media" });
  });

  it("refuses nothing, and what is too big", () => {
    expect(classifyBody("").code).toBe("body_required");
    expect(classifyBody(null).code).toBe("body_required");
    expect(classifyBody({ a: 1 }).code).toBe("body_required");
    expect(classifyBody("x".repeat(LIMITS.mediaBodyMax + 1)).code).toBe("body_too_large");
  });

  it("an edit or a whisper can only be text", () => {
    expect(classifyBody("x".repeat(LIMITS.textBodyMax + 1), { textOnly: true }).code).toBe("body_too_large");
    expect(classifyBody("x", { textOnly: true })).toEqual({ kind: "text" });
  });

  it("message ids are UUIDs", () => {
    expect(isMessageId("7c9e6679-7425-40de-944b-e07fc1f90ae7")).toBe(true);
    expect(isMessageId("7c9e6679")).toBe(false);
    expect(isMessageId({ a: 1 })).toBe(false);
  });
});

describe("codes", () => {
  it("have 6 characters, and none that is easy to mix up", () => {
    expect(CODE_LENGTH).toBe(6);
    for (const confusing of "0O1I") expect(CODE_ALPHABET).not.toContain(confusing);
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("are random", () => {
    expect(new Set(Array.from({ length: 500 }, () => generateCode())).size).toBeGreaterThan(495);
  });

  it("are read in any case, with or without separators", () => {
    expect(normalizeCode("k7m2qx")).toBe("K7M2QX");
    expect(normalizeCode("  K7M-2QX ")).toBe("K7M2QX");
    expect(normalizeCode("k7m 2qx")).toBe("K7M2QX");
  });

  it.each([[""], ["K7M2Q"], ["K7M2QXX"], ["K7M20X"], ["K7M2QI"], ["K7M2Q!"], [123456], [null], [{ a: 1 }]])("%j is not a code", (raw) => {
    expect(normalizeCode(raw)).toBeNull();
  });
});

describe("rate limiters", () => {
  it("a burst is allowed, then refused until the window has passed", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    expect([limiter.allow(), limiter.allow(), limiter.allow(), limiter.allow()]).toEqual([true, true, true, false]);
    now = 999;
    expect(limiter.allow()).toBe(false);
    now = 1000;
    expect(limiter.allow()).toBe(true);
  });

  it("an address is blocked after too many failures, for a while, and others are not", () => {
    let now = 0;
    const limiter = new FailureLimiter(3, 1000, () => now);
    limiter.fail("a");
    limiter.fail("a");
    expect(limiter.blocked("a")).toBe(false);
    limiter.fail("a");
    expect(limiter.blocked("a")).toBe(true);
    expect(limiter.blocked("b")).toBe(false);
    now = 1000;
    expect(limiter.blocked("a")).toBe(false);
  });
});

describe("registry", () => {
  const fresh = (generate) => new Registry(generate);
  const person = (r, id, nickname) => r.register(id, nickname).user;

  it("starts with no room at all: they cannot be browsed", () => {
    const r = fresh();
    person(r, "a", "Ada");
    expect(r.rooms.size).toBe(0);
    expect(r.roomsOf("a")).toEqual([]);
    expect(r.stats()).toEqual({ online: 1, rooms: 0 });
  });

  it("refuses a nickname that is online already, whatever the case, and frees it when the person leaves", () => {
    const r = fresh();
    person(r, "a", "Ada");
    expect(r.register("b", "ada")).toMatchObject({ code: "nickname_taken", params: { nickname: "ada" } });
    expect(r.register("a", "Other").code).toBe("already_registered");
    r.unregister("a");
    expect(r.register("b", "Ada").user).toBeTruthy();
  });

  it("a room is created with a code, and its creator is inside and runs it", () => {
    const r = fresh();
    person(r, "a", "Ada");
    const { room } = r.createRoom("a", "  Study   group ");
    expect(room).toMatchObject({ name: "Study group", members: 1, locked: false, ownerId: "a" });
    expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(r.isIn("a", room.id)).toBe(true);
    expect(r.members(room.id)).toEqual([{ id: "a", nickname: "Ada", owner: true }]);
  });

  it("needs a nickname to create or join", () => {
    const r = fresh();
    expect(r.createRoom("ghost", "Room").code).toBe("nickname_required");
    expect(r.joinWithCode("ghost", "ABCDEF").code).toBe("nickname_required");
  });

  it("never gives two rooms the same code, even when the generator repeats itself", () => {
    const codes = ["AAAAAA", "AAAAAA", "AAAAAA", "BBBBBB"];
    const r = fresh(() => codes.shift());
    person(r, "a", "Ada");
    person(r, "b", "Bob");
    expect(r.createRoom("a", "One").room.code).toBe("AAAAAA");
    expect(r.createRoom("b", "Two").room.code).toBe("BBBBBB");
  });

  it("lets somebody in with the code, however it is typed", () => {
    const r = fresh();
    person(r, "a", "Ada");
    person(r, "b", "Bob");
    const { room } = r.createRoom("a", "Study");
    const joined = r.joinWithCode("b", ` ${room.code.slice(0, 3).toLowerCase()}-${room.code.slice(3)} `);
    expect(joined).toMatchObject({ already: false, room: { id: room.id, members: 2 } });
    expect(r.members(room.id).map((m) => m.nickname)).toEqual(["Ada", "Bob"]);
    expect(r.joinWithCode("b", room.code).already).toBe(true);
  });

  it("refuses a code that does not exist, or is not a code, and says to count the failure", () => {
    const r = fresh();
    person(r, "a", "Ada");
    expect(r.joinWithCode("a", "ZZZZZZ")).toMatchObject({ code: "code_unknown", wrongCode: true });
    expect(r.joinWithCode("a", "nope")).toMatchObject({ code: "code_invalid", wrongCode: true });
    expect(r.joinWithCode("a", { code: 1 })).toMatchObject({ wrongCode: true });
  });

  it("a full room refuses without counting a wrong code", () => {
    const r = fresh();
    person(r, "owner", "Owner");
    const { room } = r.createRoom("owner", "Full");
    for (let i = 1; i < LIMITS.membersPerRoom; i++) {
      person(r, `c${i}`, `User ${i}`);
      expect(r.joinWithCode(`c${i}`, room.code).room).toBeTruthy();
    }
    person(r, "late", "Latecomer");
    expect(r.joinWithCode("late", room.code)).toMatchObject({ code: "room_full" });
  });

  it("the last person to leave closes the room, and its code stops working", () => {
    const r = fresh();
    person(r, "a", "Ada");
    person(r, "b", "Bob");
    const { room } = r.createRoom("a", "Temp");
    r.joinWithCode("b", room.code);
    expect(r.leave("a", room.id)).toMatchObject({ left: true, removed: false });
    expect(r.leave("b", room.id)).toMatchObject({ left: true, removed: true });
    expect(r.rooms.size).toBe(0);
    person(r, "c", "Cleo");
    expect(r.joinWithCode("c", room.code).code).toBe("code_unknown");
  });

  it("a room somebody was alone in stays open after a disconnection, so a blip does not lose it", () => {
    const r = fresh();
    person(r, "a", "Ada");
    const { room } = r.createRoom("a", "Blip");
    expect(r.unregister("a").left[0]).toMatchObject({ removed: false, emptied: true });
    person(r, "a2", "Ada");
    const back = r.joinWithCode("a2", room.code);
    expect(back.room).toMatchObject({ id: room.id, members: 1, ownerId: "a2" }); // the one who comes back runs it again
    expect(r.closeIfEmpty(room.id)).toBe(false);
  });

  it("an empty room is closed once the grace period is over, and leaving on purpose closes it at once", () => {
    const r = fresh();
    person(r, "a", "Ada");
    const blip = r.createRoom("a", "Blip").room;
    const onPurpose = r.createRoom("a", "Purpose").room;
    expect(r.leave("a", onPurpose.id).removed).toBe(true);
    r.unregister("a");
    expect(r.closeIfEmpty(blip.id)).toBe(true);
    person(r, "b", "Bob");
    expect(r.joinWithCode("b", blip.code).code).toBe("code_unknown");
  });

  it("limits how many rooms one person is in, and how many rooms exist", () => {
    const r = fresh();
    person(r, "a", "Ada");
    for (let i = 0; i < LIMITS.roomsPerUser; i++) expect(r.createRoom("a", `Room ${i}`).room).toBeTruthy();
    expect(r.createRoom("a", "One more").code).toBe("rooms_per_user");
    const crowded = fresh();
    for (let i = 0; i < LIMITS.rooms; i++) {
      person(crowded, `u${i}`, `User ${i}`);
      expect(crowded.createRoom(`u${i}`, "Room").room).toBeTruthy();
    }
    person(crowded, "extra", "Extra");
    expect(crowded.createRoom("extra", "Too many").code).toBe("too_many_rooms");
  });

  it("finds somebody in a room by nickname, whatever the case", () => {
    const r = fresh();
    person(r, "a", "Ada");
    person(r, "b", "Bob");
    const { room } = r.createRoom("a", "Find");
    r.joinWithCode("b", room.code);
    expect(r.findMember(room.id, "BOB")).toEqual({ id: "b", nickname: "Bob" });
    expect(r.findMember(room.id, "Eve")).toBeNull();
  });
});

describe("running a room", () => {
  const setup = () => {
    const r = new Registry();
    for (const [id, nick] of [["a", "Ada"], ["b", "Bob"], ["c", "Cleo"]]) r.register(id, nick);
    const { room } = r.createRoom("a", "Club");
    r.joinWithCode("b", room.code);
    return { r, room };
  };

  it("only the owner can lock, remove people or change the code", () => {
    const { r, room } = setup();
    expect(r.setLocked("b", room.id, true).code).toBe("not_owner");
    expect(r.kick("b", room.id, "a").code).toBe("not_owner");
    expect(r.newCode("b", room.id).code).toBe("not_owner");
    expect(r.setLocked("c", room.id, true).code).toBe("not_member"); // not even in the room
  });

  it("a locked room lets nobody new in, but its former members can come back", () => {
    const { r, room } = setup();
    expect(r.setLocked("a", room.id, true).room.locked).toBe(true);
    expect(r.joinWithCode("c", room.code).code).toBe("locked");
    r.unregister("b"); // a blip
    r.register("b2", "Bob");
    expect(r.joinWithCode("b2", room.code).room).toBeTruthy(); // Bob was a member: welcome back
    r.setLocked("a", room.id, false);
    expect(r.joinWithCode("c", room.code).room).toBeTruthy();
  });

  it("a person who is removed cannot come back with the code", () => {
    const { r, room } = setup();
    expect(r.kick("a", room.id, "b")).toMatchObject({ target: { nickname: "Bob" } });
    expect(r.isIn("b", room.id)).toBe(false);
    expect(r.joinWithCode("b", room.code).code).toBe("banned");
    expect(r.kick("a", room.id, "a").code).toBe("cannot_kick_self");
    expect(r.kick("a", room.id, "zzz").code).toBe("unknown_target");
  });

  it("a new code replaces the old one", () => {
    const { r, room } = setup();
    const { room: changed } = r.newCode("a", room.id);
    expect(changed.code).not.toBe(room.code);
    expect(r.joinWithCode("c", room.code).code).toBe("code_unknown");
    expect(r.joinWithCode("c", changed.code).room).toBeTruthy();
  });

  it("when the owner leaves, the person who has been there longest takes over", () => {
    const { r, room } = setup();
    r.joinWithCode("c", room.code);
    const left = r.leave("a", room.id);
    expect(left.newOwner).toEqual({ id: "b", nickname: "Bob" });
    expect(r.members(room.id).find((m) => m.owner).nickname).toBe("Bob");
    expect(r.setLocked("b", room.id, true).room.locked).toBe(true);
  });
});
