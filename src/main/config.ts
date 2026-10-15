import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface Config {
  openaiApiKey?: string
  licenceKey?: string
  authSession?: AuthSession
  outputDir?: string
  youtubeApiKey?: string
  channelHandles?: string[]
  pinecastFeedUrl?: string
  // handle → UC… id, so we only scrape a channel page once
  channelIds?: Record<string, string>
}

// funk-27 login. token is the JWT, base64 of the safeStorage-encrypted bytes
// when encrypted is true. email/verified cache the last /me answer so a
// verified user can keep working while offline.
export interface AuthSession {
  token: string
  encrypted: boolean
  email: string
  verified: boolean
}

const configPath = join(app.getPath('userData'), 'vb-config.json')

function readConfig(): Config {
  try {
    if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {}
  return {}
}

function writeConfig(config: Config): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

export function getApiKey(): string {
  return readConfig().openaiApiKey || process.env['OPENAI_API_KEY'] || ''
}

export function setApiKey(key: string): void {
  writeConfig({ ...readConfig(), openaiApiKey: key })
}

export function getLicenceKey(): string {
  return readConfig().licenceKey ?? ''
}

export function setLicenceKey(key: string): void {
  writeConfig({ ...readConfig(), licenceKey: key })
}

export function getAuthSession(): AuthSession | null {
  return readConfig().authSession ?? null
}

export function setAuthSession(session: AuthSession): void {
  writeConfig({ ...readConfig(), authSession: session })
}

export function clearAuthSession(): void {
  const { authSession: _, ...rest } = readConfig()
  writeConfig(rest)
}

// The user's chosen export folder. Sticky across sessions and across loading a
// new video — once they've said where exports go, we don't second-guess it.
export function getOutputDir(): string {
  return readConfig().outputDir ?? ''
}

export function setOutputDir(dir: string): void {
  writeConfig({ ...readConfig(), outputDir: dir })
}

// Content dashboard settings. The YouTube key is optional — without it we fall
// back to the public RSS feeds (recent uploads + views, but no subscriber count).
const DEFAULT_CHANNEL_HANDLES = ['aidThompsin', 'aidthompsinClips']
const DEFAULT_PINECAST_FEED = 'https://pinecast.com/feed/aid-thompsin-other-disappointm'

export function getDashboardSettings(): { channelHandles: string[]; pinecastFeedUrl: string; youtubeApiKey: string } {
  const c = readConfig()
  return {
    channelHandles: c.channelHandles ?? DEFAULT_CHANNEL_HANDLES,
    pinecastFeedUrl: c.pinecastFeedUrl ?? DEFAULT_PINECAST_FEED,
    youtubeApiKey: c.youtubeApiKey || process.env['YOUTUBE_API_KEY'] || '',
  }
}

export function setDashboardSettings(s: { channelHandles: string[]; pinecastFeedUrl: string; youtubeApiKey: string }): void {
  writeConfig({ ...readConfig(), ...s })
}

export function getCachedChannelId(handle: string): string | undefined {
  return readConfig().channelIds?.[handle.toLowerCase()]
}

export function setCachedChannelId(handle: string, id: string): void {
  const c = readConfig()
  writeConfig({ ...c, channelIds: { ...c.channelIds, [handle.toLowerCase()]: id } })
}
