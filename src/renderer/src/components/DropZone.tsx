import { useCallback, useState, DragEvent } from 'react'

interface Props {
  onFile: (path: string) => void
}

const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/x-matroska']

export default function DropZone({ onFile }: Props) {
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = useCallback(
    (file: File) => {
      const hasValidType = ACCEPTED.includes(file.type)
      const hasValidExt = file.name.match(/\.(mp4|mov|avi|webm|mkv|m4v)$/i)
      if (!hasValidType && !hasValidExt) {
        setError('Please drop a video file (MP4, MOV, AVI, WebM, MKV)')
        return
      }
      setError(null)
      const filePath = window.api.getPathForFile(file)
      onFile(filePath)
    },
    [onFile]
  )

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(true)
  }

  const onDragLeave = () => setDragging(false)

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div
      className={`dropzone ${dragging ? 'dropzone--active' : ''}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="dropzone-content">
        <div className="dropzone-icon">🎥</div>
        <p className="dropzone-title">Drop your video here</p>
        <p className="dropzone-sub">or</p>
        <label className="btn-secondary">
          Browse file
          <input
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={onInputChange}
          />
        </label>
        <p className="dropzone-formats">MP4, MOV, AVI, WebM, MKV</p>
        {error && <p className="dropzone-error">{error}</p>}
      </div>
    </div>
  )
}
