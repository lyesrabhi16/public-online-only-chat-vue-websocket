// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RoomList from './RoomList.vue'

const rooms = [
  { id: 'r1', name: 'Study group', people: 3 },
  { id: 'r2', name: 'Movie night', people: 1 },
]
const make = (props = {}) => mount(RoomList, { props: { rooms, active: 'r1', nickname: 'Ada', ...props } })

describe('RoomList', () => {
  it('lists only the rooms you are in, with their head counts', () => {
    const wrapper = make()
    expect(wrapper.findAll('.room')).toHaveLength(2)
    expect(wrapper.text()).toContain('3 people here')
    expect(wrapper.text()).toContain('1 person here')
    expect(wrapper.find('.room.active').text()).toContain('Study group')
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
    await wrapper.find('input').setValue('k7m 2qx')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('join')).toEqual([['k7m 2qx']])
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('creates a room with a name', async () => {
    const wrapper = make()
    await wrapper.findAll('.actions button')[1].trigger('click')
    expect(wrapper.find('input.code').exists()).toBe(false)
    await wrapper.find('input').setValue('Chess')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('create')).toEqual([['Chess']])
  })

  it('does not submit an empty form', async () => {
    const wrapper = make()
    await wrapper.findAll('.actions button')[0].trigger('click')
    expect(wrapper.find('form button').attributes('disabled')).toBeDefined()
  })

  it('shows an error', () => {
    expect(make({ error: 'No room has this code.' }).find('[role=alert]').text()).toBe('No room has this code.')
  })
})
