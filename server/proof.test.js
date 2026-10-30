import { describe, expect, it } from "vitest";
import { createProofs } from "./proof.js";

describe("proofs", () => {
  const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("are good for the message, the room and the person they were made for", () => {
    const proofs = createProofs("secret");
    const proof = proofs.sign(id, "room1", "Ada");
    expect(proofs.verify(proof, id, "room1", "Ada")).toBe(true);
    expect(proofs.verify(proof, id, "room1", "ada")).toBe(true); // nicknames are not case sensitive
  });

  it("are good for nothing else", () => {
    const proofs = createProofs("secret");
    const proof = proofs.sign(id, "room1", "Ada");
    expect(proofs.verify(proof, id, "room2", "Ada")).toBe(false);
    expect(proofs.verify(proof, id, "room1", "Bob")).toBe(false);
    expect(proofs.verify(proof, "7c9e6679-7425-40de-944b-e07fc1f90ae8", "room1", "Ada")).toBe(false);
    expect(proofs.verify("", id, "room1", "Ada")).toBe(false);
    expect(proofs.verify(null, id, "room1", "Ada")).toBe(false);
    expect(proofs.verify({ a: 1 }, id, "room1", "Ada")).toBe(false);
  });

  it("depend on the secret: servers that share it accept each other's proofs", () => {
    const a = createProofs("shared"), b = createProofs("shared"), other = createProofs("different");
    expect(b.verify(a.sign(id, "r", "Ada"), id, "r", "Ada")).toBe(true);
    expect(other.verify(a.sign(id, "r", "Ada"), id, "r", "Ada")).toBe(false);
  });
});
