import { app, IpcMain, safeStorage } from 'electron'
import { FUNK_API_URL } from './subtitles'
import { getAuthSession, setAuthSession, clearAuthSession } from './config'
import type { AuthState } from '../shared/types'

// Accounts live in funk-api (the same ones as funk-27.co.uk). We never touch
// the database — the app logs in over HTTPS and keeps only the JWT, encrypted
// with the OS keychain via safeStorage. Access requires a verified account.

const REQUEST_TIMEOUT_MS = 15_000

function encrypt(token: string): string {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token).toString('base64')
    : token
}

function decrypt(stored: string, encrypted: boolean): string | null {
  if (!encrypted) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null // keychain entry changed/unavailable — treat as logged out
  }
}

// The JWT's exp claim, in ms. Read locally (no signature check — the server
// does that) so an expired session goes straight to the login screen.
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function storedToken(): string | null {
  const session = getAuthSession()
  if (!session) return null
  const token = decrypt(session.token, session.encrypted)
  if (!token) return null
  const exp = tokenExpiry(token)
  if (exp !== null && exp <= Date.now()) return null
  return token
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${FUNK_API_URL}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

// funk-api reports errors as { detail: "…" }.
async function errorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    return typeof body.detail === 'string' ? body.detail : fallback
  } catch {
    return fallback
  }
}

// Login is skipped in dev (unpackaged) builds for now. Set VB_REQUIRE_LOGIN=1
// to exercise the login flow locally.
const LOGIN_REQUIRED = app.isPackaged || process.env['VB_REQUIRE_LOGIN'] === '1'

export async function getAuthState(): Promise<AuthState> {
  if (!LOGIN_REQUIRED) return { status: 'ok', email: '' }

  const token = storedToken()
  if (!token) {
    clearAuthSession()
    return { status: 'logged-out' }
  }

  let res: Response
  try {
    res = await apiFetch('/me', { headers: { Authorization: `Bearer ${token}` } })
  } catch {
    // Offline or the API is down. Don't lock out someone already verified —
    // the token is still within its expiry, so trust the last answer we got.
    const session = getAuthSession()
    if (session?.verified) return { status: 'ok', email: session.email }
    return { status: 'logged-out', error: "Couldn't reach funk-27 to check your account." }
  }

  if (res.status === 401 || res.status === 403 || res.status === 404) {
    clearAuthSession()
    return { status: 'logged-out', error: res.status === 401 ? 'Your session expired — please log in again.' : undefined }
  }
  if (!res.ok) {
    const session = getAuthSession()
    if (session?.verified) return { status: 'ok', email: session.email }
    return { status: 'logged-out', error: await errorDetail(res, 'Account check failed.') }
  }

  const profile = (await res.json()) as { email?: string; verified?: boolean }
  const email = profile.email ?? getAuthSession()?.email ?? ''
  const verified = profile.verified === true
  const session = getAuthSession()
  if (session) setAuthSession({ ...session, email, verified })
  return verified ? { status: 'ok', email } : { status: 'unverified', email }
}

export async function login(email: string, password: string): Promise<AuthState> {
  let res: Response
  try {
    res = await apiFetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    })
  } catch {
    throw new Error("Couldn't reach funk-27. Check your connection and try again.")
  }
  if (!res.ok) throw new Error(await errorDetail(res, 'Login failed.'))

  const { access_token } = (await res.json()) as { access_token?: string }
  if (!access_token) throw new Error('Login failed — no session returned.')

  setAuthSession({
    token: encrypt(access_token),
    encrypted: safeStorage.isEncryptionAvailable(),
    email: email.trim(),
    verified: false,
  })
  return getAuthState()
}

export function registerAuthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('auth:state', () => getAuthState())
  ipcMain.handle('auth:login', (_event, email: string, password: string) => login(email, password))
  ipcMain.handle('auth:logout', () => clearAuthSession())
}
