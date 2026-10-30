<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { MAX_VOICE_MS, preparePhoto, VoiceRecorder, type Photo, type Voice } from '../media'
import type { Msg } from '../types'
import { MENTION_ALL, clock, colorFor, mentionCandidates, mentionEnd, mentionQuery } from '../utils'
import WaveBars from './WaveBars.vue'

const props = defineProps<{ replyTo: Msg | null; editing: Msg | null; nicknames?: string[] }>()
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

// ---- mentions: typing "@" lists the people of the room (and "all") to pick from
const MAX_LENGTH = 500
const caret = ref(0)
const choice = ref(0)
const dismissed = ref(false) // Escape, or a pick, closes the list until the next keystroke
const mention = computed(() => (dismissed.value ? null : mentionQuery(text.value, caret.value)))
const options = computed(() => (mention.value ? mentionCandidates(mention.value.query, props.nicknames ?? []) : []))
const listOpen = computed(() => options.value.length > 0)
watch(options, () => (choice.value = 0))

const syncCaret = () => (caret.value = input.value?.selectionStart ?? text.value.length)

/** Puts "@name " where the "@" was typed, in place of the whole mention when the caret is inside one. Answers whether it did (it does not when the message would get too long). */
const pick = (name: string): boolean => {
  const typing = mention.value
  if (!typing) return false
  const before = text.value.slice(0, typing.start)
  const after = text.value.slice(mentionEnd(text.value, typing.start, caret.value, props.nicknames ?? []))
  const inserted = `@${name}${after.startsWith(' ') ? '' : ' '}`
  if (before.length + inserted.length + after.length > MAX_LENGTH) return false
  text.value = before + inserted + after
  caret.value = before.length + inserted.length + (after.startsWith(' ') ? 1 : 0)
  dismissed.value = true
  void nextTick(() => {
    input.value?.focus()
    input.value?.setSelectionRange(caret.value, caret.value)
  })
  return true
}

const onKeydown = (e: KeyboardEvent) => {
  if (!listOpen.value) return
  const last = options.value.length - 1
  if (e.key === 'ArrowDown') choice.value = choice.value >= last ? 0 : choice.value + 1
  else if (e.key === 'ArrowUp') choice.value = choice.value <= 0 ? last : choice.value - 1
  else if (e.key === 'Enter' || e.key === 'Tab') {
    if (!pick(options.value[choice.value])) return // nothing was filled in: Enter still sends and Tab still moves on
  } else if (e.key === 'Escape') dismissed.value = true
  else return
  e.preventDefault()
}

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
  dismissed.value = false
  syncCaret()
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

    <ul v-if="listOpen && !recording" id="mention-list" class="mention-list" role="listbox" :aria-label="t('mention.list')">
      <li
        v-for="(name, i) in options"
        :id="`mention-option-${i}`"
        :key="name"
        role="option"
        :aria-selected="i === choice"
        :class="{ active: i === choice, everyone: name === MENTION_ALL }"
        @mousedown.prevent="pick(name)"
        @mousemove="choice = i"
      >
        <span v-if="name === MENTION_ALL" class="avatar all" aria-hidden="true">@</span>
        <span v-else class="avatar" aria-hidden="true" :style="{ background: colorFor(name) }">{{ name.charAt(0).toUpperCase() }}</span>
        <strong>{{ name === MENTION_ALL ? '@all' : name }}</strong>
        <small v-if="name === MENTION_ALL">{{ t('mention.all') }}</small>
      </li>
    </ul>

    <form v-if="!recording" class="composer" @submit.prevent="submit">
      <button type="button" class="icon-button" :disabled="busy || !!editing" :title="t('composer.photo')" :aria-label="t('composer.photo')" @click="files?.click()">📷</button>
      <input ref="files" class="visually-hidden" type="file" accept="image/*" tabindex="-1" @change="onPick" />
      <input
        ref="input"
        v-model="text"
        type="text"
        :maxlength="MAX_LENGTH"
        :placeholder="t('composer.placeholder')"
        :title="t('composer.whisperHint')"
        aria-label="Message"
        autocomplete="off"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="listOpen"
        :aria-controls="listOpen ? 'mention-list' : undefined"
        :aria-activedescendant="listOpen ? `mention-option-${choice}` : undefined"
        @input="onInput"
        @keydown="onKeydown"
        @keyup="syncCaret"
        @click="syncCaret"
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
