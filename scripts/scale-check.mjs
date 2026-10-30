// Checks a running cluster from the outside (docker compose -f docker-compose.scale.yaml up): people who land on different
// servers must still find each other, share rooms and see the same counts.
//   node scripts/scale-check.mjs [http://localhost:8080]
import { createHash } from "node:crypto";
import { io } from "socket.io-client";

const url = process.argv[2] || "http://localhost:8080";
const ask = (s, e, d) => new Promise((r) => s.emit(e, d, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name} ${ok ? "" : detail}`);
  if (!ok) failures++;
};

/** Connects until somebody lands on a server that is not `avoid` (the balancer decides: we only keep trying). */
async function person(nickname, avoid) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const socket = io(url, { transports: ["websocket"], reconnection: false });
    await new Promise((r) => socket.on("connect", r));
    const hello = await ask(socket, "hello", { nickname: `${nickname}${attempt ? attempt : ""}` });
    if (!hello.ok) throw new Error(JSON.stringify(hello));
    if (hello.instance !== avoid) return { socket, instance: hello.instance, nickname: `${nickname}${attempt ? attempt : ""}` };
    socket.close();
  }
  throw new Error("the balancer always chose the same server");
}

const health = async () => (await fetch(`${url}/health`)).json();

console.log(`cluster at ${url}`);
const seen = new Set();
for (let i = 0; i < 6; i++) seen.add((await health()).instance);
check("the balancer reaches more than one server", seen.size >= 2, [...seen].join(", "));

const suffix = Math.random().toString(36).slice(2, 6);
const ada = await person(`Ada${suffix}`);
const bob = await person(`Bob${suffix}`, ada.instance);
check("two people are on different servers", ada.instance !== bob.instance, `${ada.instance} / ${bob.instance}`);

const dup = io(url, { transports: ["websocket"], reconnection: false });
await new Promise((r) => dup.on("connect", r));
check("a nickname is unique across servers", (await ask(dup, "hello", { nickname: ada.nickname.toUpperCase() })).code === "nickname_taken");
dup.close();

const handle = createHash("sha256").update(`scale-check ${suffix}`).digest("hex"); // the servers only see the handle of a code
const room = (await ask(ada.socket, "room:create", { name: `Cluster ${suffix}`, handle })).room;
const joined = await ask(bob.socket, "room:join", { handle });
check("somebody on the other server joins with the handle", joined.ok === true, JSON.stringify(joined));

const heard = [];
bob.socket.on("message", (m) => heard.push(m.body));
const back = [];
ada.socket.on("message", (m) => back.push(m.body));
await ask(ada.socket, "message", { room: room.id, body: "across the servers" });
await ask(bob.socket, "message", { room: room.id, body: "and back" });
await sleep(500);
check("messages cross from one server to the other, both ways", heard.includes("across the servers") && back.includes("and back"), JSON.stringify({ heard, back }));

const [one, two] = await Promise.all([health(), health(), health(), health()].slice(0, 2));
check("every server reports the same people and rooms", one.online === two.online && one.rooms === two.rooms && one.online >= 2, JSON.stringify([one, two]));

const events = [];
ada.socket.on("room:event", (e) => events.push(e));
bob.socket.close();
await sleep(600);
check("the people of the room are told when somebody leaves", events.some((e) => e.kind === "leave" && e.nickname === bob.nickname));

ada.socket.close();
console.log(failures === 0 ? "\ncluster ok" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
