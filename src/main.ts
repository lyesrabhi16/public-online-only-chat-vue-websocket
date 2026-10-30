import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { useChat } from './composables/chat'
import { codeFromHash } from './utils'

// An invite link carries the room code after "#". It is read once, and taken out of the address bar and the history.
const invite = codeFromHash(location.hash)
if (invite) history.replaceState(null, '', location.pathname + location.search)
useChat(invite)

createApp(App).mount('#app')

// The page can be installed and starts quickly: its files are kept (never what was said, which is not stored anywhere).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {})
}
