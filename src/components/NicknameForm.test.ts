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
    expect(mount(NicknameForm, { props: { error: 'Already used' } }).find('[role=alert]').text()).toBe('Already used')
  })

  it('does not submit twice while connecting', async () => {
    const wrapper = mount(NicknameForm, { props: { busy: true } })
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.find('button').text()).toBe('Connecting…')
  })

  it('says that nothing is saved, and that messages are encrypted', () => {
    const text = mount(NicknameForm).text()
    expect(text).toContain('nothing is saved')
    expect(text).toContain('encrypted')
  })

  it('welcomes somebody who came with an invite link', () => {
    const wrapper = mount(NicknameForm, { props: { invited: true } })
    expect(wrapper.find('.invite-note').text()).toContain('invited')
  })
})
