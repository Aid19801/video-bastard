import OpenAI from 'openai'
import { getFfmpegPath } from './ffmpeg'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync, unlinkSync, createReadStream, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ExportPreset } from '../shared/types'

export const WORKER_URL = process.env['WORKER_URL'] || 'https://vb-api.funk27.workers.dev'

const execFileAsync = promisify(execFile)

export interface WordTimestamp {
  word: string
  start: number
  end: number
}

// Extract audio to a small mp3 for the Whisper API (max 25MB limit)
async function extractAudio(inputPath: string): Promise<string> {
  const outPath = join(tmpdir(), `vb-audio-${Date.now()}.mp3`)
  await execFileAsync(getFfmpegPath(), [
    '-i', inputPath,
    '-vn',
    '-acodec', 'mp3',
    '-ar', '16000',
    '-ac', '1',
    '-q:a', '5',
    '-y',
    outPath,
  ])
  return outPath
}

// Direct OpenAI path — used in dev when OPENAI_API_KEY is set
export async function transcribeVideo(
  inputPath: string,
  apiKey: string,
  onProgress: (label: string) => void
): Promise<WordTimestamp[]> {
  onProgress('Extracting audio…')
  const audioPath = await extractAudio(inputPath)

  try {
    onProgress('Transcribing with Whisper…')
    const openai = new OpenAI({ apiKey })
    const result = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    })

    const words = (result as unknown as { words: WordTimestamp[] }).words ?? []
    return words.map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }))
      .filter((w) => w.word.length > 0)
  } finally {
    if (existsSync(audioPath)) unlinkSync(audioPath)
  }
}

const FUNK_API_URL = process.env['FUNK_API_URL'] || 'https://funk-api-afd30b1f0bb5.herokuapp.com'

// Transcribe via funk-api (validates licence + calls Whisper server-side)
export async function transcribeViaWorker(
  inputPath: string,
  licenceKey: string,
  onProgress: (label: string) => void
): Promise<WordTimestamp[]> {
  onProgress('Extracting audio…')
  const audioPath = await extractAudio(inputPath)

  try {
    onProgress('Transcribing with Whisper…')
    const audioBase64 = readFileSync(audioPath).toString('base64')

    const res = await fetch(`${FUNK_API_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licence_key: licenceKey, audioBase64 }),
    })

    if (!res.ok) {
      const err = await res.json() as { detail?: string; error?: string }
      throw new Error(err.detail ?? err.error ?? `Transcription error ${res.status}`)
    }

    const words = await res.json() as WordTimestamp[]
    return words.map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }))
      .filter((w) => w.word.length > 0)
  } finally {
    if (existsSync(audioPath)) unlinkSync(audioPath)
  }
}

// Activate a licence key against funk-api
export async function activateLicence(licenceKey: string): Promise<void> {
  const res = await fetch(`${FUNK_API_URL}/licence/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ licence_key: licenceKey }),
  })
  if (!res.ok) {
    const err = await res.json() as { detail?: string; error?: string }
    throw new Error(err.detail ?? err.error ?? 'Invalid licence key')
  }
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')   // smart quote avoids escaping headaches
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

function fontSizeForPreset(preset: ExportPreset): number {
  if (preset.height >= preset.width) return preset.width >= 1080 ? 152 : 120  // portrait/square
  return preset.width >= 1920 ? 108 : 92                                        // landscape
}

function yBaseForPreset(preset: ExportPreset, srcW: number, srcH: number): number {
  if (preset.height >= preset.width) {
    // Portrait: 20px below the bottom edge of the centered main video
    const mainH = Math.round(preset.width * srcH / srcW)
    if (mainH >= preset.height) {
      // Source fills whole frame vertically — fall back to near-bottom
      return preset.height - fontSizeForPreset(preset) - 80
    }
    return Math.round((preset.height + mainH) / 2) + 30
  }
  // Landscape: near bottom
  return preset.height - fontSizeForPreset(preset) - 80
}

// Find a bold font on common macOS paths; fall back to empty string (FFmpeg default)
function findFontFile(): string {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Impact.ttf',
    '/Library/Fonts/Impact.ttf',
    'C:/Windows/Fonts/impact.ttf',
    '/usr/share/fonts/truetype/msttcorefonts/Impact.ttf',
  ]
  return candidates.find((p) => existsSync(p)) ?? ''
}

export function buildSubtitleDrawtext(
  words: WordTimestamp[],
  preset: ExportPreset,
  srcWidth = 1920,
  srcHeight = 1080
): string {
  if (words.length === 0) return ''

  // Portrait uses 2-word chunks — font is large (152px) and 3 words often exceeds frame width
  const CHUNK_SIZE = preset.height >= preset.width ? 2 : 3
  const chunks: WordTimestamp[][] = []
  for (let i = 0; i < words.length; i += CHUNK_SIZE) {
    chunks.push(words.slice(i, i + CHUNK_SIZE))
  }

  const fontSize = fontSizeForPreset(preset)
  const yBase = yBaseForPreset(preset, srcWidth, srcHeight)
  const bounce = 40
  const fontFile = findFontFile()
  const fontOpt = fontFile ? `fontfile='${fontFile}':` : ''

  return chunks.map((chunk) => {
    const text = escapeDrawtext(chunk.map((w) => w.word).join(' '))
    const start = chunk[0].start.toFixed(3)
    const end = chunk[chunk.length - 1].end.toFixed(3)
    // Fade in + bounce upward over 0.25s
    const alphaExpr = `if(lt(t-${start},0.25),(t-${start})/0.25,1)`
    const yExpr = `${yBase}+${bounce}*max(0,1-(t-${start})/0.25)`
    return (
      `drawtext=${fontOpt}` +
      `text='${text}':` +
      `fontsize=${fontSize}:` +
      `fontcolor=white:` +
      `borderw=3:bordercolor=black@0.9:` +
      `box=1:boxcolor=black@0.55:boxborderw=14:` +
      `x='max(40,(w-text_w)/2)':` +
      `y='${yExpr}':` +
      `alpha='${alphaExpr}':` +
      `fix_bounds=1:` +
      `enable='between(t,${start},${end})'`
    )
  }).join(',')
}

// Probe source video dimensions so subtitle placement can be calculated precisely
export async function probeVideoSize(inputPath: string): Promise<{ w: number; h: number }> {
  try {
    await execFileAsync(getFfmpegPath(), ['-i', inputPath])
  } catch (err: unknown) {
    const msg = (err as { stderr?: string; message?: string }).stderr
      || (err as { message?: string }).message
      || ''
    const m = msg.match(/(\d{3,5})x(\d{3,5})/)
    if (m) return { w: parseInt(m[1]), h: parseInt(m[2]) }
  }
  return { w: 1920, h: 1080 }
}
