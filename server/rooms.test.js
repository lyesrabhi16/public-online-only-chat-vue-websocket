import { describe, expect, it } from "vitest";
import { registryContract } from "./registry.contract.js";
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

// What the registry does is in registry.contract.js, which also runs against Redis (redis.test.js).
registryContract("in memory", (generate) => ({ registry: new Registry(generate) }));

describe("the registry in memory", () => {
  it("keeps a count of what is there", () => {
    const r = new Registry();
    r.register("a", "Ada");
    r.createRoom("a", "One");
    expect(r.stats()).toEqual({ online: 1, rooms: 1 });
  });
});
