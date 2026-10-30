<script setup lang="ts">
import { ref } from 'vue'
import { locale, t, type Locale } from '../i18n'
import { colorFor, peopleLabel } from '../utils'

export interface RoomItem {
  id: string
  name: string
  people: number
  unread: number
  mentioned: boolean
}

defineProps<{ rooms: RoomItem[]; active: string | null; nickname: string; error?: string; sound: boolean; mentionSound: boolean; notifications: boolean }>()
const emit = defineEmits<{
  open: [id: string]
  create: [name: string]
  join: [code: string]
  logout: []
  sound: [on: boolean]
  mentionSound: [on: boolean]
  notifications: [on: boolean]
  language: [locale: Locale]
}>()

const mode = ref<'' | 'join' | 'create'>('')
const text = ref('')
const settings = ref(false)

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
      <button class="link" type="button" :aria-expanded="settings" :title="t('settings.language')" @click="settings = !settings">⚙</button>
      <button class="link" type="button" @click="emit('logout')">{{ t('rooms.leaveChat') }}</button>
    </header>

    <div v-if="settings" class="settings">
      <label><input type="checkbox" :checked="mentionSound" @change="emit('mentionSound', ($event.target as HTMLInputElement).checked)" /> {{ t('settings.mentionSound') }}</label>
      <label><input type="checkbox" :checked="sound" @change="emit('sound', ($event.target as HTMLInputElement).checked)" /> {{ t('settings.sound') }}</label>
      <label><input type="checkbox" :checked="notifications" @change="emit('notifications', ($event.target as HTMLInputElement).checked)" /> {{ t('settings.notifications') }}</label>
      <label>
        {{ t('settings.language') }}
        <select :value="locale" @change="emit('language', ($event.target as HTMLSelectElement).value as Locale)">
          <option value="en">English</option>
          <option value="fr">Français</option>
        </select>
      </label>
    </div>

    <div class="actions">
      <button type="button" class="primary" :aria-pressed="mode === 'join'" @click="choose('join')">{{ t('rooms.enterCode') }}</button>
      <button type="button" class="secondary" :aria-pressed="mode === 'create'" @click="choose('create')">{{ t('rooms.newRoom') }}</button>
    </div>

    <form v-if="mode" class="enter" @submit.prevent="submit">
      <input
        v-model="text"
        type="text"
        :maxlength="mode === 'join' ? 12 : 30"
        :class="{ code: mode === 'join' }"
        :placeholder="mode === 'join' ? t('rooms.codePlaceholder') : t('rooms.namePlaceholder')"
        :aria-label="mode === 'join' ? t('rooms.codeLabel') : t('rooms.nameLabel')"
        autocomplete="off"
        autofocus
      />
      <button type="submit" class="primary" :disabled="!text.trim()">{{ mode === 'join' ? t('rooms.join') : t('rooms.create') }}</button>
    </form>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <h2>{{ t('rooms.yours') }}</h2>
    <ul v-if="rooms.length">
      <li v-for="room in rooms" :key="room.id">
        <button type="button" class="room" :class="{ active: room.id === active }" @click="emit('open', room.id)">
          <span class="avatar" :style="{ background: colorFor(room.name) }">#</span>
          <span class="room-text">
            <strong>{{ room.name }}</strong>
            <small>{{ peopleLabel(room.people) }}</small>
          </span>
          <span v-if="room.unread" class="badge" :class="{ mention: room.mentioned }" :title="room.mentioned ? t('rooms.mention') : t('rooms.unread', { n: room.unread })">{{ room.mentioned ? '@' : '' }}{{ room.unread }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="none">{{ t('rooms.none') }}</p>

    <p class="live-note">{{ t('rooms.note') }}</p>
  </aside>
</template>
