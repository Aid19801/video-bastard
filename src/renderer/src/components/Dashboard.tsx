import { useCallback, useEffect, useState } from 'react'
import { FaYoutube, FaPodcast } from 'react-icons/fa'
import type { ChannelStat, DashboardSettings, DashboardStats, IdeasResult, PodcastStat, VideoStat } from '../../../shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

// Survives the dashboard unmounting when a video is loaded, so "Change video"
// doesn't re-hit YouTube every time.
const STALE_MS = 10 * 60 * 1000
let cached: DashboardStats | null = null
let cachedIdeas: IdeasResult | null = null

const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 })
const fmt = (n: number) => compact.format(n)

function ago(iso?: string): string {
  if (!iso) return '—'
  const days = (Date.now() - Date.parse(iso)) / DAY_MS
  if (days < 1 / 24) return 'just now'
  if (days < 1) return `${Math.round(days * 24)}h ago`
  return `${Math.round(days)}d ago`
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function within(iso: string, days: number): boolean {
  return Date.now() - Date.parse(iso) <= days * DAY_MS
}

function Delta({ n, unit }: { n?: number; unit: string }) {
  if (n === undefined) return null
  return (
    <span className={`dash-delta ${n > 0 ? 'dash-delta--up' : ''}`}>
      {n > 0 ? '▲ ' : ''}{fmt(n)} {unit} / 24h
    </span>
  )
}

// Oldest → newest, left to right, so the strip reads like a timeline.
function UploadStrip({ videos }: { videos: VideoStat[] }) {
  const ordered = [...videos].reverse()
  const max = Math.max(...ordered.map((v) => v.views), 1)
  return (
    <div className="dash-strip" aria-label="Views on recent uploads, oldest to newest">
      {ordered.map((v) => (
        <button
          key={v.id}
          className="dash-strip-bar"
          title={`${v.title}\n${v.views.toLocaleString()} views · ${ago(v.publishedAt)}`}
          onClick={() => window.api.openExternal(v.url)}
        >
          <span style={{ height: `${Math.max((v.views / max) * 100, 3)}%` }} />
        </button>
      ))}
    </div>
  )
}

function ChannelTile({ c, hasKey }: { c: ChannelStat; hasKey: boolean }) {
  if (c.error) {
    return (
      <div className="dash-tile">
        <div className="dash-tile-head"><FaYoutube /> {c.title}</div>
        <p className="dash-error">{c.error}</p>
      </div>
    )
  }
  const med = median(c.recent.map((v) => v.views))
  return (
    <div className="dash-tile">
      <button className="dash-tile-head" onClick={() => window.api.openExternal(c.url)}>
        <FaYoutube /> {c.title}
      </button>
      <div className="dash-hero">
        {c.subscribers !== undefined ? (
          <><strong>{fmt(c.subscribers)}</strong> subs</>
        ) : (
          <><strong>{fmt(med)}</strong> median views</>
        )}
      </div>
      <Delta n={c.viewsGained24h} unit="views" />
      <Delta n={c.subsGained24h} unit="subs" />
      <UploadStrip videos={c.recent} />
      <div className="dash-meta">
        {c.subscribers !== undefined && <span>median {fmt(med)} views</span>}
        <span>last upload {ago(c.recent[0]?.publishedAt)}</span>
        {!hasKey && c.subscribers === undefined && <span>last {c.recent.length} uploads</span>}
      </div>
    </div>
  )
}

function PodcastTile({ p }: { p: PodcastStat | null }) {
  if (!p) {
    return (
      <div className="dash-tile dash-tile--empty">
        <div className="dash-tile-head"><FaPodcast /> Podcast</div>
        <p className="dash-meta">Add your Pinecast RSS feed in ⚙ settings to track episodes.</p>
      </div>
    )
  }
  if (p.error) {
    return (
      <div className="dash-tile">
        <div className="dash-tile-head"><FaPodcast /> {p.title}</div>
        <p className="dash-error">{p.error}</p>
      </div>
    )
  }
  const daysSince = p.lastPublishedAt ? (Date.now() - Date.parse(p.lastPublishedAt)) / DAY_MS : undefined
  // Flag once we're past the usual rhythm, give or take a day.
  const overdue = daysSince !== undefined && p.avgGapDays !== undefined && daysSince > p.avgGapDays + 1
  return (
    <div className="dash-tile">
      <div className="dash-tile-head"><FaPodcast /> {p.title}</div>
      <div className="dash-hero"><strong>{p.episodeCount}</strong> episodes</div>
      <div className="dash-meta">
        <span className={overdue ? 'dash-warn' : undefined}>
          {overdue && '⚠ '}last episode {ago(p.lastPublishedAt)}
        </span>
        {p.avgGapDays !== undefined && <span>usually every {p.avgGapDays.toFixed(1)}d</span>}
      </div>
    </div>
  )
}

function Insights({ stats }: { stats: DashboardStats }) {
  const all = stats.channels.flatMap((c) => c.recent.map((v) => ({ ...v, channel: c.title })))
  const top = all
    .filter((v) => within(v.publishedAt, 14))
    .sort((a, b) => b.viewsPerDay - a.viewsPerDay)
    .slice(0, 3)

  const uploads30 = all.filter((v) => within(v.publishedAt, 30)).length
  const eps30 = stats.podcast?.episodes.filter((e) => within(e.publishedAt, 30)).length

  return (
    <div className="dash-insights">
      <div className="dash-insight-head">
        <span className="meta-label">working best · last 14 days, by views/day</span>
        {eps30 !== undefined && eps30 > 0 && (
          <span className="dash-meta" title="YouTube uploads across all channels per podcast episode, last 30 days">
            {(uploads30 / eps30).toFixed(1)} videos per episode (30d)
          </span>
        )}
      </div>
      {top.length === 0 && <p className="dash-meta">No uploads in the last 14 days.</p>}
      {top.map((v) => (
        <button key={v.id} className="dash-top" onClick={() => window.api.openExternal(v.url)}>
          <img src={v.thumbnail} alt="" />
          <span className="dash-top-title">{v.title}</span>
          <span className="dash-top-num">{fmt(v.viewsPerDay)}/day</span>
          <span className="dash-top-sub">{v.channel} · {fmt(v.views)} views · {ago(v.publishedAt)}</span>
        </button>
      ))}
    </div>
  )
}

function IdeasHelper() {
  const [result, setResult] = useState<IdeasResult | null>(cachedIdeas)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.getContentIdeas()
      cachedIdeas = r
      setResult(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!cachedIdeas) void load()
  }, [load])

  const ideas = result?.ideas ?? []
  const quoted = ideas.map((v) => (
    <button key={v.id} className="dash-idea-title" onClick={() => window.api.openExternal(v.url)} title={`${v.channelTitle} · ${v.views.toLocaleString()} views`}>
      &ldquo;{v.title}&rdquo;
    </button>
  ))

  return (
    <div className="dash-ideas">
      <div className="dash-insight-head">
        <span className="meta-label">past winners</span>
        <button className="dash-icon-btn" onClick={() => void load()} disabled={loading} title="Pick three different ideas">↻</button>
      </div>
      {error && <p className="dash-error">{error}</p>}
      {!result && loading && <p className="dash-meta">Reading your last 100 uploads…</p>}
      {ideas.length > 0 && (
        <p className={`dash-ideas-text ${loading ? 'dash-ideas-text--loading' : ''}`}>
          Three Ideas That Performed Well Before Were {quoted[0]}
          {quoted[1] && <>, and {quoted[1]}</>}
          {quoted[2] && <> and {quoted[2]}</>}
          . Is there something within these topics you can re-explore today?
        </p>
      )}
      {result?.topics && (
        <div className="dash-topics">
          {result.topics.map((t, i) => <span key={i} className="dash-topic">{t}</span>)}
        </div>
      )}
      {result && !result.topics && !result.topicsError && (
        <p className="dash-meta">Add an OpenAI key (captions setting) to get the broad topic behind each one.</p>
      )}
      {result?.topicsError && <p className="dash-meta">Couldn&apos;t distil topics: {result.topicsError}</p>}
    </div>
  )
}

function Settings({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [s, setS] = useState<DashboardSettings | null>(null)
  useEffect(() => { window.api.getDashboardSettings().then(setS) }, [])
  if (!s) return null
  return (
    <div className="dash-settings">
      <label>
        <span className="meta-label">YouTube channels (handles, comma-separated)</span>
        <input
          className="meta-input"
          value={s.channelHandles.join(', ')}
          onChange={(e) => setS({ ...s, channelHandles: e.target.value.split(',') })}
        />
      </label>
      <label>
        <span className="meta-label">Podcast RSS feed URL (from Pinecast)</span>
        <input
          className="meta-input"
          placeholder="https://pinecast.com/feed/your-show"
          value={s.pinecastFeedUrl}
          onChange={(e) => setS({ ...s, pinecastFeedUrl: e.target.value })}
        />
      </label>
      <label>
        <span className="meta-label">YouTube Data API key (optional: adds subscribers &amp; comments)</span>
        <input
          className="meta-input"
          type="password"
          placeholder="AIza…"
          value={s.youtubeApiKey}
          onChange={(e) => setS({ ...s, youtubeApiKey: e.target.value })}
        />
      </label>
      <div className="dash-settings-actions">
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button
          className="btn-secondary"
          onClick={async () => {
            await window.api.setDashboardSettings({ ...s, channelHandles: s.channelHandles.map((h) => h.trim()).filter(Boolean) })
            onSaved()
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(cached)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await window.api.getDashboardStats()
      cached = s
      setStats(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!cached || Date.now() - Date.parse(cached.fetchedAt) > STALE_MS) void load()
  }, [load])

  return (
    <section className="dash">
      <div className="dash-bar">
        <span className="meta-label">your content</span>
        <span className="dash-meta">
          {loading ? 'refreshing…' : stats ? `updated ${ago(stats.fetchedAt)}` : ''}
        </span>
        <button className="dash-icon-btn" onClick={() => void load()} disabled={loading} title="Refresh">↻</button>
        <button className="dash-icon-btn" onClick={() => setShowSettings((v) => !v)} title="Dashboard settings">⚙</button>
      </div>

      {showSettings && (
        <Settings
          onCancel={() => setShowSettings(false)}
          onSaved={() => { setShowSettings(false); void load() }}
        />
      )}

      {error && <p className="dash-error">{error}</p>}

      {stats && (
        <>
          <div className="dash-tiles">
            {stats.channels.map((c) => <ChannelTile key={c.handle} c={c} hasKey={stats.hasYoutubeKey} />)}
            <PodcastTile p={stats.podcast} />
          </div>
          <Insights stats={stats} />
          <IdeasHelper />
        </>
      )}

      {!stats && loading && <div className="dash-tiles"><div className="dash-tile dash-tile--loading" /></div>}
    </section>
  )
}
