/** The loudness bars of a voice message, as on the Android app: measured while recording, drawn as bars. */
export const BARS = 40

/** A loudness (0 to 1, the root mean square of the samples) as a bar height from 0 to 1; the square root makes quiet speech visible. */
export function level(rms: number): number {
  const clamped = Math.min(Math.max(rms, 0), 1)
  return Math.min(1, Math.sqrt(clamped) * 1.25)
}

/** `levels` (0 to 1, any count) reduced to `count` whole numbers from 0 to 100, each the loudest of its slice. */
export function downsample(levels: number[], count = BARS): number[] {
  const out: number[] = []
  const n = levels.length
  for (let i = 0; i < count; i++) {
    let max = 0
    if (n > 0) {
      const from = Math.floor((i * n) / count)
      const to = Math.max(from + 1, Math.floor(((i + 1) * n) / count))
      for (let j = from; j < Math.min(to, n); j++) max = Math.max(max, levels[j])
    }
    out.push(Math.round(max * 100))
  }
  return out
}

/** The bars a message carries (whole numbers 0 to 100) as heights from 0 to 1, whatever junk a sender put in. */
export function toHeights(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  return raw.slice(0, 64).map((v) => Math.min(1, Math.max(0, (typeof v === 'number' && Number.isFinite(v) ? v : 0) / 100)))
}
