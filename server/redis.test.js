// The Redis registry: the same contract as the in-memory one, plus what only a cluster needs.
// These tests need a Redis: REDIS_URL=redis://localhost:6379 npm test   (they are skipped without it)
import crypto from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { registryContract } from "./registry.contract.js";
import { RedisFailureLimiter, RedisRegistry } from "./redis.js";

const url = process.env.REDIS_URL;
const redis = url ? new Redis(url) : null;
afterAll(() => redis?.quit());
const prefix = () => `test:${crypto.randomUUID().slice(0, 8)}:`;
const handle = (digit) => digit.repeat(64);

describe.skipIf(!url)("redis", () => {
  registryContract("in Redis", () => {
    const registry = new RedisRegistry(redis, { prefix: prefix() });
    return { registry, cleanup: () => registry.flush() };
  });

  describe("a cluster", () => {
    it("shares everything between servers: a nickname, a room, its handle", async () => {
      const p = prefix();
      const one = new RedisRegistry(redis, { prefix: p, instanceId: "one" });
      const two = new RedisRegistry(redis, { prefix: p, instanceId: "two" });
      try {
        await one.register("a", "Ada");
        expect((await two.register("b", "ada")).code).toBe("nickname_taken"); // taken on the other server
        await two.register("b", "Bob");
        const { room } = await one.createRoom("a", "Shared", handle("a"));
        expect((await two.joinWithHandle("b", handle("a"))).room.members).toBe(2);
        expect((await two.advanceEpoch("b", room.id, 0))).toEqual({ epoch: 1 }); // the epoch is shared too
        expect((await one.advanceEpoch("a", room.id, 0)).code).toBe("stale_epoch");
        expect((await one.members(room.id)).map((m) => m.nickname)).toEqual(["Ada", "Bob"]);
        expect((await one.stats())).toEqual({ online: 2, rooms: 1 });
      } finally {
        await one.flush();
      }
    });

    it("never lets two servers take the same nickname at the same moment", async () => {
      const p = prefix();
      const servers = Array.from({ length: 6 }, (_, i) => new RedisRegistry(redis, { prefix: p, instanceId: `s${i}` }));
      try {
        const results = await Promise.all(servers.map((s, i) => s.register(`c${i}`, "Same Name")));
        expect(results.filter((r) => r.user)).toHaveLength(1);
        expect(results.filter((r) => r.code === "nickname_taken")).toHaveLength(5);
      } finally {
        await servers[0].flush();
      }
    });

    it("never overfills a room, even when many join at once", async () => {
      const p = prefix();
      const server = new RedisRegistry(redis, { prefix: p, instanceId: "one" });
      try {
        await server.register("owner", "Owner");
        const { room } = await server.createRoom("owner", "Rush", handle("a"));
        const people = Array.from({ length: 260 }, (_, i) => `u${i}`);
        await Promise.all(people.map((id, i) => server.register(id, `User ${i}`)));
        const results = await Promise.all(people.map((id) => server.joinWithHandle(id, handle("a"))));
        expect(results.filter((r) => r.room)).toHaveLength(199); // 200 places, the owner has one
        expect(results.filter((r) => r.code === "room_full")).toHaveLength(61);
        expect((await server.roomSummary(room.id)).members).toBe(200);
      } finally {
        await server.flush();
      }
    }, 60_000);

    it("hands out a handle once, even when two servers make rooms at the same moment with the same one", async () => {
      const p = prefix();
      const one = new RedisRegistry(redis, { prefix: p, instanceId: "one" });
      const two = new RedisRegistry(redis, { prefix: p, instanceId: "two" });
      try {
        await one.register("a", "Ada");
        await two.register("b", "Bob");
        const results = await Promise.all([one.createRoom("a", "One", handle("a")), two.createRoom("b", "Two", handle("a"))]);
        expect(results.filter((r) => r.room)).toHaveLength(1);
        expect(results.filter((r) => r.code === "code_unavailable" && r.wrongCode)).toHaveLength(1);
      } finally {
        await one.flush();
      }
    });

    it("removes the people of a server that died, and frees their nicknames and rooms", async () => {
      const p = prefix();
      const dying = new RedisRegistry(redis, { prefix: p, instanceId: "dying" });
      const alive = new RedisRegistry(redis, { prefix: p, instanceId: "alive" });
      try {
        await dying.heartbeat(1); // a heartbeat that expires in a second, and is not renewed: the server has crashed
        await alive.heartbeat(60);
        await dying.register("a", "Ada");
        await alive.register("b", "Bob");
        const { room } = await dying.createRoom("a", "Crash", handle("a"));
        await alive.joinWithHandle("b", handle("a"));
        expect(await alive.reapDead()).toEqual([]); // still alive: nothing to do
        await new Promise((r) => setTimeout(r, 1300));
        const reaped = await alive.reapDead();
        expect(reaped).toHaveLength(1);
        expect(reaped[0].user.nickname).toBe("Ada");
        expect(reaped[0].left[0]).toMatchObject({ roomId: room.id, newOwner: { id: "b", nickname: "Bob" }, emptied: false });
        expect((await alive.members(room.id)).map((m) => m.nickname)).toEqual(["Bob"]);
        expect((await alive.register("c", "Ada")).user).toBeTruthy(); // the nickname is free again
        expect(await alive.reapDead()).toEqual([]); // and it is done only once
      } finally {
        await alive.flush();
      }
    });

    it("lets a server say goodbye, so nobody waits for its heartbeat to expire", async () => {
      const p = prefix();
      const leaving = new RedisRegistry(redis, { prefix: p, instanceId: "leaving" });
      const staying = new RedisRegistry(redis, { prefix: p, instanceId: "staying" });
      try {
        await leaving.heartbeat();
        await staying.heartbeat();
        await leaving.register("a", "Ada");
        await leaving.goodbye();
        const reaped = await staying.reapDead();
        expect(reaped.map((r) => r.user.nickname)).toEqual(["Ada"]);
      } finally {
        await staying.flush();
      }
    });

    it("forgets rooms whose grace period has passed when it counts them", async () => {
      const p = prefix();
      const server = new RedisRegistry(redis, { prefix: p, instanceId: "one" });
      try {
        await server.register("a", "Ada");
        const { room } = await server.createRoom("a", "Fading", handle("a"));
        await server.unregister("a"); // emptied: kept for a while
        await redis.pexpire(`${p}r:${room.id}`, 1); // the while is over
        await new Promise((r) => setTimeout(r, 20));
        expect(await server.roomSummary(room.id)).toBeNull();
        await server.register("b", "Bob");
        expect((await server.createRoom("b", "Fresh", handle("b"))).room).toBeTruthy();
      } finally {
        await server.flush();
      }
    });
  });

  describe("the wrong-code counter", () => {
    it("is shared, blocks after too many, and forgets after its window", async () => {
      const p = prefix();
      const one = new RedisFailureLimiter(redis, { prefix: p, max: 3, windowMs: 400 });
      const two = new RedisFailureLimiter(redis, { prefix: p, max: 3, windowMs: 400 });
      try {
        expect(await one.blocked("1.2.3.4")).toBe(false);
        await one.fail("1.2.3.4");
        await two.fail("1.2.3.4");
        expect(await one.blocked("1.2.3.4")).toBe(false);
        await one.fail("1.2.3.4");
        expect(await two.blocked("1.2.3.4")).toBe(true); // three failures, counted across both servers
        expect(await two.blocked("5.6.7.8")).toBe(false);
        await new Promise((r) => setTimeout(r, 500));
        expect(await one.blocked("1.2.3.4")).toBe(false);
      } finally {
        const keys = await redis.keys(`${p}*`);
        if (keys.length) await redis.del(...keys);
      }
    });
  });
});
