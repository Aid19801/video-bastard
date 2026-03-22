import { useState } from 'react'
import { FaYoutube } from 'react-icons/fa'

interface Props {
  onDownload: (url: string) => void
}

function isValidYoutubeUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/.test(url.trim())
}

export default function YoutubeInput({ onDownload }: Props) {
  const [url, setUrl] = useState('')
  const invalid = url.length > 0 && !isValidYoutubeUrl(url)

  const handleSubmit = () => {
    if (isValidYoutubeUrl(url)) onDownload(url.trim())
  }

  return (
    <div className="yt-input-wrap">
      <div className="yt-input-row">
        <FaYoutube className="yt-icon" />
        <input
          className={`yt-input ${invalid ? 'yt-input--invalid' : ''}`}
          type="url"
          placeholder="Paste a YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <button
          className="btn-primary"
          onClick={handleSubmit}
          disabled={!isValidYoutubeUrl(url)}
        >
          Go
        </button>
      </div>
      {invalid && (
        <p className="yt-invalid">Doesn't look like a valid YouTube URL</p>
      )}
    </div>
  )
}
