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
