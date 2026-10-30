import { describe, expect, it } from 'vitest'
import { AUDIO_URL, PHOTO_URL, fitWithin } from './media'

describe('fitWithin', () => {
  it('shrinks a big picture to the longest side, keeping its proportions', () => {
    expect(fitWithin(4000, 3000, 900)).toEqual({ width: 900, height: 675 })
    expect(fitWithin(3000, 4000, 900)).toEqual({ width: 675, height: 900 })
  })

  it('never makes a picture bigger', () => {
    expect(fitWithin(300, 200, 900)).toEqual({ width: 300, height: 200 })
  })

  it('never goes below one pixel', () => {
    expect(fitWithin(10000, 1, 900).height).toBe(1)
  })
})

describe('what is shown as a photo or a voice message', () => {
  it('accepts small images of kinds that cannot run code', () => {
    for (const kind of ['jpeg', 'png', 'webp']) expect(PHOTO_URL.test(`data:image/${kind};base64,AAAA/+9=`)).toBe(true)
  })

  it('refuses anything else: svg, html, scripts, other schemes', () => {
    for (const bad of [
      'data:image/svg+xml;base64,AAAA',
      'data:text/html;base64,AAAA',
      'data:image/png;charset=utf-8,<script>',
      'javascript:alert(1)',
      'https://example.com/a.png',
      'data:image/png;base64,AAAA" onerror="x',
      '',
    ]) expect(PHOTO_URL.test(bad), bad).toBe(false)
  })

  it('accepts audio recorded by browsers, with or without a codec', () => {
    expect(AUDIO_URL.test('data:audio/webm;codecs=opus;base64,GkXf')).toBe(true)
    expect(AUDIO_URL.test('data:audio/ogg;codecs=opus;base64,T2dn')).toBe(true)
    expect(AUDIO_URL.test('data:audio/mp4;base64,AAAA')).toBe(true)
  })

  it('refuses audio that is something else', () => {
    expect(AUDIO_URL.test('data:audio/x-evil;base64,AAAA')).toBe(false)
    expect(AUDIO_URL.test('data:video/webm;base64,AAAA')).toBe(false)
    expect(AUDIO_URL.test('data:audio/webm;base64,AA AA')).toBe(false)
  })
})
