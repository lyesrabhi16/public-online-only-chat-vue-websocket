<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ error?: string; busy?: boolean }>()
const emit = defineEmits<{ submit: [nickname: string] }>()
const nickname = ref('')

const submit = () => {
  if (!props.busy) emit('submit', nickname.value)
}
</script>

<template>
  <main class="welcome">
    <form class="card" @submit.prevent="submit">
      <h1>Chat rooms with a code</h1>
      <p class="lead">
        Pick a nickname, then create a room and share its code, or join one with the code you were given.
      </p>
      <p class="live-note">
        Live only: nothing is saved. You only see what is said while you are in a room.
      </p>
      <label for="nickname">Nickname</label>
      <input
        id="nickname"
        v-model="nickname"
        type="text"
        maxlength="20"
        autocomplete="nickname"
        autofocus
        placeholder="For example Ada"
      />
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Connecting…' : 'Enter' }}</button>
    </form>
  </main>
</template>
