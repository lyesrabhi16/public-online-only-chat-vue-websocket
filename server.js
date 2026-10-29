import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatServer } from "./server/index.js";

const port = Number(process.env.PORT || 3000);
const chat = createChatServer({
  corsOrigin: process.env.CORS_ORIGIN,
  // when the client has been built (npm run build) the same server serves it: one address for everything
  staticDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "dist"),
});

chat.listen(port).then((p) => console.log(`Chat server listening on http://localhost:${p}`));
