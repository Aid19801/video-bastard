import { BrowserWindow, IpcMain } from 'electron'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { PRESETS } from '../shared/presets'
import type { StartExportArgs, ExportJob, ExportPreset } from '../shared/types'
import { transcribeVideo, transcribeViaWorker, buildSubtitleDrawtext, probeVideoSize, type WordTimestamp } from './subtitles'

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic)
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
function buildPortraitFilterComplex(preset: ExportPreset, subtitleDrawtext?: string): string {
  const { width: w, height: h, fps } = preset

  // Scale large enough that after a 10° rotation the full portrait frame is covered.
  // Worst case for landscape sources: need ~2700px wide. 3000 gives comfortable margin.
  const bgScale = 3000

  const bgChain = (angle: string, inL: string, outL: string): string =>
    `[${inL}]trim=duration=30,` +
    `setpts=(PTS-STARTPTS)/0.3,` +
    `scale=${bgScale}:-2,` +
    `hue=s=0,` +
    `rotate=${angle}:ow=${w}:oh=${h}:c=black@0,` +
    `format=rgba,` +
    `colorchannelmixer=aa=0.3` +
    `[${outL}]`

  return [
    // Split source into: main video + two background copies
    `[0:v]split=3[mainv][bg1in][bg2in]`,

    // Background 1: rotated -10° (fills gaps behind upper portion)
    bgChain('-PI/18', 'bg1in', 'bg1out'),

    // Background 2: rotated +10° (fills gaps behind lower portion)
    bgChain('PI/18', 'bg2in', 'bg2out'),

    // Main video: scale to target width, preserve aspect ratio
    `[mainv]scale=${w}:-2[mainscaled]`,

    // Black canvas as base layer
    `color=c=black:s=${w}x${h}:r=${fps}:d=10000[canvas]`,

    // Layer: canvas → bg1 → bg2 → main
    `[canvas][bg1out]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto[step1]`,
    `[step1][bg2out]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto[step2]`,
    subtitleDrawtext
      ? `[step2][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[composed];[composed]${subtitleDrawtext}[out]`
      : `[step2][mainscaled]overlay=(W-w)/2:(H-h)/2:shortest=1[out]`,
  ].join(';')
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
      await runJob(job, subtitleWords)
    }

    return jobs.map((j) => j.id)
  })
}

async function runJob(job: ExportJob, subtitleWords: WordTimestamp[] = []): Promise<void> {
  const { preset, inputPath } = job
  const portrait = preset.height >= preset.width
  let srcSize = { w: 1920, h: 1080 }
  if (subtitleWords.length > 0) {
    srcSize = await probeVideoSize(inputPath)
  }
  const subtitleDrawtext = subtitleWords.length > 0
    ? buildSubtitleDrawtext(subtitleWords, preset, srcSize.w, srcSize.h)
    : ''

  return new Promise((resolve) => {
    const { outputPath, id: jobId, title, description } = job
    const metadataOpts = [
      '-metadata', `title=${title ?? ''}`,
      '-metadata', `description=${description ?? ''}`,
    ]
    // Compatibility flags accepted by every major platform's web uploader:
    // - main profile + level 4.0: Instagram/TikTok web rejects High profile
    // - yuv420p: required for broad decoder support
    // - vsync cfr: VFR source (phones, YouTube) causes grey-out on web uploaders
    const compatOpts = [
      '-profile:v main',
      '-level:v 4.0',
      '-pix_fmt yuv420p',
      '-vsync cfr',
    ]

    sendToRenderer('export:job-status', { jobId, status: 'processing' })

    let cmd: ReturnType<typeof ffmpeg>

    if (portrait) {
      const filterComplex = buildPortraitFilterComplex(preset, subtitleDrawtext || undefined)
      cmd = ffmpeg(inputPath).outputOptions([
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
