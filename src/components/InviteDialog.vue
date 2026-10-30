<script setup lang="ts">
import QRCode from 'qrcode'
import { onMounted, ref } from 'vue'
import { t } from '../i18n'
import { copyText, groupCode, inviteLink } from '../utils'

const props = defineProps<{ roomName: string; code: string }>()
const emit = defineEmits<{ close: [] }>()

const link = inviteLink(props.code)
const qr = ref('')
const copied = ref(false)
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

// The code is in the part of the link after "#", which browsers never send to a server.
onMounted(async () => {
  qr.value = await QRCode.toString(link, { type: 'svg', margin: 1, width: 220 })
})

const copy = async () => {
  copied.value = await copyText(link)
  setTimeout(() => (copied.value = false), 1500)
}

const share = () => navigator.share({ title: props.roomName, text: t('invite.shareText', { name: props.roomName, code: groupCode(props.code) }), url: link }).catch(() => {})
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="t('invite.title')">
      <h2>{{ t('invite.title') }}</h2>
      <p class="room-name">{{ roomName }}</p>
      <div class="qr" v-html="qr" :aria-label="t('invite.scan')"></div>
      <p class="hint">{{ t('invite.scan') }}</p>
      <p class="big-code">{{ groupCode(code) }}</p>
      <label for="invite-link">{{ t('invite.link') }}</label>
      <input id="invite-link" type="text" readonly :value="link" @focus="($event.target as HTMLInputElement).select()" />
      <div class="dialog-actions">
        <button type="button" class="primary" @click="copy">{{ copied ? t('panel.copied') : t('invite.copyLink') }}</button>
        <button v-if="canShare" type="button" class="secondary" @click="share">{{ t('invite.share') }}</button>
        <button type="button" class="link" @click="emit('close')">{{ t('invite.close') }}</button>
      </div>
    </div>
  </div>
</template>
