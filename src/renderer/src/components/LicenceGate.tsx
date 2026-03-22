import { useState } from 'react'

interface Props {
  onActivated: () => void
}

export default function LicenceGate({ onActivated }: Props) {
  const [key, setKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleActivate = async () => {
    if (!key.trim()) return
    setLoading(true)
    setError(null)
    try {
      await window.api.activateLicence(key.trim())
      onActivated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="licence-gate">
      <div className="licence-content">
        <div className="licence-logo">Video Bastard</div>
        <h2 className="licence-title">Activate your licence</h2>
        <p className="licence-sub">
          Enter the licence key from your purchase confirmation email.
        </p>
        <input
          className="licence-input"
          type="text"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
          disabled={loading}
          spellCheck={false}
        />
        {error && <p className="licence-error">{error}</p>}
        <button
          className="licence-btn"
          onClick={handleActivate}
          disabled={!key.trim() || loading}
        >
          {loading ? 'Activating…' : 'Activate'}
        </button>
        <p className="licence-hint">
          Don't have a licence?{' '}
          <button
            className="licence-buy-link"
            onClick={() => window.api.openExternal('https://funk-27.co.uk')}
          >
            Get one at funk-27.co.uk
          </button>
        </p>
      </div>
    </div>
  )
}
