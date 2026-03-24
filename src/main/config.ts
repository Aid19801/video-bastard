import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface Config {
  openaiApiKey?: string
  licenceKey?: string
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

