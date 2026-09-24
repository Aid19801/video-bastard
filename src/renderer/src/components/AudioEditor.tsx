import { useState, useRef, useEffect, useCallback } from 'react'

type Selection = { start: number; end: number }
type HistoryEntry = { channels: Float32Array[]; sampleRate: number; numberOfChannels: number; length: number }
type CtxMenu = { x: number; y: number } | null

const REVERB_PRESETS: Record<string, { decayTime: number; decayExp: number; dry: number; wet: number }> = {
  'reverb-hall':       { decayTime: 1.4, decayExp: 2.5, dry: 0.65, wet: 0.55 },
  'reverb-cave':       { decayTime: 4.0, decayExp: 1.2, dry: 0.45, wet: 0.90 },
  'reverb-ridiculous': { decayTime: 9.0, decayExp: 0.4, dry: 0.20, wet: 1.40 },
}

const OPERATIONS = [
  { id: 'silence',           label: 'Silence',       description: 'Replace selection with silence' },
  { id: 'reverse',           label: 'Reverse',       description: 'Reverse the selected audio' },
  { id: 'reverb-hall',       label: 'School Hall',   description: 'Tight room reverb with short decay' },
  { id: 'reverb-cave',       label: 'Huge Cave',     description: 'Deep, spacious cave reverb' },
  { id: 'reverb-ridiculous', label: 'Ridiculous',    description: 'Absurd, endless echoey reverb' },
  { id: 'fade-in',           label: 'Fade In',       description: 'Ramp volume up at the start of selection' },
  { id: 'fade-out',          label: 'Fade Out',      description: 'Ramp volume down at the end of selection' },
  { id: 'gain',              label: 'Gain',          description: 'Adjust volume of selection in dB' },
  { id: 'lorem-5',           label: 'Lorem Ipsum',   description: 'Et dolore magna aliqua ut enim' },
]

async function detectBPM(buffer: AudioBuffer): Promise<number> {
  const sr = buffer.sampleRate
  // Cap analysis at 60s to keep it fast
  const maxSamples = Math.min(buffer.length, sr * 60)

  // Mix down to mono
  const mono = new Float32Array(maxSamples)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < maxSamples; i++) mono[i] += data[i]
  }
  for (let i = 0; i < maxSamples; i++) mono[i] /= buffer.numberOfChannels

  // Low-pass filter at 150 Hz to focus on kick/bass transients
  const monoBuf = new AudioBuffer({ numberOfChannels: 1, length: maxSamples, sampleRate: sr })
  monoBuf.getChannelData(0).set(mono)
  const offCtx = new OfflineAudioContext(1, maxSamples, sr)
  const src = offCtx.createBufferSource()
  src.buffer = monoBuf
  const lpf = offCtx.createBiquadFilter()
  lpf.type = 'lowpass'
  lpf.frequency.value = 150
  src.connect(lpf).connect(offCtx.destination)
  src.start(0)
  const filtered = await offCtx.startRendering()
  const signal = filtered.getChannelData(0)

  // Compute RMS energy per 10 ms frame
  const frameSize = Math.round(sr * 0.01)
  const numFrames = Math.floor(signal.length / frameSize)
  const energy = new Float32Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    let sum = 0
    for (let i = 0; i < frameSize; i++) { const s = signal[f * frameSize + i]; sum += s * s }
    energy[f] = Math.sqrt(sum / frameSize)
  }

  // Autocorrelation over lag range corresponding to 55–210 BPM
  const fps = sr / frameSize
  const minLag = Math.round(60 * fps / 210)
  const maxLag = Math.round(60 * fps / 55)
  let bestLag = minLag, bestCorr = -Infinity
  const n = energy.length
  for (let lag = minLag; lag <= Math.min(maxLag, Math.floor(n / 2)); lag++) {
    let corr = 0
    for (let i = 0; i < n - lag; i++) corr += energy[i] * energy[i + lag]
    corr /= (n - lag)
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag }
  }

  return Math.round(60 * fps / bestLag)
}

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const nch = buffer.numberOfChannels
  const sr = buffer.sampleRate
  const len = buffer.length
  const bytesPerSample = 2 // 16-bit PCM
  const dataSize = len * nch * bytesPerSample
  const ab = new ArrayBuffer(44 + dataSize)
  const view = new DataView(ab)

  const write = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)          // chunk size
  view.setUint16(20, 1, true)           // PCM
  view.setUint16(22, nch, true)
  view.setUint32(24, sr, true)
  view.setUint32(28, sr * nch * bytesPerSample, true) // byte rate
  view.setUint16(32, nch * bytesPerSample, true)      // block align
  view.setUint16(34, 16, true)          // bits per sample
  write(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < nch; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return ab
}

function isAudioFile(f: File) {
  return f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name)
}

function fmt(s: number) {
  if (!isFinite(s)) return '0:00.00'
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(2).padStart(5, '0')
  return `${m}:${sec}`
}

function snapshotBuffer(buf: AudioBuffer): HistoryEntry {
  const channels: Float32Array[] = []
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    channels.push(new Float32Array(buf.getChannelData(ch)))
  }
  return { channels, sampleRate: buf.sampleRate, numberOfChannels: buf.numberOfChannels, length: buf.length }
}

function restoreBuffer(entry: HistoryEntry): AudioBuffer {
  const buf = new AudioBuffer({
    numberOfChannels: entry.numberOfChannels,
    length: entry.length,
    sampleRate: entry.sampleRate,
  })
  for (let ch = 0; ch < entry.numberOfChannels; ch++) {
    buf.getChannelData(ch).set(entry.channels[ch])
  }
  return buf
}

function drawWaveform(canvas: HTMLCanvasElement, buffer: AudioBuffer, sel: Selection | null, playhead?: number) {
  const ctx = canvas.getContext('2d')!
  const { width, height } = canvas

  ctx.fillStyle = '#0d0f14'
  ctx.fillRect(0, 0, width, height)

  ctx.strokeStyle = 'rgba(255,255,255,0.04)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2)
  ctx.stroke()

  if (sel && sel.end > sel.start) {
    const sx = Math.round((sel.start / buffer.duration) * width)
    const ex = Math.round((sel.end / buffer.duration) * width)
    ctx.fillStyle = 'rgba(124, 58, 237, 0.18)'
    ctx.fillRect(sx, 0, ex - sx, height)
  }

  const data = buffer.getChannelData(0)
  const step = Math.max(1, Math.floor(data.length / width))
  const mid = height / 2
  const amp = mid * 0.88

  ctx.strokeStyle = '#7c3aed'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 0; x < width; x++) {
    let lo = 0, hi = 0
    for (let j = 0; j < step; j++) {
      const v = data[x * step + j] ?? 0
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    ctx.moveTo(x + 0.5, mid + lo * amp)
    ctx.lineTo(x + 0.5, mid + hi * amp)
  }
  ctx.stroke()

  if (sel && sel.end > sel.start) {
    const sx = Math.round((sel.start / buffer.duration) * width)
    const ex = Math.round((sel.end / buffer.duration) * width)
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, height)
    ctx.moveTo(ex + 0.5, 0); ctx.lineTo(ex + 0.5, height)
    ctx.stroke()
  }

  if (playhead !== undefined && playhead >= 0 && playhead <= buffer.duration) {
    const px = Math.round((playhead / buffer.duration) * width)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(px + 0.5, 0)
    ctx.lineTo(px + 0.5, height)
    ctx.stroke()
  }
}

export default function AudioEditor() {
  const [file, setFile] = useState<File | null>(null)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [decoding, setDecoding] = useState(false)
  const [sel, setSel] = useState<Selection | null>(null)
  const [canvasWidth, setCanvasWidth] = useState(900)
  const [drawTick, setDrawTick] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null)
  const [processing, setProcessing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [detectingBPM, setDetectingBPM] = useState(false)
  const [bpm, setBPM] = useState<number | null>(null)
  const [gainPrompt, setGainPrompt] = useState(false)
  const [gainValue, setGainValue] = useState('')
  const gainInputRef = useRef<HTMLInputElement>(null)
  const dragStart = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  
  const [isPlaying, setIsPlaying] = useState(false)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const playCtxRef = useRef<AudioContext | null>(null)
  const playStartTimeRef = useRef<number>(0)
  const playOffsetRef = useRef<number>(0)
  const rafRef = useRef<number>(0)

  const hasSel = sel !== null && sel.end - sel.start > 0.01
  const canUndo = history.length > 0

  const pushHistory = useCallback((buf: AudioBuffer) => {
    const snapshot = snapshotBuffer(buf)
    setHistory(h => [...h.slice(-30), snapshot])
  }, [])

  // Resize canvas to container width
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => setCanvasWidth(wrap.clientWidth))
    ro.observe(wrap)
    setCanvasWidth(wrap.clientWidth)
    return () => ro.disconnect()
  }, [buffer])

  const handleDetectBPM = useCallback(async () => {
    if (!buffer || detectingBPM) return
    setBPM(null)
    setDetectingBPM(true)
    try {
      const result = await detectBPM(buffer)
      setBPM(result)
    } finally {
      setDetectingBPM(false)
    }
  }, [buffer, detectingBPM])

  const handleExport = useCallback(async () => {
    if (!buffer || exporting) return
    setExporting(true)
    setExportedPath(null)
    try {
      const wav = encodeWav(buffer)
      const stem = file?.name.replace(/\.[^.]+$/, '') ?? 'audio'
      const result = await (window as any).api.saveAudioFile(`${stem}_edited.wav`, wav)
      if (result.saved) setExportedPath(result.filePath)
    } finally {
      setExporting(false)
    }
  }, [buffer, file, exporting])

  const handlePlay = useCallback(() => {
    if (!buffer) return
    if (isPlaying) {
      sourceRef.current?.stop()
      sourceRef.current = null
      cancelAnimationFrame(rafRef.current)
      playCtxRef.current?.close()
      playCtxRef.current = null
      setIsPlaying(false)
      setPlayhead(null)
      return
    }
    const ctx = new AudioContext()
    playCtxRef.current = ctx
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    const offset = hasSel ? sel!.start : 0
    const duration = hasSel ? sel!.end - sel!.start : undefined
    playOffsetRef.current = offset
    playStartTimeRef.current = ctx.currentTime
    src.start(0, offset, duration)
    sourceRef.current = src
    setIsPlaying(true)
    src.onended = () => {
      cancelAnimationFrame(rafRef.current)
      playCtxRef.current?.close()
      playCtxRef.current = null
      setIsPlaying(false)
      setPlayhead(null)
    }
    const tick = () => {
      if (!playCtxRef.current) return
      const pos = playOffsetRef.current + (playCtxRef.current.currentTime - playStartTimeRef.current)
      setPlayhead(pos)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [buffer, isPlaying, hasSel, sel])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sourceRef.current?.stop()
      cancelAnimationFrame(rafRef.current)
      playCtxRef.current?.close()
    }
  }, [])

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !buffer) return
    drawWaveform(canvas, buffer, sel, playhead ?? undefined)
  }, [buffer, sel, canvasWidth, drawTick, playhead])

  // Decode audio file
  useEffect(() => {
    if (!file) return
    let cancelled = false
    setDecoding(true)
    setSel(null)
    setHistory([])
    ;(async () => {
      const actx = new AudioContext()
      try {
        const ab = await file.arrayBuffer()
        const decoded = await actx.decodeAudioData(ab)
        if (!cancelled) setBuffer(decoded)
      } catch (e) {
        console.error('[AudioEditor] decode failed', e)
      } finally {
        if (!cancelled) setDecoding(false)
        actx.close()
      }
    })()
    return () => { cancelled = true }
  }, [file])

  // Auto-focus gain input
  useEffect(() => {
    if (gainPrompt) gainInputRef.current?.focus()
  }, [gainPrompt])

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctxMenu])

  const pixelToTime = (clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas || !buffer) return 0
    const rect = canvas.getBoundingClientRect()
    const ratio = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(buffer.duration, ratio * buffer.duration))
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (!buffer || e.button !== 0) return
    e.preventDefault()
    const t = pixelToTime(e.clientX)
    dragStart.current = t
    setSel({ start: t, end: t })
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (dragStart.current === null || !buffer) return
    const t = pixelToTime(e.clientX)
    const s = dragStart.current
    setSel({ start: Math.min(s, t), end: Math.max(s, t) })
  }

  const onMouseUp = () => { dragStart.current = null }

  const onContextMenu = (e: React.MouseEvent) => {
    if (!hasSel) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const f = Array.from(e.dataTransfer.files).find(isAudioFile)
    if (f) setFile(f)
  }

  const undo = useCallback(() => {
    if (!canUndo) return
    const prev = history[history.length - 1]
    setHistory(h => h.slice(0, -1))
    setBuffer(restoreBuffer(prev))
    setDrawTick(t => t + 1)
  }, [history, canUndo])

  const applyOp = useCallback(async (id: string) => {
    if (!buffer || !sel || !hasSel || processing) return
    const sr = buffer.sampleRate
    const from = Math.floor(sel.start * sr)
    const to = Math.ceil(sel.end * sr)

    pushHistory(buffer)

    if (id === 'silence') {
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        buffer.getChannelData(ch).fill(0, from, to)
      }
      setDrawTick(t => t + 1)

    } else if (id === 'reverse') {
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        buffer.getChannelData(ch).subarray(from, to).reverse()
      }
      setDrawTick(t => t + 1)

    } else if (id === 'gain') {
      // undo snapshot already pushed above — cancel it if user dismisses
      setHistory(h => h.slice(0, -1)) // will re-push on confirm
      setGainPrompt(true)
      setGainValue('')
      return

    } else if (id === 'fade-in') {
      const len = to - from
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch)
        for (let i = 0; i < len; i++) {
          // Square-root curve feels more natural than linear
          data[from + i] *= Math.sqrt(i / len)
        }
      }
      setDrawTick(t => t + 1)

    } else if (id === 'fade-out') {
      const len = to - from
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch)
        for (let i = 0; i < len; i++) {
          data[from + i] *= Math.sqrt(1 - i / len)
        }
      }
      setDrawTick(t => t + 1)

    } else if (id in REVERB_PRESETS) {
      const preset = REVERB_PRESETS[id]
      setProcessing(true)
      try {
        const nch = buffer.numberOfChannels
        const selLen = to - from
        const irLen = Math.ceil(preset.decayTime * sr)

        const irBuf = new AudioBuffer({ numberOfChannels: 1, length: irLen, sampleRate: sr })
        const d = irBuf.getChannelData(0)
        for (let i = 0; i < irLen; i++) {
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, preset.decayExp)
        }

        const selBuf = new AudioBuffer({ numberOfChannels: nch, length: selLen, sampleRate: sr })
        for (let ch = 0; ch < nch; ch++) {
          selBuf.getChannelData(ch).set(buffer.getChannelData(ch).subarray(from, to))
        }

        const offCtx = new OfflineAudioContext(nch, selLen + irLen, sr)
        const src = offCtx.createBufferSource()
        src.buffer = selBuf

        const conv = offCtx.createConvolver()
        conv.normalize = true
        conv.buffer = irBuf

        const dryGain = offCtx.createGain()
        dryGain.gain.value = preset.dry

        const wetGain = offCtx.createGain()
        wetGain.gain.value = preset.wet

        src.connect(dryGain).connect(offCtx.destination)
        src.connect(conv).connect(wetGain).connect(offCtx.destination)
        src.start(0)

        const rendered = await offCtx.startRendering()

        for (let ch = 0; ch < nch; ch++) {
          const src2 = rendered.getChannelData(ch)
          const dst = buffer.getChannelData(ch)
          let peak = 0
          for (let i = 0; i < selLen; i++) if (Math.abs(src2[i]) > peak) peak = Math.abs(src2[i])
          const scale = peak > 1.0 ? 1.0 / peak : 1.0
          for (let i = 0; i < selLen; i++) dst[from + i] = src2[i] * scale
        }

        setDrawTick(t => t + 1)
      } finally {
        setProcessing(false)
      }
    }
  }, [buffer, sel, hasSel, pushHistory, processing])

  const insertBefore = useCallback(() => {
    if (!buffer || !sel || !hasSel) return
    setCtxMenu(null)
    const sr = buffer.sampleRate
    const insertAt = Math.floor(sel.start * sr)
    const selLen = Math.ceil((sel.end - sel.start) * sr)

    pushHistory(buffer)

    const newBuf = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length: buffer.length + selLen,
      sampleRate: sr,
    })

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch)
      const dst = newBuf.getChannelData(ch)
      dst.set(src.subarray(0, insertAt), 0)
      // inserted region stays zeroed (silence)
      dst.set(src.subarray(insertAt), insertAt + selLen)
    }

    // Shift the selection right to sit over the same original audio
    setSel({ start: sel.start + (selLen / sr), end: sel.end + (selLen / sr) })
    setBuffer(newBuf)
  }, [buffer, sel, hasSel, pushHistory])

  const confirmGain = useCallback(() => {
    const db = parseFloat(gainValue)
    if (!buffer || !sel || !hasSel || isNaN(db)) { setGainPrompt(false); return }
    const sr = buffer.sampleRate
    const from = Math.floor(sel.start * sr)
    const to = Math.ceil(sel.end * sr)
    const linear = Math.pow(10, db / 20)
    pushHistory(buffer)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = from; i < to; i++) data[i] = Math.max(-1, Math.min(1, data[i] * linear))
    }
    setGainPrompt(false)
    setGainValue('')
    setDrawTick(t => t + 1)
  }, [buffer, sel, hasSel, gainValue, pushHistory])

  if (!file || (!buffer && !decoding)) {
    return (
      <div
        className={`ae-drop ${isDragOver ? 'ae-drop--over' : ''}`}
        onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <svg className="ae-drop__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <p className="ae-drop__label">Drop an audio file here</p>
        <p className="ae-drop__sub">MP3 · WAV · M4A · FLAC · OGG</p>
      </div>
    )
  }

  return (
    <div className="ae">
      <div className="ae__header">
        <span className="ae__filename">{file.name}</span>
        {buffer && <span className="ae__dur">{fmt(buffer.duration)}</span>}

        <button
          className={`ae__undo ${canUndo ? 'ae__undo--on' : ''}`}
          disabled={!canUndo}
          onClick={undo}
          title="Undo"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 8.5 C3.5 5 6.5 2.5 10 2.5 C13.5 2.5 16.5 5 16.5 8.5 C16.5 12 13.5 14.5 10 14.5 L6 14.5"/>
            <polyline points="3.5,11.5 6,14.5 3.5,17.5"/>
          </svg>
          <span>undo</span>
        </button>

        <button
          className="btn-ghost"
          onClick={() => { setFile(null); setBuffer(null); setSel(null); setHistory([]); setBPM(null); setExportedPath(null) }}
        >
          Clear
        </button>

        <button
          className="ae__bpm-btn"
          disabled={!buffer || detectingBPM}
          onClick={handleDetectBPM}
        >
          {detectingBPM ? 'Detecting…' : 'Detect BPM'}
        </button>

        {bpm !== null && (
          <span className="ae__bpm-result">{bpm} BPM</span>
        )}

        <button
          className="ae__export"
          disabled={!buffer || exporting}
          onClick={handleExport}
        >
          {exporting ? 'Saving…' : 'Export WAV'}
        </button>

        {exportedPath && (
          <button
            className="ae__saved-link"
            onClick={() => (window as any).api.showItemInFolder(exportedPath)}
          >
            Saved — Show in Finder
          </button>
        )}
      </div>

      <div className="ae__body">
        <div className="ae__main">
          <div className="ae__track" ref={wrapRef}>
            {decoding && (
              <div className="ae__decoding">
                <span className="transcribe-spinner" />
                <span>Decoding audio…</span>
              </div>
            )}
            {buffer && (
              <canvas
                ref={canvasRef}
                className="ae__canvas"
                width={canvasWidth}
                height={140}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onContextMenu={onContextMenu}
              />
            )}
          </div>

          {buffer && (
            <div className="ae__status">
              {hasSel ? (
                <div className="ae__sel-info">
                  <span className="meta-label">selection</span>
                  <span className="ae__sel-time">{fmt(sel!.start)}</span>
                  <span className="ae__sel-arrow">→</span>
                  <span className="ae__sel-time">{fmt(sel!.end)}</span>
                  <span className="ae__sel-dur">{fmt(sel!.end - sel!.start)}</span>
                  <button className="btn-ghost ae__sel-clear" onClick={() => setSel(null)}>
                    Clear selection
                  </button>
                </div>
              ) : (
                <p className="ae__hint">Click and drag to select · Right-click selection to insert</p>
              )}
            </div>
          )}
        </div>

        {buffer && (
          <aside className={`ae__ops ${hasSel && !processing ? 'ae__ops--active' : ''}`}>
            <p className="ae__ops-heading">Operations</p>
            {processing && (
              <div className="ae__ops-processing">
                <span className="transcribe-spinner" />
                <span>Processing…</span>
              </div>
            )}
            {gainPrompt ? (
              <div className="ae__gain-prompt">
                <p className="ae__gain-label">Gain (dB)</p>
                <p className="ae__gain-hint">e.g. 5 or −5</p>
                <div className="ae__gain-row">
                  <input
                    ref={gainInputRef}
                    className="ae__gain-input"
                    type="number"
                    step="0.5"
                    placeholder="0"
                    value={gainValue}
                    onChange={e => setGainValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') confirmGain()
                      if (e.key === 'Escape') { setGainPrompt(false); setGainValue('') }
                    }}
                  />
                  <button className="btn-primary ae__gain-apply" onClick={confirmGain}>Apply</button>
                </div>
                <button className="btn-ghost ae__gain-cancel" onClick={() => { setGainPrompt(false); setGainValue('') }}>Cancel</button>
              </div>
            ) : (
              <ul className="ae__ops-list">
                {OPERATIONS.map(op => (
                  <li key={op.id}>
                    <button
                      className={`ae__op ${hasSel && !processing ? 'ae__op--on' : ''}`}
                      disabled={!hasSel || processing}
                      onClick={() => applyOp(op.id)}
                    >
                      <span className="ae__op-label">{op.label}</span>
                      <span className="ae__op-desc">{op.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>
        <button className={`ae__play ${isPlaying ? 'ae__play--active' : ''}`} onClick={handlePlay} disabled={!buffer}>
          {isPlaying ? (
            <svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="currentColor"><path d="M6 4l11 6-11 6V4z"/></svg>
          )}
          {isPlaying ? 'Pause' : 'Play'}
        </button>
      {ctxMenu && (
        <ul
          className="ae__ctxmenu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={e => e.stopPropagation()}
        >
          <li>
            <button className="ae__ctxitem" onClick={insertBefore}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="8" x2="13" y2="8"/>
                <line x1="7" y1="4" x2="3" y2="8"/>
                <line x1="7" y1="12" x2="3" y2="8"/>
                <line x1="13" y1="4" x2="13" y2="12" strokeDasharray="2 2"/>
              </svg>
              Insert {hasSel ? fmt(sel!.end - sel!.start) : ''} silence before
            </button>
          </li>
          <li>
            <button className="ae__ctxitem" onClick={() => { setCtxMenu(null); applyOp('reverse') }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 5 C13 3 11 2 9 2 C6 2 3 4 3 8 C3 12 6 14 9 14 C11 14 13 13 13 11"/>
                <polyline points="11,3 13,5 11,7"/>
              </svg>
              Reverse selection
            </button>
          </li>
          <li>
            <button className="ae__ctxitem" onClick={() => { setCtxMenu(null); applyOp('reverb-hall') }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8 Q4 4 6 8 Q8 12 10 8 Q12 4 14 8"/>
                <path d="M2 11 Q4 8 6 11 Q8 14 10 11 Q12 8 14 11" opacity="0.4"/>
              </svg>
              Add reverb
            </button>
          </li>
          <li>
            <button className="ae__ctxitem" onClick={() => { setCtxMenu(null); applyOp('gain') }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2,12 5,7 8,9 11,4 14,6"/>
                <line x1="14" y1="3" x2="14" y2="7"/>
                <line x1="11" y1="3" x2="14" y2="3"/>
              </svg>
              Gain…
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}
