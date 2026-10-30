import { describe, expect, it } from "vitest";
import { registryContract } from "./registry.contract.js";
import { FailureLimiter, LIMITS, RateLimiter, Registry, classifyBody, cleanNickname, cleanRoomName, isHandle, isMessageId, isMlsText } from "./rooms.js";

describe("nicknames and room names", () => {
  it("nicknames are trimmed and have their spaces collapsed", () => {
    expect(cleanNickname("  Ada   Lovelace ").value).toBe("Ada Lovelace");
    expect(cleanNickname("Élodie_42").value).toBe("Élodie_42");
  });

  it("\"all\" is kept for mentioning everybody, whatever the case", () => {
    for (const reserved of ["all", "ALL", " All "]) expect(cleanNickname(reserved)).toMatchObject({ code: "nickname_reserved", params: { nickname: reserved.trim() } });
    expect(cleanNickname("Allan").value).toBe("Allan");
    expect(cleanNickname("all ears").value).toBe("all ears");
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

describe("handles", () => {
  it("are 64 lowercase hex digits: all the server ever knows of a code", () => {
    expect(isHandle("0123456789abcdef".repeat(4))).toBe(true);
  });

  it.each([[""], ["a".repeat(63)], ["a".repeat(65)], ["A".repeat(64)], ["g".repeat(64)], ["K7M2QXAB9T"], [123], [null], [{ a: 1 }]])("%j is not a handle", (raw) => {
    expect(isHandle(raw)).toBe(false);
  });
});

describe("messages of the group encryption", () => {
  it("are base64 text of a sensible size", () => {
    expect(isMlsText("AAECAw==")).toBe(true);
    expect(isMlsText("x".repeat(LIMITS.mlsMax))).toBe(true);
  });

  it.each([[""], ["x".repeat(LIMITS.mlsMax + 1)], ["not base64!"], [42], [null], [["AAEC"]]])("%j is not one", (raw) => {
    expect(isMlsText(raw)).toBe(false);
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
registryContract("in memory", () => ({ registry: new Registry() }));

describe("the registry in memory", () => {
  it("keeps a count of what is there", () => {
    const r = new Registry();
    r.register("a", "Ada");
    r.createRoom("a", "One", "a".repeat(64));
    expect(r.stats()).toEqual({ online: 1, rooms: 1 });
  });
});
