<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { Line, Member } from '../types'
import { colorFor, copyText, formatTime, groupCode, peopleLabel, typingLabel } from '../utils'

const props = defineProps<{ roomName: string; code: string; lines: Line[]; members: Member[]; typing: string[]; error?: string }>()
const emit = defineEmits<{ send: [text: string]; typing: [on: boolean]; leave: []; back: [] }>()

const text = ref('')
const showMembers = ref(false)
const copied = ref(false)
const list = ref<HTMLElement | null>(null)
let typingTimer: ReturnType<typeof setTimeout> | undefined

const scrollDown = () => nextTick(() => list.value && (list.value.scrollTop = list.value.scrollHeight))

// follow the conversation, unless the reader has scrolled up to read something
watch(
  () => props.lines.length,
  () => {
    const el = list.value
    const last = props.lines[props.lines.length - 1]
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom || (last?.kind === 'message' && last.mine)) scrollDown()
  },
  { flush: 'post' },
)

const copyCode = async () => {
  copied.value = await copyText(props.code)
  setTimeout(() => (copied.value = false), 1500)
}

const submit = () => {
  const value = text.value.trim()
  if (!value) return
  emit('send', value)
  text.value = ''
  clearTimeout(typingTimer)
  emit('typing', false)
}

const onInput = () => {
  emit('typing', text.value.trim().length > 0)
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => emit('typing', false), 2500)
}
</script>

<template>
  <section class="panel">
    <header>
      <button type="button" class="icon back" aria-label="Back to the rooms" @click="emit('back')">‹</button>
      <div class="title">
        <h2>{{ roomName }}</h2>
        <button type="button" class="link" @click="showMembers = !showMembers">{{ peopleLabel(members.length) }}</button>
      </div>
      <button type="button" class="code-chip" :title="'Share this code to let people in'" @click="copyCode">
        <span class="code-label">Code</span>
        <strong>{{ groupCode(code) }}</strong>
        <span class="copy">{{ copied ? 'Copied' : 'Copy' }}</span>
      </button>
      <button type="button" class="link" @click="emit('leave')">Leave room</button>
    </header>

    <ul v-if="showMembers" class="members" aria-label="People in the room">
      <li v-for="m in members" :key="m.id">
        <span class="dot" :style="{ background: colorFor(m.nickname) }"></span>{{ m.nickname }}
      </li>
    </ul>

    <ol ref="list" class="lines" aria-live="polite">
      <template v-for="line in lines" :key="line.id">
        <li v-if="line.kind === 'event'" class="event">{{ line.text }}</li>
        <li v-else class="message" :class="{ mine: line.mine }">
          <span v-if="!line.mine" class="author" :style="{ color: colorFor(line.from.nickname) }">{{ line.from.nickname }}</span>
          <span class="text">{{ line.text }}</span>
          <time :datetime="line.at">{{ formatTime(line.at) }}</time>
        </li>
      </template>
    </ol>

    <p class="typing" aria-live="polite">{{ typingLabel(typing) }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form class="composer" @submit.prevent="submit">
      <input
        v-model="text"
        type="text"
        maxlength="500"
        placeholder="Message everyone in the room"
        aria-label="Message"
        autocomplete="off"
        @input="onInput"
      />
      <button type="submit" class="primary" :disabled="!text.trim()">Send</button>
    </form>
  </section>
</template>
