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

/** "K7M2QXAB9T" is easier to read and to dictate as "K7M2Q XAB9T". */
export function groupCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)} ${code.slice(5)}` : code
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

/** The word that mentions everybody in the room: "@all". The server does not let anybody take it as a nickname. */
export const MENTION_ALL = 'all'

export interface Segment {
  text: string
  /** the nickname this piece of text mentions, if it is a mention of a person */
  mention?: string
  /** true for "@all" */
  all?: boolean
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A message cut into plain text, "@nickname" mentions of the people in the room (nicknames may contain spaces) and "@all".
 * An "@" inside a word ("me@all.com") is not a mention.
 */
export function splitMentions(text: string, nicknames: string[]): Segment[] {
  if (!text.includes('@')) return [{ text }]
  const names = [...new Set(nicknames)].filter(Boolean).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])@(${[...names, MENTION_ALL].map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    const name = names.find((n) => n.toLowerCase() === match[1].toLowerCase())
    segments.push(name ? { text: match[0], mention: name } : { text: match[0], all: true })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

/** Whether a message mentions this nickname ("@ada", in any case) or everybody ("@all"). */
export function mentions(text: string, nickname: string): boolean {
  return splitMentions(text, [nickname]).some((s) => s.mention !== undefined || s.all)
}

/** Whether a message mentions everybody ("@all"). */
export function mentionsEveryone(text: string): boolean {
  return splitMentions(text, []).some((s) => s.all)
}

/** The "@" being typed just before the caret, if any: where it starts and what follows it (a nickname can have spaces, so what follows can too). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?<![\p{L}\p{N}_])@([\p{L}\p{N} ._-]{0,20})$/u.exec(text.slice(0, caret))
  return match ? { start: match.index, query: match[1] } : null
}

/** What a mention being typed could be: "all" first, then the nicknames that start with what was typed. Nothing once it cannot be a name any more. */
export function mentionCandidates(query: string, nicknames: string[]): string[] {
  const typed = query.toLowerCase()
  const names = [...new Set(nicknames)].filter((n) => n.toLowerCase().startsWith(typed)).sort((a, b) => a.localeCompare(b))
  return MENTION_ALL.startsWith(typed) ? [MENTION_ALL, ...names] : names
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

/** The code in a link such as https://site/#/join/K7M2QXAB9T, or null. */
export function codeFromHash(hash: string): string | null {
  const match = /^#\/join\/([A-Za-z0-9]{10})$/.exec(hash)
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
