import { useState, useEffect, useCallback } from 'react'
import { PRESETS } from '../../shared/presets'
import type { ExportJob, SubtitleStyle, BgStyle } from '../../shared/types'
import DropZone from './components/DropZone'
import ServicePicker from './components/ServicePicker'
import JobQueue from './components/JobQueue'
import CompleteScreen from './components/CompleteScreen'
import YoutubeInput from './components/YoutubeInput'
import LicenceGate from './components/LicenceGate'
import AudioEditor from './components/AudioEditor'
import ScratchBuilder from './components/ScratchBuilder'
import ImageStudio from './components/ImageStudio'

type Tab = 'social-exports' | 'audio-editor' | 'scratch-builder' | 'images'

declare global {
  interface Window {
    api: {
      getPathForFile: (file: File) => string
      startExport: (args: {
        inputPath: string
        presetIds: string[]
        outputDir: string
        title: string
        description: string
        fileBaseName?: string
        subtitles: boolean
        subtitleStyle?: SubtitleStyle
        bgStyle?: BgStyle
        openaiApiKey?: string
        licenceKey?: string
        slamEffect?: boolean
        wobbleEffect?: boolean
      }) => Promise<string[]>
      selectOutputDir: () => Promise<string | null>
      getDesktopPath: () => Promise<string>
      getDownloadsPath: () => Promise<string>
      getPodcastDir: () => Promise<string>
      getSavedOutputDir: () => Promise<string>
      setSavedOutputDir: (dir: string) => Promise<void>
      getApiKey: () => Promise<string>
      setApiKey: (key: string) => Promise<void>
      getLicenceKey: () => Promise<string>
      isPackaged: () => Promise<boolean>
      activateLicence: (key: string) => Promise<void>
      openExternal: (url: string) => Promise<void>
      showItemInFolder: (path: string) => Promise<void>
      onTranscribeProgress: (cb: (data: { label: string }) => void) => () => void
      onJobsCreated: (cb: (jobs: ExportJob[]) => void) => () => void
      onProgress: (cb: (data: { jobId: string; progress: number }) => void) => () => void
      onJobStatus: (cb: (data: { jobId: string; status: string }) => void) => () => void
      onJobDone: (cb: (data: { jobId: string; outputPath: string }) => void) => () => void
      onJobError: (cb: (data: { jobId: string; error: string }) => void) => () => void
      getYoutubeInfo: (url: string) => Promise<{ duration: number; title: string }>
      downloadYoutube: (url: string, startSec?: number, endSec?: number) => Promise<{ path: string; title: string; description: string }>
      onYoutubeProgress: (cb: (data: { label: string; percent: number }) => void) => () => void
      getTestVideoPath: () => Promise<string | null>
      fetchImageUrl: (url: string) => Promise<string>
      encodeMp4: (args: { frames: string[]; fps: number }) => Promise<string>
      onUpdateAvailable: (cb: (data: { version: string }) => void) => () => void
      onUpdateProgress: (cb: (data: { percent: number }) => void) => () => void
      onUpdateReady: (cb: (data: { version: string }) => void) => () => void
      onUpdateError: (cb: (data: { message: string }) => void) => () => void
      installUpdate: () => Promise<void>
      getReleasesUrl: () => Promise<string>
    }
  }
}

// Paths come from the main process, so they use the host separator: '/' on
// macOS, '\\' on Windows. Split on either or these silently misbehave on Windows.
function baseFromPath(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? ''
}

function stemFromPath(filePath: string): string {
  return baseFromPath(filePath).replace(/\.[^/.]+$/, '')
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('social-exports')
  const [inputPath, setInputPath] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [selectedPresets, setSelectedPresets] = useState<Set<string>>(new Set())
  const [outputDir, setOutputDir] = useState<string | null>(null)
  const [jobs, setJobs] = useState<ExportJob[]>([])
  const [isExporting, setIsExporting] = useState(false)
  const [allDone, setAllDone] = useState(false)
  const [ytDownload, setYtDownload] = useState<{ label: string; percent: number } | null>(null)
  const [ytError, setYtError] = useState<string | null>(null)
  const [subtitles, setSubtitles] = useState(false)
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>('standard')
  const [bgStyle, setBgStyle] = useState<BgStyle>('slo-mo-bnw')
  const [apiKey, setApiKeyState] = useState('')
  const [transcribeLabel, setTranscribeLabel] = useState<string | null>(null)
  const [isPackaged, setIsPackaged] = useState(false)
  const [licenceKey, setLicenceKey] = useState<string | null>(null)
  const [licenceChecked, setLicenceChecked] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<
    { version: string; status: 'downloading' | 'ready'; percent: number } | null
  >(null)
  const [updateFailed, setUpdateFailed] = useState(false)
  const [slamEffect, setSlamEffect] = useState(false)
  const [wobbleEffect, setWobbleEffect] = useState(false)

  const [defaultOutputDir, setDefaultOutputDir] = useState<string | null>(null)

  // Downloads on both macOS and Windows, unless the user has picked a folder.
  const effectiveOutputDir = outputDir ?? defaultOutputDir

  useEffect(() => {
    Promise.all([
      window.api.getApiKey(),
      window.api.isPackaged(),
      window.api.getLicenceKey(),
      window.api.getSavedOutputDir(),
      window.api.getDownloadsPath(),
    ]).then(([key, packaged, licence, savedDir, downloads]) => {
      if (key) setApiKeyState(key)
      setIsPackaged(packaged)
      setLicenceKey(licence || null)
      setLicenceChecked(true)
      setDefaultOutputDir(downloads)
      // A folder the user picked in an earlier session wins over the default.
      if (savedDir) {
        setOutputDir(savedDir)
      }
    })
  }, [])

  useEffect(() => {
    const unsubs = [
      window.api.onUpdateAvailable(({ version }) =>
        setUpdateInfo({ version, status: 'downloading', percent: 0 })
      ),
      window.api.onUpdateProgress(({ percent }) =>
        setUpdateInfo((prev) => (prev ? { ...prev, percent } : prev))
      ),
      window.api.onUpdateReady(({ version }) =>
        setUpdateInfo({ version, status: 'ready', percent: 100 })
      ),
      window.api.onUpdateError(() => {
        // Fall back to the manual download link rather than leaving a banner
        // stuck at "downloading" forever.
        setUpdateInfo(null)
        setUpdateFailed(true)
      }),
      window.api.onYoutubeProgress((data) => setYtDownload(data)),
      window.api.onTranscribeProgress(({ label }) => setTranscribeLabel(label)),
      window.api.onJobsCreated((newJobs) => {
        setJobs(newJobs)
        setIsExporting(true)
      }),
      window.api.onProgress(({ jobId, progress }) => {
        setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, progress } : j))
      }),
      window.api.onJobStatus(({ jobId, status }) => {
        setJobs((prev) =>
          prev.map((j) => j.id === jobId ? { ...j, status: status as ExportJob['status'] } : j)
        )
      }),
      window.api.onJobDone(({ jobId, outputPath }) => {
        setJobs((prev) =>
          prev.map((j) => j.id === jobId ? { ...j, outputPath, status: 'done', progress: 100 } : j)
        )
      }),
      window.api.onJobError(({ jobId, error }) => {
        setJobs((prev) =>
          prev.map((j) => j.id === jobId ? { ...j, error, status: 'error' } : j)
        )
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  useEffect(() => {
    if (jobs.length > 0 && jobs.every((j) => j.status === 'done' || j.status === 'error')) {
      setIsExporting(false)
      setAllDone(true)
    }
  }, [jobs])

  const handleFile = useCallback((path: string) => {
    const stem = stemFromPath(path)
    setInputPath(path)
    setTitle(stem)
    setDescription(`Type description here for ${stem}`)
  }, [])

  const handleSelectOutputDir = useCallback(async () => {
    const dir = await window.api.selectOutputDir()
    if (!dir) return
    setOutputDir(dir)
    // Remember it for future videos and future sessions.
    void window.api.setSavedOutputDir(dir)
  }, [])

  const handleExport = useCallback(async () => {
    if (!inputPath || selectedPresets.size === 0 || !effectiveOutputDir) return

    setJobs([])
    setIsExporting(true)
    setAllDone(false)

    await window.api.startExport({
      inputPath,
      presetIds: Array.from(selectedPresets),
      outputDir: effectiveOutputDir,
      title,
      description,
      fileBaseName: title,
      subtitles,
      subtitleStyle,
      bgStyle,
      openaiApiKey: isPackaged ? undefined : (apiKey || undefined),
      licenceKey: licenceKey || undefined,
      slamEffect,
      wobbleEffect,
    })
  }, [inputPath, selectedPresets, effectiveOutputDir, title, description, subtitles, subtitleStyle, bgStyle, apiKey, isPackaged, licenceKey, slamEffect, wobbleEffect])

  const handleReset = useCallback(() => {
    setInputPath(null)
    setTitle('')
    setDescription('')
    setJobs([])
    setIsExporting(false)
    setAllDone(false)
    setSelectedPresets(new Set())
    // Deliberately keeps outputDir — "change video" should not silently throw
    // away where the user said exports go.
    setYtDownload(null)
    setYtError(null)
    setTranscribeLabel(null)
  }, [])

  const handleDevLoad = useCallback(async () => {
    const path = await window.api.getTestVideoPath()
    if (!path) {
      alert('No test video found. Add a file at dev-assets/test.mp4 in the project root.')
      return
    }
    handleFile(path)
    setTitle('Test Video')
    setDescription('Dev mode test description.')
  }, [handleFile])

  const handleYoutubeDownload = useCallback(async (url: string, startSec?: number, endSec?: number) => {
    setYtError(null)
    setYtDownload({ label: 'Starting…', percent: 0 })
    try {
      const result = await window.api.downloadYoutube(url, startSec, endSec)
      setYtDownload(null)
      setTitle(result.title)
      setDescription(result.description.slice(0, 220))
      setInputPath(result.path)
    } catch (err) {
      setYtDownload(null)
      setYtError(err instanceof Error ? err.message : String(err) || 'Download failed')
    }
  }, [])

  const canExport = inputPath !== null && selectedPresets.size > 0 && !isExporting

  const PORTRAIT_PRESET_IDS = ['tiktok', 'instagram-feed', 'instagram-story', 'bluesky']
  const hasPortraitSelected = PORTRAIT_PRESET_IDS.some((id) => selectedPresets.has(id))

  if (!licenceChecked) return null

  if (isPackaged && !licenceKey) {
    return (
      <LicenceGate onActivated={() => {
        window.api.getLicenceKey().then((k) => setLicenceKey(k || null))
      }} />
    )
  }

  if (allDone) {
    return <CompleteScreen jobs={jobs} onReset={handleReset} />
  }

  return (
    <div className="app">
      {updateInfo && (
        <div className="update-banner">
          {updateInfo.status === 'downloading' ? (
            <span>
              Downloading version <strong>{updateInfo.version}</strong>… {updateInfo.percent}%
            </span>
          ) : (
            <>
              <span>Version <strong>{updateInfo.version}</strong> is ready to install.</span>
              <button className="update-banner-link" onClick={() => void window.api.installUpdate()}>
                Restart &amp; install
              </button>
            </>
          )}
          <button className="update-banner-dismiss" onClick={() => setUpdateInfo(null)}>✕</button>
        </div>
      )}
      {updateFailed && (
        <div className="update-banner">
          <span>Couldn&apos;t check for updates.</span>
          <button
            className="update-banner-link"
            onClick={async () => window.api.openExternal(await window.api.getReleasesUrl())}
          >
            Check manually
          </button>
          <button className="update-banner-dismiss" onClick={() => setUpdateFailed(false)}>✕</button>
        </div>
      )}
      <header className="app-header">
        <h1>Video Bastard</h1>
        <p className="app-tagline">Drop your video. Pick your platforms. Done.</p>
        {!isPackaged && (
          <button className="dev-menu-btn" onClick={handleDevLoad}>
            ⚙ populate with test vid
          </button>
        )}
      </header>

      <nav className="app-tabs">
        <button
          className={`app-tab ${activeTab === 'social-exports' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('social-exports')}
        >
          Social Exports
        </button>
        <button
          className={`app-tab ${activeTab === 'audio-editor' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('audio-editor')}
        >
          Audio Editor
        </button>
        <button
          className={`app-tab ${activeTab === 'scratch-builder' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('scratch-builder')}
        >
          Scratch Builder
        </button>
        <button
          className={`app-tab ${activeTab === 'images' ? 'app-tab--active' : ''}`}
          onClick={() => setActiveTab('images')}
        >
          Images
        </button>
      </nav>

      {activeTab === 'audio-editor' && <AudioEditor />}
      {activeTab === 'scratch-builder' && <ScratchBuilder />}
      {activeTab === 'images' && <ImageStudio />}

      <main className="app-main" style={{ display: activeTab === 'social-exports' ? undefined : 'none' }}>
        {!inputPath && ytDownload && (
          <div className="yt-downloading">
            <p className="yt-downloading-label">{ytDownload.label}</p>
            <div className="yt-progress-track">
              <div className="yt-progress-fill" style={{ width: `${ytDownload.percent}%` }} />
            </div>
            <p className="yt-downloading-pct">{ytDownload.percent}%</p>
          </div>
        )}

        {!inputPath && !ytDownload && (
          <>
            <DropZone onFile={handleFile} />
            <div className="yt-divider"><span>or</span></div>
            <YoutubeInput onDownload={handleYoutubeDownload} />
            {ytError && <p className="yt-error">{ytError}</p>}
          </>
        )}

        {inputPath && (
          <div className="loaded-file">
            <span className="meta-label">video</span>
            <div className="file-info">
              <span className="file-icon">🎬</span>
              <span className="file-name">{baseFromPath(inputPath)}</span>
              {!isExporting && (
                <button className="btn-ghost" onClick={handleReset}>Change video</button>
              )}
            </div>
          </div>
        )}

        {inputPath && !isExporting && (
          <>
            <div className="meta-fields">
              <div className="meta-field">
                <span className="meta-label">title</span>
                <input
                  className="meta-input"
                  type="text"
                  placeholder="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="meta-field">
                <span className="meta-label">description</span>
                <textarea
                  className="meta-textarea"
                  placeholder="Description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>
            </div>

            <span className="meta-label">export for</span>
            <ServicePicker
              presets={PRESETS}
              selected={selectedPresets}
              onChange={setSelectedPresets}
            />

            <div className="captions-row">
              <label className="captions-toggle">
                <input
                  type="checkbox"
                  checked={subtitles}
                  onChange={(e) => setSubtitles(e.target.checked)}
                />
                <span className="captions-toggle-label">Add captions</span>
                {isPackaged
                  ? <span className="captions-toggle-note captions-included">✓ included with licence</span>
                  : <span className="captions-toggle-note">burns subtitles into the video via OpenAI Whisper</span>
                }
              </label>
              {subtitles && !isPackaged && (
                <input
                  className="captions-key-input"
                  type="password"
                  placeholder="OpenAI API key (sk-…)"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKeyState(e.target.value)
                    window.api.setApiKey(e.target.value)
                  }}
                />
              )}
              {subtitles && (
                <div className="style-picker">
                  {(['standard', 'danger', 'f27'] as SubtitleStyle[]).map((s) => (
                    <button
                      key={s}
                      className={`style-chip ${subtitleStyle === s ? 'style-chip--active' : ''}`}
                      onClick={() => setSubtitleStyle(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {hasPortraitSelected && (
              <div className="bg-picker">
                <span className="bg-picker-label">background</span>
                <div className="bg-picker-options">
                  {([
                    { id: 'slo-mo-bnw', label: 'slo-mo BnW' },
                    { id: 'rainbow', label: 'rainbow' },
                    { id: 'scratchy-blue', label: 'scratchy blue' },
                    { id: 'checks', label: 'checks' },
                    { id: 'none', label: 'none' },
                  ] as { id: BgStyle; label: string }[]).map((opt) => (
                    <button
                      key={opt.id}
                      className={`style-chip ${bgStyle === opt.id ? 'style-chip--active' : ''}`}
                      onClick={() => setBgStyle(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {hasPortraitSelected && (
              <label className="captions-toggle">
                <input
                  type="checkbox"
                  checked={slamEffect}
                  onChange={(e) => setSlamEffect(e.target.checked)}
                />
                <span className="captions-toggle-label">Slam effect</span>
                <span className="captions-toggle-note">video slams in from the side at the start</span>
              </label>
            )}

            {hasPortraitSelected && (
              <label className="captions-toggle">
                <input
                  type="checkbox"
                  checked={wobbleEffect}
                  onChange={(e) => setWobbleEffect(e.target.checked)}
                />
                <span className="captions-toggle-label">Wobble</span>
                <span className="captions-toggle-note">subtle handheld motion (±7px)</span>
              </label>
            )}

            <div className="output-row">
              <div className="output-dir">
                <span className="output-dir-label">Save to</span>
                <button className="output-dir-btn" onClick={handleSelectOutputDir}>
                  <span className="output-dir-icon">📁</span>
                  <span className="output-dir-path">
                    {effectiveOutputDir ?? 'Downloads'}
                  </span>
                  <span className="output-dir-change">Change</span>
                </button>
              </div>

              <button className="btn-primary" onClick={handleExport} disabled={!canExport}>
                Export {selectedPresets.size > 0 ? `(${selectedPresets.size})` : ''}
              </button>
            </div>
          </>
        )}

        {transcribeLabel && isExporting && (
          <div className="transcribe-status">
            <span className="transcribe-spinner" />
            <span>{transcribeLabel}</span>
          </div>
        )}

        {jobs.length > 0 && isExporting && (
          <JobQueue jobs={jobs} onReset={handleReset} isExporting={isExporting} />
        )}

      </main>

      <button className="funk-brand" onClick={() => window.api.openExternal('https://funk-27.co.uk')}>
        funk-27
      </button>
    </div>
  )
}
