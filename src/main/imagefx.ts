import { IpcMain } from 'electron'
import ffmpeg from 'fluent-ffmpeg'
import { getFfmpegPath } from './ffmpeg'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'

ffmpeg.setFfmpegPath(getFfmpegPath())

export function registerImageFxHandlers(ipcMain: IpcMain): void {
  // Encode a sequence of JPEG frames (base64, no data-URL prefix) into an H.264
  // MP4 and hand it back as a data URL for preview + download.
  ipcMain.handle(
    'image:encodeMp4',
    async (_event, { frames, fps }: { frames: string[]; fps: number }) => {
      const dir = mkdtempSync(join(tmpdir(), 'vb-cutout-'))
      try {
        frames.forEach((b64, i) => {
          writeFileSync(join(dir, `frame_${String(i).padStart(4, '0')}.jpg`), Buffer.from(b64, 'base64'))
        })
        const out = join(dir, 'cutout.mp4')
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(join(dir, 'frame_%04d.jpg'))
            .inputOptions([`-framerate ${fps}`, '-start_number 0'])
            // libx264 + yuv420p needs even dimensions.
            .videoFilters('scale=trunc(iw/2)*2:trunc(ih/2)*2')
            .videoCodec('libx264')
            .outputOptions(['-pix_fmt yuv420p', '-movflags +faststart'])
            .fps(fps)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(out)
        })
        const buf = readFileSync(out)
        return `data:video/mp4;base64,${buf.toString('base64')}`
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
}
