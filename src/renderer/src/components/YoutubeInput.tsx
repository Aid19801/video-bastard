import { useState, useEffect, useRef } from 'react'
import { FaYoutube } from 'react-icons/fa'

interface Props {
  onDownload: (url: string, startSec?: number, endSec?: number) => void
}

// When a URL carries a timestamp, the clip is centred on it with this much
// on each side (so a 40s clip total).
const CLIP_HALF_SECONDS = 20

function isValidYoutubeUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/.test(url.trim())
}

// Pull a start moment out of a YouTube URL's t= / start= param.
// Handles t=31, t=31s, t=1m30s, t=1h2m3s, and #t=… hash form.
function parseUrlTimestamp(url: string): number | null {
  const m = url.match(/[?&#](?:t|start)=([^&#]+)/)
  if (!m) return null
  const v = m[1]
  if (/^\d+$/.test(v)) return parseInt(v, 10)
  const hms = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return (
      parseInt(hms[1] || '0', 10) * 3600 +
      parseInt(hms[2] || '0', 10) * 60 +
      parseInt(hms[3] || '0', 10)
    )
  }
  return null
}

// Identify the video a URL points at, so we can tell when it changes.
function parseVideoId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]+)/)
  return m ? m[1] : null
}

// Accepts "SS", "M:SS", "H:MM:SS", each with optional decimal seconds.
// Returns seconds, or null if the field is empty/unparseable.
function parseTime(input: string): number | null {
  const t = input.trim()
  if (!t) return null
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t)
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const h = m[1] ? parseInt(m[1], 10) : 0
  const min = parseInt(m[2], 10)
  const sec = parseFloat(m[3])
  if (min > 59 || sec >= 60) return null
  return h * 3600 + min * 60 + sec
}

function formatDuration(sec: number): string {
  const rounded = Math.round(sec)
  const h = Math.floor(rounded / 3600)
  const m = Math.floor((rounded % 3600) / 60)
  const s = rounded % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// Draggable range bar. Handles map to seconds along the full video duration;
// dragging either handle reports the new [from, to] back to the parent.
function TrimSlider({
  duration,
  fromSec,
  toSec,
  onChange,
}: {
  duration: number
  fromSec: number
  toSec: number
  onChange: (from: number, to: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)

  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / duration) * 100))}%`

  const secAtClientX = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * duration
  }

  const grab = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const drag = (which: 'from' | 'to') => (e: React.PointerEvent) => {
    if (e.buttons !== 1) return // only while the primary button is held
    const s = secAtClientX(e.clientX)
    if (which === 'from') onChange(Math.min(s, toSec - 1), toSec)
    else onChange(fromSec, Math.max(s, fromSec + 1))
  }

  return (
    <div className="trim-slider">
      <div className="trim-track" ref={trackRef}>
        <div
          className="trim-selected"
          style={{ left: pct(fromSec), right: `${100 - Math.min(100, Math.max(0, (toSec / duration) * 100))}%` }}
        />
        <div
          className="trim-handle trim-handle--from"
          style={{ left: pct(fromSec) }}
          onPointerDown={grab}
          onPointerMove={drag('from')}
          role="slider"
          aria-label="Clip start"
          aria-valuenow={Math.round(fromSec)}
        >
          <span className="trim-handle-bubble">{formatDuration(fromSec)}</span>
        </div>
        <div
          className="trim-handle trim-handle--to"
          style={{ left: pct(toSec) }}
          onPointerDown={grab}
          onPointerMove={drag('to')}
          role="slider"
          aria-label="Clip end"
          aria-valuenow={Math.round(toSec)}
        >
          <span className="trim-handle-bubble">{formatDuration(toSec)}</span>
        </div>
      </div>
      <div className="trim-scale">
        <span>0:00</span>
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  )
}

export default function YoutubeInput({ onDownload }: Props) {
  const [url, setUrl] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)

  // A different video was pasted → nuke everything so nothing carries over.
  // Runs before the timestamp effect below, so a URL that carries a timestamp
  // still gets its from/to pre-filled after this clears them.
  const videoId = parseVideoId(url)
  useEffect(() => {
    setFrom('')
    setTo('')
    setDuration(null)
  }, [videoId])

  // When the URL's timestamp changes, centre a 40s clip on it. Keyed on the
  // parsed value so it only fires on a *new* timestamp — later manual edits to
  // the from/to fields (typed or dragged) are left untouched.
  const urlTimestamp = parseUrlTimestamp(url)
  useEffect(() => {
    if (urlTimestamp === null) return
    setFrom(formatDuration(Math.max(0, urlTimestamp - CLIP_HALF_SECONDS)))
    setTo(formatDuration(urlTimestamp + CLIP_HALF_SECONDS))
  }, [urlTimestamp])

  // Fetch the video's duration (debounced) so we can show the drag bar. Falls
  // back silently to the text fields if the lookup fails.
  useEffect(() => {
    const trimmed = url.trim()
    if (!isValidYoutubeUrl(trimmed)) {
      setDuration(null)
      setInfoLoading(false)
      return
    }
    let cancelled = false
    setInfoLoading(true)
    const handle = setTimeout(async () => {
      try {
        const info = await window.api.getYoutubeInfo(trimmed)
        if (!cancelled) setDuration(info.duration > 0 ? info.duration : null)
      } catch {
        if (!cancelled) setDuration(null)
      } finally {
        if (!cancelled) setInfoLoading(false)
      }
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [url])

  const invalidUrl = url.length > 0 && !isValidYoutubeUrl(url)

  const fromSec = parseTime(from)
  const toSec = parseTime(to)
  const fromBad = from.trim().length > 0 && fromSec === null
  const toBad = to.trim().length > 0 && toSec === null

  // A trim is "set" if either field has content. It's valid only when both
  // parse and to > from.
  const trimStarted = from.trim().length > 0 || to.trim().length > 0
  const trimComplete = fromSec !== null && toSec !== null
  const trimValid = trimComplete && (toSec as number) > (fromSec as number)
  const rangeError = trimStarted && !fromBad && !toBad && trimComplete && !trimValid

  const clipLength = trimValid ? (toSec as number) - (fromSec as number) : null

  const canGo =
    isValidYoutubeUrl(url) &&
    !fromBad &&
    !toBad &&
    (!trimStarted || trimValid)

  const handleSubmit = () => {
    if (!canGo) return
    if (trimValid) {
      onDownload(url.trim(), fromSec as number, toSec as number)
    } else {
      onDownload(url.trim())
    }
  }

  // Drag writes whole-second values straight into the from/to fields, so the
  // slider and the text inputs stay in sync in both directions.
  const applyDrag = (f: number, t: number) => {
    setFrom(formatDuration(f))
    setTo(formatDuration(t))
  }

  return (
    <div className="yt-input-wrap">
      <div className="yt-input-row">
        <FaYoutube className="yt-icon" />
        <input
          className={`yt-input ${invalidUrl ? 'yt-input--invalid' : ''}`}
          type="url"
          placeholder="Paste a YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <button className="btn-primary" onClick={handleSubmit} disabled={!canGo}>
          Go
        </button>
      </div>

      {infoLoading && !duration && (
        <p className="yt-trim-hint">
          <span className="transcribe-spinner" /> Loading video…
        </p>
      )}

      {duration !== null && (
        <div className="trim-block">
          <span className="yt-trim-label">drag to trim</span>
          <TrimSlider
            duration={duration}
            fromSec={fromSec ?? 0}
            toSec={toSec ?? duration}
            onChange={applyDrag}
          />
        </div>
      )}

      <div className="yt-trim-row">
        <span className="yt-trim-label">{duration !== null ? 'or type' : 'trim (optional)'}</span>
        <input
          className={`yt-trim-input ${fromBad ? 'yt-input--invalid' : ''}`}
          type="text"
          placeholder="from  e.g. 3:37"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <span className="yt-trim-arrow">→</span>
        <input
          className={`yt-trim-input ${toBad || rangeError ? 'yt-input--invalid' : ''}`}
          type="text"
          placeholder="to  e.g. 3:59"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        {clipLength !== null && (
          <span className="yt-trim-length">= {formatDuration(clipLength)}</span>
        )}
      </div>

      {invalidUrl && <p className="yt-invalid">Doesn't look like a valid YouTube URL</p>}
      {(fromBad || toBad) && (
        <p className="yt-invalid">Use seconds or a M:SS / H:MM:SS timestamp</p>
      )}
      {rangeError && <p className="yt-invalid">"to" must be later than "from"</p>}
    </div>
  )
}
