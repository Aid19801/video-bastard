import { useEffect, useRef, useState } from 'react'
import { FaTiktok, FaYoutube, FaInstagram, FaLinkedin } from 'react-icons/fa'
import { FaXTwitter, FaBluesky } from 'react-icons/fa6'
import type { ExportJob } from '../../../shared/types'

interface Props {
  jobs: ExportJob[]
  onReset: () => void
}

const PLATFORM_CONFIG: Record<string, { icon: React.ReactNode; uploadUrl: string; color: string }> = {
  tiktok: {
    icon: <FaTiktok />,
    uploadUrl: 'https://www.tiktok.com/upload',
    color: '#010101',
  },
  youtube: {
    icon: <FaYoutube />,
    uploadUrl: 'https://studio.youtube.com/',
    color: '#ff0000',
  },
  'instagram-feed': {
    icon: <FaInstagram />,
    uploadUrl: 'https://www.instagram.com/',
    color: '#e1306c',
  },
  'instagram-story': {
    icon: <FaInstagram />,
    uploadUrl: 'https://www.instagram.com/',
    color: '#e1306c',
  },
  twitter: {
    icon: <FaXTwitter />,
    uploadUrl: 'https://x.com/compose/post',
    color: '#000000',
  },
  linkedin: {
    icon: <FaLinkedin />,
    uploadUrl: 'https://www.linkedin.com/feed/',
    color: '#0a66c2',
  },
  bluesky: {
    icon: <FaBluesky />,
    uploadUrl: 'https://bsky.app/',
    color: '#0085ff',
  },
}

function PublishButton({ job, onPublished }: { job: ExportJob; onPublished: (msg?: string) => void }) {
  const config = PLATFORM_CONFIG[job.preset.id]
  if (!config) return null

  const isStory = job.preset.id === 'instagram-story'
  const storyTooltip = isStory
    ? "Instagram doesn't support video Story uploads in any browser — it's app-only. Click to reveal your file in Finder, then AirDrop it to your phone and upload via the Instagram app."
    : undefined

  const handlePublish = async () => {
    const text = [job.title, job.description].filter(Boolean).join('\n\n')
    await navigator.clipboard.writeText(text)

    if (isStory) {
      window.api.showItemInFolder(job.outputPath)
      onPublished('airdrop')
    } else {
      window.api.openExternal(config.uploadUrl)
      onPublished()
    }
  }

  return (
    <div className={`publish-row ${isStory ? 'publish-row--has-tooltip' : ''}`} data-tooltip={storyTooltip}>
      <div className="publish-platform">
        <span className="publish-icon" style={{ color: config.color }}>{config.icon}</span>
        <div className="publish-platform-text">
          <span className="publish-name">
            {job.preset.name}
            {isStory && <span className="publish-name-why">why?</span>}
          </span>
          {isStory && (
            <span className="publish-subnote">AirDrop to phone → upload via app</span>
          )}
        </div>
      </div>
      <button
        className="publish-btn"
        onClick={handlePublish}
        style={{ '--platform-color': config.color } as React.CSSProperties}
      >
        {isStory ? 'Show in Finder →' : 'Publish →'}
      </button>
    </div>
  )
}

export default function CompleteScreen({ jobs, onReset }: Props) {
  const doneJobs = jobs.filter((j) => j.status === 'done')
  const errorJobs = jobs.filter((j) => j.status === 'error')
  const [toast, setToast] = useState<{ visible: boolean; airdrop: boolean }>({ visible: false, airdrop: false })
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg?: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ visible: true, airdrop: msg === 'airdrop' })
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 3500)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onReset()
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [onReset])

  return (
    <div className="complete-screen">
      <div className="complete-content">
        <div className="complete-icon">✓</div>
        <h2 className="complete-title">Export complete</h2>
        <p className="complete-summary">
          {doneJobs.length} {doneJobs.length === 1 ? 'file' : 'files'} ready to publish
          {errorJobs.length > 0 && <span className="complete-errors">, {errorJobs.length} failed</span>}
        </p>

        {doneJobs.length > 0 && (
          <div className="publish-list">
            <p className="publish-hint-top">
              Clicking Publish copies your title &amp; description to the clipboard and opens the platform — just select your video and paste.
            </p>
            {doneJobs.map((job) => (
              <PublishButton key={job.id} job={job} onPublished={showToast} />
            ))}
          </div>
        )}

        {errorJobs.length > 0 && (
          <ul className="complete-error-list">
            {errorJobs.map((j) => (
              <li key={j.id}>{j.preset.name}: {j.error}</li>
            ))}
          </ul>
        )}

        <button className="btn-complete-reset" onClick={onReset}>
          Do another?
        </button>
        <p className="complete-hint">or press Esc</p>
      </div>

      <button className="funk-brand" onClick={() => window.api.openExternal('https://funk-27.co.uk')}>
        funk-27
      </button>

      <div className={`publish-toast ${toast.visible ? 'publish-toast--visible' : ''}`}>
        <span className="publish-toast-icon">{toast.airdrop ? '📁' : '📋'}</span>
        <div className="publish-toast-text">
          {toast.airdrop ? (
            <>
              <strong>File revealed in Finder</strong>
              <span>AirDrop to your phone, then upload as a Story</span>
            </>
          ) : (
            <>
              <strong>Copied to clipboard</strong>
              <span>Title &amp; description ready to paste</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
