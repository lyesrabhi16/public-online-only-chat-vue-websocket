<script setup lang="ts">
import { ref } from 'vue'
import { colorFor, peopleLabel } from '../utils'

export interface RoomItem {
  id: string
  name: string
  people: number
}

defineProps<{ rooms: RoomItem[]; active: string | null; nickname: string; error?: string }>()
const emit = defineEmits<{ open: [id: string]; create: [name: string]; join: [code: string]; logout: [] }>()

const mode = ref<'' | 'join' | 'create'>('')
const text = ref('')

const submit = () => {
  if (mode.value === 'join') emit('join', text.value)
  else emit('create', text.value)
  text.value = ''
  mode.value = ''
}

const choose = (next: 'join' | 'create') => {
  mode.value = mode.value === next ? '' : next
  text.value = ''
}
</script>

<template>
  <aside class="rooms">
    <header>
      <div class="me">
        <span class="avatar" :style="{ background: colorFor(nickname) }">{{ nickname.charAt(0).toUpperCase() }}</span>
        <span class="me-name">{{ nickname }}</span>
      </div>
      <button class="link" type="button" @click="emit('logout')">Leave chat</button>
    </header>

    <div class="actions">
      <button type="button" class="primary" :aria-pressed="mode === 'join'" @click="choose('join')">Join with a code</button>
      <button type="button" class="secondary" :aria-pressed="mode === 'create'" @click="choose('create')">+ New room</button>
    </div>

    <form v-if="mode" class="enter" @submit.prevent="submit">
      <input
        v-model="text"
        type="text"
        :maxlength="mode === 'join' ? 12 : 30"
        :class="{ code: mode === 'join' }"
        :placeholder="mode === 'join' ? 'Code, for example K7M 2QX' : 'Name of the room'"
        :aria-label="mode === 'join' ? 'Room code' : 'Room name'"
        autocomplete="off"
        autofocus
      />
      <button type="submit" class="primary" :disabled="!text.trim()">{{ mode === 'join' ? 'Join' : 'Create' }}</button>
    </form>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <h2>Your rooms</h2>
    <ul v-if="rooms.length">
      <li v-for="room in rooms" :key="room.id">
        <button type="button" class="room" :class="{ active: room.id === active }" @click="emit('open', room.id)">
          <span class="avatar" :style="{ background: colorFor(room.name) }">#</span>
          <span class="room-text">
            <strong>{{ room.name }}</strong>
            <small>{{ peopleLabel(room.people) }}</small>
          </span>
        </button>
      </li>
    </ul>
    <p v-else class="none">You are not in any room yet.</p>

    <p class="live-note">Rooms cannot be browsed: you need their code. A room closes when everybody has left it.</p>
  </aside>
</template>
