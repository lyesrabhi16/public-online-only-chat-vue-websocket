// What every registry must do, whether it keeps the chat in memory (rooms.js) or in Redis (redis.js).
// One list of tests, run against both: if they ever disagree, this fails.
import { describe, expect, it } from "vitest";
import { LIMITS } from "./rooms.js";

/** `make(generate)` answers `{ registry, cleanup }`; `generate` replaces the random code maker when given. */
export function registryContract(label, make) {
  const setup = async (generate) => {
    const { registry, cleanup } = await make(generate);
    return { r: registry, cleanup };
  };
  /** Runs one test with a fresh registry, and cleans up whatever happens. */
  const test = (name, body) =>
    it(name, async () => {
      const ctx = await setup(body.generate);
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

    test("a room is created with a code, and its creator is inside and runs it", async (r) => {
      await person(r, "a", "Ada");
      const { room } = await r.createRoom("a", "  Study   group ");
      expect(room).toMatchObject({ name: "Study group", members: 1, locked: false, ownerId: "a" });
      expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(await r.isIn("a", room.id)).toBe(true);
      expect(await r.members(room.id)).toEqual([{ id: "a", nickname: "Ada", owner: true }]);
      expect(await r.roomsOf("a")).toEqual([room]);
    });

    test("needs a nickname to create or join", async (r) => {
      expect((await r.createRoom("ghost", "Room")).code).toBe("nickname_required");
      expect((await r.joinWithCode("ghost", "ABCDEF")).code).toBe("nickname_required");
      expect((await r.createRoom("ghost", "x")).error).toBeTruthy();
    });

    const codes = ["AAAAAA", "AAAAAA", "AAAAAA", "BBBBBB"];
    const repeating = () => codes.shift();
    const repeatingTest = async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      expect((await r.createRoom("a", "One")).room.code).toBe("AAAAAA");
      expect((await r.createRoom("b", "Two")).room.code).toBe("BBBBBB");
    };
    repeatingTest.generate = repeating;
    test("never gives two rooms the same code, even when the generator repeats itself", repeatingTest);

    test("lets somebody in with the code, however it is typed", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Study");
      const joined = await r.joinWithCode("b", ` ${room.code.slice(0, 3).toLowerCase()}-${room.code.slice(3)} `);
      expect(joined).toMatchObject({ already: false, room: { id: room.id, members: 2 } });
      expect((await r.members(room.id)).map((m) => m.nickname)).toEqual(["Ada", "Bob"]);
      expect((await r.joinWithCode("b", room.code)).already).toBe(true);
    });

    test("refuses a code that does not exist, or is not a code, and says to count the failure", async (r) => {
      await person(r, "a", "Ada");
      expect(await r.joinWithCode("a", "ZZZZZZ")).toMatchObject({ code: "code_unknown", wrongCode: true });
      expect(await r.joinWithCode("a", "nope")).toMatchObject({ code: "code_invalid", wrongCode: true });
      expect(await r.joinWithCode("a", { code: 1 })).toMatchObject({ wrongCode: true });
    });

    test("a full room refuses without counting a wrong code", async (r) => {
      await person(r, "owner", "Owner");
      const { room } = await r.createRoom("owner", "Full");
      for (let i = 1; i < LIMITS.membersPerRoom; i++) {
        await person(r, `c${i}`, `User ${i}`);
        expect((await r.joinWithCode(`c${i}`, room.code)).room).toBeTruthy();
      }
      await person(r, "late", "Latecomer");
      const refused = await r.joinWithCode("late", room.code);
      expect(refused.code).toBe("room_full");
      expect(refused.wrongCode).toBeUndefined();
    }, 60_000);

    test("the last person to leave closes the room, and its code stops working", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Temp");
      await r.joinWithCode("b", room.code);
      expect(await r.leave("a", room.id)).toMatchObject({ left: true, removed: false });
      expect(await r.leave("b", room.id)).toMatchObject({ left: true, removed: true });
      expect((await r.stats()).rooms).toBe(0);
      await person(r, "c", "Cleo");
      expect((await r.joinWithCode("c", room.code)).code).toBe("code_unknown");
    });

    test("somebody who is not in a room cannot leave it", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Mine");
      expect(await r.leave("b", room.id)).toMatchObject({ left: false });
      expect(await r.leave("a", "nope")).toMatchObject({ left: false });
    });

    test("a room somebody was alone in stays open after a disconnection, so a blip does not lose it", async (r) => {
      await person(r, "a", "Ada");
      const { room } = await r.createRoom("a", "Blip");
      expect((await r.unregister("a")).left[0]).toMatchObject({ removed: false, emptied: true });
      await person(r, "a2", "Ada");
      const back = await r.joinWithCode("a2", room.code);
      expect(back.room).toMatchObject({ id: room.id, members: 1, ownerId: "a2" }); // the one who comes back runs it again
      expect(await r.closeIfEmpty(room.id)).toBe(false);
    });

    test("an empty room is closed once the grace period is over, and leaving on purpose closes it at once", async (r) => {
      await person(r, "a", "Ada");
      const blip = (await r.createRoom("a", "Blip")).room;
      const onPurpose = (await r.createRoom("a", "Purpose")).room;
      expect((await r.leave("a", onPurpose.id)).removed).toBe(true);
      await r.unregister("a");
      expect(await r.closeIfEmpty(blip.id)).toBe(true);
      await person(r, "b", "Bob");
      expect((await r.joinWithCode("b", blip.code)).code).toBe("code_unknown");
    });

    test("a disconnection takes a person out of every room", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const one = (await r.createRoom("a", "One")).room;
      await r.createRoom("a", "Two");
      await r.joinWithCode("b", one.code);
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
      for (let i = 0; i < LIMITS.roomsPerUser; i++) expect((await r.createRoom("a", `Room ${i}`)).room).toBeTruthy();
      expect(await r.createRoom("a", "One more")).toMatchObject({ code: "rooms_per_user", params: { max: LIMITS.roomsPerUser } });
      await person(r, "b", "Bob");
      const other = (await r.createRoom("b", "Elsewhere")).room;
      expect((await r.joinWithCode("a", other.code)).code).toBe("rooms_per_user");
    });

    test("limits how many rooms exist", async (r) => {
      for (let i = 0; i < LIMITS.rooms; i++) {
        await person(r, `u${i}`, `User ${i}`);
        expect((await r.createRoom(`u${i}`, "Room")).room).toBeTruthy();
      }
      await person(r, "extra", "Extra");
      expect((await r.createRoom("extra", "Too many")).code).toBe("too_many_rooms");
    }, 60_000);

    test("finds somebody in a room by nickname, whatever the case", async (r) => {
      await person(r, "a", "Ada");
      await person(r, "b", "Bob");
      const { room } = await r.createRoom("a", "Find");
      await r.joinWithCode("b", room.code);
      expect(await r.findMember(room.id, "BOB")).toEqual({ id: "b", nickname: "Bob" });
      expect(await r.findMember(room.id, "Eve")).toBeNull();
    });

    test("describes a room as it is now, or null when it is gone", async (r) => {
      await person(r, "a", "Ada");
      const { room } = await r.createRoom("a", "Look");
      expect(await r.roomSummary(room.id)).toEqual(room);
      await r.leave("a", room.id);
      expect(await r.roomSummary(room.id)).toBeNull();
    });
  });

  describe(`${label}: running a room`, () => {
    const club = async (r) => {
      for (const [id, nick] of [["a", "Ada"], ["b", "Bob"], ["c", "Cleo"]]) await r.register(id, nick);
      const { room } = await r.createRoom("a", "Club");
      await r.joinWithCode("b", room.code);
      return room;
    };

    test("only the owner can lock, remove people or change the code", async (r) => {
      const room = await club(r);
      expect((await r.setLocked("b", room.id, true)).code).toBe("not_owner");
      expect((await r.kick("b", room.id, "a")).code).toBe("not_owner");
      expect((await r.newCode("b", room.id)).code).toBe("not_owner");
      expect((await r.setLocked("c", room.id, true)).code).toBe("not_member"); // not even in the room
    });

    test("a locked room lets nobody new in, but its former members can come back", async (r) => {
      const room = await club(r);
      expect((await r.setLocked("a", room.id, true)).room.locked).toBe(true);
      expect((await r.joinWithCode("c", room.code)).code).toBe("locked");
      await r.unregister("b"); // a blip
      await r.register("b2", "Bob");
      expect((await r.joinWithCode("b2", room.code)).room).toBeTruthy(); // Bob was a member: welcome back
      await r.setLocked("a", room.id, false);
      expect((await r.joinWithCode("c", room.code)).room).toBeTruthy();
    });

    test("a person who is removed cannot come back with the code", async (r) => {
      const room = await club(r);
      expect(await r.kick("a", room.id, "b")).toMatchObject({ target: { nickname: "Bob" } });
      expect(await r.isIn("b", room.id)).toBe(false);
      expect((await r.joinWithCode("b", room.code)).code).toBe("banned");
      expect((await r.kick("a", room.id, "a")).code).toBe("cannot_kick_self");
      expect((await r.kick("a", room.id, "zzz")).code).toBe("unknown_target");
    });

    test("every change of the room raises its revision, so that a late description can be recognised as old", async (r) => {
      const room = await club(r);
      const seen = [room.rev];
      const note = async (result) => seen.push((result.room ?? (await r.roomSummary(room.id))).rev);
      await note(await r.setLocked("a", room.id, true));
      await note(await r.newCode("a", room.id));
      await note(await r.setLocked("a", room.id, false)); // open again, so that somebody can come in
      await r.register("d", "Dina");
      const joined = await r.joinWithCode("d", (await r.roomSummary(room.id)).code);
      expect(joined.room).toBeTruthy();
      await note(joined);
      await r.leave("d", room.id);
      await note({});
      expect(seen.every((v, i) => i === 0 || v > seen[i - 1]), JSON.stringify(seen)).toBe(true);
    });

    test("a new code replaces the old one", async (r) => {
      const room = await club(r);
      const { room: changed } = await r.newCode("a", room.id);
      expect(changed.code).not.toBe(room.code);
      expect((await r.joinWithCode("c", room.code)).code).toBe("code_unknown");
      expect((await r.joinWithCode("c", changed.code)).room).toBeTruthy();
    });

    test("when the owner leaves, the person who has been there longest takes over", async (r) => {
      const room = await club(r);
      await r.joinWithCode("c", room.code);
      const left = await r.leave("a", room.id);
      expect(left.newOwner).toEqual({ id: "b", nickname: "Bob" });
      expect((await r.members(room.id)).find((m) => m.owner).nickname).toBe("Bob");
      expect((await r.setLocked("b", room.id, true)).room.locked).toBe(true);
    });
  });
}
