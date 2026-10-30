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

describe('Composer: mentions', () => {
  const people = ['Bob', 'Ada', 'Ada Lovelace', 'Cleo']
  const box = (wrapper: ReturnType<typeof make>) => wrapper.find('input[type=text]')
  /** Types text with the caret at its end, as a person does. */
  const type = async (wrapper: ReturnType<typeof make>, value: string) => {
    const input = box(wrapper)
    await input.setValue(value)
    ;(input.element as HTMLInputElement).setSelectionRange(value.length, value.length)
    await input.trigger('keyup')
  }
  const names = (wrapper: ReturnType<typeof make>) => wrapper.findAll('[role=option] strong').map((o) => o.text())

  it('lists everybody to pick from as soon as an @ is typed, "all" first', async () => {
    const wrapper = make({ nicknames: people })
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    await type(wrapper, 'hello @')
    expect(names(wrapper)).toEqual(['@all', 'Ada', 'Ada Lovelace', 'Bob', 'Cleo'])
    expect(wrapper.find('[role=option]').text()).toContain('Everyone in the room')
    expect(box(wrapper).attributes('aria-expanded')).toBe('true')
  })

  it('narrows the list as the name is typed, spaces included, and closes it when nobody fits', async () => {
    const wrapper = make({ nicknames: people })
    await type(wrapper, '@a')
    expect(names(wrapper)).toEqual(['@all', 'Ada', 'Ada Lovelace'])
    await type(wrapper, '@Ada L')
    expect(names(wrapper)).toEqual(['Ada Lovelace'])
    await type(wrapper, '@Ada can you')
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    expect(box(wrapper).attributes('aria-expanded')).toBe('false')
  })

  it('does not open for an @ inside a word, or for something that cannot be a name', async () => {
    const wrapper = make({ nicknames: people })
    await type(wrapper, 'write to me@')
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    await type(wrapper, '@zz')
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
  })

  it('still offers "all" in a room where you are alone', async () => {
    const wrapper = make({ nicknames: [] })
    await type(wrapper, '@')
    expect(names(wrapper)).toEqual(['@all'])
  })

  it('moves with the arrow keys (round and round) and fills the name in with Enter or Tab, without sending', async () => {
    const wrapper = make({ nicknames: people })
    await type(wrapper, 'hi @')
    const selected = () => wrapper.findAll('[role=option]').findIndex((o) => o.attributes('aria-selected') === 'true')
    expect(selected()).toBe(0)
    await box(wrapper).trigger('keydown', { key: 'ArrowDown' })
    await box(wrapper).trigger('keydown', { key: 'ArrowDown' })
    expect(selected()).toBe(2)
    await box(wrapper).trigger('keydown', { key: 'ArrowUp' })
    await box(wrapper).trigger('keydown', { key: 'ArrowUp' })
    await box(wrapper).trigger('keydown', { key: 'ArrowUp' })
    expect(selected()).toBe(4) // from the first one, up goes to the last
    await box(wrapper).trigger('keydown', { key: 'Enter' })
    expect((box(wrapper).element as HTMLInputElement).value).toBe('hi @Cleo ')
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)

    await type(wrapper, 'again @bo')
    await box(wrapper).trigger('keydown', { key: 'Tab' })
    expect((box(wrapper).element as HTMLInputElement).value).toBe('again @Bob ')
  })

  it('picks "all" with the mouse, and a click does not take the focus away from the box', async () => {
    const wrapper = make({ nicknames: people })
    await type(wrapper, '@')
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    wrapper.find('[role=option]').element.dispatchEvent(press)
    await wrapper.vm.$nextTick()
    expect((box(wrapper).element as HTMLInputElement).value).toBe('@all ')
    expect(press.defaultPrevented).toBe(true) // the box keeps the focus, and the caret
  })

  it('fills in a name in the middle of a sentence, and does not double the space', async () => {
    const wrapper = make({ nicknames: people })
    const input = box(wrapper)
    await input.setValue('ask @bo about it')
    ;(input.element as HTMLInputElement).setSelectionRange(7, 7) // right after "@bo"
    await input.trigger('keyup')
    expect(names(wrapper)).toEqual(['Bob'])
    await input.trigger('keydown', { key: 'Enter' })
    expect((input.element as HTMLInputElement).value).toBe('ask @Bob about it')
  })

  it('replaces the whole name when the caret is inside one that is already typed, instead of repeating its end', async () => {
    const wrapper = make({ nicknames: people })
    const input = box(wrapper)
    await input.setValue('ask @Ada Lovelace about it')
    ;(input.element as HTMLInputElement).setSelectionRange(7, 7) // "@Ad|a Lovelace"
    await input.trigger('keyup')
    expect(names(wrapper)).toEqual(['Ada', 'Ada Lovelace'])
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })
    expect((input.element as HTMLInputElement).value).toBe('ask @Ada Lovelace about it')
    await input.setValue('ask @Ada Lovelace about it')
    ;(input.element as HTMLInputElement).setSelectionRange(7, 7)
    await input.trigger('keyup')
    await input.trigger('keydown', { key: 'Enter' }) // "Ada": the whole old mention is replaced
    expect((input.element as HTMLInputElement).value).toBe('ask @Ada about it')
  })

  it('closes with Escape until the next keystroke, and then Enter sends', async () => {
    const wrapper = make({ nicknames: people })
    await type(wrapper, '@bo')
    await box(wrapper).trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toEqual([['@bo']])
  })

  it('leaves Enter alone when no list is open', async () => {
    const wrapper = make({ nicknames: people })
    await type(wrapper, 'plain text')
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    box(wrapper).element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not fill in a name that would make the message too long', async () => {
    const wrapper = make({ nicknames: people })
    const input = box(wrapper)
    const long = 'x'.repeat(497) + ' @'
    await input.setValue(long)
    ;(input.element as HTMLInputElement).setSelectionRange(long.length, long.length)
    await input.trigger('keyup')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    input.element.dispatchEvent(enter)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    input.element.dispatchEvent(tab)
    expect((input.element as HTMLInputElement).value).toBe(long)
    expect(enter.defaultPrevented).toBe(false) // nothing was filled in, so Enter still sends and Tab still moves on
    expect(tab.defaultPrevented).toBe(false)
  })

  it('keeps the focus in the box when a name is picked with the mouse', async () => {
    const wrapper = mount(Composer, { props: { replyTo: null, editing: null, nicknames: people }, attachTo: document.body })
    const input = box(wrapper)
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('@')
    ;(input.element as HTMLInputElement).setSelectionRange(1, 1)
    await input.trigger('keyup')
    ;(document.activeElement as HTMLElement | null)?.blur() // what a click on the list would do, if the page did not stop it
    wrapper.find('[role=option]').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })
})
