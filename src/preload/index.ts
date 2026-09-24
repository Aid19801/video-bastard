import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  startExport: (args: { inputPath: string; presetIds: string[]; outputDir: string }) =>
    ipcRenderer.invoke('export:start', args),

  selectOutputDir: () => ipcRenderer.invoke('dialog:selectOutputDir'),

  onJobsCreated: (cb: (jobs: unknown[]) => void) => {
    const handler = (_: unknown, jobs: unknown[]) => cb(jobs)
    ipcRenderer.on('export:jobs-created', handler)
    return () => ipcRenderer.removeListener('export:jobs-created', handler)
  },

  onProgress: (cb: (data: { jobId: string; progress: number }) => void) => {
    const handler = (_: unknown, data: { jobId: string; progress: number }) => cb(data)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },

  onJobStatus: (cb: (data: { jobId: string; status: string }) => void) => {
    const handler = (_: unknown, data: { jobId: string; status: string }) => cb(data)
    ipcRenderer.on('export:job-status', handler)
    return () => ipcRenderer.removeListener('export:job-status', handler)
  },

  onJobDone: (cb: (data: { jobId: string; outputPath: string }) => void) => {
    const handler = (_: unknown, data: { jobId: string; outputPath: string }) => cb(data)
    ipcRenderer.on('export:job-done', handler)
    return () => ipcRenderer.removeListener('export:job-done', handler)
  },

  onJobError: (cb: (data: { jobId: string; error: string }) => void) => {
    const handler = (_: unknown, data: { jobId: string; error: string }) => cb(data)
    ipcRenderer.on('export:job-error', handler)
    return () => ipcRenderer.removeListener('export:job-error', handler)
  },

  getDesktopPath: () => ipcRenderer.invoke('app:desktopPath'),
  getDownloadsPath: () => ipcRenderer.invoke('app:downloadsPath'),

  getPodcastDir: () => ipcRenderer.invoke('app:podcastDir'),

  getApiKey: () => ipcRenderer.invoke('config:getApiKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('config:setApiKey', key),
  getLicenceKey: () => ipcRenderer.invoke('config:getLicenceKey'),
  getSavedOutputDir: () => ipcRenderer.invoke('config:getOutputDir'),
  setSavedOutputDir: (dir: string) => ipcRenderer.invoke('config:setOutputDir', dir),
  isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  activateLicence: (key: string) => ipcRenderer.invoke('licence:activate', key),

  onTranscribeProgress: (cb: (data: { label: string }) => void) => {
    const handler = (_: unknown, data: { label: string }) => cb(data)
    ipcRenderer.on('export:transcribe-progress', handler)
    return () => ipcRenderer.removeListener('export:transcribe-progress', handler)
  },

  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:openExternal', url),

  showItemInFolder: (path: string) =>
    ipcRenderer.invoke('shell:showItemInFolder', path),

  getYoutubeInfo: (url: string) =>
    ipcRenderer.invoke('youtube:info', url),

  downloadYoutube: (url: string, startSec?: number, endSec?: number) =>
    ipcRenderer.invoke('youtube:download', { url, startSec, endSec }),

  onYoutubeProgress: (cb: (data: { label: string; percent: number }) => void) => {
    const handler = (_: unknown, data: { label: string; percent: number }) => cb(data)
    ipcRenderer.on('youtube:progress', handler)
    return () => ipcRenderer.removeListener('youtube:progress', handler)
  },

  getTestVideoPath: (): Promise<string | null> => ipcRenderer.invoke('dev:getTestVideoPath'),

  fetchImageUrl: (url: string): Promise<string> => ipcRenderer.invoke('image:fetchUrl', url),

  encodeMp4: (args: { frames: string[]; fps: number }): Promise<string> =>
    ipcRenderer.invoke('image:encodeMp4', args),

  saveAudioFile: (filename: string, buffer: ArrayBuffer): Promise<{ saved: boolean; filePath?: string }> =>
    ipcRenderer.invoke('audio:save', { filename, buffer }),

  onUpdateAvailable: (cb: (data: { version: string }) => void) => {
    const handler = (_: unknown, data: { version: string }) => cb(data)
    ipcRenderer.on('app:update-available', handler)
    return () => ipcRenderer.removeListener('app:update-available', handler)
  },

  onUpdateProgress: (cb: (data: { percent: number }) => void) => {
    const handler = (_: unknown, data: { percent: number }) => cb(data)
    ipcRenderer.on('app:update-progress', handler)
    return () => ipcRenderer.removeListener('app:update-progress', handler)
  },

  onUpdateReady: (cb: (data: { version: string }) => void) => {
    const handler = (_: unknown, data: { version: string }) => cb(data)
    ipcRenderer.on('app:update-ready', handler)
    return () => ipcRenderer.removeListener('app:update-ready', handler)
  },

  onUpdateError: (cb: (data: { message: string }) => void) => {
    const handler = (_: unknown, data: { message: string }) => cb(data)
    ipcRenderer.on('app:update-error', handler)
    return () => ipcRenderer.removeListener('app:update-error', handler)
  },

  installUpdate: () => ipcRenderer.invoke('update:install'),
  getReleasesUrl: () => ipcRenderer.invoke('update:releasesUrl'),
})
