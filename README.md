# Chat rooms joined with a code: live only (Vue 3 + Socket.IO)

Chat rooms with two rules. **A room can only be entered with its code**, and **nothing is ever stored**. A message is relayed to the people who are in the room at that moment and that is all: join late, or reconnect, and the room looks empty. There are no accounts: you pick a nickname, then create a room and share its code, or join one with the code you were given.

| | | |
| :---: | :---: | :---: |
| <img src="docs/screenshots/welcome.png" width="260" alt="The first screen: choose a nickname"> | <img src="docs/screenshots/phone-rooms.png" width="170" alt="The rooms you are in, on a phone"> | <img src="docs/screenshots/phone-chat.png" width="170" alt="A room on a phone: the code on its own row, and a late joiner who only sees what is said after arriving"> |

<img src="docs/screenshots/chat.png" alt="A conversation in the Study group room: your rooms on the left, the room's code in the header">

A wrong code: [docs/screenshots/wrong-code.png](docs/screenshots/wrong-code.png). The conversation in dark mode: [docs/screenshots/chat-dark.png](docs/screenshots/chat-dark.png).

## How it works

- **Create a room**: give it a name and you are inside, with its **code** (six letters and digits such as `K7M 2QX`) shown in the header, with a Copy button. Send the code to whoever should come in.
- **Join a room**: type the code (any case, with or without the space). That is the only way in. Rooms **cannot be browsed or listed**, and the server never sends anyone a list of rooms.
- **Live only**: the server keeps no history and the browser stores nothing (no cookie, no local storage). Leaving a room forgets everything said in it.
- **A room exists while somebody is in it.** When the last person leaves, the room closes and its code stops working. If the last person was only disconnected, the room stays open for a minute, so a connection that blips does not cost you your room and its code.
- Everybody in a room sees who else is in it, "Ada joined" / "Bob left" notices, a typing indicator and message times. Nicknames are unique among the people online (2 to 20 characters; "ada" and "Ada" are the same).
- If the connection drops, the page says hello again with the same nickname and goes back into its rooms using their codes.
- Light and dark themes; on a phone, the room list and the conversation take turns.

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

Or with Docker (page and chat in one container):

```bash
docker compose up --build         # http://localhost:3000
```

`nix develop` gives you Node 22 and Docker Compose if you use Nix.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | port of the server |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | pages that may connect from another address (comma-separated, or `*`). Not needed when the server serves the page itself |
| `VITE_SOCKET_URL` | this site (production), `http://<host>:3000` (dev) | address of the server, set at build time |

## Rules enforced by the server

Everything the client sends is untrusted, so the server checks it (see `server/rooms.js`):

| | |
| --- | --- |
| room code | 6 characters from 32 (no `0/O` or `1/I`, easy to mix up): about a billion codes, chosen at random, unique among open rooms |
| wrong codes | 10 per address every 5 minutes, then even the right code is refused until the window passes: two guesses a minute per address, against a billion possible codes |
| nickname | 2 to 20 letters, digits, spaces, `.`, `_`, `-`; unique among people online |
| room name | 2 to 30 characters; two rooms can share a name, their codes tell them apart; at most 200 rooms |
| message | text, 1 to 500 characters; at most 5 per 5 seconds per connection |
| room | at most 200 people; one person can be in at most 10 rooms |
| payload | anything over 10 KB is dropped by Socket.IO before it is read |

Messages are shown by Vue as text, never as HTML. The wrong-code limit works per network address and the server does not read `X-Forwarded-For`: behind a reverse proxy every visitor would look like the proxy and share one limit, so put it behind one only after adding that. `/health` shows only how many people and rooms there are, never names or codes.

## Protocol (Socket.IO)

Client to server, each with an acknowledgement `{ ok: true, ... }` or `{ error }`:

| Event | Data | Answer |
| --- | --- | --- |
| `hello` | `{ nickname }` | `user` (required before anything else) |
| `room:create` | `{ name }` | `room` (with its `code`), `members`: you are inside |
| `room:join` | `{ code }` | `room`, `members` |
| `room:leave` | `{ room }` | |
| `message` | `{ room, text }` | `id` |
| `typing` | `{ room, typing }` | (no answer) |

Server to the people in a room: `message`, `typing`, `room:members` (who is in) and `room:event` (join / leave notices). `GET /health` answers `{ status, online, rooms }`.

## Tests

```bash
npm test                  # 103 tests: the rules, the server with real sockets, the chat store, the components
npm run test:coverage     # with a coverage report (about 86%, 95% on the server)
npm run build             # type-checks the code and the tests, then builds
```

The server tests start a real server on a free port and connect several real clients: a room cannot be entered without its code (its id is not a way in either), rooms are never listed, messages reach only the people in the room, nothing is stored (a late joiner sees nothing), a room closes when the last person leaves, brute-forcing codes is stopped, rate limits and payload checks. The chat-store test also cuts a connection and checks that the page comes back into its room with the same code.

## CI/CD

`.github/workflows/main.yml` runs on every push and pull request: install (`npm ci`), build and type-check, tests with coverage (uploaded as an artifact, and to Codecov when a `CODECOV_TOKEN` secret exists), then it builds the Docker image, starts it and checks `/health`.

`docker-compose.jenkins.yaml` starts a local Jenkins (with a Docker-in-Docker service) from `jenkins.Dockerfile`, to experiment with CI/CD. It is optional and not needed to run the chat.

## Project layout

```
server.js                entry point: starts the server (and serves dist/ when it has been built)
server/rooms.js          the rules: nicknames, rooms, codes, members, limits, rate limiters (no Socket.IO)
server/index.js          the Socket.IO server and the tiny static file server
src/composables/chat.ts  the chat on the client: connection, rooms, messages, reconnection
src/components/          NicknameForm, RoomList, ChatPanel
src/App.vue              the layout
Dockerfile               one image for the page and the server
```

## Tech stack

Vue 3 (`<script setup>`), TypeScript, Vite 7, Socket.IO 4, Node.js 22, Vitest 5 and Vue Test Utils, GitHub Actions, Docker.
