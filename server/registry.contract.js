// What every registry must do, whether it keeps the chat in memory (rooms.js) or in Redis (redis.js).
// One list of tests, run against both: if they ever disagree, this fails.
import { describe, expect, it } from "vitest";
import { LIMITS } from "./rooms.js";

/** The handle of a room as the server sees it: 64 hex digits (what the pages make of a code), here just one digit repeated. */
const handle = (digit) => digit.repeat(64);

/** `make()` answers `{ registry, cleanup }`. */
export function registryContract(label, make) {
  const setup = async () => {
    const { registry, cleanup } = await make();
    return { r: registry, cleanup };
  };
  /** Runs one test with a fresh registry, and cleans up whatever happens. */
  const test = (name, body) =>
    it(name, async () => {
      const ctx = await setup();
      try {
        await body(ctx.r);
      } finally {
        await ctx.cleanup?.();
      }
    });
  const person = async (r, id, nickname) => (await r.register(id, nickname)).user;

  describe(`${label}: people and rooms`, () => {
    test("starts with no room at all: they cannot be browsed", async (r) => {
      await person(r, "a", "Ada");
      expect(await r.roomsOf("a")).toEqual([]);
      expect(await r.stats()).toEqual({ online: 1, rooms: 0 });
    });

    test("refuses a nickname that is online already, whatever the case, and frees it when the person leaves", async (r) => {
      await person(r, "a", "Ada");
      expect(await r.register("b", "ada")).toMatchObject({ code: "nickname_taken", params: { nickname: "ada" } });
      expect((await r.register("a", "Other")).code).toBe("already_registered");
      expect((await r.register("c", "<b>")).code).toBe("nickname_chars");
      await r.unregister("a");
      expect((await r.register("b", "Ada")).user).toBeTruthy();
    });

    test("knows who is who", async (r) => {
      await person(r, "a", "  Ada   Lovelace ");
      expect(await r.user("a")).toMatchObject({ id: "a", nickname: "Ada Lovelace" });
      expect(await r.user("nobody")).toBeUndefined();
    });

    test("a room is created with a handle, and its creator is inside and runs it", async (r) => {
      await person(r, "a", "Ada");
      const { room } = await r.createRoom("a", "  Study   group ", handle("a"));
      expect(room).toMatchObject({ name: "Study group", members: 1, locked: false, ownerId: "a" });
      expect(room.code).toBeUndefined(); // the server knows no code: only the handle, and it does not hand that out
      expect(await r.isIn("a", room.id)).toBe(true);
      expect(await r.members(room.id)).toEqual([{ id: "a", nickname: "Ada", owner: true }]);
      expect(await r.roomsOf("a")).toEqual([room]);
    });

    test("needs a nickname to create or join", async (r) => {
      expect((await r.createRoom("ghost", "Room", handle("a"))).code).toBe("nickname_required");
      expect((await r.joinWithHandle("ghost", handle("a"))).code).toBe("nickname_required");
      expect((await r.createRoom("ghost", "x", handle("a"))).error).toBeTruthy();
    });

    test("never gives two rooms the same handle, and counts the attempt as a wrong code (it would tell which rooms exist)", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      expect((await r.createRoom("a", "One", handle("a"))).room).toBeTruthy();
      expect(await r.createRoom("b", "Two", handle("a"))).toMatchObject({ code: "code_unavailable", wrongCode: true });
      expect((await r.createRoom("b", "Two", handle("b"))).room).toBeTruthy();
    });

    test("refuses a handle that is not 64 hex digits", async (r) => {
      await person(r, "a", "Ada");
      for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63), 5, null, { a: 1 }]) {
        expect((await r.createRoom("a", "Room", bad)).code).toBe("code_invalid");
      }
      expect(await r.stats()).toEqual({ online: 1, rooms: 0 });
    });

    test("lets somebody in with the handle", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Study", handle("a"));
      const joined = await r.joinWithHandle("b", handle("a"));
      expect(joined).toMatchObject({ already: false, first: false, room: { id: room.id, members: 2 } });
      expect((await r.members(room.id)).map((m) => m.nickname)).toEqual(["Ada", "Bob"]);
      expect((await r.joinWithHandle("b", handle("a"))).already).toBe(true);
    });

    test("refuses a handle that does not exist, or is not one, and says to count the failure", async (r) => {
      await person(r, "a", "Ada");
      expect(await r.joinWithHandle("a", handle("f"))).toMatchObject({ code: "code_unknown", wrongCode: true });
      expect(await r.joinWithHandle("a", "nope")).toMatchObject({ code: "code_invalid", wrongCode: true });
      expect(await r.joinWithHandle("a", { code: 1 })).toMatchObject({ wrongCode: true });
    });

    test("a full room refuses without counting a wrong code", async (r) => {
      await person(r, "owner", "Owner");
      await r.createRoom("owner", "Full", handle("a"));
      for (let i = 1; i < LIMITS.membersPerRoom; i++) {
        await person(r, `c${i}`, `User ${i}`);
        expect((await r.joinWithHandle(`c${i}`, handle("a"))).room).toBeTruthy();
      }
      await person(r, "late", "Latecomer");
      const refused = await r.joinWithHandle("late", handle("a"));
      expect(refused.code).toBe("room_full");
      expect(refused.wrongCode).toBeUndefined();
    }, 60_000);

    test("the last person to leave closes the room, and its handle stops working", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Temp", handle("a"));
      await r.joinWithHandle("b", handle("a"));
      expect(await r.leave("a", room.id)).toMatchObject({ left: true, removed: false });
      expect(await r.leave("b", room.id)).toMatchObject({ left: true, removed: true });
      expect((await r.stats()).rooms).toBe(0);
      await person(r, "c", "Cleo");
      expect((await r.joinWithHandle("c", handle("a"))).code).toBe("code_unknown");
    });

    test("somebody who is not in a room cannot leave it", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Mine", handle("a"));
      expect(await r.leave("b", room.id)).toMatchObject({ left: false });
      expect(await r.leave("a", "nope")).toMatchObject({ left: false });
    });

    test("a room somebody was alone in stays open after a disconnection, so a blip does not lose it", async (r) => {
      await person(r, "a", "Ada");
      const { room } = await r.createRoom("a", "Blip", handle("a"));
      expect((await r.unregister("a")).left[0]).toMatchObject({ removed: false, emptied: true });
      await person(r, "a2", "Ada");
      const back = await r.joinWithHandle("a2", handle("a"));
      expect(back.room).toMatchObject({ id: room.id, members: 1, ownerId: "a2" }); // the one who comes back runs it again
      expect(back.first).toBe(true); // and starts the group encryption again
      expect(await r.closeIfEmpty(room.id)).toBe(false);
    });

    test("an empty room is closed once the grace period is over, and leaving on purpose closes it at once", async (r) => {
      await person(r, "a", "Ada");
      const blip = (await r.createRoom("a", "Blip", handle("a"))).room;
      const onPurpose = (await r.createRoom("a", "Purpose", handle("b"))).room;
      expect((await r.leave("a", onPurpose.id)).removed).toBe(true);
      await r.unregister("a");
      expect(await r.closeIfEmpty(blip.id)).toBe(true);
      await person(r, "b", "Bob");
      expect((await r.joinWithHandle("b", handle("a"))).code).toBe("code_unknown");
    });

    test("a disconnection takes a person out of every room", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const one = (await r.createRoom("a", "One", handle("a"))).room;
      await r.createRoom("a", "Two", handle("b"));
      await r.joinWithHandle("b", handle("a"));
      const { user, left } = await r.unregister("a");
      expect(user).toMatchObject({ id: "a", nickname: "Ada" });
      expect(left).toHaveLength(2);
      expect((await r.roomsOf("b")).map((x) => x.id)).toEqual([one.id]);
      expect((await r.members(one.id)).map((m) => m.nickname)).toEqual(["Bob"]);
      expect(await r.unregister("a")).toEqual({ user: null, left: [] }); // nothing left to remove
    });

    test("somebody who was in no room can disconnect too", async (r) => {
      await person(r, "a", "Ada");
      expect(await r.unregister("a")).toEqual({ user: { id: "a", nickname: "Ada" }, left: [] });
      expect(await r.stats()).toEqual({ online: 0, rooms: 0 });
    });

    test("limits how many rooms one person is in", async (r) => {
      await person(r, "a", "Ada");
      const unique = (i) => i.toString(16).padStart(64, "0");
      for (let i = 0; i < LIMITS.roomsPerUser; i++) expect((await r.createRoom("a", `Room ${i}`, unique(i))).room).toBeTruthy();
      expect(await r.createRoom("a", "One more", unique(99))).toMatchObject({ code: "rooms_per_user", params: { max: LIMITS.roomsPerUser } });
      await person(r, "b", "Bob");
      await r.createRoom("b", "Elsewhere", unique(100));
      expect((await r.joinWithHandle("a", unique(100))).code).toBe("rooms_per_user");
    });

    test("limits how many rooms exist", async (r) => {
      for (let i = 0; i < LIMITS.rooms; i++) {
        await person(r, `u${i}`, `User ${i}`);
        expect((await r.createRoom(`u${i}`, "Room", i.toString(16).padStart(64, "0"))).room).toBeTruthy();
      }
      await person(r, "extra", "Extra");
      expect((await r.createRoom("extra", "Too many", "f".repeat(64))).code).toBe("too_many_rooms");
    }, 60_000);

    test("finds somebody in a room by nickname, whatever the case", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Find", handle("a"));
      await r.joinWithHandle("b", handle("a"));
      expect(await r.findMember(room.id, "BOB")).toEqual({ id: "b", nickname: "Bob" });
      expect(await r.findMember(room.id, "Eve")).toBeNull();
    });

    test("describes a room as it is now, or null when it is gone", async (r) => {
      await person(r, "a", "Ada");
      const { room } = await r.createRoom("a", "Look", handle("a"));
      expect(await r.roomSummary(room.id)).toEqual(room);
      await r.leave("a", room.id);
      expect(await r.roomSummary(room.id)).toBeNull();
    });
  });

  describe(`${label}: running a room`, () => {
    const club = async (r) => {
      for (const [id, nick] of [["a", "Ada"], ["b", "Bob"], ["c", "Cleo"]]) await r.register(id, nick);
      const { room } = await r.createRoom("a", "Club", handle("a"));
      await r.joinWithHandle("b", handle("a"));
      return room;
    };

    test("only the owner can lock, remove people or change the code", async (r) => {
      const room = await club(r);
      expect((await r.setLocked("b", room.id, true)).code).toBe("not_owner");
      expect((await r.kick("b", room.id, "a")).code).toBe("not_owner");
      expect((await r.newHandle("b", room.id, handle("b"))).code).toBe("not_owner");
      expect((await r.setLocked("c", room.id, true)).code).toBe("not_member"); // not even in the room
    });

    test("a locked room lets nobody new in, but its former members can come back", async (r) => {
      const room = await club(r);
      expect((await r.setLocked("a", room.id, true)).room.locked).toBe(true);
      expect((await r.joinWithHandle("c", handle("a"))).code).toBe("locked");
      await r.unregister("b"); // a blip
      await r.register("b2", "Bob");
      expect((await r.joinWithHandle("b2", handle("a"))).room).toBeTruthy(); // Bob was a member: welcome back
      await r.setLocked("a", room.id, false);
      expect((await r.joinWithHandle("c", handle("a"))).room).toBeTruthy();
    });

    test("a person who is removed cannot come back with the code", async (r) => {
      const room = await club(r);
      expect(await r.kick("a", room.id, "b")).toMatchObject({ target: { nickname: "Bob" } });
      expect(await r.isIn("b", room.id)).toBe(false);
      expect((await r.joinWithHandle("b", handle("a"))).code).toBe("banned");
      expect((await r.kick("a", room.id, "a")).code).toBe("cannot_kick_self");
      expect((await r.kick("a", room.id, "zzz")).code).toBe("unknown_target");
    });

    test("every change of the room raises its revision, so that a late description can be recognised as old", async (r) => {
      const room = await club(r);
      const seen = [room.rev];
      const note = async (result) => seen.push((result.room ?? (await r.roomSummary(room.id))).rev);
      await note(await r.setLocked("a", room.id, true));
      await note(await r.newHandle("a", room.id, handle("c")));
      await note(await r.setLocked("a", room.id, false)); // open again, so that somebody can come in
      await r.register("d", "Dina");
      const joined = await r.joinWithHandle("d", handle("c"));
      expect(joined.room).toBeTruthy();
      await note(joined);
      await r.leave("d", room.id);
      await note({});
      expect(seen.every((v, i) => i === 0 || v > seen[i - 1]), JSON.stringify(seen)).toBe(true);
    });

    test("a new handle replaces the old one, and cannot be one that another room has", async (r) => {
      const room = await club(r);
      expect((await r.newHandle("a", room.id, handle("b"))).room).toBeTruthy();
      expect((await r.joinWithHandle("c", handle("a"))).code).toBe("code_unknown");
      expect((await r.joinWithHandle("c", handle("b"))).room).toBeTruthy();
      await r.register("d", "Dina");
      await r.createRoom("d", "Other", handle("d"));
      expect(await r.newHandle("a", room.id, handle("d"))).toMatchObject({ code: "code_unavailable", wrongCode: true });
      expect((await r.newHandle("a", room.id, "short")).code).toBe("code_invalid");
    });

    test("when the owner leaves, the person who has been there longest takes over", async (r) => {
      const room = await club(r);
      await r.joinWithHandle("c", handle("a"));
      const left = await r.leave("a", room.id);
      expect(left.newOwner).toEqual({ id: "b", nickname: "Bob" });
      expect((await r.members(room.id)).find((m) => m.owner).nickname).toBe("Bob");
      expect((await r.setLocked("b", room.id, true)).room.locked).toBe(true);
    });
  });

  describe(`${label}: the group encryption`, () => {
    const group = async (r) => {
      for (const [id, nick] of [["a", "Ada"], ["b", "Bob"], ["c", "Cleo"]]) await r.register(id, nick);
      const { room } = await r.createRoom("a", "Club", handle("a"));
      await r.joinWithHandle("b", handle("a"));
      return room;
    };

    test("a room starts at epoch 0 and each change moves it by one", async (r) => {
      const room = await group(r);
      expect(await r.advanceEpoch("a", room.id, 0)).toEqual({ epoch: 1 });
      expect(await r.advanceEpoch("b", room.id, 1)).toEqual({ epoch: 2 });
    });

    test("of two changes made on the same epoch only the first is kept", async (r) => {
      const room = await group(r);
      expect(await r.advanceEpoch("a", room.id, 0)).toEqual({ epoch: 1 });
      expect(await r.advanceEpoch("b", room.id, 0)).toMatchObject({ code: "stale_epoch", epoch: 1 });
      expect(await r.advanceEpoch("b", room.id, 5)).toMatchObject({ code: "stale_epoch", epoch: 1 });
    });

    test("only a member can change the group", async (r) => {
      const room = await group(r);
      expect((await r.advanceEpoch("c", room.id, 0)).code).toBe("not_member");
      expect((await r.advanceEpoch("a", "nope", 0)).code).toBe("not_member");
    });

    test("a room that was empty and is entered again starts over at epoch 0, and says so", async (r) => {
      await r.register("a", "Ada");
      const { room } = await r.createRoom("a", "Blip", handle("a"));
      await r.advanceEpoch("a", room.id, 0);
      await r.unregister("a");
      await r.register("a2", "Ada");
      expect(await r.joinWithHandle("a2", handle("a"))).toMatchObject({ first: true });
      expect(await r.advanceEpoch("a2", room.id, 0)).toEqual({ epoch: 1 });
    });
  });
}
