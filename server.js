import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatServer } from "./server/index.js";
import { createProofs } from "./server/proof.js";
import { createRedisBackend } from "./server/redis.js";

const port = Number(process.env.PORT || 3000);
const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist"); // the page, once built (npm run build)

// Alone, the server keeps everything in its own memory. With REDIS_URL, any number of servers can share the chat behind a load balancer.
let backend = null;
let options = { corsOrigin: process.env.CORS_ORIGIN, staticDir, instanceId: process.env.INSTANCE_ID };
if (process.env.REDIS_URL) {
  backend = createRedisBackend({ url: process.env.REDIS_URL, instanceId: process.env.INSTANCE_ID });
  options = {
    ...options,
    instanceId: backend.instanceId,
    registry: backend.registry,
    wrongCodes: backend.wrongCodes,
    attach: backend.attach,
    proofs: createProofs(process.env.MESSAGE_SECRET || (await backend.sharedSecret())),
  };
}
if (!options.instanceId) delete options.instanceId;

const chat = createChatServer(options);
backend?.start((reaped) => chat.announceReaped(reaped));
const p = await chat.listen(port);
console.log(`Chat server ${chat.instanceId} listening on http://localhost:${p}${backend ? " (shared through Redis)" : ""}`);

// a clean stop: leave the cluster, so that nobody waits for the heartbeat to expire
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await chat.close();
    await backend?.close();
    process.exit(0);
  });
}
