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
  // Base name for the output file(s). When set, exports are named after this
  // (e.g. the YouTube video title) instead of the input file's name.
  fileBaseName?: string
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

// ── Content dashboard ────────────────────────────────────────────────────────

export interface VideoStat {
  id: string
  title: string
  url: string
  thumbnail: string
  publishedAt: string
  views: number
  likes: number
  comments?: number // only with a YouTube API key
  viewsPerDay: number
}

export interface ChannelStat {
  handle: string
  id: string
  title: string
  url: string
  subscribers?: number // only with a YouTube API key
  totalViews?: number
  videoCount?: number
  recent: VideoStat[] // newest first, up to 15
  // Change since the snapshot closest to 24h ago; absent on first run.
  viewsGained24h?: number
  subsGained24h?: number
  error?: string
}

export interface PodcastEpisode {
  title: string
  publishedAt: string
  durationSec?: number
  url?: string
}

export interface PodcastStat {
  title: string
  episodeCount: number
  lastPublishedAt?: string
  avgGapDays?: number
  episodes: PodcastEpisode[] // newest first
  error?: string
}

export interface DashboardStats {
  fetchedAt: string
  hasYoutubeKey: boolean
  channels: ChannelStat[]
  podcast: PodcastStat | null // null when no feed URL is configured
}

export interface DashboardSettings {
  channelHandles: string[]
  pinecastFeedUrl: string
  youtubeApiKey: string
}

export interface PastIdea {
  id: string
  title: string
  url: string
  views: number
  channelTitle: string
  description: string
}

export interface IdeasResult {
  ideas: PastIdea[] // up to 3, randomly drawn from each channel's top quartile
  topics?: string[] // AI-distilled broad topic per idea, same order; absent without an OpenAI key
  topicsError?: string
}

// funk-27 account gate. Only 'ok' (logged in + verified) unlocks the app.
export type AuthState =
  | { status: 'logged-out'; error?: string }
  | { status: 'unverified'; email: string }
  | { status: 'ok'; email: string }
