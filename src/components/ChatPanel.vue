<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { t } from '../i18n'
import type { JoinedRoom, Member, Msg } from '../types'
import type { Photo, Voice } from '../media'
import { colorFor, copyText, groupCode, peopleLabel, typingLabel } from '../utils'
import Composer from './Composer.vue'
import InviteDialog from './InviteDialog.vue'
import MessageItem from './MessageItem.vue'

const props = defineProps<{ joined: JoinedRoom; me: Member; error?: string }>()
const emit = defineEmits<{
  send: [text: string, replyTo: string | null]
  save: [id: string, text: string]
  remove: [id: string]
  react: [id: string, emoji: string]
  photo: [photo: Photo, replyTo: string | null]
  voice: [voice: Voice, replyTo: string | null]
  typing: [on: boolean]
  leave: []
  back: []
  lock: [locked: boolean]
  kick: [id: string]
  newCode: []
  mute: [nickname: string]
  problem: [message: string]
}>()

const showMembers = ref(false)
const showInvite = ref(false)
const copied = ref(false)
const zoomed = ref<string | null>(null)
const replyTo = ref<Msg | null>(null)
const editing = ref<Msg | null>(null)
const list = ref<HTMLElement | null>(null)
const composer = ref<InstanceType<typeof Composer> | null>(null)

const isOwner = computed(() => props.joined.room.ownerId === props.me.id)
const nicknames = computed(() => props.joined.members.map((m) => m.nickname))
const byId = computed(() => {
  const map = new Map<string, Msg>()
  for (const line of props.joined.lines) if (line.kind === 'message') map.set(line.msg.id, line.msg)
  return map
})
// what you muted is hidden on your side only
const visible = computed(() => props.joined.lines.filter((l) => l.kind === 'event' || !props.joined.muted.includes(l.msg.from.nickname.toLowerCase())))

const scrollDown = () => nextTick(() => list.value && (list.value.scrollTop = list.value.scrollHeight))

// follow the conversation, unless the reader has scrolled up to read something
watch(
  () => props.joined.lines.length,
  () => {
    const el = list.value
    const last = props.joined.lines[props.joined.lines.length - 1]
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom || (last?.kind === 'message' && last.msg.mine)) scrollDown()
  },
  { flush: 'post' },
)

// another room: nothing half-written carries over
watch(
  () => props.joined.room.id,
  () => {
    replyTo.value = editing.value = null
    showMembers.value = showInvite.value = false
  },
)

const copyCode = async () => {
  copied.value = await copyText(props.joined.code)
  setTimeout(() => (copied.value = false), 1500)
}

const done = () => (replyTo.value = editing.value = null)

const onSend = (text: string) => {
  emit('send', text, replyTo.value?.id ?? null)
  done()
}
const onSave = (text: string) => {
  if (editing.value) emit('save', editing.value.id, text)
  done()
}
const startReply = (msg: Msg) => {
  editing.value = null
  replyTo.value = msg
}
const startEdit = (msg: Msg) => {
  replyTo.value = null
  editing.value = msg
}
const confirmRemove = (msg: Msg) => emit('remove', msg.id)
const confirmNewCode = () => window.confirm(t('panel.newCodeConfirm')) && emit('newCode')
const confirmKick = (m: Member) => window.confirm(t('panel.removeConfirm', { name: m.nickname })) && emit('kick', m.id)
const whisper = (m: Member) => composer.value?.prefill(`/w ${m.nickname} `)
</script>

<template>
  <section class="panel">
    <header>
      <button type="button" class="icon back" :aria-label="t('panel.back')" @click="emit('back')">‹</button>
      <div class="title">
        <h2>{{ joined.room.name }}<span v-if="joined.room.locked" class="lock" :title="t('panel.locked')"> 🔒</span></h2>
        <button type="button" class="link" @click="showMembers = !showMembers">{{ peopleLabel(joined.members.length) }}</button>
      </div>
      <button type="button" class="code-chip" @click="copyCode">
        <span class="code-label">{{ t('panel.code') }}</span>
        <strong>{{ groupCode(joined.code) }}</strong>
        <span class="copy">{{ copied ? t('panel.copied') : t('panel.copy') }}</span>
      </button>
      <button type="button" class="secondary small" @click="showInvite = true">{{ t('panel.invite') }}</button>
      <template v-if="isOwner">
        <button type="button" class="link" @click="emit('lock', !joined.room.locked)">{{ joined.room.locked ? t('panel.unlock') : t('panel.lock') }}</button>
        <button type="button" class="link" @click="confirmNewCode">{{ t('panel.newCode') }}</button>
      </template>
      <button type="button" class="link" @click="emit('leave')">{{ t('panel.leave') }}</button>
    </header>

    <ul v-if="showMembers" class="members" :aria-label="t('panel.people')">
      <li v-for="m in joined.members" :key="m.id">
        <span class="dot" :style="{ background: colorFor(m.nickname) }"></span>
        <span class="member-name">{{ m.nickname }}</span>
        <span v-if="m.id === joined.room.ownerId" class="tag">{{ t('panel.runs') }}</span>
        <span v-if="joined.muted.includes(m.nickname.toLowerCase())" class="tag">{{ t('panel.muted') }}</span>
        <template v-if="m.id !== me.id">
          <button type="button" class="link" @click="whisper(m)">{{ t('panel.whisper') }}</button>
          <button type="button" class="link" @click="emit('mute', m.nickname)">{{ joined.muted.includes(m.nickname.toLowerCase()) ? t('panel.unmute') : t('panel.mute') }}</button>
          <button v-if="isOwner" type="button" class="link danger" @click="confirmKick(m)">{{ t('panel.remove') }}</button>
        </template>
      </li>
    </ul>

    <ol ref="list" class="lines" aria-live="polite">
      <template v-for="line in visible" :key="line.kind === 'event' ? line.id : line.msg.id">
        <li v-if="line.kind === 'event'" class="event">{{ t(line.key, line.params) }}</li>
        <MessageItem
          v-else
          :msg="line.msg"
          :replied="line.msg.replyTo ? (byId.get(line.msg.replyTo) ?? null) : null"
          :nicknames="nicknames"
          :me="me.nickname"
          @reply="startReply"
          @edit="startEdit"
          @remove="confirmRemove"
          @react="(m, emoji) => emit('react', m.id, emoji)"
          @photo="(src) => (zoomed = src)"
        />
      </template>
    </ol>

    <p class="typing" aria-live="polite">{{ typingLabel(joined.typing) }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <Composer
      ref="composer"
      :reply-to="replyTo"
      :editing="editing"
      @send="onSend"
      @save="onSave"
      @photo="(p) => (emit('photo', p, replyTo?.id ?? null), done())"
      @voice="(v) => (emit('voice', v, replyTo?.id ?? null), done())"
      @typing="(on) => emit('typing', on)"
      @cancel="done"
      @problem="(m) => emit('problem', m)"
    />

    <InviteDialog v-if="showInvite" :room-name="joined.room.name" :code="joined.code" @close="showInvite = false" />
    <div v-if="zoomed" class="overlay lightbox" @click="zoomed = null">
      <img :src="zoomed" :alt="t('msg.photo')" />
      <button type="button" class="link" :aria-label="t('lightbox.close')">✕</button>
    </div>
  </section>
</template>
