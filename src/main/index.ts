import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
import { writeFile } from 'fs/promises'
import { getApiKey, setApiKey, getLicenceKey, setLicenceKey, getOutputDir, setOutputDir } from './config'
import { activateLicence, WORKER_URL } from './subtitles'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

// Auto-update from GitHub Releases. electron-updater reads the latest.yml /
// latest-mac.yml that electron-builder publishes next to the binaries, compares
// against app.getVersion(), then downloads and stages the new version in the
// background. The user restarts once instead of deleting and reinstalling.
function setupAutoUpdate(): void {
  autoUpdater.autoDownload = true
  // We ship stable tags only; never offer a prerelease.
  autoUpdater.allowPrerelease = false
  autoUpdater.autoInstallOnAppQuit = true

  const send = (channel: string, payload: unknown): void => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) wins[0].webContents.send(channel, payload)
  }

  autoUpdater.on('update-available', (info) => {
    send('app:update-available', { version: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    send('app:update-progress', { percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    send('app:update-ready', { version: info.version })
  })
  autoUpdater.on('error', (err) => {
    // Never block the app on a failed update check (offline, rate limited,
    // private repo with no token) — just tell the renderer so it can offer the
    // manual download link instead.
    send('app:update-error', { message: err?.message ?? 'Update check failed' })
  })

  // Unsigned/unpacked dev builds can't self-update; don't even try.
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch(() => {
    // handled by the error event above
  })
}

const GITHUB_RELEASES_URL = 'https://github.com/Aid19801/video-bastard/releases'

import { registerFFmpegHandlers } from './ffmpeg'
import { registerYoutubeHandlers } from './youtube'
import { registerImageFxHandlers } from './imagefx'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerFFmpegHandlers(ipcMain)
  registerYoutubeHandlers(ipcMain)
  registerImageFxHandlers(ipcMain)

  // Restart into the staged update. quitAndInstall closes every window, so the
  // renderer must only call this once the download has finished.
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })
  ipcMain.handle('update:releasesUrl', () => GITHUB_RELEASES_URL)

  ipcMain.handle('app:desktopPath', () => app.getPath('desktop'))
  // Default export destination on every platform. Electron resolves the real
  // known-folder, so this follows a redirected/OneDrive Downloads correctly.
  ipcMain.handle('app:downloadsPath', () => app.getPath('downloads'))
  ipcMain.handle('app:podcastDir', () => {
    const dir = join(app.getPath('documents'), 'Podcast', 'FAR RIGHT WATCH - GB News')
    mkdirSync(dir, { recursive: true })
    return dir
  })
  ipcMain.handle('config:getApiKey', () => getApiKey())
  ipcMain.handle('config:setApiKey', (_event, key: string) => setApiKey(key))
  ipcMain.handle('config:getOutputDir', () => getOutputDir())
  ipcMain.handle('config:setOutputDir', (_event, dir: string) => setOutputDir(dir))
  ipcMain.handle('config:getLicenceKey', () => getLicenceKey())
  ipcMain.handle('config:setLicenceKey', (_event, key: string) => setLicenceKey(key))
  ipcMain.handle('app:isPackaged', () => app.isPackaged)
  ipcMain.handle('licence:activate', async (_event, key: string) => {
    await activateLicence(key)   // throws on failure
    setLicenceKey(key)
  })

  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    shell.openExternal(url)
  })

  ipcMain.handle('shell:showItemInFolder', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('dev:getTestVideoPath', () => {
    const p = join(__dirname, '../../dev-assets/test.mp4')
    return existsSync(p) ? p : null
  })

  ipcMain.handle('audio:save', async (_event, { filename, buffer }: { filename: string; buffer: ArrayBuffer }) => {
    const downloadsDir = app.getPath('downloads')
    const filePath = join(downloadsDir, filename)
    await writeFile(filePath, Buffer.from(buffer))
    return { saved: true, filePath }
  })

  // Fetch a remote image URL in the main process and hand it back as a data
  // URL. Doing the fetch here (rather than in the renderer) avoids CORS-tainted
  // canvases, so the pixels stay readable for the image effects.
  ipcMain.handle('image:fetchUrl', async (_event, url: string) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not fetch image (HTTP ${res.status})`)
    const type = res.headers.get('content-type') || 'image/png'
    if (!type.startsWith('image/')) throw new Error('That URL is not an image')
    const buf = Buffer.from(await res.arrayBuffer())
    return `data:${type};base64,${buf.toString('base64')}`
  })

  ipcMain.handle('dialog:selectOutputDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  createWindow()
  setupAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
