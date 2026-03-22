import { app, BrowserWindow, IpcMain } from 'electron'
import YTDlpWrapModule from 'yt-dlp-wrap'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const YTDlpWrap = (YTDlpWrapModule as any).default ?? YTDlpWrapModule
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync } from 'fs'

function ytDlpBinaryPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(app.getPath('userData'), `yt-dlp${ext}`)
}

function sendToRenderer(channel: string, data: unknown): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) wins[0].webContents.send(channel, data)
}

async function getYtDlp(): Promise<YTDlpWrap> {
  const binPath = ytDlpBinaryPath()
  if (!existsSync(binPath)) {
    sendToRenderer('youtube:progress', { label: 'Downloading yt-dlp…', percent: 0 })
    await YTDlpWrap.downloadFromGithub(binPath)
  }
  return new YTDlpWrap(binPath)
}

export function registerYoutubeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('youtube:download', async (_event, url: string) => {
    const ytDlp = await getYtDlp()

    // Fetch metadata for title/description
    sendToRenderer('youtube:progress', { label: 'Fetching video info…', percent: 0 })
    let videoTitle = ''
    let videoDescription = ''
    try {
      const info = await ytDlp.getVideoInfo(url)
      videoTitle = (info.title as string) ?? ''
      videoDescription = (info.description as string) ?? ''
    } catch {
      // non-fatal — title/description will just be empty
    }

    const outputPath = join(tmpdir(), `video-bastard-${Date.now()}.mp4`)

    return new Promise<{ path: string; title: string; description: string }>(
      (resolve, reject) => {
        const dl = ytDlp.exec([
          url,
          '-o', outputPath,
          '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          '--no-playlist',
          '--merge-output-format', 'mp4',
        ])

        dl.on('progress', (progress) => {
          sendToRenderer('youtube:progress', {
            label: 'Downloading…',
            percent: Math.round(progress.percent ?? 0),
          })
        })

        dl.on('close', () => {
          if (!existsSync(outputPath)) {
            reject(new Error('Download failed — output file was not created. Check the URL and try again.'))
          } else {
            resolve({ path: outputPath, title: videoTitle, description: videoDescription })
          }
        })

        dl.on('error', (err: Error) => {
          reject(new Error(err?.message ?? 'Download failed'))
        })
      }
    )
  })
}
