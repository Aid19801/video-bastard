import { app, BrowserWindow, IpcMain } from 'electron'
import YTDlpWrapModule from 'yt-dlp-wrap'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const YTDlpWrap = (YTDlpWrapModule as any).default ?? YTDlpWrapModule
import { join, delimiter } from 'path'
import { tmpdir, homedir } from 'os'
import { existsSync, readdirSync, statSync, utimesSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getFfmpegPath } from './ffmpeg'

const execFileAsync = promisify(execFile)

// yt-dlp rots fast — YouTube changes break old versions (403 Forbidden), so
// refresh the binary if it's older than this.
const YTDLP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Locate a binary by name across PATH plus common install dirs. GUI-launched
// apps often get a minimal PATH that misses Homebrew etc., so we check those
// explicitly. Returns the full path or null.
function findBinary(name: string): string | null {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const dirs = [
    ...(process.env['PATH']?.split(delimiter) ?? []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(homedir(), '.deno', 'bin'),
    join(homedir(), '.bun', 'bin'),
  ]
  for (const dir of dirs) {
    if (!dir) continue
    const full = join(dir, name + ext)
    if (existsSync(full)) return full
  }
  return null
}

// YouTube now requires a JS runtime to solve signature challenges — without one
// many videos fail with 403. Electron's embedded Node is too old for yt-dlp's
// EJS, so we look for a real runtime on the machine (deno preferred, then node;
// bun works but yt-dlp has deprecated it). Returns a --js-runtimes value or null.
function findJsRuntime(): string | null {
  for (const name of ['deno', 'node', 'bun']) {
    const bin = findBinary(name)
    if (bin) return `${name}:${bin}`
  }
  return null
}

// YouTube increasingly gates videos behind a "confirm you're not a bot" check
// that requires cookies. Detect an installed browser whose cookies yt-dlp can
// borrow. Returns a yt-dlp browser name (chrome/brave/…) or null. Safari is
// skipped — reading its cookies needs Full Disk Access and otherwise errors.
function findBrowserForCookies(): string | null {
  const home = homedir()
  const local = process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local')
  const roaming = process.env['APPDATA'] || join(home, 'AppData', 'Roaming')

  // [yt-dlp browser name, a dir that exists only if the browser is installed]
  let candidates: [string, string][]
  if (process.platform === 'darwin') {
    const as = join(home, 'Library', 'Application Support')
    candidates = [
      ['chrome', join(as, 'Google/Chrome')],
      ['brave', join(as, 'BraveSoftware/Brave-Browser')],
      ['edge', join(as, 'Microsoft Edge')],
      ['chromium', join(as, 'Chromium')],
      ['vivaldi', join(as, 'Vivaldi')],
      ['firefox', join(as, 'Firefox/Profiles')],
    ]
  } else if (process.platform === 'win32') {
    candidates = [
      ['chrome', join(local, 'Google/Chrome/User Data')],
      ['brave', join(local, 'BraveSoftware/Brave-Browser/User Data')],
      ['edge', join(local, 'Microsoft/Edge/User Data')],
      ['chromium', join(local, 'Chromium/User Data')],
      ['vivaldi', join(local, 'Vivaldi/User Data')],
      ['firefox', join(roaming, 'Mozilla/Firefox/Profiles')],
    ]
  } else {
    candidates = [
      ['chrome', join(home, '.config/google-chrome')],
      ['chromium', join(home, '.config/chromium')],
      ['brave', join(home, '.config/BraveSoftware/Brave-Browser')],
      ['firefox', join(home, '.mozilla/firefox')],
    ]
  }

  for (const [name, dir] of candidates) {
    if (hasReadableCookieDb(name, dir)) return name
  }
  return null
}

// A browser is only usable if a cookie DB is actually there AND we can list the
// profile directory — that's how yt-dlp locates the DB. On macOS the browser's
// data dir is TCC-protected: a process can stat a known file inside it but
// readdir fails with EPERM unless it has Full Disk Access. That's exactly the
// "could not find chrome cookies database" error, and the dir existing tells us
// nothing. Probing here means we skip the browser rather than fail the download.
function hasReadableCookieDb(name: string, dir: string): boolean {
  const dbName = name === 'firefox' ? 'cookies.sqlite' : 'Cookies'
  let profiles: string[]
  try {
    profiles = readdirSync(dir)
  } catch {
    return false // missing, or unreadable (macOS TCC / permissions)
  }
  // Chromium keeps cookies at <profile>/Cookies or <profile>/Network/Cookies;
  // the empty entry covers layouts with no profile subdirectory.
  for (const profile of ['', ...profiles]) {
    const base = join(dir, profile)
    if (existsSync(join(base, dbName)) || existsSync(join(base, 'Network', dbName))) return true
  }
  return false
}

// Common flags for talking to YouTube: a JS runtime for signature challenges
// and browser cookies for the bot check. Shared by info + download so they
// behave identically.
function youtubeArgs(useCookies = true): string[] {
  const args: string[] = []
  const runtime = findJsRuntime()
  if (runtime) args.push('--js-runtimes', runtime)
  if (useCookies) {
    const browser = findBrowserForCookies()
    if (browser) args.push('--cookies-from-browser', browser)
  }
  return args
}

// Most videos download fine anonymously, and borrowing browser cookies has real
// costs: it hands the user's live Google session to yt-dlp, it's the account
// carrying those cookies that gets rate-limited if YouTube dislikes the traffic,
// and extraction fails outright on some setups (macOS TCC, Chrome's app-bound
// encryption on Windows, a locked DB while the browser runs). So we go without
// them by default and only reach for them when YouTube actually demands a signed
// in session — a bot check, an age gate, or private/members-only content.
function needsAuth(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not a bot|sign in|log ?in|age.?restrict|age.?gate|private video|members.?only|account/i.test(msg)
}

// Fetch video metadata directly (yt-dlp-wrap's getVideoInfo hardcodes its own
// args and ignores ours, so it misses the runtime/cookie flags above).
async function fetchVideoInfo(
  url: string
): Promise<{ duration: number; title: string; description: string }> {
  const run = (useCookies: boolean): Promise<{ stdout: string }> =>
    execFileAsync(
      ytDlpBinaryPath(),
      [url, '--dump-single-json', '--skip-download', '--no-warnings', ...youtubeArgs(useCookies)],
      { maxBuffer: 64 * 1024 * 1024 }
    )

  let stdout: string
  try {
    ;({ stdout } = await run(false))
  } catch (err) {
    // Only worth a second attempt if YouTube asked us to sign in and we have a
    // browser whose cookies we can actually read.
    if (!needsAuth(err) || !findBrowserForCookies()) throw err
    ;({ stdout } = await run(true))
  }
  const info = JSON.parse(stdout) as { duration?: number; title?: string; description?: string }
  return {
    duration: Number(info.duration) || 0,
    title: info.title ?? '',
    description: info.description ?? '',
  }
}

function ytDlpBinaryPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(app.getPath('userData'), `yt-dlp${ext}`)
}

function sendToRenderer(channel: string, data: unknown): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) wins[0].webContents.send(channel, data)
}

// Ensure the yt-dlp binary is present, downloading it once if missing. Does NOT
// self-update (that happens in the background — see maybeUpdateYtDlp) and only
// emits progress when asked, so the lightweight info fetch never hijacks the UI.
async function ensureYtDlp(emitProgress: boolean): Promise<InstanceType<typeof YTDlpWrap>> {
  const binPath = ytDlpBinaryPath()
  if (!existsSync(binPath)) {
    if (emitProgress) sendToRenderer('youtube:progress', { label: 'Downloading yt-dlp…', percent: 0 })
    await YTDlpWrap.downloadFromGithub(binPath)
  }
  return new YTDlpWrap(binPath)
}

// Fire-and-forget self-update. Never blocks a download or the UI — the refreshed
// binary is simply used next time. We bump the binary's mtime up front so a
// failed attempt won't re-trigger until the next interval (no hammering).
function maybeUpdateYtDlp(): void {
  const binPath = ytDlpBinaryPath()
  if (!existsSync(binPath)) return
  try {
    if (Date.now() - statSync(binPath).mtimeMs <= YTDLP_MAX_AGE_MS) return
    utimesSync(binPath, new Date(), new Date())
  } catch {
    return
  }
  execFile(binPath, ['-U'], { timeout: 120_000 }, () => {
    // best-effort; ignore success/failure
  })
}

interface DownloadArgs {
  url: string
  startSec?: number
  endSec?: number
}

export function registerYoutubeHandlers(ipcMain: IpcMain): void {
  // Refresh yt-dlp in the background at startup, off the request path.
  maybeUpdateYtDlp()

  // Lightweight metadata fetch so the UI can show a trim slider before download.
  // Silent — must never emit progress or it hijacks the download overlay.
  ipcMain.handle('youtube:info', async (_event, url: string) => {
    await ensureYtDlp(false)
    const info = await fetchVideoInfo(url)
    return { duration: info.duration, title: info.title }
  })

  ipcMain.handle('youtube:download', async (_event, arg: string | DownloadArgs) => {
    // Back-compat: a bare string is treated as the URL with no trim.
    const { url, startSec, endSec } = typeof arg === 'string' ? { url: arg } as DownloadArgs : arg
    const trim = startSec != null && endSec != null && endSec > startSec

    const ytDlp = await ensureYtDlp(true)

    // Fetch metadata for title/description
    sendToRenderer('youtube:progress', { label: 'Fetching video info…', percent: 0 })
    let videoTitle = ''
    let videoDescription = ''
    try {
      const info = await fetchVideoInfo(url)
      videoTitle = info.title
      videoDescription = info.description
    } catch {
      // non-fatal — title/description will just be empty
    }

    const outputPath = join(tmpdir(), `video-bastard-${Date.now()}.mp4`)

    const buildArgs = (useCookies: boolean): string[] => {
      const execArgs = [
        url,
        '-o', outputPath,
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--no-playlist',
        '--merge-output-format', 'mp4',
        // Point yt-dlp at the bundled ffmpeg so cutting/merging works without a
        // system ffmpeg on PATH (needed in the packaged app).
        '--ffmpeg-location', getFfmpegPath(),
        // JS runtime + browser cookies (signature challenges + bot check).
        ...youtubeArgs(useCookies),
      ]

      if (trim) {
        // Only download the requested segment — for a 2hr source this fetches
        // just the clip, not the whole video. Keyframe-accurate cut points.
        execArgs.push(
          '--download-sections', `*${startSec}-${endSec}`,
          '--force-keyframes-at-cuts',
        )
      }
      return execArgs
    }

    const attempt = (useCookies: boolean): Promise<{ path: string; title: string; description: string }> =>
      new Promise((resolve, reject) => {
        const dl = ytDlp.exec(buildArgs(useCookies))

        dl.on('progress', (progress: { percent?: number }) => {
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
      })

    try {
      return await attempt(false)
    } catch (err) {
      if (!needsAuth(err) || !findBrowserForCookies()) throw err
      // YouTube wants a signed-in session — retry borrowing browser cookies.
      sendToRenderer('youtube:progress', { label: 'Signing in via browser cookies…', percent: 0 })
      return await attempt(true)
    }
  })
}
