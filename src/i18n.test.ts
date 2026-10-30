import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { detectLocale, errorText, keysOf, locale, t } from './i18n'

afterEach(() => {
  locale.value = 'en'
})

describe('translations', () => {
  it('French has exactly the sentences English has', () => {
    expect(keysOf('fr').sort()).toEqual(keysOf('en').sort())
  })

  it('no sentence is left empty or the same placeholders in both languages', () => {
    for (const key of keysOf('en')) {
      locale.value = 'en'
      const en = t(key as never, {})
      locale.value = 'fr'
      const fr = t(key as never, {})
      expect(en.length, key).toBeGreaterThan(0)
      expect(fr.length, key).toBeGreaterThan(0)
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      expect(names(fr), key).toEqual(names(en))
    }
  })

  it('every refusal the server can make has a sentence in both languages', () => {
    const source = readFileSync(new URL('../server/rooms.js', import.meta.url), 'utf8') + readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
    const codes = [...new Set([...source.matchAll(/refusal\(\s*"([a-z_]+)"/g)].map((m) => m[1]))]
    expect(codes.length).toBeGreaterThan(20)
    for (const code of codes) expect(keysOf('en'), code).toContain(`error.${code}`)
  })

  it('replaces the values of a sentence', () => {
    expect(t('error.nickname_length', { min: 2, max: 20 })).toBe('A nickname has 2 to 20 characters.')
    locale.value = 'fr'
    expect(t('error.nickname_length', { min: 2, max: 20 })).toBe('Un pseudo a de 2 à 20 caractères.')
  })

  it('picks French for French browsers and English for the rest', () => {
    expect(detectLocale('fr-FR')).toBe('fr')
    expect(detectLocale('FR')).toBe('fr')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale('de')).toBe('en')
  })
})

describe('errorText', () => {
  it('shows a refusal by its code, in the language of the page', () => {
    const refusal = { code: 'nickname_taken', error: 'English from the server', params: { nickname: 'Ada' } }
    expect(errorText(refusal)).toBe('"Ada" is already used by someone online. Pick another nickname.')
    locale.value = 'fr'
    expect(errorText(refusal)).toBe('« Ada » est déjà utilisé par quelqu’un en ligne. Choisissez un autre pseudo.')
  })

  it('falls back to the sentence of the server for a code it does not know, and to a plain message for none', () => {
    expect(errorText({ code: 'brand_new', error: 'Something new' })).toBe('Something new')
    expect(errorText({})).toBe('The server did not answer.')
  })
})
