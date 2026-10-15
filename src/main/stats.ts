import { app, IpcMain } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import OpenAI from 'openai'
import {
  getDashboardSettings,
  setDashboardSettings,
  getCachedChannelId,
  setCachedChannelId,
  getApiKey,
} from './config'
import { ensureYtDlp, ytDlpBinaryPath } from './youtube'
import type {
  ChannelStat,
  DashboardSettings,
  DashboardStats,
  IdeasResult,
  PastIdea,
  PodcastEpisode,
  PodcastStat,
  VideoStat,
} from '../shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

// UK/EU requests to youtube.com get bounced to a cookie-consent page unless we
// say consent was already given.
const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  Cookie: 'SOCS=CAI; CONSENT=YES+1',
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${new URL(url).host}`)
  return res.text()
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = await res.json() as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(body.error?.message ?? `${res.status} ${res.statusText}`)
  return body
}

// ── Tiny XML helpers ─────────────────────────────────────────────────────────
// Both feeds are flat and well-formed, so a regex pass beats pulling in a parser.

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim()
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? decodeEntities(m[1]) : undefined
}

function attr(xml: string, name: string, attribute: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`))
  return m ? decodeEntities(m[1]) : undefined
}

function blocks(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, 'g')) ?? []
}

// ── YouTube ──────────────────────────────────────────────────────────────────

function normaliseHandle(h: string): string {
  return h.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^@/, '').replace(/\/.*$/, '')
}

async function resolveChannelId(handle: string, apiKey: string): Promise<string> {
  if (/^UC[\w-]{22}$/.test(handle)) return handle
  const cached = getCachedChannelId(handle)
  if (cached) return cached

  let id: string | undefined
  if (apiKey) {
    const r = await fetchJson<{ items?: { id: string }[] }>(
      `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent('@' + handle)}&key=${apiKey}`
    )
    id = r.items?.[0]?.id
  } else {
    const html = await fetchText(`https://www.youtube.com/@${encodeURIComponent(handle)}`, YT_HEADERS)
    id = html.match(/"externalId":"(UC[\w-]{22})"/)?.[1]
  }
  if (!id) throw new Error(`Couldn't find a YouTube channel for @${handle}`)
  setCachedChannelId(handle, id)
  return id
}

function viewsPerDay(views: number, publishedAt: string): number {
  const ageDays = Math.max((Date.now() - Date.parse(publishedAt)) / DAY_MS, 1)
  return views / ageDays
}

async function fetchChannel(rawHandle: string, apiKey: string): Promise<ChannelStat> {
  const handle = normaliseHandle(rawHandle)
  const id = await resolveChannelId(handle, apiKey)
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, YT_HEADERS)
  const head = xml.split('<entry>')[0]

  const recent: VideoStat[] = blocks(xml, 'entry').map((e) => {
    const videoId = tag(e, 'yt:videoId') ?? ''
    const publishedAt = tag(e, 'published') ?? ''
    const views = Number(attr(e, 'media:statistics', 'views') ?? 0)
    return {
      id: videoId,
      title: tag(e, 'title') ?? '',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      publishedAt,
      views,
      likes: Number(attr(e, 'media:starRating', 'count') ?? 0),
      viewsPerDay: viewsPerDay(views, publishedAt),
    }
  })

  const channel: ChannelStat = {
    handle,
    id,
    title: tag(head, 'title') ?? handle,
    url: `https://www.youtube.com/channel/${id}`,
    recent,
  }

  // With a key, swap in exact numbers (the RSS view counts lag a little) and
  // add the channel-level totals RSS doesn't expose.
  if (apiKey) {
    const [ch, vids] = await Promise.all([
      fetchJson<{ items?: { statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string } }[] }>(
        `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${id}&key=${apiKey}`
      ),
      recent.length
        ? fetchJson<{ items?: { id: string; statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
            `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${recent.map((v) => v.id).join(',')}&key=${apiKey}`
          )
        : Promise.resolve({ items: [] }),
    ])
    const s = ch.items?.[0]?.statistics
    if (s) {
      channel.subscribers = s.subscriberCount !== undefined ? Number(s.subscriberCount) : undefined
      channel.totalViews = Number(s.viewCount ?? 0)
      channel.videoCount = Number(s.videoCount ?? 0)
    }
    const byId = new Map(vids.items?.map((v) => [v.id, v.statistics]))
    for (const v of recent) {
      const vs = byId.get(v.id)
      if (!vs) continue
      v.views = Number(vs.viewCount ?? v.views)
      v.likes = Number(vs.likeCount ?? v.likes)
      v.comments = vs.commentCount !== undefined ? Number(vs.commentCount) : undefined
      v.viewsPerDay = viewsPerDay(v.views, v.publishedAt)
    }
  }

  return channel
}

// ── Podcast (Pinecast, or any podcast RSS feed) ──────────────────────────────

function parseDuration(d?: string): number | undefined {
  if (!d) return undefined
  if (/^\d+$/.test(d)) return Number(d)
  const parts = d.split(':').map(Number)
  if (parts.some(isNaN)) return undefined
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

async function fetchPodcast(feedUrl: string): Promise<PodcastStat> {
  const xml = await fetchText(feedUrl)
  const head = xml.split('<item')[0]
  const episodes: PodcastEpisode[] = blocks(xml, 'item')
    .map((item) => {
      const pub = tag(item, 'pubDate')
      return {
        title: tag(item, 'title') ?? '',
        publishedAt: pub ? new Date(pub).toISOString() : '',
        durationSec: parseDuration(tag(item, 'itunes:duration')),
        url: tag(item, 'link'),
      }
    })
    .filter((e) => e.publishedAt)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))

  // Cadence over the last 10 episodes — recent rhythm matters more than the
  // whole back catalogue.
  const window = episodes.slice(0, 10)
  const avgGapDays = window.length > 1
    ? (Date.parse(window[0].publishedAt) - Date.parse(window[window.length - 1].publishedAt)) / DAY_MS / (window.length - 1)
    : undefined

  return {
    title: tag(head, 'title') ?? 'Podcast',
    episodeCount: episodes.length,
    lastPublishedAt: episodes[0]?.publishedAt,
    avgGapDays,
    episodes: episodes.slice(0, 20),
  }
}

// ── Snapshot history ─────────────────────────────────────────────────────────
// YouTube only gives lifetime totals without OAuth Analytics, so we keep one
// snapshot a day locally and diff against it to get "last 24h" movement.

interface Snapshot {
  at: number
  channels: Record<string, { subs?: number; views: Record<string, number> }>
}

const historyPath = () => join(app.getPath('userData'), 'vb-stats-history.json')
const MAX_SNAPSHOTS = 60

function readHistory(): Snapshot[] {
  try {
    if (existsSync(historyPath())) return JSON.parse(readFileSync(historyPath(), 'utf-8'))
  } catch {}
  return []
}

function applyHistory(channels: ChannelStat[]): void {
  const history = readHistory()
  const now = Date.now()

  // Compare against the snapshot nearest 24h ago, but at least 12h old so a
  // couple of quick refreshes don't read as "0 gained".
  const baseline = history
    .filter((s) => now - s.at >= DAY_MS / 2)
    .sort((a, b) => Math.abs(now - a.at - DAY_MS) - Math.abs(now - b.at - DAY_MS))[0]

  if (baseline) {
    for (const c of channels) {
      const prev = baseline.channels[c.id]
      if (!prev) continue
      let gained = 0
      for (const v of c.recent) {
        if (prev.views[v.id] !== undefined) gained += v.views - prev.views[v.id]
        // A video that didn't exist at the baseline gained all its views since.
        else if (Date.parse(v.publishedAt) > baseline.at) gained += v.views
      }
      c.viewsGained24h = gained
      if (c.subscribers !== undefined && prev.subs !== undefined) c.subsGained24h = c.subscribers - prev.subs
    }
  }

  // Store at most one snapshot per ~20h.
  const latest = history[history.length - 1]
  if (latest && now - latest.at < DAY_MS * 0.8) return
  const snap: Snapshot = { at: now, channels: {} }
  for (const c of channels) {
    if (c.error) continue
    snap.channels[c.id] = {
      subs: c.subscribers,
      views: Object.fromEntries(c.recent.map((v) => [v.id, v.views])),
    }
  }
  try {
    writeFileSync(historyPath(), JSON.stringify([...history, snap].slice(-MAX_SNAPSHOTS)))
  } catch {}
}

// ── Past-winner ideas ────────────────────────────────────────────────────────
// Draw three videos at random from each channel's best-performing quarter of
// its last 100 uploads, so the prompt changes day to day but always points at
// something that worked.

const execFileAsync = promisify(execFile)
const UPLOAD_SAMPLE = 100
const IDEAS_MODEL = 'gpt-5.4-mini'

type Upload = { id: string; title: string; views: number; description?: string; publishedAt?: string }

async function listUploadsViaApi(channelId: string, apiKey: string): Promise<Upload[]> {
  // Every channel's uploads playlist is its id with UC → UU.
  const playlistId = 'UU' + channelId.slice(2)
  const items: { id: string; title: string; description: string; publishedAt: string }[] = []
  let pageToken = ''
  while (items.length < UPLOAD_SAMPLE) {
    const r = await fetchJson<{
      nextPageToken?: string
      items?: { snippet: { title: string; description: string; publishedAt: string; resourceId: { videoId: string } } }[]
    }>(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`
    )
    for (const i of r.items ?? []) {
      items.push({ id: i.snippet.resourceId.videoId, title: i.snippet.title, description: i.snippet.description, publishedAt: i.snippet.publishedAt })
    }
    if (!r.nextPageToken) break
    pageToken = r.nextPageToken
  }
  const views = new Map<string, number>()
  for (let i = 0; i < items.length; i += 50) {
    const r = await fetchJson<{ items?: { id: string; statistics: { viewCount?: string } }[] }>(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${items.slice(i, i + 50).map((v) => v.id).join(',')}&key=${apiKey}`
    )
    for (const v of r.items ?? []) views.set(v.id, Number(v.statistics.viewCount ?? 0))
  }
  return items.slice(0, UPLOAD_SAMPLE).map((v) => ({ ...v, views: views.get(v.id) ?? 0 }))
}

// Keyless: yt-dlp's flat listing of the Videos tab returns titles and views in
// one quick request, but no descriptions — those are fetched only for the picks.
async function listUploadsViaYtDlp(channelId: string): Promise<Upload[]> {
  await ensureYtDlp(false)
  const { stdout } = await execFileAsync(
    ytDlpBinaryPath(),
    [`https://www.youtube.com/channel/${channelId}/videos`, '--flat-playlist', '-J', '--playlist-end', String(UPLOAD_SAMPLE), '--no-warnings'],
    { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 }
  )
  const entries = (JSON.parse(stdout) as { entries?: { id: string; title?: string; view_count?: number | null }[] }).entries ?? []
  // Upcoming premieres and members-only videos come back without a view count.
  return entries
    .filter((e) => typeof e.view_count === 'number')
    .map((e) => ({ id: e.id, title: e.title ?? '', views: e.view_count as number }))
}

async function fetchDescription(videoId: string): Promise<string> {
  try {
    const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`, YT_HEADERS)
    const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)
    return m ? (JSON.parse(`"${m[1]}"`) as string) : ''
  } catch {
    return ''
  }
}

// Listing 100 uploads per channel is a few seconds of work, and the pool only
// shifts when you post — so shuffles within a session reuse it.
const POOL_TTL_MS = 6 * 60 * 60 * 1000
let poolCache: { at: number; key: string; pool: (Upload & { channelTitle: string })[] } | null = null

async function winnersPool(): Promise<(Upload & { channelTitle: string })[]> {
  const { channelHandles, youtubeApiKey } = getDashboardSettings()
  const cacheKey = channelHandles.join(',') + (youtubeApiKey ? ':key' : '')
  if (poolCache && poolCache.key === cacheKey && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.pool

  const perChannel = await Promise.all(
    channelHandles.map(async (h) => {
      const handle = normaliseHandle(h)
      const id = await resolveChannelId(handle, youtubeApiKey)
      const uploads = youtubeApiKey ? await listUploadsViaApi(id, youtubeApiKey) : await listUploadsViaYtDlp(id)
      // Skip the newest few: they're still collecting views, and the point is
      // to resurface older ideas, not what's already on the dashboard.
      const settled = uploads.slice(3)
      // Rank within each channel so a big clips channel doesn't drown out the
      // main one — "high performing" is relative to that channel's audience.
      const ranked = [...settled].sort((a, b) => b.views - a.views)
      const top = ranked.slice(0, Math.max(3, Math.ceil(ranked.length / 4)))
      return top.map((v) => ({ ...v, channelTitle: handle }))
    }).map((p) => p.catch(() => []))
  )
  const pool = perChannel.flat()
  if (pool.length) poolCache = { at: Date.now(), key: cacheKey, pool }
  return pool
}

let lastPicks = new Set<string>()

function pickRandom<T>(xs: T[], n: number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}

async function distilTopics(ideas: PastIdea[], apiKey: string): Promise<string[]> {
  const openai = new OpenAI({ apiKey })
  const res = await openai.chat.completions.create({
    model: IDEAS_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You help a podcaster and YouTuber find topics worth revisiting. For each past video, name the broad, reusable topic behind it in 2-5 words: the subject area a new video could return to, not a summary of that specific video. Plain words, no quotes, no trailing punctuation. Reply as JSON: {"topics": ["...", ...]} in the same order as the input.',
      },
      {
        role: 'user',
        content: ideas
          .map((v, i) => `${i + 1}. Title: ${v.title}\nDescription: ${v.description.slice(0, 600) || '(none)'}`)
          .join('\n\n'),
      },
    ],
  })
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as { topics?: unknown }
  if (!Array.isArray(parsed.topics)) throw new Error('Unexpected reply from the model')
  return parsed.topics.slice(0, ideas.length).map(String)
}

// ── IPC ──────────────────────────────────────────────────────────────────────

export function registerStatsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('stats:getSettings', (): DashboardSettings => getDashboardSettings())

  ipcMain.handle('stats:setSettings', (_event, s: DashboardSettings) => {
    setDashboardSettings({
      channelHandles: s.channelHandles.map(normaliseHandle).filter(Boolean),
      pinecastFeedUrl: s.pinecastFeedUrl.trim(),
      youtubeApiKey: s.youtubeApiKey.trim(),
    })
  })

  ipcMain.handle('stats:ideas', async (): Promise<IdeasResult> => {
    const pool = await winnersPool()
    if (!pool.length) throw new Error("Couldn't list past uploads for your channels")
    // A reshuffle should show three new videos, as long as the pool is big enough.
    const fresh = pool.filter((v) => !lastPicks.has(v.id))
    const picks = pickRandom(fresh.length >= 3 ? fresh : pool, 3)
    lastPicks = new Set(picks.map((v) => v.id))
    const ideas: PastIdea[] = await Promise.all(
      picks.map(async (v) => ({
        id: v.id,
        title: v.title,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        views: v.views,
        channelTitle: v.channelTitle,
        description: v.description ?? (await fetchDescription(v.id)),
      }))
    )

    // Topics are a bonus: the sentence works on titles alone, so a missing key
    // or a model hiccup never blocks the helper.
    const openaiKey = getApiKey()
    if (!openaiKey) return { ideas }
    try {
      return { ideas, topics: await distilTopics(ideas, openaiKey) }
    } catch (err) {
      return { ideas, topicsError: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('stats:get', async (): Promise<DashboardStats> => {
    const { channelHandles, pinecastFeedUrl, youtubeApiKey } = getDashboardSettings()

    const [channels, podcast] = await Promise.all([
      Promise.all(
        channelHandles.map((h) =>
          fetchChannel(h, youtubeApiKey).catch((err): ChannelStat => ({
            handle: normaliseHandle(h),
            id: '',
            title: '@' + normaliseHandle(h),
            url: `https://www.youtube.com/@${normaliseHandle(h)}`,
            recent: [],
            error: err instanceof Error ? err.message : String(err),
          }))
        )
      ),
      pinecastFeedUrl
        ? fetchPodcast(pinecastFeedUrl).catch((err): PodcastStat => ({
            title: 'Podcast',
            episodeCount: 0,
            episodes: [],
            error: err instanceof Error ? err.message : String(err),
          }))
        : Promise.resolve(null),
    ])

    applyHistory(channels)

    return {
      fetchedAt: new Date().toISOString(),
      hasYoutubeKey: Boolean(youtubeApiKey),
      channels,
      podcast,
    }
  })
}
