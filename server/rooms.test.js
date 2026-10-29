import { describe, expect, it } from "vitest";
import { LIMITS, RateLimiter, Registry, cleanNickname, cleanRoomName, cleanText, slugify } from "./rooms.js";

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

  it("slugs drop accents and punctuation", () => {
    expect(slugify("Café & Thé!")).toBe("cafe-the");
    expect(slugify("日本語")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("rate limiter", () => {
  it("allows a burst, then refuses until the window has passed", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    expect([limiter.allow(), limiter.allow(), limiter.allow(), limiter.allow()]).toEqual([true, true, true, false]);
    now = 999;
    expect(limiter.allow()).toBe(false);
    now = 1000;
    expect(limiter.allow()).toBe(true);
  });
});

describe("registry", () => {
  const fresh = () => new Registry();

  it("starts with the default rooms, empty and permanent", () => {
    const r = fresh();
    expect(r.list().map((x) => x.id).sort()).toEqual(["general", "random", "tech"]);
    expect(r.list().every((x) => x.members === 0 && x.permanent)).toBe(true);
  });

  it("refuses a nickname that is online already, whatever the case", () => {
    const r = fresh();
    expect(r.register("a", "Ada").user).toBeTruthy();
    expect(r.register("b", "ada").error).toMatch(/already used/);
    expect(r.register("a", "Other").error).toMatch(/already chose/);
  });

  it("frees the nickname when the person leaves", () => {
    const r = fresh();
    r.register("a", "Ada");
    r.unregister("a");
    expect(r.register("b", "Ada").user).toBeTruthy();
  });

  it("only lets registered people join, and only rooms that exist", () => {
    const r = fresh();
    expect(r.join("ghost", "general").error).toMatch(/nickname/);
    r.register("a", "Ada");
    expect(r.join("a", "nope").error).toMatch(/no longer exists/);
    expect(r.join("a", "general").room.members).toBe(1);
    expect(r.join("a", "general").already).toBe(true);
    expect(r.isIn("a", "general")).toBe(true);
  });

  it("creates rooms, refuses duplicates and gives unique ids", () => {
    const r = fresh();
    const first = r.createRoom("Chess club").room;
    expect(first.id).toBe("chess-club");
    expect(r.createRoom("CHESS CLUB").error).toMatch(/already exists/);
    expect(r.createRoom("Chess-club!").room.id).toBe("chess-club-2"); // same slug, different name
  });

  it("removes a created room when its last member leaves, but keeps the default ones", () => {
    const r = fresh();
    r.register("a", "Ada");
    r.register("b", "Bob");
    const { room } = r.createRoom("Temp");
    r.join("a", room.id);
    r.join("b", room.id);
    expect(r.leave("a", room.id)).toMatchObject({ left: true, removed: false });
    expect(r.leave("b", room.id)).toMatchObject({ left: true, removed: true });
    expect(r.rooms.has(room.id)).toBe(false);
    r.join("a", "general");
    r.leave("a", "general");
    expect(r.rooms.has("general")).toBe(true);
  });

  it("lists members alphabetically and by head count", () => {
    const r = fresh();
    r.register("a", "Zoe");
    r.register("b", "Adam");
    r.join("a", "tech");
    r.join("b", "tech");
    expect(r.members("tech").map((m) => m.nickname)).toEqual(["Adam", "Zoe"]);
    expect(r.list()[0]).toMatchObject({ id: "tech", members: 2 });
  });

  it("limits how many rooms one person can be in", () => {
    const r = fresh();
    r.register("a", "Ada");
    for (let i = 0; i < LIMITS.roomsPerUser; i++) r.join("a", r.createRoom(`Room ${i}`).room.id);
    expect(r.join("a", "general").error).toMatch(/rooms at a time/);
  });

  it("limits the number of rooms and the size of a room", () => {
    const r = fresh();
    for (let i = r.rooms.size; i < LIMITS.rooms; i++) expect(r.createRoom(`Room number ${i}`).room).toBeTruthy();
    expect(r.createRoom("One too many").error).toMatch(/too many rooms/);
    const full = fresh();
    for (let i = 0; i < LIMITS.membersPerRoom; i++) {
      full.register(`c${i}`, `User ${i}`);
      full.join(`c${i}`, "general");
    }
    full.register("late", "Latecomer");
    expect(full.join("late", "general").error).toMatch(/full/);
  });

  it("takes a person out of every room when they disconnect", () => {
    const r = fresh();
    r.register("a", "Ada");
    r.join("a", "general");
    r.join("a", "random");
    const { left } = r.unregister("a");
    expect(left.map((l) => l.roomId).sort()).toEqual(["general", "random"]);
    expect(r.members("general")).toEqual([]);
  });
});
