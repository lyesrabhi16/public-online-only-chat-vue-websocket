import { describe, expect, it } from 'vitest'
import { CODE_ALPHABET, CODE_LENGTH, COST, aesKey, canonicalCode, decrypt, deriveSecrets, encrypt, generateCode, isCode, prove, verifyProof } from './crypto'

// the real cost is about a second a run: the tests use the smallest one Argon2 accepts
const cheap = { t: 1, m: 8 }

describe('codes', () => {
  it('have 8 characters and none that is easy to mix up', () => {
    expect(CODE_LENGTH).toBe(8)
    for (const confusing of '0O1I') expect(CODE_ALPHABET).not.toContain(confusing)
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  })

  it('are random, and every character of the alphabet comes up', () => {
    const codes = Array.from({ length: 800 }, () => generateCode())
    expect(new Set(codes).size).toBe(800)
    expect(new Set(codes.join('')).size).toBe(CODE_ALPHABET.length)
  })

  it('are read in any case, with or without separators', () => {
    expect(canonicalCode('k7m2-qxab')).toBe('K7M2QXAB')
    expect(canonicalCode('  K7M2 QXAB ')).toBe('K7M2QXAB')
    expect(canonicalCode('k7m2_qxab')).toBe('K7M2QXAB')
  })

  it.each([[''], ['K7M2QXA'], ['K7M2QXABC'], ['K7M2QX0B'], ['K7M2QXIB'], ['K7M2QX!B'], ['K7M2QX B!']])('%j is not a code', (code) => {
    expect(isCode(code)).toBe(false)
  })

  it('are recognised however they are typed', () => {
    expect(isCode('k7m2-qxab')).toBe(true)
    expect(isCode(' K7M2 QXAB ')).toBe(true)
  })

  it('are made with a random source that can be replaced, and a byte maps evenly onto 32 characters', () => {
    expect(generateCode((n) => new Uint8Array(n))).toBe('AAAAAAAA')
    expect(generateCode((n) => new Uint8Array(n).fill(255))).toBe('99999999')
    expect(generateCode((n) => new Uint8Array(n).fill(32))).toBe('AAAAAAAA') // 32 wraps round to the first character
  })
})

describe('what is made of a code', () => {
  it('is the same on every page, however the code was typed', async () => {
    const [one, two] = await Promise.all([deriveSecrets('K7M2QXAB', cheap), deriveSecrets(' k7m2-qxab ', cheap)])
    expect(two).toEqual(one)
  })

  it('is a handle of 64 hex digits and two keys of 32 bytes, all different', async () => {
    const secrets = await deriveSecrets('K7M2QXAB', cheap)
    expect(secrets.handle).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.psk).toHaveLength(32)
    expect(secrets.admissionKey).toHaveLength(32)
    expect(secrets.psk).not.toEqual(secrets.admissionKey)
    expect(secrets.handle).not.toBe([...secrets.psk].map((b) => b.toString(16).padStart(2, '0')).join('')) // knowing the handle tells nothing about the keys
  })

  it('differs for every code, and for every cost (so a page with another cost finds no room)', async () => {
    const a = await deriveSecrets('K7M2QXAB', cheap)
    const b = await deriveSecrets('K7M2QXAC', cheap)
    const c = await deriveSecrets('K7M2QXAB', { t: 2, m: 8 })
    expect(new Set([a.handle, b.handle, c.handle]).size).toBe(3)
  })

  it('costs real memory and time at the real setting', () => {
    expect(COST.m).toBeGreaterThanOrEqual(65536) // 64 MiB
    expect(COST.t).toBeGreaterThanOrEqual(3)
  })
})

describe('the proof that goes with a request to come in', () => {
  const key = new Uint8Array(32).fill(7)
  const data = new TextEncoder().encode('a key package')

  it('is good for the data it covers and the key that made it', () => {
    const proof = prove(key, data)
    expect(verifyProof(key, data, proof)).toBe(true)
    expect(verifyProof(new Uint8Array(32).fill(8), data, proof)).toBe(false)
    expect(verifyProof(key, new TextEncoder().encode('another key package'), proof)).toBe(false)
  })

  it('refuses what is not a proof', () => {
    for (const bad of ['', 'AAAA', '!!!', prove(key, data).slice(1), prove(key, data) + 'AA']) expect(verifyProof(key, data, bad)).toBe(false)
  })
})

describe('whisper encryption', () => {
  const key = () => aesKey(crypto.getRandomValues(new Uint8Array(32)))

  it('gives back what was put in', async () => {
    const k = await key()
    const body = await encrypt(k, { k: 'text', text: 'héllo 👋' })
    expect(await decrypt(k, body)).toEqual({ k: 'text', text: 'héllo 👋' })
  })

  it('does not repeat itself: the same message gives another text each time', async () => {
    const k = await key()
    expect(await encrypt(k, 'same')).not.toBe(await encrypt(k, 'same'))
  })

  it('gives null for another key, damaged text, or something that was never encrypted', async () => {
    const k = await key()
    const body = await encrypt(k, 'secret')
    expect(await decrypt(await key(), body)).toBeNull()
    const bytes = atob(body)
    const damaged = btoa(bytes.slice(0, -1) + String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 1))
    expect(await decrypt(k, damaged)).toBeNull()
    expect(await decrypt(k, 'not base64!')).toBeNull()
    expect(await decrypt(k, btoa('short'))).toBeNull()
  })
})
