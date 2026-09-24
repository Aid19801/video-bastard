import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface Config {
  openaiApiKey?: string
  licenceKey?: string
  outputDir?: string
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


// The user's chosen export folder. Sticky across sessions and across loading a
// new video — once they've said where exports go, we don't second-guess it.
export function getOutputDir(): string {
  return readConfig().outputDir ?? ''
}

export function setOutputDir(dir: string): void {
  writeConfig({ ...readConfig(), outputDir: dir })
}
