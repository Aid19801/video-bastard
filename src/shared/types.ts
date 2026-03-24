export interface ExportPreset {
  id: string
  name: string
  label: string
  width: number
  height: number
  fps: number
  videoBitrate: string
  audioBitrate: string
  maxDurationSeconds?: number
  codec: string
  format: string
  titleSuffix: string
}

export type JobStatus = 'queued' | 'processing' | 'done' | 'error'

export interface ExportJob {
  id: string
  inputPath: string
  preset: ExportPreset
  outputPath: string
  status: JobStatus
  progress: number
  error?: string
  title?: string
  description?: string
}

export type SubtitleStyle = 'standard' | 'danger' | 'f27'
export type BgStyle = 'slo-mo-bnw' | 'rainbow' | 'scratchy-blue' | 'checks' | 'none'

export interface StartExportArgs {
  inputPath: string
  presetIds: string[]
  outputDir: string
  title: string
  description: string
  subtitles: boolean
  subtitleStyle?: SubtitleStyle
  bgStyle?: BgStyle
  openaiApiKey?: string
  licenceKey?: string
  slamEffect?: boolean
  wobbleEffect?: boolean
}

export interface ProgressEvent {
  jobId: string
  progress: number
}

export interface JobDoneEvent {
  jobId: string
  outputPath: string
}

export interface JobErrorEvent {
  jobId: string
  error: string
}
