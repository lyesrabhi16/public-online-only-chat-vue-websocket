# Real-time Chat (Vue 3 + Socket.IO)

A minimal real-time chat: every message sent by a client is broadcast to all connected clients over WebSockets. Also serves as a CI/CD playground (GitHub Actions and a Jenkins image with Docker).

## Tech stack

Vue 3 (`<script setup>`), TypeScript, Vite, Socket.IO, Jest, GitHub Actions, Docker (Jenkins).

## Getting started

```bash
npm install
npm run dev-server   # Socket.IO server on port 3000
npm run dev          # Vite dev server (http://localhost:5173)
```

Open the app in two browser tabs and send a message from one of them.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run dev-server` | Start the Socket.IO server with nodemon |
| `npm run build` | Type-check and build |
| `npm run test` | Run Jest |

## CI

`.github/workflows/main.yml` builds the app, runs the tests with coverage and uploads the results to Codecov (requires a `CODECOV_TOKEN` repository secret). `docker-compose.yaml` starts a local Jenkins instance built from `jenkins.Dockerfile`.
