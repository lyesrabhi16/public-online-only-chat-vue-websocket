// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../i18n'
import type { Msg } from '../types'
import MessageItem from './MessageItem.vue'

afterEach(() => {
  locale.value = 'en'
  vi.unstubAllGlobals()
})

const msg = (over: Partial<Msg> = {}): Msg => ({
  id: 'm1',
  from: { id: 'a', nickname: 'Ada' },
  at: '2026-01-01T10:00:00.000Z',
  mine: false,
  kind: 'text',
  text: 'hello there',
  replyTo: null,
  edited: false,
  deleted: false,
  unreadable: false,
  reactions: {},
  ...over,
})
const make = (m: Msg, props: Record<string, unknown> = {}) =>
  mount(MessageItem, { props: { msg: m, replied: null, nicknames: ['Ada', 'Bob'], me: 'Bob', ...props } })

describe('MessageItem', () => {
  it("names the author of other people's messages, not yours", () => {
    expect(make(msg()).find('.author').text()).toBe('Ada')
    expect(make(msg({ mine: true })).find('.author').exists()).toBe(false)
    expect(make(msg({ mine: true })).classes()).toContain('mine')
  })

  it('shows text as text, never as HTML', () => {
    const wrapper = make(msg({ text: 'hello <b>there</b>' }))
    expect(wrapper.find('.text').text()).toBe('hello <b>there</b>')
    expect(wrapper.find('.text b').exists()).toBe(false)
  })

  it('highlights mentions, and yours differently', () => {
    const wrapper = make(msg({ text: 'hi @Bob and @Ada' }))
    const marks = wrapper.findAll('.mention')
    expect(marks.map((m) => m.text())).toEqual(['@Bob', '@Ada'])
    expect(marks[0].classes()).toContain('self')
    expect(marks[1].classes()).not.toContain('self')
  })

  it('highlights @all as a mention of you, whoever you are', () => {
    const marks = make(msg({ text: '@all meeting at ten' })).findAll('.mention')
    expect(marks.map((m) => m.text())).toEqual(['@all'])
    expect(marks[0].classes()).toContain('self')
  })

  it('shows a photo that opens full size on a click', async () => {
    const src = 'data:image/jpeg;base64,/9j/4AAQ'
    const wrapper = make(msg({ kind: 'image', src, w: 800, h: 600, text: '' }))
    expect(wrapper.find('img.photo').attributes('src')).toBe(src)
    await wrapper.find('img.photo').trigger('click')
    expect(wrapper.emitted('photo')).toEqual([[src]])
  })

  it('plays a voice message: bars, length, play and pause', async () => {
    const played: string[] = []
    class FakeAudio {
      paused = true
      duration = 4
      currentTime = 0
      ontimeupdate: (() => void) | null = null
      onended: (() => void) | null = null
      onpause: (() => void) | null = null
      onplay: (() => void) | null = null
      constructor(public src: string) {}
      play() {
        this.paused = false
        played.push(this.src)
        this.onplay?.()
        this.currentTime = 2
        this.ontimeupdate?.()
        return Promise.resolve()
      }
      pause() {
        this.paused = true
        this.onpause?.()
      }
    }
    vi.stubGlobal('Audio', FakeAudio)
    const src = 'data:audio/webm;codecs=opus;base64,GkXf'
    const wrapper = make(msg({ kind: 'audio', src, ms: 4000, wave: [10, 50, 90, 30], text: '' }))
    expect(wrapper.findAll('.wave .bar')).toHaveLength(4)
    expect(wrapper.find('.duration').text()).toBe('0:04')
    await wrapper.find('.play').trigger('click')
    expect(played).toEqual([src])
    expect(wrapper.find('.play').text()).toBe('❚❚')
    expect(wrapper.findAll('.bar.played').length).toBeGreaterThan(0) // half played
    expect(wrapper.find('.duration').text()).toBe('0:02')
    await wrapper.find('.play').trigger('click')
    expect(wrapper.find('.play').text()).toBe('▶')
  })

  it('shows the message a reply answers, or says it is not available', () => {
    const replied = msg({ id: 'm0', text: 'the question' })
    const found = make(msg({ replyTo: 'm0' }), { replied })
    expect(found.find('.quote').text()).toContain('Ada')
    expect(found.find('.quote').text()).toContain('the question')
    expect(make(msg({ replyTo: 'm0' })).find('.quote').text()).toContain('not available')
    expect(make(msg({ replyTo: 'm0' }), { replied: msg({ kind: 'audio', text: '' }) }).find('.quote').text()).toContain('Voice message')
  })

  it('counts reactions, shows who made them, and toggles one on a click', async () => {
    const wrapper = make(msg({ reactions: { '👍': ['Ada', 'Bob'], '🎉': ['Ada'] } }))
    const buttons = wrapper.findAll('.reaction')
    expect(buttons.map((b) => b.text())).toEqual(['👍 2', '🎉 1'])
    expect(buttons[0].classes()).toContain('mine')
    expect(buttons[1].classes()).not.toContain('mine')
    expect(buttons[0].attributes('title')).toBe('Ada, Bob')
    await buttons[1].trigger('click')
    expect(wrapper.emitted('react')![0][1]).toBe('🎉')
  })

  it('offers the emoji list to react', async () => {
    const wrapper = make(msg())
    await wrapper.find('[title="React"]').trigger('click')
    const picks = wrapper.findAll('.picker button')
    expect(picks).toHaveLength(6)
    await picks[1].trigger('click')
    expect(wrapper.emitted('react')![0][1]).toBe('❤️')
    expect(wrapper.find('.picker').exists()).toBe(false)
  })

  it('lets only the author of a message edit and delete it', async () => {
    const mine = make(msg({ mine: true, proof: 'p' }))
    expect(mine.find('[title="Edit"]').exists()).toBe(true)
    expect(mine.find('[title="Delete"]').exists()).toBe(true)
    await mine.find('[title="Delete"]').trigger('click')
    expect(mine.emitted('remove')).toHaveLength(1)
    const theirs = make(msg())
    expect(theirs.find('[title="Edit"]').exists()).toBe(false)
    expect(theirs.find('[title="Delete"]').exists()).toBe(false)
    expect(theirs.find('[title="Reply"]').exists()).toBe(true)
    expect(make(msg({ mine: true })).find('[title="Delete"]').exists()).toBe(false) // no proof yet: not sent
  })

  it('shows "edited", a deleted message and an unreadable one', () => {
    expect(make(msg({ edited: true })).find('time').text()).toContain('edited')
    const gone = make(msg({ deleted: true, text: '' }))
    expect(gone.text()).toContain('Message deleted')
    expect(gone.find('.actions-row').exists()).toBe(false)
    expect(make(msg({ unreadable: true })).text()).toContain('could not be read')
  })

  it('labels a whisper for both sides', () => {
    expect(make(msg({ mine: true, whisperTo: 'Bob' })).find('.whisper-label').text()).toBe('whisper to Bob')
    expect(make(msg({ whisperTo: 'Bob' })).find('.whisper-label').text()).toBe('whispers to you')
  })

  it('speaks French when the page does', () => {
    locale.value = 'fr'
    expect(make(msg({ deleted: true, text: '' })).text()).toContain('Message supprimé')
  })
})
