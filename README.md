# Chat rooms joined with a code: live only (Vue 3 + Socket.IO)

Chat rooms with two rules. **A room can only be entered with its code**, and **nothing is ever stored**. A message is relayed to the people who are in the room at that moment and that is all: join late, or reconnect, and the room looks empty. There are no accounts: you pick a nickname, then create a room and share its code (or an invite link), or join one with the code you were given. What people write is **encrypted in their browsers with MLS** (RFC 9420, the group-messaging standard), and **the server never sees the room code**, only a hash of it. The server can **run on several machines** sharing the chat through Redis.

| | | |
| :---: | :---: | :---: |
| <img src="docs/screenshots/welcome.png" width="250" alt="The first screen, for somebody who came with an invite link"> | <img src="docs/screenshots/invite.png" width="250" alt="The invite dialog with a QR code"> | <img src="docs/screenshots/phone.png" width="160" alt="A room on a phone: a late joiner only sees what is said after arriving"> |

<img src="docs/screenshots/conversation.png" alt="A conversation: a reply, a mention, a photo, a voice message with its waveform, reactions">

More: [picking somebody to mention](docs/screenshots/mentions.png) · [recording a voice message](docs/screenshots/recording.png) · [unread counters, with a mention](docs/screenshots/unread.png) · [dark mode](docs/screenshots/dark.png) · [in French](docs/screenshots/french.png)

## What you can do

- **Rooms and codes**: create a room and you are inside, running it, with its **code** (ten letters and digits such as `K7M2Q XAB9T`). Anybody who has the code can come in; nobody else can. Rooms cannot be browsed or listed. Somebody who comes in is let into the encrypted group by a member who is there, so a room nobody answers in cannot be entered (the newcomer is told after 20 seconds).
- **Invite**: an **invite link** (`/#/join/K7M2QXAB9T`, the code is after the `#`, which browsers never send to a server) and a **QR code** to scan with a phone, with the share sheet where the browser has one. The code is taken out of the address bar as soon as the page has read it.
- **Messages**: text, **photos** (shrunk to 900 px in the browser), **voice messages** (up to 30 seconds, recorded with a **live scrolling waveform**, shown as loudness bars that fill while they play), **replies** (the quoted message is shown), **edit** and **delete** (your own), **reactions** (👍 ❤️ 😂 😮 😢 🎉), **@mentions** (typing `@` opens a list of the people in the room to pick from, with the arrow keys, Enter or Tab, or a click; `@all` mentions everybody; a mention is highlighted, yours in a stronger colour) and **whispers** to one person (`/w Nickname message`).
- **Keeping up**: an unread counter per room (with a mark when somebody mentioned you), the count in the browser tab title, a **chime of its own when you are mentioned** (by name or with `@all`, on unless you turn it off in the settings), an optional beep for any other new message you are not looking at, and optional desktop notifications (which never contain what was said), "typing…", who is in the room, "joined / left" notices.
- **Running a room**: the person who runs it can **lock** it (nobody new comes in, but people who were in can come back after a connection blip), **remove** somebody (who cannot come back with the code), or make a **new code** (the old one stops finding the room; the members learn the new one through the encrypted group). If the owner leaves, the person who has been there longest takes over. Anybody can **mute** somebody: their messages disappear from your screen only.
- **Live only**: the server keeps no history and the browser stores nothing (no cookie, no local storage). Leaving a room forgets everything said in it. A room exists while somebody is in it; if the last person was only disconnected it stays open for a minute, so a blip does not cost you your room and code.
- **Reconnection**: if the connection drops, the page says hello again with the same nickname, goes back into its rooms using their codes, and asks the members to let it back into the group (what was said while it was away is lost).
- **Installable** as an app (the page's files are kept for fast starts; never what was said), **light and dark themes**, **English and French** (the language of the browser, changeable in the settings), a layout for phones.

## Encryption, and its limits

**How it works.** The code never leaves the browsers. Each browser turns it, with **Argon2id** (64 MiB, 3 passes, about a second), into three separate secrets: a **handle** (all the server ever learns, and what it finds the room by), a **pre-shared key** and an **admission key**. The people in a room form an **MLS group** (RFC 9420, through the [ts-mls](https://github.com/LukaJCB/ts-mls) library, cipher suite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`):

```
Bob types the code ──► Argon2id ──► handle ─────────────────────► server: "which room?"  (the server finds it, sees nothing else)
                                 ├► admission key ─► proof ────► the members: "I know the code" (HMAC over Bob's key package)
                                 └► pre-shared key (PSK)
Ada (the oldest member there) checks the proof, then commits "add Bob" + the PSK:
   Bob can only read the welcome if he has the PSK; the server relays it and cannot.
Every message, edit and photo: MLS application message, readable by the members of the current epoch only.
```

- **Joining needs the code**: the PSK goes into the keys of the epoch that adds a member, so somebody without the code cannot read the welcome, and the server, which has only the handle, cannot join. A member ignores any request without a valid proof.
- **Forward secrecy**: the keys move on with every message and every change of the group. Somebody who comes in cannot read what was said before; somebody who is removed cannot read what comes after (tested). A change of the group is made on an epoch and the server keeps the first one made on it (a compare-and-set, in Redis too), so members agree on the order.
- **Who looks after the group**: the oldest member who is still in the room lets newcomers in and takes out the people who left or whose connection dropped. Everybody works out the same member; if two act at once the server keeps one and the other follows it. A page also refuses a commit that adds somebody without the PSK or does anything a room never does.
- **A new code** is chosen by the owner's page. The server only learns its handle; the members learn the code itself through the group (a message that is not shown) and only from the owner.
- **Photos, voice messages, edits, replies** are MLS messages too. **Whispers** use a key derived from the group's secrets for the two people (see below).

**What this does and does not protect against.**

- **Protected**: somebody who reads the network traffic, the server's memory or logs, or what travels through Redis sees handles, sizes and timing, never a code, a key or a word. The server's operator cannot read messages and cannot get into a room by itself.
- **Not protected, and the big one**: a code has **10 characters, 50 bits**. Whoever has a room's handle (the server's operator, anybody with access to its memory or Redis) can **try every code offline**, each try costing one Argon2id run. That is about 10¹⁵ runs; at a rough 0.15 s of one CPU core each and a few cents per core-hour, it comes to **about two billion dollars** to find the code of *every* room at once (one pass tests all handles, and the salt is the same for everybody, so the work is reusable). That is far out of reach for most attackers, but it is a price, not a proof, and it only holds while hardware stays this expensive: a code is a password, and a longer one is the real fix. With the code, an attacker can join the group as a member and read **from then on** (not the past); the page shows the server's list of people, so a dishonest server could hide them from it. For comparison, an 8-character code would cost a few million dollars and a 6-character one about two thousand.
- **Whispers** are routed only to the person they are for, but their key is derivable by every member of the group (it protects them from the server, not from the other members), and a whisper made just as the group changes may arrive unreadable.
- **Members are not authenticated beyond the code.** The server tells each page who is who; the library does not say which member encrypted a message, so a dishonest server could relabel who said what, and a member who knows the code is as good as any other.
- **Metadata is visible to the server**: who is in which room, nicknames, room names, when and how much people write, who is typing, and reactions (the emoji and which message).
- **An isolated joiner**: the server decides whether a person is the first in a room; a dishonest server could tell a newcomer they are alone. They would be in a group with nobody else, never one that leaks.
- **The library has not been audited** (its README says so), and this code has been tested but not reviewed by a cryptographer. It needs a recent browser (Ed25519 in Web Crypto: Chrome 137, Firefox 129, Safari 17) on https or localhost, and says so otherwise.

Photos and voice messages are checked by the page that receives them (an image must be a JPEG, PNG or WebP data URL, never an SVG or a script; audio must be a known kind): anything else is shown as "this message could not be read".

## Run it

```bash
npm install
npm run build && npm start        # the server also serves the page: http://localhost:3000
```

For development, in two terminals (the page reloads as you edit):

```bash
npm run dev-server                # Socket.IO server on :3000 (restarts on change)
npm run dev                       # Vite dev server on http://localhost:5173
```

Or with Docker (page and chat in one container): `docker compose up --build` → http://localhost:3000. `nix develop` gives you Node 22 and Docker Compose if you use Nix.

Voice messages, notifications and the installable app need a secure context: `localhost` or HTTPS.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | port of the server |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | pages that may connect from another address (comma-separated, or `*`). Not needed when the server serves the page itself |
| `VITE_SOCKET_URL` | this site (production), `http://<host>:3000` (dev) | address of the server, set at build time |
| `REDIS_URL` | not set | with a Redis, several servers share the chat (see below) |
| `INSTANCE_ID` | random | the name of this server in a cluster |
| `MESSAGE_SECRET` | random, or shared through Redis | signs the proofs that let you edit your own messages |
| `TRUST_PROXY` | `0` | `1`: read the visitor's address from `X-Forwarded-For` (only behind a proxy that sets it itself, as `deploy/nginx.conf` does) |

## Several servers

On its own, the server keeps everything in its memory. With `REDIS_URL` it keeps *who is online and which rooms exist* in Redis instead, so that any number of servers behind a load balancer behave as one chat:

```
                         ┌─────────┐        ┌─────────────────────────────┐
 browsers ── WebSocket ─►│  nginx  │───────►│ chat1 ◄──┐       ┌──► chat2 │
                         └─────────┘        └──────────┼───────┼──────────┘
                                                       ▼       ▼
                                             Redis: nicknames, rooms, codes, who is in them (no messages)
                                                 + pub/sub that carries each message to the other servers
```

```bash
docker compose -f docker-compose.scale.yaml up --build     # Redis, two chat servers, nginx on http://localhost:8080
npm run scale-check                                         # people on different servers find each other
```

- **State in Redis**: each change that must not be interrupted (taking a nickname, entering a room that has one place left, closing a room when its last person leaves, handing a room to somebody else) is a **Lua script**, which Redis runs as one step: two servers can never give the same nickname or the same code, or overfill a room. Messages are never written to Redis: they go through its pub/sub (the Socket.IO Redis adapter) and are gone once delivered.
- **Any server takes any visitor**: the page uses WebSockets only, so the load balancer needs no sticky sessions.
- **Wrong codes are counted across servers**, so trying one guess on each server in turn does not help.
- **A server that dies** (killed, crashed, machine lost) would leave its people "online" for ever. Every server refreshes a heartbeat key that expires; the others notice a missing one, remove that server's people, free their nicknames and tell the rooms ("Bob left", a new owner if needed). In the Docker test, a killed server was noticed after about 12 seconds. nginx gives up on a dead server after 2 seconds, so visitors are not kept waiting.
- **No stale state**: every change of a room (somebody joins or leaves, a lock, a new code, a new owner) raises a revision number that travels with the room's description. Two servers announcing at nearly the same moment can deliver their messages in either order, so a page ignores any description older than the one it has. (A test in this repo failed about one run in four before this was added: a join announcement, computed a moment before a lock, arrived after it and undid it on screen.)
- **Proofs are shared**: the secret that signs the right to edit a message is made by the first server and read from Redis by the others (or set with `MESSAGE_SECRET`), so you can reconnect to another server and still edit your message.
- **Not done**: Redis itself is a single point of failure (use a managed or replicated Redis for that); and the rooms are in one Redis, which is the limit of this design.

## Rules enforced by the server

Everything the client sends is untrusted, so the server checks it (see `server/rooms.js`). Every refusal has a stable `code`, which is how the page shows it in French or English.

| | |
| --- | --- |
| room code | 10 characters from 32 (no `0/O` or `1/I`): 50 bits, chosen at random by the page. The server never sees it, only its **handle** (64 hex digits), which must be unique among open rooms |
| wrong handles | 10 per address every 5 minutes (joining, creating and changing the code all count), then even the right one is refused until the window passes. The limit is shared by all servers; behind a proxy set `TRUST_PROXY=1` so that each visitor has their own. It stops outsiders from guessing; it does nothing against the server itself (see above) |
| nickname | 2 to 20 letters, digits, spaces, `.`, `_`, `-`; unique among people online (across servers); `all` is kept for `@all` |
| room name | 2 to 30 characters; two rooms can share a name, their handles tell them apart; at most 200 rooms |
| message | the server measures it (it cannot read it): up to 6,000 characters of encrypted text (500 characters), or 450 KB for a photo or voice message. Text: 5 per 5 seconds per connection; photos and voice: 3 per 10 seconds |
| edit and delete | only the author: the server gives the sender a signed **proof** with each message (never relayed to others); edit and delete must present it |
| reactions, whispers | reactions from the fixed list only; a whisper only to somebody who is in the room |
| room | at most 200 people; one person can be in at most 10 rooms; only the owner locks, removes or changes the code |
| group encryption | requests, commits and welcomes are base64 text of at most 200 KB; only a member can send them; a commit made on an epoch that was already used is refused |
| payload | anything over the largest allowed message is dropped by Socket.IO before it is read |

Messages are shown by Vue as text, never as HTML. `/health` shows only how many people and rooms there are, never names or handles.

## Protocol (Socket.IO)

Client to server, each with an acknowledgement `{ ok: true, ... }` or `{ error, code, params }`:

| Event | Data | Answer |
| --- | --- | --- |
| `hello` | `{ nickname }` | `user`, `instance` (required before anything else) |
| `room:create` | `{ name, handle }` | `room`, `members`: you are inside, and run it |
| `room:join` | `{ handle }` | `room`, `members`, `first` (nobody else was there: you start the group) |
| `mls:request` | `{ room, keyPackage, proof }` | (passed to the others in the room) |
| `mls:commit` | `{ room, base, commit, welcome?, to? }` | `epoch`, or `stale_epoch` when another change was made on `base` first |
| `room:leave` | `{ room }` | |
| `message` | `{ room, body, replyTo? }` | `id`, `at`, `proof` |
| `message:edit` / `message:delete` | `{ room, id, proof, body? }` | |
| `message:react` | `{ room, id, emoji, on }` | |
| `whisper` | `{ room, to, body }` | `id` |
| `room:lock` / `room:kick` / `room:newcode` | `{ room, locked }` / `{ room, id }` / `{ room, handle }` | `room` |
| `typing` | `{ room, typing }` | (no answer) |

`body` is an MLS message (base64). Server to the people in a room: `message`, `message:edited`, `message:deleted`, `message:reaction`, `typing`, `room:members`, `room:event` (join / leave / kick / owner notices), `room:updated` (head count, lock, owner, and a revision `rev`), `mls:request`, `mls:commit`; to one person: `whisper`, `room:kicked`, `mls:welcome`. `GET /health` answers `{ status, instance, online, rooms }`.

## Tests

```bash
npm test                        # 297 tests without Redis (52 more are skipped)
REDIS_URL=redis://localhost:6379 npm test   # 349 tests, with the Redis registry and two real servers
npm run test:coverage           # with a coverage report (about 84%, 97% on the server)
npm run build                   # type-checks the code and the tests, then builds
```

- **The rules** (`server/rooms.js`) and the **Redis registry** (`server/redis.js`) are tested by *one* list of tests (`registry.contract.js`) run against both, so they cannot disagree.
- **The server** is tested with real sockets: a room cannot be entered without its handle, nothing is stored, the group-encryption relay (requests, the first commit on an epoch wins, a welcome reaches only its person), edit and delete need the proof, reactions, whispers, owner tools, rate limits, payload limits, brute-forcing handles, addresses behind a proxy.
- **A cluster** is tested with two real servers on one Redis: people on different servers share nicknames, rooms, messages, whispers and typing; the owner's tools work across servers; wrong codes are counted together; two members who change the group at the same moment on different servers leave exactly one winner; a server that "crashes" is cleaned up after. Real chat clients on the two servers also join one encrypted group, write while it changes and hand it over when its oldest member leaves.
- **The group encryption** (`src/mls.test.ts`): letting somebody in, a wrong PSK or handle failing, messages across a change of epoch and ahead of one, removal, a change the server turned down, the same keeper everywhere, and what a commit may contain (checked against the library).
- **The client**: the chat store against the real server (end to end, with real MLS: the server's registry holds no code; a bare connection in the room only ever sees ciphertext; a wrong proof is ignored; five people arriving at once all get in; people who left or dropped are taken out; a removed member cannot read on; nobody answering ends in an error), every component, the encryption, the translations (French has every sentence English has, and **every refusal code the server can make is translated**), and the parsing of mentions, whispers and invite links.
- The whole flow was also driven in real browsers at the real Argon2 cost (a room opens in under a second, a join with the typed code takes under a second, and every frame sent over the socket was searched for the code and the words).

## CI/CD

`.github/workflows/main.yml` runs on every push and pull request: install (`npm ci`), build and type-check, **all the tests against a Redis service**, with coverage (uploaded as an artifact, and to Codecov when a `CODECOV_TOKEN` secret exists); then it builds the Docker image and checks `/health`; then it starts **Redis, two servers and nginx** and runs `npm run scale-check`.

`docker-compose.jenkins.yaml` starts a local Jenkins (with a Docker-in-Docker service) from `jenkins.Dockerfile`, to experiment with CI/CD. It is optional and not needed to run the chat.

## Project layout

```
server.js                 entry point: one server, or one of a cluster when REDIS_URL is set
server/rooms.js           the rules: nicknames, rooms, handles, owners, epochs, limits, rate limiters (in memory)
server/redis.js           the same registry on Redis (Lua scripts), the shared counter, heartbeat and janitor
server/index.js           the Socket.IO server, the tiny static file server, /health
server/proof.js           the signed proofs that let you edit your own messages
src/composables/chat.ts   the chat on the client: connection, rooms, the group, messages, reconnection
src/crypto.ts             the code: Argon2id into a handle, a PSK and an admission key; the whisper cipher
src/mls.ts                the MLS group (ts-mls): letting people in, removing them, sealing and opening
src/media.ts              photos and voice recording
src/components/           NicknameForm, RoomList, ChatPanel, MessageItem, Composer, InviteDialog, WaveBars
src/i18n.ts               English and French
public/                   manifest, service worker, icons (the installable app)
deploy/nginx.conf         the load balancer of the cluster
docker-compose*.yaml      one server, or Redis + two servers + nginx; Jenkins for CI experiments
scripts/scale-check.mjs   checks a running cluster from the outside
```

## Tech stack

Vue 3 (`<script setup>`), TypeScript, Vite 7, Socket.IO 4 (+ Redis adapter), Node.js 22, Redis (ioredis, Lua), MLS (ts-mls), Argon2id (@noble/hashes), Web Crypto, MediaRecorder, Vitest 5 and Vue Test Utils, GitHub Actions, Docker, nginx.
