import { t } from './i18n'

/** The same name always gets the same colour, so people are recognisable in the conversation. */
export function colorFor(name: string): string {
  let hash = 0
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return `hsl(${hash % 360} 62% 48%)`
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function peopleLabel(count: number): string {
  if (count === 0) return t('people.zero')
  return count === 1 ? t('people.one') : t('people.many', { n: count })
}

export function typingLabel(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return t('panel.typingOne', { a: names[0] })
  if (names.length === 2) return t('panel.typingTwo', { a: names[0], b: names[1] })
  return t('panel.typingMany')
}

/** "K7M2QXAB" is easier to read and to dictate as "K7M2 QXAB". */
export function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

/** Copies text to the clipboard. Falls back to a temporary text field where the clipboard API is not available (a page served over plain http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the old way */
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  return copied
}

export interface Segment {
  text: string
  /** the nickname this piece of text mentions, if it is a mention */
  mention?: string
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A message cut into plain text and "@nickname" mentions of the people in the room (nicknames may contain spaces). */
export function splitMentions(text: string, nicknames: string[]): Segment[] {
  const names = [...new Set(nicknames)].filter(Boolean).sort((a, b) => b.length - a.length)
  if (names.length === 0 || !text.includes('@')) return [{ text }]
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    segments.push({ text: match[0], mention: names.find((n) => n.toLowerCase() === match[1].toLowerCase()) })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

/** Whether a message mentions this nickname ("@ada", in any case). */
export function mentions(text: string, nickname: string): boolean {
  return splitMentions(text, [nickname]).some((s) => s.mention !== undefined)
}

/** "/w Bob hello there" as { to: "Bob", text: "hello there" }: the longest nickname of the room that starts the rest of the line. */
export function parseWhisper(line: string, nicknames: string[]): { to: string; text: string } | null {
  const match = /^\/(?:w|whisper)\s+(.+)$/is.exec(line.trim())
  if (!match) return null
  const rest = match[1]
  const names = [...nicknames].sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (rest.toLowerCase().startsWith(name.toLowerCase()) && /^\s+\S/.test(rest.slice(name.length))) {
      return { to: name, text: rest.slice(name.length).trim() }
    }
  }
  return null
}

/** The code in a link such as https://site/#/join/K7M2QXAB, or null. */
export function codeFromHash(hash: string): string | null {
  const match = /^#\/join\/([A-Za-z0-9]{8})$/.exec(hash)
  return match ? match[1].toUpperCase() : null
}

export function inviteLink(code: string, base = location.origin + location.pathname): string {
  return `${base}#/join/${code}`
}

/** The reactions people can use; the server accepts exactly these. */
export const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉']

/** 83000 ms as "1:23". */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
