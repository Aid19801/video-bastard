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

  getApiKey: () => ipcRenderer.invoke('config:getApiKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('config:setApiKey', key),
  getLicenceKey: () => ipcRenderer.invoke('config:getLicenceKey'),
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

  downloadYoutube: (url: string) =>
    ipcRenderer.invoke('youtube:download', url),

  onYoutubeProgress: (cb: (data: { label: string; percent: number }) => void) => {
    const handler = (_: unknown, data: { label: string; percent: number }) => cb(data)
    ipcRenderer.on('youtube:progress', handler)
    return () => ipcRenderer.removeListener('youtube:progress', handler)
  },

  getTestVideoPath: (): Promise<string | null> => ipcRenderer.invoke('dev:getTestVideoPath'),

  onUpdateAvailable: (cb: (data: { version: string; downloadUrl: string }) => void) => {
    const handler = (_: unknown, data: { version: string; downloadUrl: string }) => cb(data)
    ipcRenderer.on('app:update-available', handler)
    return () => ipcRenderer.removeListener('app:update-available', handler)
  },
})
