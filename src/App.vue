<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChatPanel from './components/ChatPanel.vue'
import NicknameForm from './components/NicknameForm.vue'
import RoomList from './components/RoomList.vue'
import { useChat } from './composables/chat'
import { locale, t } from './i18n'

const chat = useChat()
const state = chat.state
const busy = ref(false)
const loginError = ref('')
const sendError = ref('')

const current = computed(() => (state.active ? state.joined[state.active] : undefined))
const rooms = computed(() =>
  Object.values(state.joined).map((j) => ({ id: j.room.id, name: j.room.name, people: j.members.length, unread: j.unread, mentioned: j.mentioned })),
)

// the number of messages waiting is in the title of the tab
const unread = computed(() => Object.values(state.joined).reduce((sum, j) => sum + j.unread, 0))
watch(
  [unread, locale],
  () => (document.title = `${unread.value ? `(${unread.value}) ` : ''}${t('welcome.title')}`),
  { immediate: true },
)

// coming back to the tab reads what is in the open room
const onVisible = () => state.active && chat.markRead(state.active)
onMounted(() => document.addEventListener('visibilitychange', onVisible))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible))

async function enter(nickname: string) {
  busy.value = true
  loginError.value = await chat.login(nickname)
  busy.value = false
}

const report = async (work: Promise<string>) => {
  sendError.value = await work
}
</script>

<template>
  <NicknameForm v-if="!state.me" :busy="busy" :invited="!!state.invite" :error="loginError || state.error" @submit="enter" />

  <div v-else class="app" :class="{ 'in-room': current }">
    <p v-if="state.status !== 'online'" class="banner" role="status">{{ t('banner.lost') }}</p>
    <RoomList
      :rooms="rooms"
      :active="state.active"
      :nickname="state.me.nickname"
      :error="state.error"
      :sound="state.settings.sound"
      :mention-sound="state.settings.mentionSound"
      :notifications="state.settings.notifications"
      @open="chat.open"
      @create="async (name) => (state.error = await chat.create(name))"
      @join="async (code) => (state.error = await chat.join(code))"
      @logout="chat.logout"
      @sound="chat.setSound"
      @mention-sound="chat.setMentionSound"
      @notifications="(on) => chat.setNotifications(on).then((ok) => (state.error = on && !ok ? t('settings.denied') : ''))"
      @language="(l) => (locale = l)"
    />
    <ChatPanel
      v-if="current"
      :joined="current"
      :me="state.me"
      :error="sendError"
      @send="(text, replyTo) => report(chat.send(text, replyTo))"
      @save="(id, text) => report(chat.edit(id, text))"
      @remove="(id) => report(chat.remove(id))"
      @react="(id, emoji) => report(chat.react(id, emoji))"
      @photo="(photo, replyTo) => report(chat.sendPhoto(photo, '', replyTo))"
      @voice="(voice, replyTo) => report(chat.sendVoice(voice, replyTo))"
      @typing="chat.typing"
      @leave="chat.leave(current.room.id)"
      @back="state.active = null"
      @lock="(on) => report(chat.lock(on))"
      @kick="(id) => report(chat.kick(id))"
      @new-code="report(chat.newCode())"
      @mute="chat.toggleMute"
      @problem="(message) => (sendError = message)"
    />
    <section v-else class="empty">
      <h2>{{ t('empty.title') }}</h2>
      <p>{{ t('empty.text') }}</p>
      <p class="live-note">{{ t('empty.live') }}</p>
    </section>
  </div>
</template>
