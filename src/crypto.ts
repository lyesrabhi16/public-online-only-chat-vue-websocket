// What a room code is for, and how it is kept away from the server.
//
// The code is 10 characters out of 32 (50 bits). It is typed or scanned by the people who should get in, and it never leaves their
// browsers. Each browser turns it, with a slow memory-hard hash (Argon2id, about a second), into three separate secrets:
//   - the handle: all the server ever learns, and what it finds the room by;
//   - the PSK: a pre-shared key that goes into the group encryption (see mls.ts) every time somebody is let in, so that only people
//     who know the code can join the group;
//   - the admission key: with it a newcomer proves they know the code when they ask to be let in.
//
// An honest limit: 50 bits is still a password. Whoever has a handle can try every code offline (about 10^15), and every try costs
// one Argon2 run. That is a lot of money for one room and no real obstacle for somebody who is willing to spend it, and the same
// work tests every room at once. A longer code is the only real fix. See the README, "What this does and does not protect against".

import { argon2idAsync } from '@noble/hashes/argon2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** 32 characters, without 0/O and 1/I, which are easy to mix up. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 10

const utf8 = (text: string) => new TextEncoder().encode(text)

/** The code as it was typed ("k7m2q-xab9t", " K7M2Q XAB9T ") and as it counts ("K7M2QXAB9T"): all the browsers must derive from the same text. */
export function canonicalCode(code: string): string {
  return code.replace(/[\s_-]+/g, '').toUpperCase()
}

/** Whether this is a code (once typed in any way). */
export function isCode(code: string): boolean {
  const canonical = canonicalCode(code)
  return canonical.length === CODE_LENGTH && [...canonical].every((c) => CODE_ALPHABET.includes(c))
}

/** A random code. 256 is a multiple of 32, so taking a byte modulo 32 is not biased. */
export function generateCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(CODE_LENGTH)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
}

export interface Cost {
  /** passes over the memory */
  t: number
  /** memory in KiB */
  m: number
}

/** 64 MiB and 3 passes (the second choice of RFC 9106): about a second in a browser. Lower it and every guess gets cheaper. */
export const COST: Cost = { t: 3, m: 65536 }

const SALT = utf8('public-chat-rooms/v2')

export interface Secrets {
  /** 64 hex digits: what the server knows of the code */
  handle: string
  /** goes into the group encryption as a pre-shared key */
  psk: Uint8Array
  /** proves to the members that a newcomer knows the code */
  admissionKey: Uint8Array
}

/**
 * The secrets of a code. Slow on purpose: this is what makes each guess of a code cost something.
 * `cost` is only for tests; every page must use the same one, or it finds no room.
 */
export async function deriveSecrets(code: string, cost: Cost = COST): Promise<Secrets> {
  const stretched = await argon2idAsync(utf8(canonicalCode(code)), SALT, { t: cost.t, m: cost.m, p: 1, dkLen: 32 })
  const part = (label: string) => hkdf(sha256, stretched, undefined, utf8(`public-chat-rooms/v2 ${label}`), 32)
  return { handle: bytesToHex(part('handle')), psk: part('psk'), admissionKey: part('admission') }
}

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** The proof that goes with a request to be let in: it covers the key package, so it cannot be moved onto another one. */
export function prove(admissionKey: Uint8Array, data: Uint8Array): string {
  return toBase64(hmac(sha256, admissionKey, data))
}

export function verifyProof(admissionKey: Uint8Array, data: Uint8Array, proof: string): boolean {
  let given: Uint8Array
  try {
    given = fromBase64(proof)
  } catch {
    return false
  }
  const expected = hmac(sha256, admissionKey, data)
  if (given.length !== expected.length) return false
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= given[i] ^ expected[i] // the whole length, always
  return difference === 0
}

/** An AES-GCM key from 32 bytes. */
export const aesKey = (raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

/** JSON in, one base64 text out: a random 12-byte IV followed by the AES-GCM ciphertext (which also authenticates it). */
export async function encrypt(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = utf8(JSON.stringify(value))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data))
  const out = new Uint8Array(iv.length + encrypted.length)
  out.set(iv)
  out.set(encrypted, iv.length)
  return toBase64(out)
}

/** The value, or null when the text was not encrypted with this key (or was tampered with). */
export async function decrypt<T = unknown>(key: CryptoKey, body: string): Promise<T | null> {
  try {
    const bytes = fromBase64(body)
    if (bytes.length < 13) return null
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } catch {
    return null
  }
}
