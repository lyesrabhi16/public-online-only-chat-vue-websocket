import { describe, expect, it } from 'vitest'
import { canonicalCode, decrypt, deriveKey, encrypt } from './crypto'

describe('encryption with the room code', () => {
  it('gives back what was encrypted', async () => {
    const key = await deriveKey('K7M2QX')
    const value = { k: 'text', text: 'hello, é 🎉', n: [1, 2, 3] }
    expect(await decrypt(key, await encrypt(key, value))).toEqual(value)
  })

  it('hides the text: the body is base64 and does not contain it', async () => {
    const key = await deriveKey('K7M2QX')
    const body = await encrypt(key, { k: 'text', text: 'very secret words' })
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(body).not.toContain('secret')
    expect(atob(body)).not.toContain('secret')
  })

  it('is different every time (a new random IV), so equal messages cannot be recognised', async () => {
    const key = await deriveKey('K7M2QX')
    expect(await encrypt(key, 'same')).not.toBe(await encrypt(key, 'same'))
  })

  it('cannot be read with another code', async () => {
    const body = await encrypt(await deriveKey('K7M2QX'), { text: 'hi' })
    expect(await decrypt(await deriveKey('K7M2QY'), body)).toBeNull()
  })

  it('reads a code typed any way: the key comes from the code itself', async () => {
    const body = await encrypt(await deriveKey('k7m-2qx'), { text: 'hi' })
    expect(await decrypt(await deriveKey(' K7M 2QX '), body)).toEqual({ text: 'hi' })
    expect(canonicalCode('k7m_2qx')).toBe('K7M2QX')
  })

  it('notices a message that was tampered with, or is not encrypted at all', async () => {
    const key = await deriveKey('K7M2QX')
    const body = await encrypt(key, { text: 'hi' })
    const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
    bytes[bytes.length - 1] ^= 1
    expect(await decrypt(key, btoa(String.fromCharCode(...bytes)))).toBeNull()
    expect(await decrypt(key, 'not base64 at all!')).toBeNull()
    expect(await decrypt(key, '')).toBeNull()
    expect(await decrypt(key, btoa('short'))).toBeNull()
  })

  it('carries a photo-sized message', async () => {
    const key = await deriveKey('K7M2QX')
    const big = 'A'.repeat(250_000)
    expect(await decrypt<{ src: string }>(key, await encrypt(key, { src: big }))).toEqual({ src: big })
  })
})
