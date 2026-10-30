<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { t } from '../i18n'
import type { Msg } from '../types'
import { EMOJIS, clock, colorFor, formatTime, splitMentions } from '../utils'
import { toHeights } from '../waveform'
import WaveBars from './WaveBars.vue'

const props = defineProps<{ msg: Msg; replied: Msg | null; nicknames: string[]; me: string }>()
const emit = defineEmits<{ reply: [msg: Msg]; edit: [msg: Msg]; remove: [msg: Msg]; react: [msg: Msg, emoji: string]; photo: [src: string] }>()

const picking = ref(false)
const segments = computed(() => splitMentions(props.msg.text, props.nicknames))
const heights = computed(() => toHeights(props.msg.wave))
const reactions = computed(() => Object.entries(props.msg.reactions))
const canChange = computed(() => props.msg.mine && !!props.msg.proof && !props.msg.deleted && !props.msg.whisperTo)

const snippet = (m: Msg) => (m.deleted ? t('msg.deleted') : m.kind === 'image' ? t('msg.photo') : m.kind === 'audio' ? t('msg.voice') : m.text.slice(0, 80))

// ---- playing a voice message
const playing = ref(false)
const progress = ref(-1)
const position = ref(0)
let sound: HTMLAudioElement | null = null

const toggle = () => {
  if (!props.msg.src) return
  if (!sound) {
    sound = new Audio(props.msg.src)
    sound.ontimeupdate = () => {
      position.value = sound!.currentTime * 1000
      progress.value = sound!.duration ? sound!.currentTime / sound!.duration : 0
    }
    sound.onended = () => {
      playing.value = false
      progress.value = -1
      position.value = 0
    }
    sound.onpause = () => (playing.value = false)
    sound.onplay = () => (playing.value = true)
  }
  if (sound.paused) void sound.play()
  else sound.pause()
}

onBeforeUnmount(() => sound?.pause())
</script>

<template>
  <li class="message" :class="{ mine: msg.mine, whisper: !!msg.whisperTo, gone: msg.deleted }">
    <span v-if="msg.whisperTo" class="whisper-label">{{ msg.mine ? t('msg.whisperTo', { name: msg.whisperTo }) : t('msg.whisperFrom') }}</span>
    <span v-if="!msg.mine" class="author" :style="{ color: colorFor(msg.from.nickname) }">{{ msg.from.nickname }}</span>

    <blockquote v-if="msg.replyTo && !msg.deleted" class="quote">
      <template v-if="replied">
        <strong>{{ replied.mine ? t('msg.you') : replied.from.nickname }}</strong>
        <span>{{ snippet(replied) }}</span>
      </template>
      <em v-else>{{ t('msg.unavailable') }}</em>
    </blockquote>

    <em v-if="msg.deleted" class="text">{{ t('msg.deleted') }}</em>
    <em v-else-if="msg.unreadable" class="text">{{ t('msg.unreadable') }}</em>
    <template v-else>
      <img
        v-if="msg.kind === 'image'"
        class="photo"
        :src="msg.src"
        :alt="t('msg.photo')"
        :width="msg.w || undefined"
        :height="msg.h || undefined"
        loading="lazy"
        @click="emit('photo', msg.src!)"
      />
      <div v-else-if="msg.kind === 'audio'" class="voice">
        <button type="button" class="play" :aria-label="playing ? t('msg.pause') : t('msg.play')" @click="toggle">{{ playing ? '❚❚' : '▶' }}</button>
        <WaveBars :heights="heights" :progress="progress" />
        <span class="duration">{{ clock(playing || position ? position : msg.ms ?? 0) }}</span>
      </div>
      <span v-if="msg.kind === 'text' || msg.text" class="text"
        ><template v-for="(s, i) in segments" :key="i"
          ><span v-if="s.mention || s.all" class="mention" :class="{ self: s.all || s.mention?.toLowerCase() === me.toLowerCase() }">{{ s.text }}</span
          ><template v-else>{{ s.text }}</template></template
        ></span
      >
    </template>

    <div v-if="reactions.length" class="reactions">
      <button
        v-for="[emoji, names] in reactions"
        :key="emoji"
        type="button"
        class="reaction"
        :class="{ mine: names.includes(me) }"
        :title="names.join(', ')"
        @click="emit('react', msg, emoji)"
      >
        {{ emoji }} {{ names.length }}
      </button>
    </div>

    <time :datetime="msg.at">{{ formatTime(msg.at) }}<template v-if="msg.edited"> · {{ t('msg.edited') }}</template></time>

    <div v-if="!msg.deleted && !msg.unreadable" class="actions-row">
      <button type="button" :title="t('msg.reply')" @click="emit('reply', msg)">↩</button>
      <button v-if="!msg.whisperTo" type="button" :title="t('msg.react')" @click="picking = !picking">☺</button>
      <button v-if="canChange && msg.kind === 'text'" type="button" :title="t('msg.edit')" @click="emit('edit', msg)">✎</button>
      <button v-if="canChange" type="button" :title="t('msg.delete')" @click="emit('remove', msg)">🗑</button>
    </div>
    <div v-if="picking" class="picker">
      <button
        v-for="emoji in EMOJIS"
        :key="emoji"
        type="button"
        @click="(emit('react', msg, emoji), (picking = false))"
      >
        {{ emoji }}
      </button>
    </div>
  </li>
</template>
