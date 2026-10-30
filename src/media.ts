import { BARS, downsample, level } from './waveform'

/** What a photo or a voice message may weigh once prepared (the server accepts up to 450 KB of encrypted text). */
export const MAX_PHOTO_BYTES = 150_000
export const MAX_VOICE_MS = 30_000
const MAX_SIDE = 900

/** The size of a picture shrunk to fit in a square of `max` pixels, keeping its proportions. */
export function fitWithin(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** What the page accepts to show as a photo: a small image data URL of a kind that cannot run code. */
export const PHOTO_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/
export const AUDIO_URL = /^data:audio\/(webm|ogg|mp4|mpeg)(;codecs=[a-z0-9.,]+)?;base64,[A-Za-z0-9+/]+=*$/

export interface Photo {
  src: string
  w: number
  h: number
}

/** A picture file as a JPEG small enough to send: shrunk to 900 pixels, then compressed harder until it fits. */
export async function preparePhoto(file: Blob): Promise<Photo> {
  const bitmap = await createImageBitmap(file)
  let { width, height } = fitWithin(bitmap.width, bitmap.height)
  for (let shrink = 0; shrink < 4; shrink++) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff' // a transparent picture would turn black as a JPEG
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      const src = canvas.toDataURL('image/jpeg', quality)
      if (src.length * 0.75 <= MAX_PHOTO_BYTES) {
        bitmap.close()
        return { src, w: width, h: height }
      }
    }
    width = Math.round(width * 0.75)
    height = Math.round(height * 0.75)
  }
  bitmap.close()
  throw new Error('photo_too_big')
}

export interface Voice {
  src: string
  ms: number
  wave: number[]
}

/** Records the microphone, with a live loudness for the screen and the bars to send once it is over. */
export class VoiceRecorder {
  onLevel: (value: number) => void = () => {}
  onLimit: () => void = () => {}
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private chunks: Blob[] = []
  private levels: number[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private startedAt = 0

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m))
    this.recorder = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 })
    this.chunks = []
    this.levels = []
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data)
    // the loudness, many times a second, from an analyser listening to the same stream
    this.context = new AudioContext()
    const analyser = this.context.createAnalyser()
    analyser.fftSize = 1024
    this.context.createMediaStreamSource(this.stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    this.startedAt = performance.now()
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const s of samples) sum += s * s
      const value = level(Math.sqrt(sum / samples.length))
      this.levels.push(value)
      this.onLevel(value)
      if (performance.now() - this.startedAt >= MAX_VOICE_MS) this.onLimit()
    }, 60)
    this.recorder.start()
  }

  get elapsed(): number {
    return this.recorder ? performance.now() - this.startedAt : 0
  }

  /** Ends the recording and answers with the voice message, or null when there is nothing worth sending. */
  async stop(): Promise<Voice | null> {
    const recorder = this.recorder
    if (!recorder) return null
    const ms = Math.min(this.elapsed, MAX_VOICE_MS)
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
    if (recorder.state !== 'inactive') recorder.stop()
    await done
    const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' })
    this.release()
    if (ms < 700 || blob.size === 0) return null
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    return { src, ms: Math.round(ms), wave: downsample(this.levels, BARS) }
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    this.release()
  }

  private release(): void {
    clearInterval(this.timer)
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.context?.close()
    this.recorder = null
    this.stream = null
    this.context = null
  }
}
