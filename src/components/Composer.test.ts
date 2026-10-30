// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Msg } from '../types'
import Composer from './Composer.vue'

const message = (over: Partial<Msg> = {}): Msg => ({
  id: 'm1',
  from: { id: 'a', nickname: 'Ada' },
  at: '2026-01-01T10:00:00.000Z',
  mine: false,
  kind: 'text',
  text: 'original text',
  replyTo: null,
  edited: false,
  deleted: false,
  unreadable: false,
  reactions: {},
  ...over,
})
const make = (props = {}) => mount(Composer, { props: { replyTo: null, editing: null, ...props } })

describe('Composer', () => {
  it('sends the trimmed text and empties the box', async () => {
    const wrapper = make()
    await wrapper.find('input[type=text]').setValue('  my message  ')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toEqual([['my message']])
    expect((wrapper.find('input[type=text]').element as HTMLInputElement).value).toBe('')
  })

  it('does not send an empty message', async () => {
    const wrapper = make()
    await wrapper.find('input[type=text]').setValue('   ')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('tells the others when you start and stop typing', async () => {
    const wrapper = make()
    await wrapper.find('input[type=text]').setValue('h')
    await wrapper.find('input[type=text]').trigger('input')
    expect(wrapper.emitted('typing')?.at(-1)).toEqual([true])
    await wrapper.find('input[type=text]').setValue('')
    await wrapper.find('input[type=text]').trigger('input')
    expect(wrapper.emitted('typing')?.at(-1)).toEqual([false])
  })

  it('offers no microphone where the browser cannot record, but still a send button', () => {
    const wrapper = make()
    expect(wrapper.find('[aria-label="Record a voice message"]').exists()).toBe(false)
    expect(wrapper.find('button[type=submit]').exists()).toBe(true)
  })

  it('says who you are replying to, and can drop the reply', async () => {
    const wrapper = make({ replyTo: message() })
    expect(wrapper.find('.banner-reply').text()).toContain('Replying to Ada')
    await wrapper.find('.banner-reply button').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('calls your own message "You" when you reply to it', () => {
    expect(make({ replyTo: message({ mine: true }) }).find('.banner-reply').text()).toContain('Replying to You')
  })

  it('edits: the box starts with the text, and saving sends the new one', async () => {
    const wrapper = make()
    await wrapper.setProps({ editing: message({ mine: true }) })
    expect(wrapper.find('.banner-reply').text()).toContain('Editing your message')
    expect((wrapper.find('input[type=text]').element as HTMLInputElement).value).toBe('original text')
    await wrapper.find('input[type=text]').setValue('better text')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('save')).toEqual([['better text']])
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('cannot send a photo while editing', async () => {
    const wrapper = make()
    await wrapper.setProps({ editing: message({ mine: true }) })
    expect(wrapper.find('[aria-label="Send a photo"]').attributes('disabled')).toBeDefined()
  })

  it('can prefill the box (for a whisper) from outside', async () => {
    const wrapper = make()
    ;(wrapper.vm as unknown as { prefill: (s: string) => void }).prefill('/w Bob ')
    await wrapper.vm.$nextTick()
    expect((wrapper.find('input[type=text]').element as HTMLInputElement).value).toBe('/w Bob ')
  })
})
