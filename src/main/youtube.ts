import { app, BrowserWindow, IpcMain } from 'electron'
import YTDlpWrapModule from 'yt-dlp-wrap'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const YTDlpWrap = (YTDlpWrapModule as any).default ?? YTDlpWrapModule
import { join, delimiter } from 'path'
import { tmpdir, homedir } from 'os'
import {
  chmodSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { execFile, spawn } from 'child_process'
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

// X/Twitter posts go through the same yt-dlp pipeline as YouTube. A post can
// hold several videos, which yt-dlp treats as a playlist — we only ever take
// the first, since the output path is a single file.
function isTwitterUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.|mobile\.)?(twitter|x)\.com\//i.test(url.trim())
}

function platformArgs(url: string): string[] {
  return isTwitterUrl(url) ? ['--playlist-items', '1'] : []
}

// Fetch video metadata directly (yt-dlp-wrap's getVideoInfo hardcodes its own
// args and ignores ours, so it misses the runtime/cookie flags above).
type VideoInfo = { duration: number; title: string; description: string; thumbnail: string }

// A metadata fetch costs a round trip to YouTube (several seconds), and the UI
// asks for it twice for the same URL: once via youtube:info to draw the trim
// slider, then again when the download starts. Cache the in-flight promise, not
// just the result, so hitting Go before the first lookup lands still shares it.
const infoCache = new Map<string, { info: Promise<VideoInfo>; at: number }>()
const INFO_CACHE_TTL_MS = 5 * 60 * 1000

function fetchVideoInfo(url: string): Promise<VideoInfo> {
  const hit = infoCache.get(url)
  if (hit && Date.now() - hit.at <= INFO_CACHE_TTL_MS) return hit.info

  const info = fetchVideoInfoUncached(url)
  infoCache.set(url, { info, at: Date.now() })
  // Don't cache failures — the next attempt should go back to YouTube.
  info.catch(() => infoCache.delete(url))
  return info
}

async function fetchVideoInfoUncached(url: string): Promise<VideoInfo> {
  const run = (useCookies: boolean): Promise<{ stdout: string }> =>
    execFileAsync(
      ytDlpBinaryPath(),
      [
        url,
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        // Without this a "watch?v=…&list=…" URL makes yt-dlp resolve the whole
        // playlist before answering. The download path already passes it.
        '--no-playlist',
        ...platformArgs(url),
        ...youtubeArgs(useCookies),
      ],
      // Never let a stalled request hang the UI forever.
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 }
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
  type RawInfo = {
    duration?: number
    title?: string
    description?: string
    thumbnail?: string
    entries?: RawInfo[]
  }
  let raw = JSON.parse(stdout) as RawInfo
  // A multi-video X post comes back as a playlist wrapper with no duration of
  // its own — the video we'll download is its first entry.
  if (raw.entries?.length) raw = { ...raw.entries[0], title: raw.entries[0].title ?? raw.title }
  return {
    duration: Number(raw.duration) || 0,
    title: raw.title ?? '',
    description: raw.description ?? '',
    thumbnail: raw.thumbnail ?? '',
  }
}

// yt-dlp's plain "yt-dlp" release asset is a Python zipapp that runs on the
// system python3. A Finder-launched Mac app gets Apple's /usr/bin/python3 (3.9),
// which yt-dlp no longer supports, so every download failed in the packaged
// app. The per-platform standalone builds bundle their own Python.
function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

export function ytDlpBinaryPath(): string {
  return join(app.getPath('userData'), ytDlpAssetName())
}

// Fetch the latest standalone build. Written to a temp name and renamed into
// place so an interrupted download never leaves a half-written binary that
// existsSync would then treat as installed.
async function downloadYtDlp(binPath: string): Promise<void> {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytDlpAssetName()}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Couldn't download yt-dlp (${res.status}). Check your internet connection and try again.`)
  const partPath = `${binPath}.part`
  writeFileSync(partPath, Buffer.from(await res.arrayBuffer()))
  chmodSync(partPath, 0o755)
  renameSync(partPath, binPath)

  // Older versions installed the Python zipapp as "yt-dlp" on macOS/Linux.
  // It's never used again, so don't leave it behind.
  const legacy = join(app.getPath('userData'), 'yt-dlp')
  if (legacy !== binPath && existsSync(legacy)) {
    try {
      unlinkSync(legacy)
    } catch {
      // harmless if it lingers
    }
  }
}

function sendToRenderer(channel: string, data: unknown): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) wins[0].webContents.send(channel, data)
}

// Ensure the yt-dlp binary is present, downloading it once if missing. Does NOT
// self-update (that happens in the background — see maybeUpdateYtDlp) and only
// emits progress when asked, so the lightweight info fetch never hijacks the UI.
export async function ensureYtDlp(emitProgress: boolean): Promise<InstanceType<typeof YTDlpWrap>> {
  const binPath = ytDlpBinaryPath()
  if (!existsSync(binPath)) {
    if (emitProgress) sendToRenderer('youtube:progress', { label: 'Downloading yt-dlp…', percent: 0, indeterminate: true })
    await downloadYtDlp(binPath)
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

// `ffmpeg -i` with no output always exits non-zero but lists the streams on
// stderr — same trick as probeVideoSize. A cover-art image counts as a video
// stream to ffmpeg, so ignore attached pictures.
async function hasVideoStream(path: string): Promise<boolean> {
  let out = ''
  try {
    await execFileAsync(getFfmpegPath(), ['-hide_banner', '-i', path])
  } catch (err) {
    out = (err as { stderr?: string }).stderr ?? ''
  }
  return out.split('\n').some((l) => /Stream #.*: Video:/.test(l) && !/attached pic/.test(l))
}

// ffmpeg's stats line, e.g. "frame=  812 fps= 39 … time=00:00:32.48 …". Its
// first line can read "time=-577014:…" before any frames — the leading \d+
// skips it.
const FFMPEG_TIME_RE = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g

function lastFfmpegTime(chunk: string): number | null {
  const matches = [...chunk.matchAll(FFMPEG_TIME_RE)]
  const last = matches[matches.length - 1]
  if (!last) return null
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + parseFloat(last[3])
}

// Cut [startSec, endSec) out of a local file. Re-encodes so the cut lands on
// the exact frame rather than the nearest keyframe. endSec undefined = to end.
function cutClip(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number | undefined,
  onProgress: (sec: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner',
      '-ss', String(startSec),
      '-i', inputPath,
      ...(endSec != null ? ['-t', String(endSec - startSec)] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath,
    ]
    const proc = spawn(getFfmpegPath(), args)
    let tail = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-2000)
      const sec = lastFfmpegTime(text)
      if (sec != null) onProgress(sec)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Cutting the clip failed (ffmpeg exit ${code}): ${tail.trim().split('\n').pop() ?? ''}`))
    })
  })
}

// A trimmed download hands the stream URL to ffmpeg, which gives up on the
// first 403 — YouTube sometimes refuses those direct requests even though
// yt-dlp's own chunked downloader gets the same video fine.
function isForbidden(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b403\b|forbidden/i.test(msg)
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
    return { duration: info.duration, title: info.title, thumbnail: info.thumbnail }
  })

  ipcMain.handle('youtube:download', async (_event, arg: string | DownloadArgs) => {
    // Back-compat: a bare string is treated as the URL with no trim.
    const { url, startSec, endSec } = typeof arg === 'string' ? { url: arg } as DownloadArgs : arg
    // A start with no end means "from here to the end of the video".
    const trim = startSec != null && (endSec == null || endSec > startSec)

    const ytDlp = await ensureYtDlp(true)

    // Title/description are only needed once the file lands, so don't make the
    // download wait on them — usually this is already cached from youtube:info.
    // Non-fatal: on failure they're just left empty.
    const infoPromise = fetchVideoInfo(url).catch(() => null)

    // yt-dlp does its own extraction before any bytes move, and there's no
    // percentage for that — flag it indeterminate rather than parking at 0%.
    const report = (label: string, percent?: number): void =>
      sendToRenderer('youtube:progress', {
        label,
        percent: percent ?? 0,
        indeterminate: percent == null,
      })
    report(isTwitterUrl(url) ? 'Connecting to X…' : 'Connecting to YouTube…')

    const outputPath = join(tmpdir(), `video-bastard-${Date.now()}.mp4`)

    // Clip length drives the trimmed-download progress bar. With no end given
    // it runs to the end of the video, so take the length from the metadata.
    const clipEnd = trim ? endSec ?? (await infoPromise)?.duration : undefined
    const clipSec = trim && clipEnd ? clipEnd - (startSec as number) : 0

    // sections: fetch only the clip (yt-dlp → ffmpeg) rather than the whole video.
    const buildArgs = (useCookies: boolean, sections: boolean, out: string): string[] => {
      const execArgs = [
        url,
        '-o', out,
        // Prefer H.264 + AAC at ≤1080p. A bare "bestvideo[ext=mp4]" now picks
        // AV1 (often 4K): Premiere and QuickLook can't decode it, and cutting it
        // means a slow AV1 decode + 4K re-encode. Exports never exceed 1080p.
        '-f', 'bv*+ba/b',
        '-S', 'res:1080,vcodec:h264,acodec:m4a',
        '--no-playlist',
        ...platformArgs(url),
        '--merge-output-format', 'mp4',
        // Point yt-dlp at the bundled ffmpeg so cutting/merging works without a
        // system ffmpeg on PATH (needed in the packaged app).
        '--ffmpeg-location', getFfmpegPath(),
        // JS runtime + browser cookies (signature challenges + bot check).
        ...youtubeArgs(useCookies),
      ]

      if (sections) {
        // Only download the requested segment — for a 2hr source this fetches
        // just the clip, not the whole video. Keyframe-accurate cut points.
        execArgs.push(
          '--download-sections', `*${startSec}-${endSec ?? 'inf'}`,
          '--force-keyframes-at-cuts',
        )
      }
      return execArgs
    }

    const attempt = (useCookies: boolean, sections: boolean, out: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const dl = ytDlp.exec(buildArgs(useCookies, sections, out))

        // A full download fetches video then audio as separate streams, each
        // running 0→100%, so name the stream or the bar appears to reset.
        let label = 'Downloading…'
        let streams = 0
        dl.on('ytDlpEvent', (type: string, data: string) => {
          if (type === 'download' && data.includes('Destination:')) {
            streams++
            label = sections ? 'Downloading clip…' : streams === 1 ? 'Downloading video…' : 'Downloading audio…'
            report(label, 0)
          } else if (type === 'Merger') {
            report('Merging audio and video…')
          }
        })

        dl.on('progress', (progress: { percent?: number }) => {
          report(label, Math.round(progress.percent ?? 0))
        })

        // A trimmed download is handed to ffmpeg, which never prints yt-dlp's
        // "[download] 42%" lines — without this the bar sat on its first label
        // for the whole download + cut. ffmpeg's stats (on stderr) report how
        // far into the clip it has written, which gives a real percentage.
        if (sections && clipSec > 0) {
          dl.ytDlpProcess.stderr.on('data', (chunk: Buffer) => {
            const sec = lastFfmpegTime(chunk.toString())
            if (sec != null) report(label, Math.min(99, Math.round((sec / clipSec) * 100)))
          })
        }

        dl.on('close', () => {
          if (existsSync(out)) resolve()
          else reject(new Error('Download failed — output file was not created. Check the URL and try again.'))
        })

        dl.on('error', (err: Error) => {
          reject(new Error(err?.message ?? 'Download failed'))
        })
      })

    const download = async (sections: boolean, out: string): Promise<void> => {
      try {
        await attempt(false, sections, out)
      } catch (err) {
        if (!needsAuth(err) || !findBrowserForCookies()) throw err
        // YouTube wants a signed-in session — retry borrowing browser cookies.
        report('Signing in via browser cookies…')
        await attempt(true, sections, out)
      }
    }

    try {
      await download(trim, outputPath)
    } catch (err) {
      if (!trim || !isForbidden(err)) throw err
      // The clip-only fetch was refused. Fall back to the whole video through
      // yt-dlp's own downloader, then cut the clip out locally.
      report('YouTube blocked the clip download — fetching the full video instead…')
      const fullPath = join(tmpdir(), `video-bastard-${Date.now()}-full.mp4`)
      try {
        await download(false, fullPath)
        report('Cutting clip…', 0)
        await cutClip(fullPath, outputPath, startSec as number, endSec, (sec) => {
          if (clipSec > 0) report('Cutting clip…', Math.min(99, Math.round((sec / clipSec) * 100)))
        })
      } finally {
        try { unlinkSync(fullPath) } catch { /* already gone */ }
      }
    }

    if (!(await hasVideoStream(outputPath))) {
      // yt-dlp can exit 0 having muxed an audio-only file (e.g. the video
      // stream yielded no frames when cut). Fail here with a clear message
      // rather than letting every export silently lose its picture.
      throw new Error('Download failed — the file has no video track, only audio. Try again or pick a different time window.')
    }
    const info = await infoPromise
    return { path: outputPath, title: info?.title ?? '', description: info?.description ?? '' }
  })
}
