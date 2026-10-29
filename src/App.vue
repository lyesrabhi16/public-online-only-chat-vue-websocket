<script setup lang="ts">
import { computed, ref } from 'vue'
import ChatPanel from './components/ChatPanel.vue'
import NicknameForm from './components/NicknameForm.vue'
import RoomList from './components/RoomList.vue'
import { useChat } from './composables/chat'

const chat = useChat()
const state = chat.state
const busy = ref(false)
const loginError = ref('')
const sendError = ref('')

const current = computed(() => (state.active ? state.joined[state.active] : undefined))
const rooms = computed(() =>
  Object.values(state.joined).map((j) => ({ id: j.room.id, name: j.room.name, people: j.members.length })),
)

async function enter(nickname: string) {
  busy.value = true
  loginError.value = await chat.login(nickname)
  busy.value = false
}

async function send(text: string) {
  sendError.value = await chat.send(text)
}

async function create(name: string) {
  state.error = await chat.create(name)
}

async function join(code: string) {
  state.error = await chat.join(code)
}
</script>

<template>
  <NicknameForm v-if="!state.me" :busy="busy" :error="loginError || state.error" @submit="enter" />

  <div v-else class="app" :class="{ 'in-room': current }">
    <p v-if="state.status !== 'online'" class="banner" role="status">Connection lost. Trying to reconnect…</p>
    <RoomList
      :rooms="rooms"
      :active="state.active"
      :nickname="state.me.nickname"
      :error="state.error"
      @open="chat.open"
      @create="create"
      @join="join"
      @logout="chat.logout"
    />
    <ChatPanel
      v-if="current"
      :room-name="current.room.name"
      :code="current.room.code"
      :lines="current.lines"
      :members="current.members"
      :typing="current.typing"
      :error="sendError"
      @send="send"
      @typing="chat.typing"
      @leave="chat.leave(current.room.id)"
      @back="state.active = null"
    />
    <section v-else class="empty">
      <h2>No room open</h2>
      <p>Create a room and share its code, or join one with the code you were given.</p>
      <p class="live-note">Live only: leaving a room forgets everything said in it.</p>
    </section>
  </div>
</template>
