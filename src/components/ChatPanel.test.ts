// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Line } from '../types'
import ChatPanel from './ChatPanel.vue'

const lines: Line[] = [
  { kind: 'event', id: 'e1', text: 'You joined.', at: '2026-01-01T10:00:00.000Z' },
  { kind: 'message', id: 'm1', from: { id: 'a', nickname: 'Ada' }, text: 'hello <b>there</b>', at: '2026-01-01T10:01:00.000Z', mine: false },
  { kind: 'message', id: 'm2', from: { id: 'b', nickname: 'Bob' }, text: 'hi Ada', at: '2026-01-01T10:02:00.000Z', mine: true },
]
const members = [
  { id: 'a', nickname: 'Ada' },
  { id: 'b', nickname: 'Bob' },
]
const make = (props = {}) => mount(ChatPanel, { props: { roomName: 'General', lines, members, typing: [], ...props } })

describe('ChatPanel', () => {
  it('shows the room, the head count, events and messages', () => {
    const wrapper = make()
    expect(wrapper.find('h2').text()).toBe('General')
    expect(wrapper.text()).toContain('2 people here')
    expect(wrapper.find('.event').text()).toBe('You joined.')
    expect(wrapper.findAll('.message')).toHaveLength(2)
  })

  it("marks your own messages and names the others'", () => {
    const [theirs, mine] = make().findAll('.message')
    expect(theirs.classes()).not.toContain('mine')
    expect(theirs.find('.author').text()).toBe('Ada')
    expect(mine.classes()).toContain('mine')
    expect(mine.find('.author').exists()).toBe(false)
  })

  it('shows message text as text, never as HTML', () => {
    const wrapper = make()
    expect(wrapper.find('.message .text').text()).toBe('hello <b>there</b>')
    expect(wrapper.find('.message .text b').exists()).toBe(false)
  })

  it('shows who is typing', () => {
    expect(make({ typing: ['Ada'] }).find('.typing').text()).toBe('Ada is typing…')
  })

  it('lists the people in the room on demand', async () => {
    const wrapper = make()
    expect(wrapper.find('.members').exists()).toBe(false)
    await wrapper.find('.title .link').trigger('click')
    expect(wrapper.find('.members').text()).toContain('Ada')
    expect(wrapper.find('.members').text()).toContain('Bob')
  })

  it('sends the trimmed text on submit and empties the box', async () => {
    const wrapper = make()
    await wrapper.find('input').setValue('  my message  ')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toEqual([['my message']])
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
  })

  it('does not send an empty message, and disables the button', async () => {
    const wrapper = make()
    expect(wrapper.find('button[type=submit]').attributes('disabled')).toBeDefined()
    await wrapper.find('input').setValue('   ')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('tells the others when you start and stop typing', async () => {
    const wrapper = make()
    await wrapper.find('input').setValue('h')
    await wrapper.find('input').trigger('input')
    expect(wrapper.emitted('typing')?.at(-1)).toEqual([true])
    await wrapper.find('input').setValue('')
    await wrapper.find('input').trigger('input')
    expect(wrapper.emitted('typing')?.at(-1)).toEqual([false])
  })

  it('lets you leave the room and go back to the list', async () => {
    const wrapper = make()
    await wrapper.findAll('button').find((b) => b.text() === 'Leave room')!.trigger('click')
    await wrapper.find('.back').trigger('click')
    expect(wrapper.emitted('leave')).toHaveLength(1)
    expect(wrapper.emitted('back')).toHaveLength(1)
  })
})
