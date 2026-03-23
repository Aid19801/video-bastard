import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { getApiKey, setApiKey, getLicenceKey, setLicenceKey } from './config'
import { activateLicence, WORKER_URL } from './subtitles'
import { join } from 'path'
import { existsSync } from 'fs'

function isNewerVersion(latest: string, current: string): boolean {
  const [la, lb, lc] = latest.split('.').map(Number)
  const [ca, cb, cc] = current.split('.').map(Number)
  if (la !== ca) return la > ca
  if (lb !== cb) return lb > cb
  return lc > cc
}

const GITHUB_RELEASES_URL = 'https://github.com/Aid19801/video-bastard/releases'
const GITHUB_API_LATEST = 'https://api.github.com/repos/Aid19801/video-bastard/releases/latest'

async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(GITHUB_API_LATEST, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'video-bastard' }
    })
    if (!res.ok) return
    const data = await res.json() as { tag_name: string; html_url: string }
    // tag_name is "v1.0.0" — strip the leading "v" before comparing
    const latestVersion = data.tag_name.replace(/^v/, '')
    if (!isNewerVersion(latestVersion, app.getVersion())) return
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      wins[0].webContents.send('app:update-available', {
        version: latestVersion,
        downloadUrl: GITHUB_RELEASES_URL,
      })
    }
  } catch {
    // silently ignore — no network, GitHub down, etc.
  }
}
import { registerFFmpegHandlers } from './ffmpeg'
import { registerYoutubeHandlers } from './youtube'

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

  ipcMain.handle('app:desktopPath', () => app.getPath('desktop'))
  ipcMain.handle('config:getApiKey', () => getApiKey())
  ipcMain.handle('config:setApiKey', (_event, key: string) => setApiKey(key))
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

  ipcMain.handle('dialog:selectOutputDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  createWindow()
  checkForUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
