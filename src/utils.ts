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
  if (count === 0) return 'Nobody here yet'
  return count === 1 ? '1 person here' : `${count} people here`
}

export function typingLabel(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
}

/** "K7M2QX" is easier to read and to dictate as "K7M 2QX". */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
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
