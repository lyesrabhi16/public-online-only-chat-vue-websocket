// What people write is encrypted in their browser before it leaves, with a key made from the room code, and decrypted by the
// others in the room. The server only relays the encrypted text and never has the key.
//
// An honest limit: a room code has 6 characters (about 30 bits), so it is a password, not a strong key. The encryption keeps
// messages unreadable to anybody who does not have the code (network logs, a curious server operator who does not try to
// guess it), and a new code (the owner can make one) changes the key. It does not protect against somebody who records the
// encrypted traffic and then tries every code offline.

const SALT = new TextEncoder().encode('chat-rooms/v1')
const ITERATIONS = 310_000

/** The code as it was typed ("k7m-2qx") and as it counts ("K7M2QX"): both sides must derive the key from the same text. */
export function canonicalCode(code: string): string {
  return code.replace(/[\s_-]+/g, '').toUpperCase()
}

export async function deriveKey(code: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(canonicalCode(code)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** JSON in, one base64 text out: a random 12-byte IV followed by the AES-GCM ciphertext (which also authenticates it). */
export async function encrypt(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(value))
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
