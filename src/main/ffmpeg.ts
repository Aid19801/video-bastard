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

// Returns the overlay filter string for the main video layer.
// Supports optional slam-in animation and/or continuous wobble.
function overlayMain(slamDir?: 'left' | 'right', wobble = false): string {
  // Wobble: two slow sine harmonics layered for organic handheld feel (max ±7px each axis)
  // Primary drift ~9s cycle, secondary ~5s cycle — very gradual, no jitter
  const wobbX = wobble ? `+sin(t*0.7)*4+sin(t*1.3)*3` : ``
  const wobbY = wobble ? `+sin(t*0.5)*4+sin(t*1.1)*3` : ``
  const cy = `(H-h)/2${wobbY}`

  if (!slamDir) {
    if (!wobble) return `overlay=(W-w)/2:(H-h)/2:shortest=1`
    return `overlay=x='(W-w)/2${wobbX}':y='${cy}':eval=frame:shortest=1`
  }

  // Slam: fast entry (0.05s) + bounce overshoot (0.1s sin), then wobble at rest
  const restX = `(W-w)/2${wobbX}`
  const xExpr =
    slamDir === 'right'
      ? `if(lt(t,0.05),W-(W/2+w/2)*t/0.05,if(lt(t,0.15),(W-w)/2-30*sin(PI*(t-0.05)/0.1),${restX}))`
      : `if(lt(t,0.05),-w+(W/2+w/2)*t/0.05,if(lt(t,0.15),(W-w)/2+30*sin(PI*(t-0.05)/0.1),${restX}))`
  return `overlay=x='${xExpr}':y='${cy}':eval=frame:shortest=1`
}

interface PortraitFilterResult {
  filterComplex: string
  bgInput?: string
}

function buildPortraitFilterComplex(
  preset: ExportPreset,
  bgStyle: BgStyle,
  subtitleDrawtext?: string,
  slamDir?: 'left' | 'right',
  wobble = false,
): PortraitFilterResult {
  const { width: w, height: h, fps } = preset
  const ov = overlayMain(slamDir, wobble)

  // ── slo-mo BnW ────────────────────────────────────────────────────────────
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
      `[canvas][bg1out]overlay=(W-w)/2:(H-h)/2:format=auto[step1]`,
      `[step1][bg2out]overlay=(W-w)/2:(H-h)/2:format=auto[step2]`,
      subtitleDrawtext
        ? `[step2][mainscaled]${ov}[composed];[composed]${subtitleDrawtext}[out]`
        : `[step2][mainscaled]${ov}[out]`,
    ]
    return { filterComplex: parts.join(';') }
  }

  // ── none (black bars) ─────────────────────────────────────────────────────
  if (bgStyle === 'none') {
    const parts = [
      `color=c=black:s=${w}x${h}:r=${fps}:d=10000[canvas]`,
      `[0:v]scale=${w}:-2[mainscaled]`,
      subtitleDrawtext
        ? `[canvas][mainscaled]${ov}[composed];[composed]${subtitleDrawtext}[out]`
        : `[canvas][mainscaled]${ov}[out]`,
    ]
    return { filterComplex: parts.join(';') }
  }

  // ── image backgrounds (rainbow, scratchy-blue, checks) ────────────────────
  const bgInput = getBgImagePath(bgStyle)
  const parts = [
    `color=c=black:s=${w}x${h}:r=${fps}:d=10000[base]`,
    `[1:v]scale=${w}:-2,split=2[bgtop][bgbot]`,
    `[base][bgtop]overlay=0:0[step1]`,
    `[step1][bgbot]overlay=0:H-h[step2]`,
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[mainscaled]`,
    subtitleDrawtext
      ? `[step2][mainscaled]${ov}[composed];[composed]${subtitleDrawtext}[out]`
      : `[step2][mainscaled]${ov}[out]`,
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

    const onProgress = (label: string) => sendToRenderer('export:transcribe-progress', { label })

    let subtitleWords: WordTimestamp[] = []
    if (args.subtitles) {
      const wordsFile = `${inputPath}.words.json`
      if (existsSync(wordsFile)) {
        try {
          subtitleWords = JSON.parse(readFileSync(wordsFile, 'utf-8')) as WordTimestamp[]
          onProgress('Using pre-baked captions (dev mode)')
        } catch {}
      } else {
        try {
          if (args.licenceKey) {
            subtitleWords = await transcribeViaWorker(inputPath, args.licenceKey, onProgress)
          } else if (args.openaiApiKey) {
            subtitleWords = await transcribeVideo(inputPath, args.openaiApiKey, onProgress)
          }
        } catch (err) {
          onProgress(`Captions failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    for (const job of jobs) {
      await runJob(job, subtitleWords, args.subtitleStyle, args.bgStyle, args.slamEffect ?? false, args.wobbleEffect ?? false)
    }

    return jobs.map((j) => j.id)
  })
}

async function runJob(
  job: ExportJob,
  subtitleWords: WordTimestamp[] = [],
  subtitleStyle: StartExportArgs['subtitleStyle'] = 'standard',
  bgStyle: StartExportArgs['bgStyle'] = 'slo-mo-bnw',
  slamEffect = false,
  wobbleEffect = false,
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

  const slamDir = slamEffect && portrait ? 'left' : undefined
  const wobble = wobbleEffect && portrait

  sendToRenderer('export:job-status', { jobId: job.id, status: 'processing' })
  await runJobCore(job, job.outputPath, subtitleDrawtext, bgStyle, slamDir, wobble, true)
}

function runJobCore(
  job: ExportJob,
  outputPath: string,
  subtitleDrawtext: string,
  bgStyle: StartExportArgs['bgStyle'] = 'slo-mo-bnw',
  slamDir?: 'left' | 'right',
  wobble = false,
  emitEvents = false,
): Promise<void> {
  return new Promise((resolve) => {
    const { preset, inputPath } = job
    const portrait = preset.height >= preset.width
    const effectiveBgStyle = bgStyle ?? 'slo-mo-bnw'

    const metadataOpts = [
      '-metadata', `title=${job.title ?? ''}`,
      '-metadata', `description=${job.description ?? ''}`,
    ]
    const compatOpts = [
      '-profile:v main',
      '-level:v 4.0',
      '-pix_fmt yuv420p',
      '-vsync cfr',
    ]

    let cmd: ReturnType<typeof ffmpeg>

    if (portrait) {
      const { filterComplex, bgInput } = buildPortraitFilterComplex(
        preset,
        effectiveBgStyle,
        subtitleDrawtext || undefined,
        slamDir,
        wobble,
      )
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
      cmd = ffmpeg(inputPath).outputOptions([
        `-c:v ${preset.codec}`,
        `-b:v ${preset.videoBitrate}`,
        '-c:a aac',
        `-b:a ${preset.audioBitrate}`,
        `-r ${preset.fps}`,
        `-vf ${vfParts.join(',')}`,
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
        if (!emitEvents) return
        const pct = Math.min(Math.round(progress.percent ?? 0), 99)
        sendToRenderer('export:progress', { jobId: job.id, progress: pct })
      })
      .on('end', () => {
        if (emitEvents) {
          sendToRenderer('export:progress', { jobId: job.id, progress: 100 })
          sendToRenderer('export:job-status', { jobId: job.id, status: 'done' })
          sendToRenderer('export:job-done', { jobId: job.id, outputPath })
        }
        resolve()
      })
      .on('error', (err) => {
        if (emitEvents) {
          sendToRenderer('export:job-status', { jobId: job.id, status: 'error' })
          sendToRenderer('export:job-error', { jobId: job.id, error: err.message })
        }
        resolve()
      })
      .run()
  })
}
