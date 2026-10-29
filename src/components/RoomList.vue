<script setup lang="ts">
import { ref } from 'vue'
import type { Room } from '../types'
import { colorFor, peopleLabel } from '../utils'

defineProps<{ rooms: Room[]; active: string | null; joined: string[]; nickname: string; error?: string }>()
const emit = defineEmits<{ open: [id: string]; create: [name: string]; logout: [] }>()

const creating = ref(false)
const name = ref('')

const create = () => {
  emit('create', name.value)
  name.value = ''
  creating.value = false
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

    <h2>Public rooms</h2>
    <ul>
      <li v-for="room in rooms" :key="room.id">
        <button type="button" class="room" :class="{ active: room.id === active }" @click="emit('open', room.id)">
          <span class="avatar" :style="{ background: colorFor(room.name) }">#</span>
          <span class="room-text">
            <strong>{{ room.name }}</strong>
            <small>{{ peopleLabel(room.members) }}</small>
          </span>
          <span v-if="joined.includes(room.id)" class="badge" title="You are in this room">in</span>
        </button>
      </li>
    </ul>

    <form v-if="creating" class="create" @submit.prevent="create">
      <input v-model="name" type="text" maxlength="30" placeholder="Room name" aria-label="Room name" autofocus />
      <button type="submit" class="primary">Create</button>
      <button type="button" class="link" @click="creating = false">Cancel</button>
    </form>
    <button v-else type="button" class="new-room" @click="creating = true">+ New room</button>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p class="live-note">Rooms made by people disappear when the last person leaves.</p>
  </aside>
</template>
