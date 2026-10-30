// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JoinedRoom, Line, Msg } from '../types'
import ChatPanel from './ChatPanel.vue'

afterEach(() => vi.restoreAllMocks())

const msg = (over: Partial<Msg> = {}): Msg => ({
  id: 'm1',
  from: { id: 'a', nickname: 'Ada' },
  at: '2026-01-01T10:01:00.000Z',
  mine: false,
  kind: 'text',
  text: 'hello',
  replyTo: null,
  edited: false,
  deleted: false,
  unreadable: false,
  reactions: {},
  ...over,
})

const joined = (over: Partial<JoinedRoom> = {}): JoinedRoom => ({
  room: { id: 'r1', name: 'Study group', members: 3, locked: false, ownerId: 'me', rev: 1 },
  code: 'K7M2QXAB9T',
  lines: [
    { kind: 'event', id: 'e1', at: '2026-01-01T10:00:00.000Z', key: 'event.youJoined', params: {} },
    { kind: 'message', msg: msg() },
    { kind: 'message', msg: msg({ id: 'm2', from: { id: 'me', nickname: 'Bob' }, mine: true, text: 'hi Ada', proof: 'p' }) },
  ] satisfies Line[],
  members: [
    { id: 'a', nickname: 'Ada' },
    { id: 'me', nickname: 'Bob' },
    { id: 'c', nickname: 'Cleo' },
  ],
  typing: [],
  unread: 0,
  mentioned: false,
  muted: [],
  ...over,
})

const make = (room = joined(), me = { id: 'me', nickname: 'Bob' }, props = {}) => mount(ChatPanel, { props: { joined: room, me, ...props } })

describe('ChatPanel', () => {
  it('shows the room, its code, the head count, notices and messages', () => {
    const wrapper = make()
    expect(wrapper.find('h2').text()).toBe('Study group')
    expect(wrapper.find('.code-chip').text()).toContain('K7M2Q XAB9T')
    expect(wrapper.text()).toContain('3 people here')
    expect(wrapper.find('.event').text()).toContain('You joined')
    expect(wrapper.findAll('.message')).toHaveLength(2)
  })

  it('shows who is typing, and a lock when the room is locked', () => {
    expect(make(joined({ typing: ['Ada'] })).find('.typing').text()).toBe('Ada is typing…')
    expect(make(joined({ room: { ...joined().room, locked: true } })).find('.lock').exists()).toBe(true)
  })

  it('gives the owner tools that others do not have', () => {
    const owner = make()
    expect(owner.text()).toContain('Lock the room')
    expect(owner.text()).toContain('New code')
    const member = make(joined(), { id: 'a', nickname: 'Ada' })
    expect(member.text()).not.toContain('Lock the room')
    expect(member.text()).not.toContain('New code')
  })

  it('locks and unlocks, and makes a new code only after asking', async () => {
    const wrapper = make()
    await wrapper.findAll('.link').find((b) => b.text() === 'Lock the room')!.trigger('click')
    expect(wrapper.emitted('lock')).toEqual([[true]])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const newCode = wrapper.findAll('.link').find((b) => b.text() === 'New code')!
    await newCode.trigger('click')
    expect(wrapper.emitted('newCode')).toBeUndefined()
    await newCode.trigger('click')
    expect(wrapper.emitted('newCode')).toHaveLength(1)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('lists the people with who runs the room, and what you can do with each', async () => {
    const wrapper = make()
    await wrapper.find('.title .link').trigger('click')
    const people = wrapper.findAll('.members li')
    expect(people.map((p) => p.find('.member-name').text())).toEqual(['Ada', 'Bob', 'Cleo'])
    expect(people[1].text()).toContain('runs the room')
    expect(people[1].findAll('button')).toHaveLength(0) // not yourself
    expect(people[0].text()).toContain('Whisper')
    expect(people[0].text()).toContain('Remove')
    const member = make(joined(), { id: 'a', nickname: 'Ada' })
    await member.find('.title .link').trigger('click')
    expect(member.findAll('.members li')[2].text()).not.toContain('Remove') // only the owner removes
  })

  it('removes somebody only after asking', async () => {
    const wrapper = make()
    await wrapper.find('.title .link').trigger('click')
    const remove = wrapper.findAll('.members li')[0].findAll('button').find((b) => b.text() === 'Remove')!
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    await remove.trigger('click')
    expect(wrapper.emitted('kick')).toBeUndefined()
    await remove.trigger('click')
    expect(wrapper.emitted('kick')).toEqual([['a']])
  })

  it('mutes somebody: their messages disappear from your screen', async () => {
    const wrapper = make()
    await wrapper.find('.title .link').trigger('click')
    await wrapper.findAll('.members li')[0].findAll('button').find((b) => b.text() === 'Mute')!.trigger('click')
    expect(wrapper.emitted('mute')).toEqual([['Ada']])
    const muted = make(joined({ muted: ['ada'] }))
    expect(muted.findAll('.message')).toHaveLength(1)
    expect(muted.find('.message').classes()).toContain('mine')
  })

  it('prefills a whisper from the member list', async () => {
    const wrapper = make()
    await wrapper.find('.title .link').trigger('click')
    await wrapper.findAll('.members li')[0].findAll('button').find((b) => b.text() === 'Whisper')!.trigger('click')
    await wrapper.vm.$nextTick()
    expect((wrapper.find('input[type=text]').element as HTMLInputElement).value).toBe('/w Ada ')
  })

  it('replies: the reply banner shows, and the message carries the id it answers', async () => {
    const wrapper = make()
    await wrapper.findAll('.message')[0].find('[title="Reply"]').trigger('click')
    expect(wrapper.find('.banner-reply').text()).toContain('Replying to Ada')
    await wrapper.find('input[type=text]').setValue('answer')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('send')).toEqual([['answer', 'm1']])
    expect(wrapper.find('.banner-reply').exists()).toBe(false) // done
  })

  it('edits your own message, and deletes it', async () => {
    const wrapper = make()
    const mine = wrapper.findAll('.message')[1]
    await mine.find('[title="Edit"]').trigger('click')
    expect((wrapper.find('input[type=text]').element as HTMLInputElement).value).toBe('hi Ada')
    await wrapper.find('input[type=text]').setValue('hi Ada, again')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('save')).toEqual([['m2', 'hi Ada, again']])
    await mine.find('[title="Delete"]').trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['m2']])
  })

  it('reacts to a message', async () => {
    const wrapper = make()
    await wrapper.findAll('.message')[0].find('[title="React"]').trigger('click')
    await wrapper.findAll('.message')[0].find('.picker button').trigger('click')
    expect(wrapper.emitted('react')).toEqual([['m1', '👍']])
  })

  it('opens the invite dialog, and a photo full size', async () => {
    const src = 'data:image/jpeg;base64,/9j/4AAQ'
    const wrapper = make(joined({ lines: [{ kind: 'message', msg: msg({ kind: 'image', src, text: '' }) }] }))
    await wrapper.find('.secondary.small').trigger('click')
    expect(wrapper.find('.dialog').exists()).toBe(true)
    await wrapper.find('.dialog .link').trigger('click')
    expect(wrapper.find('.dialog').exists()).toBe(false)
    await wrapper.find('img.photo').trigger('click')
    expect(wrapper.find('.lightbox img').attributes('src')).toBe(src)
    await wrapper.find('.lightbox').trigger('click')
    expect(wrapper.find('.lightbox').exists()).toBe(false)
  })

  it('goes back and leaves', async () => {
    const wrapper = make()
    await wrapper.find('.back').trigger('click')
    await wrapper.findAll('.link').find((b) => b.text() === 'Leave room')!.trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
    expect(wrapper.emitted('leave')).toHaveLength(1)
  })
})
