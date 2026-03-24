import { app, BrowserWindow, IpcMain } from 'electron'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { PRESETS } from '../shared/presets'
import type { StartExportArgs, ExportJob, ExportPreset, BgStyle } from '../shared/types'
import { transcribeVideo, transcribeViaWorker, buildSubtitleDrawtext, probeVideoSize, type WordTimestamp } from './subtitles'

export function getFfmpegPath(): string {
  const raw = ffmpegStatic as string
  if (app.isPackaged) {
    return raw.replace('app.asar', 'app.asar.unpacked')
  }
  return raw
}

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(getFfmpegPath())
}

const BG_IMAGE_FILES: Record<string, string> = {
  'rainbow': 'rainbow.jpg',
  'scratchy-blue': 'scratchy_blue.jpg',
  'checks': 'checks.jpg',
}

function getBgImagePath(bgStyle: BgStyle): string | null {
  const filename = BG_IMAGE_FILES[bgStyle]
  if (!filename) return null
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backgrounds', filename)
  }
  // dev: images are at project root; __dirname = out/main
  return join(__dirname, '../../', filename)
}

function getOutputPath(inputPath: string, presetId: string, outputDir: string): string {
  const ext = extname(inputPath)
  const name = basename(inputPath, ext)
  return join(outputDir, `${name}_${presetId}.mp4`)
}

function sendToRenderer(channel: string, data: unknown): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) {
    wins[0].webContents.send(channel, data)
  }
}

/**
 * Builds a filter_complex string for portrait exports (TikTok, Instagram Story).
 *
 * Instead of black letterbox bars, the empty space is filled by two copies of
 * the source footage that are:
 *   - Trimmed to the first 30s then slowed to 30% speed (~100s output)
 *   - Converted to black & white
 *   - Set to 30% opacity
 *   - One rotated -10° (behind top area), one rotated +10° (behind bottom area)
 *
 * The main footage is then composited at full quality in the centre foreground.
 */
interface PortraitFilterResult {
  filterComplex: string
  bgInput?: string  // path to bg image if a second input is needed
}

function buildPortraitFilterComplex(
  preset: ExportPreset,
  bgStyle: BgStyle,
  subtitleDrawtext?: string
): PortraitFilterResult {
  const { width: w, height: h, fps } = preset

  const withSubs = (base: string) =>
    subtitleDrawtext ? `${base};${subtitleDrawtext}[out]` : base.replace('[step_final]', '[out]')

  // ── slo-mo BnW (original behaviour) ──────────────────────────────────────
  if (bgStyle === 'slo-mo-bnw' || bgStyle === undefined) {
    const bgScale = 3000
    const bgChain = (angle: string, inL: string, outL: string): string =>
      `[${inL}]trim=duration=30,setpts=(PTS-STARTPTS)/0.3,scale=${bgScale}:-2,hue=s=0,` +
      `rotate=${angle}:ow=${w}:oh=${h}:c=black@0,format=rgba,colorchannelmixer=aa=0.3[${outL}]`

    const parts = [
      `[0:v]split=3[mainv][bg1in][bg2in]`,
      bgChain('-PI/18', 'bg1in', 'bg1out'),
      bgChain('PI/18', 'bg2in', 'bg2out'),
      `[mainv]scale=${w}:-2[mainscaled]`,
      `color=c=black:s=${w}x${h}:r=${fps}:d=10000[canvas]`,
      `[canvas][bg1out]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto[step1]`,
      `[step1][bg2out]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto[step2]`,
      subtitleDrawtext
        ? `[step2][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[composed];[composed]${subtitleDrawtext}[out]`
        : `[step2][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[out]`,
    ]
    return { filterComplex: parts.join(';') }
  }

  // ── none (black bars) ─────────────────────────────────────────────────────
  if (bgStyle === 'none') {
    const parts = [
      `color=c=black:s=${w}x${h}:r=${fps}:d=10000[canvas]`,
      `[0:v]scale=${w}:-2[mainscaled]`,
      subtitleDrawtext
        ? `[canvas][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[composed];[composed]${subtitleDrawtext}[out]`
        : `[canvas][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[out]`,
    ]
    return { filterComplex: parts.join(';') }
  }

  // ── image backgrounds (rainbow, scratchy-blue, checks) ────────────────────
  // Layout: black base, image at top + image at bottom, main video centred.
  // Scale image to frame width (natural aspect ratio) so it's never zoomed.
  const bgInput = getBgImagePath(bgStyle)
  const parts = [
    // Black canvas
    `color=c=black:s=${w}x${h}:r=${fps}:d=10000[base]`,
    // Scale bg image to frame width, keep aspect ratio — split into top + bottom copies
    `[1:v]scale=${w}:-2,split=2[bgtop][bgbot]`,
    // Top copy: pin to top of frame
    `[base][bgtop]overlay=0:0[step1]`,
    // Bottom copy: pin to bottom of frame
    `[step1][bgbot]overlay=0:H-h[step2]`,
    // Main video: fit within frame
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[mainscaled]`,
    // Composite video centred on top
    subtitleDrawtext
      ? `[step2][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[composed];[composed]${subtitleDrawtext}[out]`
      : `[step2][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[out]`,
  ]
  return { filterComplex: parts.join(';'), bgInput: bgInput ?? undefined }
}

export function registerFFmpegHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('export:start', async (_event, args: StartExportArgs) => {
    const { inputPath, presetIds, outputDir } = args
    const jobs: ExportJob[] = []

    for (const presetId of presetIds) {
      const preset = PRESETS.find((p) => p.id === presetId)
      if (!preset) continue

      jobs.push({
        id: randomUUID(),
        inputPath,
        preset,
        outputPath: getOutputPath(inputPath, presetId, outputDir),
        status: 'queued',
        progress: 0,
        title: args.title ? `${args.title} - ${preset.titleSuffix}` : '',
        description: args.description,
      })
    }

    sendToRenderer('export:jobs-created', jobs)

    // Transcribe once before running jobs if captions requested
    let subtitleWords: WordTimestamp[] = []
    if (args.subtitles) {
      const wordsFile = `${inputPath}.words.json`
      if (existsSync(wordsFile)) {
        // Pre-baked dev shortcut — no API call
        try {
          subtitleWords = JSON.parse(readFileSync(wordsFile, 'utf-8')) as WordTimestamp[]
          sendToRenderer('export:transcribe-progress', { label: 'Using pre-baked captions (dev mode)' })
        } catch {}
      } else {
        try {
          const onProgress = (label: string) => sendToRenderer('export:transcribe-progress', { label })
          if (args.licenceKey) {
            subtitleWords = await transcribeViaWorker(inputPath, args.licenceKey, onProgress)
          } else if (args.openaiApiKey) {
            subtitleWords = await transcribeVideo(inputPath, args.openaiApiKey, onProgress)
          }
        } catch (err) {
          sendToRenderer('export:transcribe-progress', {
            label: `Captions failed: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }
    }

    for (const job of jobs) {
      await runJob(job, subtitleWords, args.subtitleStyle, args.bgStyle)
    }

    return jobs.map((j) => j.id)
  })
}

async function runJob(
  job: ExportJob,
  subtitleWords: WordTimestamp[] = [],
  subtitleStyle: StartExportArgs['subtitleStyle'] = 'standard',
  bgStyle: StartExportArgs['bgStyle'] = 'slo-mo-bnw'
): Promise<void> {
  const { preset, inputPath } = job
  const portrait = preset.height >= preset.width
  let srcSize = { w: 1920, h: 1080 }
  if (subtitleWords.length > 0) {
    srcSize = await probeVideoSize(inputPath)
  }
  const subtitleDrawtext = subtitleWords.length > 0
    ? buildSubtitleDrawtext(subtitleWords, preset, srcSize.w, srcSize.h, subtitleStyle ?? 'standard')
    : ''

  return new Promise((resolve) => {
    const { outputPath, id: jobId, title, description } = job
    const metadataOpts = [
      '-metadata', `title=${title ?? ''}`,
      '-metadata', `description=${description ?? ''}`,
    ]
    const compatOpts = [
      '-profile:v main',
      '-level:v 4.0',
      '-pix_fmt yuv420p',
      '-vsync cfr',
    ]

    sendToRenderer('export:job-status', { jobId, status: 'processing' })

    let cmd: ReturnType<typeof ffmpeg>

    if (portrait) {
      const effectiveBgStyle = bgStyle ?? 'slo-mo-bnw'
      const { filterComplex, bgInput } = buildPortraitFilterComplex(
        preset,
        effectiveBgStyle,
        subtitleDrawtext || undefined
      )
      console.log('[vb] bgStyle:', effectiveBgStyle, '| bgInput:', bgInput)
      console.log('[vb] filterComplex:', filterComplex)
      cmd = ffmpeg(inputPath)
      if (bgInput) {
        cmd = cmd.input(bgInput).inputOptions(['-loop', '1'])
      }
      cmd = cmd.outputOptions([
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-map', '0:a?',
        `-c:v ${preset.codec}`,
        `-b:v ${preset.videoBitrate}`,
        '-c:a aac',
        `-b:a ${preset.audioBitrate}`,
        `-r ${preset.fps}`,
        '-movflags +faststart',
        '-preset fast',
        ...compatOpts,
        ...metadataOpts,
      ])
    } else {
      const vfParts = [
        `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease`,
        `pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2:black`,
      ]
      if (subtitleDrawtext) vfParts.push(subtitleDrawtext)
      const vf = vfParts.join(',')

      cmd = ffmpeg(inputPath).outputOptions([
        `-c:v ${preset.codec}`,
        `-b:v ${preset.videoBitrate}`,
        '-c:a aac',
        `-b:a ${preset.audioBitrate}`,
        `-r ${preset.fps}`,
        `-vf ${vf}`,
        '-movflags +faststart',
        '-preset fast',
        ...compatOpts,
        ...metadataOpts,
      ])
    }

    cmd = cmd.output(outputPath)

    if (preset.maxDurationSeconds) {
      cmd = cmd.duration(preset.maxDurationSeconds)
    }

    cmd
      .on('progress', (progress) => {
        const pct = Math.min(Math.round(progress.percent ?? 0), 99)
        sendToRenderer('export:progress', { jobId, progress: pct })
      })
      .on('end', () => {
        sendToRenderer('export:progress', { jobId, progress: 100 })
        sendToRenderer('export:job-status', { jobId, status: 'done' })
        sendToRenderer('export:job-done', { jobId, outputPath })
        resolve()
      })
      .on('error', (err) => {
        sendToRenderer('export:job-status', { jobId, status: 'error' })
        sendToRenderer('export:job-error', { jobId, error: err.message })
        resolve()
      })
      .run()
  })
}
