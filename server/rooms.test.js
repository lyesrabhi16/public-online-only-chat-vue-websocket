import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  FailureLimiter,
  LIMITS,
  RateLimiter,
  Registry,
  cleanNickname,
  cleanRoomName,
  cleanText,
  generateCode,
  normalizeCode,
} from "./rooms.js";

describe("nicknames", () => {
  it("are trimmed and have their spaces collapsed", () => {
    expect(cleanNickname("  Ada   Lovelace ").value).toBe("Ada Lovelace");
  });

  it("accept accents and digits", () => {
    expect(cleanNickname("Élodie_42").value).toBe("Élodie_42");
  });

  it.each([["a"], ["x".repeat(21)], ["  "], ["<script>"], ["-dash first"], [42], [null], [{ a: 1 }]])("refuse %j", (raw) => {
    expect(cleanNickname(raw).error).toBeTruthy();
  });
});

describe("room names and messages", () => {
  it("room names are 2 to 30 characters without control characters", () => {
    expect(cleanRoomName("Movie   night").value).toBe("Movie night");
    expect(cleanRoomName("x").error).toBeTruthy();
    expect(cleanRoomName("y".repeat(31)).error).toBeTruthy();
    expect(cleanRoomName("bad\u0007name").error).toBeTruthy();
    expect(cleanRoomName(["a"]).error).toBeTruthy();
  });

  it("messages are trimmed, non-empty text of at most 500 characters", () => {
    expect(cleanText("  hello \r\n world ").value).toBe("hello \n world");
    expect(cleanText("   ").error).toBeTruthy();
    expect(cleanText("z".repeat(LIMITS.textMax)).value).toHaveLength(LIMITS.textMax);
    expect(cleanText("z".repeat(LIMITS.textMax + 1)).error).toBeTruthy();
    expect(cleanText({ toString: () => "sneaky" }).error).toBeTruthy();
  });
});

describe("codes", () => {
  it("have 6 characters, and none that is easy to mix up", () => {
    expect(CODE_LENGTH).toBe(6);
    for (const confusing of "0O1I") expect(CODE_ALPHABET).not.toContain(confusing);
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("are random", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(495);
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
    expect(limiter.blocked("a")).toBe(false);
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
  });

  it("refuses a nickname that is online already, whatever the case, and frees it when the person leaves", () => {
    const r = fresh();
    person(r, "a", "Ada");
    expect(r.register("b", "ada").error).toMatch(/already used/);
    expect(r.register("a", "Other").error).toMatch(/already chose/);
    r.unregister("a");
    expect(r.register("b", "Ada").user).toBeTruthy();
  });

  it("a room is created with a code, and its creator is inside", () => {
    const r = fresh();
    person(r, "a", "Ada");
    const { room } = r.createRoom("a", "  Study   group ");
    expect(room).toMatchObject({ name: "Study group", members: 1 });
    expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(r.isIn("a", room.id)).toBe(true);
    expect(r.roomsOf("a")).toEqual([room]);
  });

  it("needs a nickname to create or join", () => {
    const r = fresh();
    expect(r.createRoom("ghost", "Room").error).toMatch(/nickname/);
    expect(r.joinWithCode("ghost", "ABCDEF").error).toMatch(/nickname/);
  });

  it("two rooms can have the same name: their codes tell them apart", () => {
    const r = fresh();
    person(r, "a", "Ada");
    person(r, "b", "Bob");
    const one = r.createRoom("a", "Study").room;
    const two = r.createRoom("b", "Study").room;
    expect(one.code).not.toBe(two.code);
    expect(one.id).not.toBe(two.id);
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
    expect(r.joinWithCode("a", "ZZZZZZ")).toMatchObject({ wrongCode: true, error: expect.stringMatching(/No room/) });
    expect(r.joinWithCode("a", "nope")).toMatchObject({ wrongCode: true, error: expect.stringMatching(/not a room code/) });
    expect(r.joinWithCode("a", { code: 1 })).toMatchObject({ wrongCode: true });
  });

  it("does not count as a wrong code when the room is full or the person is in too many", () => {
    const r = fresh();
    person(r, "owner", "Owner");
    const { room } = r.createRoom("owner", "Full");
    for (let i = 1; i < LIMITS.membersPerRoom; i++) {
      person(r, `c${i}`, `User ${i}`);
      expect(r.joinWithCode(`c${i}`, room.code).room).toBeTruthy();
    }
    person(r, "late", "Latecomer");
    expect(r.joinWithCode("late", room.code)).toEqual({ error: "This room is full." });
  });

  it("the last person to leave closes the room, and its code stops working", () => {
    const r = fresh();
    person(r, "a", "Ada");
    person(r, "b", "Bob");
    const { room } = r.createRoom("a", "Temp");
    r.joinWithCode("b", room.code);
    expect(r.leave("a", room.id)).toMatchObject({ left: true, removed: false });
    expect(r.joinWithCode("a", room.code).room).toBeTruthy(); // still open while Bob is in
    r.leave("a", room.id);
    expect(r.leave("b", room.id)).toMatchObject({ left: true, removed: true });
    expect(r.rooms.size).toBe(0);
    person(r, "c", "Cleo");
    expect(r.joinWithCode("c", room.code).error).toMatch(/No room/);
  });

  it("a disconnection takes a person out of every room", () => {
    const r = fresh();
    person(r, "a", "Ada");
    person(r, "b", "Bob");
    const one = r.createRoom("a", "One").room;
    r.createRoom("a", "Two");
    r.joinWithCode("b", one.code);
    const { left } = r.unregister("a");
    expect(left).toHaveLength(2);
    expect(r.roomsOf("b").map((x) => x.id)).toEqual([one.id]);
    expect(r.members(one.id).map((m) => m.nickname)).toEqual(["Bob"]);
  });

  it("a room somebody was alone in stays open after a disconnection, for a moment, so a blip does not lose it", () => {
    const r = fresh();
    person(r, "a", "Ada");
    const { room } = r.createRoom("a", "Blip");
    expect(r.unregister("a").left[0]).toMatchObject({ removed: false, emptied: true });
    person(r, "a2", "Ada");
    expect(r.joinWithCode("a2", room.code).room).toMatchObject({ id: room.id, members: 1 }); // back with the same code
    expect(r.closeIfEmpty(room.id)).toBe(false); // somebody is in it again
  });

  it("an empty room is closed once the grace period is over, and leaving on purpose closes it at once", () => {
    const r = fresh();
    person(r, "a", "Ada");
    const blip = r.createRoom("a", "Blip").room;
    const onPurpose = r.createRoom("a", "Purpose").room;
    expect(r.leave("a", onPurpose.id).removed).toBe(true);
    r.unregister("a");
    expect(r.closeIfEmpty(blip.id)).toBe(true);
    expect(r.rooms.size).toBe(0);
    person(r, "b", "Bob");
    expect(r.joinWithCode("b", blip.code).error).toMatch(/No room/);
  });

  it("limits how many rooms one person is in, and how many rooms exist", () => {
    const r = fresh();
    person(r, "a", "Ada");
    for (let i = 0; i < LIMITS.roomsPerUser; i++) expect(r.createRoom("a", `Room ${i}`).room).toBeTruthy();
    expect(r.createRoom("a", "One more").error).toMatch(/rooms at a time/);
    const crowded = fresh();
    for (let i = 0; i < LIMITS.rooms; i++) {
      person(crowded, `u${i}`, `User ${i}`);
      expect(crowded.createRoom(`u${i}`, "Room").room).toBeTruthy();
    }
    person(crowded, "extra", "Extra");
    expect(crowded.createRoom("extra", "Too many").error).toMatch(/too many rooms/);
  });
});
