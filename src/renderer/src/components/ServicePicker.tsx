import type { ExportPreset } from '../../../shared/types'
import {
  FaTiktok,
  FaYoutube,
  FaInstagram,
  FaLinkedin
} from 'react-icons/fa'
import { FaXTwitter, FaBluesky } from 'react-icons/fa6'
import type { IconType } from 'react-icons'

interface Props {
  presets: ExportPreset[]
  selected: Set<string>
  onChange: (selected: Set<string>) => void
}

const ICONS: Record<string, IconType> = {
  tiktok: FaTiktok,
  youtube: FaYoutube,
  'instagram-feed': FaInstagram,
  'instagram-story': FaInstagram,
  twitter: FaXTwitter,
  linkedin: FaLinkedin,
  bluesky: FaBluesky
}

function ShapeIndicator({ width, height }: { width: number; height: number }) {
  const BOX = 28
  const ratio = width / height
  let w: number, h: number

  if (ratio > 1) {
    w = BOX
    h = Math.round(BOX / ratio)
  } else if (ratio < 1) {
    h = BOX
    w = Math.round(BOX * ratio)
  } else {
    w = BOX
    h = BOX
  }

  return (
    <svg
      width={BOX}
      height={BOX}
      viewBox={`0 0 ${BOX} ${BOX}`}
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect
        x={(BOX - w) / 2}
        y={(BOX - h) / 2}
        width={w}
        height={h}
        rx={2}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </svg>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

export default function ServicePicker({ presets, selected, onChange }: Props) {
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    onChange(next)
  }

  const selectAll = () => onChange(new Set(presets.map((p) => p.id)))
  const selectNone = () => onChange(new Set())

  return (
    <section className="service-picker">
      <div className="service-picker-header">
        <h2>Export for</h2>
        <div className="service-picker-actions">
          <button className="btn-ghost" onClick={selectAll}>All</button>
          <button className="btn-ghost" onClick={selectNone}>None</button>
        </div>
      </div>

      <div className="preset-list">
        {presets.map((preset) => {
          const isSelected = selected.has(preset.id)
          const Icon = ICONS[preset.id]
          return (
            <button
              key={preset.id}
              className={`preset-row ${isSelected ? 'preset-row--selected' : ''}`}
              onClick={() => toggle(preset.id)}
            >
              <div className="preset-row-left">
                <div className="preset-row-check">
                  {isSelected && <span className="check-mark">✓</span>}
                </div>
                {Icon && <Icon className="preset-platform-icon" />}
                <span className="preset-name">{preset.name}</span>
              </div>

              <div className="preset-row-meta">
                <span className="preset-dims">{preset.width}×{preset.height}</span>
                <span className="preset-fps">{preset.fps}fps</span>
                {preset.maxDurationSeconds && (
                  <span className="preset-limit">max {formatDuration(preset.maxDurationSeconds)}</span>
                )}
              </div>

              <div className="preset-row-shape">
                <ShapeIndicator width={preset.width} height={preset.height} />
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
