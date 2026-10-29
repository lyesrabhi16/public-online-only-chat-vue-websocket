// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import NicknameForm from './NicknameForm.vue'

describe('NicknameForm', () => {
  it('sends the nickname that was typed', async () => {
    const wrapper = mount(NicknameForm)
    await wrapper.find('input').setValue('Ada')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['Ada']])
  })

  it('shows the error the server gave', () => {
    const wrapper = mount(NicknameForm, { props: { error: 'Already used' } })
    expect(wrapper.find('[role=alert]').text()).toBe('Already used')
  })

  it('does not submit twice while connecting', async () => {
    const wrapper = mount(NicknameForm, { props: { busy: true } })
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.find('button').text()).toBe('Connecting…')
  })

  it('says that nothing is saved', () => {
    expect(mount(NicknameForm).text()).toContain('nothing is saved')
    expect(mount(NicknameForm).text()).toContain('code')
  })
})
