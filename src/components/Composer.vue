<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { MAX_VOICE_MS, preparePhoto, VoiceRecorder, type Photo, type Voice } from '../media'
import type { Msg } from '../types'
import { clock } from '../utils'
import WaveBars from './WaveBars.vue'

const props = defineProps<{ replyTo: Msg | null; editing: Msg | null }>()
const emit = defineEmits<{
  send: [text: string]
  save: [text: string]
  photo: [photo: Photo]
  voice: [voice: Voice]
  typing: [on: boolean]
  cancel: []
  problem: [message: string]
}>()

const text = ref('')
const input = ref<HTMLInputElement | null>(null)
const files = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const recording = ref(false)
const levels = ref<number[]>([])
const elapsed = ref(0)
const canRecord = VoiceRecorder.supported()
let recorder: VoiceRecorder | null = null
let ticker: ReturnType<typeof setInterval> | undefined
let typingTimer: ReturnType<typeof setTimeout> | undefined

// editing starts with the text of the message; replying puts you in the box
watch(
  () => props.editing,
  (message) => {
    if (message) text.value = message.text
    void nextTick(() => input.value?.focus())
  },
)
watch(
  () => props.replyTo,
  (message) => message && void nextTick(() => input.value?.focus()),
)

const banner = computed(() => (props.editing ? t('composer.editing') : props.replyTo ? t('composer.replyingTo', { name: props.replyTo.mine ? t('msg.you') : props.replyTo.from.nickname }) : ''))

const submit = () => {
  const value = text.value.trim()
  if (!value) return
  if (props.editing) emit('save', value)
  else emit('send', value)
  text.value = ''
  clearTimeout(typingTimer)
  emit('typing', false)
}

const onInput = () => {
  if (props.editing) return
  emit('typing', text.value.trim().length > 0)
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => emit('typing', false), 2500)
}

const cancel = () => {
  text.value = ''
  emit('cancel')
}

// ---- photos: picked, or pasted into the box
const sendPicture = async (file: Blob | null | undefined) => {
  if (!file || !file.type.startsWith('image/')) return
  busy.value = true
  try {
    emit('photo', await preparePhoto(file))
  } catch {
    emit('problem', t('media.photoFailed'))
  } finally {
    busy.value = false
    if (files.value) files.value.value = ''
  }
}
const onPick = (e: Event) => void sendPicture((e.target as HTMLInputElement).files?.[0])
const onPaste = (e: ClipboardEvent) => {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (file) {
    e.preventDefault()
    void sendPicture(file)
  }
}

// ---- voice messages
const startRecording = async () => {
  recorder = new VoiceRecorder()
  recorder.onLevel = (v) => (levels.value = [...levels.value.slice(-39), v])
  recorder.onLimit = () => void finishRecording(true)
  try {
    await recorder.start()
  } catch {
    recorder = null
    emit('problem', t('media.micDenied'))
    return
  }
  levels.value = []
  elapsed.value = 0
  recording.value = true
  ticker = setInterval(() => (elapsed.value = Math.min(recorder?.elapsed ?? 0, MAX_VOICE_MS)), 200)
}

const finishRecording = async (send: boolean) => {
  if (!recorder) return
  const current = recorder
  recorder = null
  clearInterval(ticker)
  recording.value = false
  if (!send) return current.cancel()
  const voice = await current.stop()
  if (voice) emit('voice', voice)
  else emit('problem', t('media.tooShort'))
}

onBeforeUnmount(() => {
  clearInterval(ticker)
  recorder?.cancel()
})

defineExpose({ prefill: (value: string) => ((text.value = value), void nextTick(() => input.value?.focus())) })
</script>

<template>
  <div class="composer-wrap">
    <div v-if="banner" class="banner-reply">
      <span>{{ banner }}</span>
      <button type="button" class="link" @click="cancel">{{ t('composer.cancel') }}</button>
    </div>

    <form v-if="!recording" class="composer" @submit.prevent="submit">
      <button type="button" class="icon-button" :disabled="busy || !!editing" :title="t('composer.photo')" :aria-label="t('composer.photo')" @click="files?.click()">📷</button>
      <input ref="files" class="visually-hidden" type="file" accept="image/*" tabindex="-1" @change="onPick" />
      <input
        ref="input"
        v-model="text"
        type="text"
        maxlength="500"
        :placeholder="t('composer.placeholder')"
        :title="t('composer.whisperHint')"
        aria-label="Message"
        autocomplete="off"
        @input="onInput"
        @paste="onPaste"
      />
      <button v-if="canRecord && !text.trim() && !editing" type="button" class="icon-button" :title="t('composer.voice')" :aria-label="t('composer.voice')" @click="startRecording">🎤</button>
      <button v-else type="submit" class="primary" :disabled="!text.trim()">{{ t('composer.send') }}</button>
    </form>

    <div v-else class="composer recording" role="status">
      <button type="button" class="icon-button" :title="t('composer.discardRecording')" :aria-label="t('composer.discardRecording')" @click="finishRecording(false)">🗑</button>
      <span class="rec-dot" aria-hidden="true"></span>
      <span class="rec-time">{{ clock(elapsed) }}</span>
      <WaveBars class="live-wave" :heights="levels" />
      <button type="button" class="primary" :aria-label="t('composer.sendRecording')" @click="finishRecording(true)">{{ t('composer.send') }}</button>
    </div>
  </div>
</template>
