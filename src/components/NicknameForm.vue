<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'

const props = defineProps<{ error?: string; busy?: boolean; invited?: boolean }>()
const emit = defineEmits<{ submit: [nickname: string] }>()
const nickname = ref('')

const submit = () => {
  if (!props.busy) emit('submit', nickname.value)
}
</script>

<template>
  <main class="welcome">
    <form class="card" @submit.prevent="submit">
      <h1>{{ t('welcome.title') }}</h1>
      <p v-if="invited" class="invite-note">{{ t('welcome.invited') }}</p>
      <p v-else class="lead">{{ t('welcome.lead') }}</p>
      <p class="live-note">{{ t('welcome.live') }}</p>
      <p class="live-note">{{ t('welcome.encrypted') }}</p>
      <label for="nickname">{{ t('welcome.nickname') }}</label>
      <input id="nickname" v-model="nickname" type="text" maxlength="20" autocomplete="nickname" autofocus :placeholder="t('welcome.placeholder')" />
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="primary" :disabled="busy">{{ busy ? t('welcome.connecting') : t('welcome.enter') }}</button>
    </form>
  </main>
</template>
