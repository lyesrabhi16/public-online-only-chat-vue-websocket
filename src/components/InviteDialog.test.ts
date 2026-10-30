// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import InviteDialog from './InviteDialog.vue'

describe('InviteDialog', () => {
  it('shows the room, its code, a link that carries the code after the #, and a QR code', async () => {
    const wrapper = mount(InviteDialog, { props: { roomName: 'Study group', code: 'K7M2QX' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Study group')
    expect(wrapper.find('.big-code').text()).toBe('K7M 2QX')
    expect((wrapper.find('input').element as HTMLInputElement).value).toMatch(/#\/join\/K7M2QX$/)
    expect(wrapper.find('.qr svg').exists()).toBe(true)
  })

  it('copies the link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = mount(InviteDialog, { props: { roomName: 'Study group', code: 'K7M2QX' } })
    await wrapper.find('.dialog-actions .primary').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.dialog-actions .primary').text()).toBe('Copied'))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/#\/join\/K7M2QX$/))
  })

  it('closes from its button or by clicking beside it', async () => {
    const wrapper = mount(InviteDialog, { props: { roomName: 'x', code: 'K7M2QX' } })
    await wrapper.find('.dialog-actions .link').trigger('click')
    await wrapper.find('.overlay').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})
