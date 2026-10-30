// Who may edit or delete a message? The server keeps no messages, so it cannot look the author up. Instead it gives
// the sender a proof when the message is sent: a signature over (message id, room, nickname) that only the server can make.
// The proof goes to the sender alone and is never relayed. With a shared MESSAGE_SECRET several servers accept each other's proofs.
import crypto from "node:crypto";

export function createProofs(secret = process.env.MESSAGE_SECRET || crypto.randomBytes(32).toString("hex")) {
  const sign = (messageId, roomId, nickname) =>
    crypto.createHmac("sha256", secret).update(`${messageId}|${roomId}|${nickname.toLowerCase()}`).digest("base64url");
  return {
    sign,
    verify(proof, messageId, roomId, nickname) {
      if (typeof proof !== "string") return false;
      const expected = Buffer.from(sign(messageId, roomId, nickname));
      const given = Buffer.from(proof);
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    },
  };
}
