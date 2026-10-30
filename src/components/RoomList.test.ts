// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { locale } from '../i18n'
import RoomList from './RoomList.vue'

afterEach(() => {
  locale.value = 'en'
})

const rooms = [
  { id: 'r1', name: 'Study group', people: 3, unread: 0, mentioned: false },
  { id: 'r2', name: 'Movie night', people: 1, unread: 4, mentioned: false },
  { id: 'r3', name: 'Chess', people: 2, unread: 2, mentioned: true },
]
const make = (props = {}) => mount(RoomList, { props: { rooms, active: 'r1', nickname: 'Ada', sound: false, mentionSound: true, notifications: false, ...props } })

describe('RoomList', () => {
  it('lists only the rooms you are in, with their head counts', () => {
    const wrapper = make()
    expect(wrapper.findAll('.room')).toHaveLength(3)
    expect(wrapper.text()).toContain('3 people here')
    expect(wrapper.text()).toContain('1 person here')
    expect(wrapper.find('.room.active').text()).toContain('Study group')
  })

  it('shows how many messages are unread, and which room mentioned you', () => {
    const badges = make().findAll('.badge')
    expect(badges.map((b) => b.text())).toEqual(['4', '@2'])
    expect(badges[1].classes()).toContain('mention')
    expect(make({ rooms: [rooms[0]] }).find('.badge').exists()).toBe(false)
  })

  it('says so when you are in none, and that rooms cannot be browsed', () => {
    const wrapper = make({ rooms: [] })
    expect(wrapper.text()).toContain('not in any room yet')
    expect(wrapper.text()).toContain('need their code')
  })

  it('opens a room', async () => {
    const wrapper = make()
    await wrapper.findAll('.room')[1].trigger('click')
    expect(wrapper.emitted('open')).toEqual([['r2']])
  })

  it('joins a room with a code, and closes the form', async () => {
    const wrapper = make()
    await wrapper.findAll('.actions button')[0].trigger('click')
    expect(wrapper.find('input.code').exists()).toBe(true)
    await wrapper.find('.enter input').setValue('k7m 2qx')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('join')).toEqual([['k7m 2qx']])
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('creates a room with a name', async () => {
    const wrapper = make()
    await wrapper.findAll('.actions button')[1].trigger('click')
    expect(wrapper.find('input.code').exists()).toBe(false)
    await wrapper.find('.enter input').setValue('Chess club')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('create')).toEqual([['Chess club']])
  })

  it('does not submit an empty form, and shows an error', async () => {
    const wrapper = make({ error: 'No room has this code.' })
    await wrapper.findAll('.actions button')[0].trigger('click')
    expect(wrapper.find('form button').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[role=alert]').text()).toBe('No room has this code.')
  })

  it('has settings for sound, notifications and language', async () => {
    const wrapper = make()
    expect(wrapper.find('.settings').exists()).toBe(false)
    await wrapper.find('header button[aria-expanded]').trigger('click')
    const boxes = wrapper.findAll('.settings input[type=checkbox]')
    expect(boxes).toHaveLength(3)
    expect((boxes[0].element as HTMLInputElement).checked).toBe(true) // the sound of a mention is on until you turn it off
    expect((boxes[1].element as HTMLInputElement).checked).toBe(false)
    await boxes[0].setValue(false)
    await boxes[1].setValue(true)
    await boxes[2].setValue(true)
    await wrapper.find('.settings select').setValue('fr')
    expect(wrapper.emitted('mentionSound')).toEqual([[false]])
    expect(wrapper.emitted('sound')).toEqual([[true]])
    expect(wrapper.emitted('notifications')).toEqual([[true]])
    expect(wrapper.emitted('language')).toEqual([['fr']])
  })

  it('speaks French when the page does', () => {
    locale.value = 'fr'
    const wrapper = make({ rooms: [] })
    expect(wrapper.text()).toContain('Vos salons')
    expect(wrapper.text()).toContain('Saisir un code')
  })
})
