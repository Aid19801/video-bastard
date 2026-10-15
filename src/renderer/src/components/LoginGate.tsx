import { useState } from 'react'
import type { AuthState } from '../../../shared/types'

const FUNK_27_URL = 'https://funk-27.co.uk'

interface Props {
  state: Exclude<AuthState, { status: 'ok' }>
  onChange: (state: AuthState) => void
}

// Shown until the user is logged in with a verified funk-27 account. Accounts
// are created and managed on the website; the app only logs in.
export default function LoginGate({ state, onChange }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = (path: string) => () => window.api.openExternal(`${FUNK_27_URL}${path}`)

  const handleLogin = async () => {
    if (!email.trim() || !password) return
    setLoading(true)
    setError(null)
    try {
      onChange(await window.api.login(email, password))
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const handleRecheck = async () => {
    setLoading(true)
    try {
      onChange(await window.api.getAuthState())
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    await window.api.logout()
    onChange({ status: 'logged-out' })
  }

  if (state.status === 'unverified') {
    return (
      <div className="licence-gate">
        <div className="licence-content">
          <div className="licence-logo">Video Bastard</div>
          <h2 className="licence-title">Account not verified yet</h2>
          <p className="licence-sub">
            You&apos;re logged in as <strong>{state.email}</strong>, but your funk-27 account
            needs to be verified before you can use Video Bastard.
          </p>
          <button className="licence-btn" onClick={handleRecheck} disabled={loading}>
            {loading ? 'Checking…' : 'Check again'}
          </button>
          <p className="licence-hint">
            <button className="licence-buy-link" onClick={handleLogout}>
              Log in with a different account
            </button>
          </p>
        </div>
      </div>
    )
  }

  const shownError = error ?? state.error ?? null

  return (
    <div className="licence-gate">
      <div className="licence-content">
        <div className="licence-logo">Video Bastard</div>
        <h2 className="licence-title">Log in</h2>
        <p className="licence-sub">Use your funk-27 account.</p>
        <input
          className="licence-input login-input"
          type="email"
          placeholder="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          disabled={loading}
          autoFocus
        />
        <input
          className="licence-input login-input"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          disabled={loading}
        />
        {shownError && <p className="licence-error">{shownError}</p>}
        <button
          className="licence-btn"
          onClick={handleLogin}
          disabled={!email.trim() || !password || loading}
        >
          {loading ? 'Logging in…' : 'Log in'}
        </button>
        <p className="licence-hint">
          <button className="licence-buy-link" onClick={open('/forgot-password')}>
            Forgot password?
          </button>
          {' · '}
          No account?{' '}
          <button className="licence-buy-link" onClick={open('/signup')}>
            Sign up at funk-27.co.uk
          </button>
        </p>
      </div>
    </div>
  )
}
