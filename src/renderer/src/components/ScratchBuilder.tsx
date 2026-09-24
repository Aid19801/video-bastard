import { useState, useRef, useEffect, useCallback } from 'react'

// Per-bar pattern. peakSlot: 0 = "A peak" (first of bar), 1 = "B peak" (second of bar)
// short: half a 1/16th length with an immediate fade-down
// 4 beats per bar. Hit 1 (beat 0) = peak A. Hit 3 (beat 2) = peak B.
// Hit 5 is just the next bar's beat 0 = peak A again. No ghosts.
const BAR_PATTERN: { step: number; peakSlot: 0 | 1; short: boolean }[] = [
  { step: 0, peakSlot: 0, short: false }, // beat 1 — peak A
  { step: 2, peakSlot: 1, short: false }, // beat 3 — peak B
]

// ─── Audio helpers ────────────────────────────────────────────────────────────

function isAudioFile(f: File) {
  return f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name)
}

async function decodeFile(file: File): Promise<AudioBuffer> {
  const actx = new AudioContext()
  const ab = await file.arrayBuffer()
  const decoded = await actx.decodeAudioData(ab)
  actx.close()
  return decoded
}

async function estimateBPM(buffer: AudioBuffer): Promise<number> {
  const sr = buffer.sampleRate
  const maxSamples = Math.min(buffer.length, sr * 60)
  const mono = new Float32Array(maxSamples)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < maxSamples; i++) mono[i] += data[i]
  }
  for (let i = 0; i < maxSamples; i++) mono[i] /= buffer.numberOfChannels

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

  const frameSize = Math.round(sr * 0.01)
  const numFrames = Math.floor(signal.length / frameSize)
  const energy = new Float32Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    let sum = 0
    for (let i = 0; i < frameSize; i++) { const s = signal[f * frameSize + i]; sum += s * s }
    energy[f] = Math.sqrt(sum / frameSize)
  }

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

// Returns peak times in chronological order, filtered to above-threshold energy.
// Smaller min-gap and lower threshold so we get enough distinct hits to cycle through.
function findSpeechPeaks(buffer: AudioBuffer): number[] {
  const sr = buffer.sampleRate
  const frameSize = Math.round(sr * 0.01) // 10 ms frames
  const mono = new Float32Array(buffer.length)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < buffer.length; i++) mono[i] += data[i]
  }
  for (let i = 0; i < mono.length; i++) mono[i] /= buffer.numberOfChannels

  const numFrames = Math.floor(buffer.length / frameSize)
  const energy = new Float32Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    let sum = 0
    for (let i = 0; i < frameSize; i++) { const s = mono[f * frameSize + i] ?? 0; sum += s * s }
    energy[f] = Math.sqrt(sum / frameSize)
  }

  const maxE = Math.max(...energy)
  const threshold = maxE * 0.20           // 20% — catch more of the speech
  const minGap = Math.round(0.10 / (frameSize / sr)) // 100 ms min separation
  const peaks: number[] = []
  let lastPeak = -minGap

  for (let f = 1; f < numFrames - 1; f++) {
    if (
      energy[f] > threshold &&
      energy[f] > energy[f - 1] &&
      energy[f] >= energy[f + 1] &&
      f - lastPeak >= minGap
    ) {
      peaks.push((f * frameSize) / sr)
      lastPeak = f
    }
  }
  return peaks // chronological — preserves the natural flow of the speech
}

function placeSample(
  offCtx: OfflineAudioContext,
  speech: AudioBuffer,
  peakTime: number,
  gridPos: number,
  segLen: number,
  gainVal: number
) {
  const sr = offCtx.sampleRate
  const peakSample = Math.floor(peakTime * sr)
  const from = Math.max(0, peakSample)
  const to = Math.min(speech.length, from + segLen)
  const len = to - from
  if (len <= 0) return

  const nch = Math.min(speech.numberOfChannels, offCtx.length > 0 ? speech.numberOfChannels : 1)
  const segBuf = new AudioBuffer({ numberOfChannels: nch, length: len, sampleRate: sr })
  for (let ch = 0; ch < nch; ch++) {
    const dst = segBuf.getChannelData(ch)
    dst.set(speech.getChannelData(ch).subarray(from, to))
    // 5 ms pop-prevention fade in
    const fi = Math.min(Math.round(0.005 * sr), len)
    for (let j = 0; j < fi; j++) dst[j] *= j / fi
    // fade out over last 30% of clip
    const fo = Math.min(Math.round(len * 0.30), len)
    for (let j = 0; j < fo; j++) dst[len - 1 - j] *= j / fo
  }

  const src = offCtx.createBufferSource()
  src.buffer = segBuf
  const gain = offCtx.createGain()
  gain.gain.value = gainVal
  src.connect(gain).connect(offCtx.destination)
  src.start(gridPos)
}

async function buildScratch(
  beat: AudioBuffer,
  speech: AudioBuffer,
  bpm: number
): Promise<AudioBuffer> {
  const sr = beat.sampleRate

  if (speech.sampleRate !== sr) {
    const rs = new OfflineAudioContext(speech.numberOfChannels, Math.ceil(speech.duration * sr), sr)
    const s = rs.createBufferSource()
    s.buffer = speech
    s.connect(rs.destination)
    s.start(0)
    speech = await rs.startRendering()
  }

  const peaks = findSpeechPeaks(speech)
  if (peaks.length === 0) return beat

  const beatDur = 60 / bpm              // one quarter-note beat duration
  const barDuration = beatDur * 4       // 4 beats per bar

  // Full hit = 90% of a beat so it doesn't bleed into the next hit
  const fullLen  = Math.round(beatDur * 0.90 * sr)
  const shortLen = Math.round(beatDur * 0.45 * sr)

  const offCtx = new OfflineAudioContext(beat.numberOfChannels, beat.length, sr)

  const beatSrc = offCtx.createBufferSource()
  beatSrc.buffer = beat
  beatSrc.connect(offCtx.destination)
  beatSrc.start(0)

  // Each bar advances by 2 peaks (A and B). Cycle if we run out.
  const totalBars = Math.ceil(beat.duration / barDuration)
  for (let bar = 0; bar < totalBars; bar++) {
    const barBase = bar * 2
    const peakA = peaks[barBase       % peaks.length]
    const peakB = peaks[(barBase + 1) % peaks.length]

    for (const { step, peakSlot, short } of BAR_PATTERN) {
      const gridPos = bar * barDuration + step * beatDur
      if (gridPos >= beat.duration) continue

      const peakTime = peakSlot === 0 ? peakA : peakB
      const segLen   = short ? shortLen : fullLen
      // Short ghosts fade fast and sit slightly quieter
      const gainVal  = short ? 0.65 : 0.88

      placeSample(offCtx, speech, peakTime, gridPos, segLen, gainVal)

    }
  }

  return offCtx.startRendering()
}

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const nch = buffer.numberOfChannels
  const sr = buffer.sampleRate
  const len = buffer.length
  const dataSize = len * nch * 2
  const ab = new ArrayBuffer(44 + dataSize)
  const v = new DataView(ab)
  const w = (offset: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, nch, true); v.setUint32(24, sr, true)
  v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < nch; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return ab
}

// ─── Waveform canvas ──────────────────────────────────────────────────────────

function WaveCanvas({ buffer, color = '#7c3aed' }: { buffer: AudioBuffer; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => setWidth(wrap.clientWidth))
    ro.observe(wrap)
    setWidth(wrap.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const { width: w, height: h } = canvas
    ctx.fillStyle = '#0d0f14'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke()
    const data = buffer.getChannelData(0)
    const step = Math.max(1, Math.floor(data.length / w))
    const mid = h / 2, amp = mid * 0.88
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath()
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0
      for (let j = 0; j < step; j++) { const v = data[x * step + j] ?? 0; if (v < lo) lo = v; if (v > hi) hi = v }
      ctx.moveTo(x + 0.5, mid + lo * amp); ctx.lineTo(x + 0.5, mid + hi * amp)
    }
    ctx.stroke()
  }, [buffer, width, color])

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas ref={ref} className="sb__wave" width={width} height={80} />
    </div>
  )
}

// ─── Drop panel ───────────────────────────────────────────────────────────────

function DropPanel({
  label, sublabel, file, buffer, onFile,
  extra
}: {
  label: string
  sublabel: string
  file: File | null
  buffer: AudioBuffer | null
  onFile: (f: File) => void
  extra?: React.ReactNode
}) {
  const [over, setOver] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false)
    const f = Array.from(e.dataTransfer.files).find(isAudioFile)
    if (f) onFile(f)
  }

  if (!file || !buffer) {
    return (
      <div
        className={`sb__drop ${over ? 'sb__drop--over' : ''}`}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
      >
        <svg className="sb__drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <p className="sb__drop-label">{label}</p>
        <p className="sb__drop-sub">{sublabel}</p>
      </div>
    )
  }

  return (
    <div className="sb__panel-loaded"
      onDragOver={e => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
    >
      <div className="sb__panel-header">
        <span className="sb__panel-name">{file.name}</span>
        <button className="btn-ghost" onClick={() => onFile(null as any)}>Clear</button>
      </div>
      <WaveCanvas buffer={buffer} />
      {extra}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ScratchBuilder() {
  const [beatFile, setBeatFile] = useState<File | null>(null)
  const [beatBuf, setBeatBuf] = useState<AudioBuffer | null>(null)
  const [beatBPM, setBeatBPM] = useState<number | null>(null)
  const [detectingBPM, setDetectingBPM] = useState(false)

  const [speechFile, setSpeechFile] = useState<File | null>(null)
  const [speechBuf, setSpeechBuf] = useState<AudioBuffer | null>(null)

  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState<AudioBuffer | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)

  // Playback refs for result preview
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const playCtxRef = useRef<AudioContext | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  // Load beat
  const handleBeatFile = useCallback(async (f: File | null) => {
    setBeatFile(f); setBeatBuf(null); setBeatBPM(null); setResult(null)
    if (!f) return
    setDetectingBPM(true)
    try {
      const buf = await decodeFile(f)
      setBeatBuf(buf)
      const bpm = await estimateBPM(buf)
      setBeatBPM(bpm)
    } finally {
      setDetectingBPM(false)
    }
  }, [])

  // Load speech
  const handleSpeechFile = useCallback(async (f: File | null) => {
    setSpeechFile(f); setSpeechBuf(null); setResult(null)
    if (!f) return
    const buf = await decodeFile(f)
    setSpeechBuf(buf)
  }, [])

  // Process
  const handleProcess = useCallback(async () => {
    if (!beatBuf || !speechBuf || !beatBPM || processing) return
    setProcessing(true)
    setResult(null)
    setExportedPath(null)
    try {
      const out = await buildScratch(beatBuf, speechBuf, beatBPM)
      setResult(out)
    } finally {
      setProcessing(false)
    }
  }, [beatBuf, speechBuf, beatBPM, processing])

  // Preview play/stop
  const handlePlay = useCallback(() => {
    if (!result) return
    if (isPlaying) {
      sourceRef.current?.stop()
      sourceRef.current = null
      playCtxRef.current?.close()
      playCtxRef.current = null
      setIsPlaying(false)
      return
    }
    const ctx = new AudioContext()
    playCtxRef.current = ctx
    const src = ctx.createBufferSource()
    src.buffer = result
    src.connect(ctx.destination)
    src.start(0)
    sourceRef.current = src
    setIsPlaying(true)
    src.onended = () => {
      playCtxRef.current?.close()
      playCtxRef.current = null
      setIsPlaying(false)
    }
  }, [result, isPlaying])

  useEffect(() => {
    return () => {
      sourceRef.current?.stop()
      playCtxRef.current?.close()
    }
  }, [])

  // Export
  const handleExport = useCallback(async () => {
    if (!result || exporting) return
    setExporting(true)
    try {
      const wav = encodeWav(result)
      const stem = beatFile?.name.replace(/\.[^.]+$/, '') ?? 'scratch'
      const res = await (window as any).api.saveAudioFile(`${stem}_scratch.wav`, wav)
      if (res.saved) setExportedPath(res.filePath)
    } finally {
      setExporting(false)
    }
  }, [result, beatFile, exporting])

  const canProcess = !!beatBuf && !!speechBuf && !!beatBPM && !processing

  return (
    <div className="sb">
      <div className="sb__tracks">
        {/* Beat */}
        <div className="sb__track-col">
          <p className="sb__col-label">Beat track</p>
          <DropPanel
            label="Drop your beat here"
            sublabel="MP3 · WAV · M4A · FLAC"
            file={beatFile}
            buffer={beatBuf}
            onFile={handleBeatFile}
            extra={
              <div className="sb__bpm-row">
                {detectingBPM && <span className="sb__bpm-detecting"><span className="transcribe-spinner" /> Detecting BPM…</span>}
                {beatBPM !== null && !detectingBPM && (
                  <>
                    <span className="sb__bpm-val">{beatBPM} BPM</span>
                    <button
                      className="btn-ghost sb__bpm-edit"
                      onClick={() => {
                        const v = prompt('Override BPM:', String(beatBPM))
                        const n = v ? parseInt(v, 10) : NaN
                        if (!isNaN(n) && n > 0) setBeatBPM(n)
                      }}
                    >
                      Edit
                    </button>
                  </>
                )}
              </div>
            }
          />
        </div>

        {/* Speech */}
        <div className="sb__track-col">
          <p className="sb__col-label">Edited audio</p>
          <DropPanel
            label="Drop your edited audio here"
            sublabel="The speech peaks will be sampled"
            file={speechFile}
            buffer={speechBuf}
            onFile={handleSpeechFile}
            extra={null}
          />
        </div>
      </div>

      {/* Controls */}
      <div className="sb__controls">
        <div className="sb__pattern-info">
          <span className="sb__pattern-label">Per bar (4 beats)</span>
          {Array.from({ length: 4 }, (_, i) => {
            const hit = BAR_PATTERN.find(p => p.step === i)
            const label = hit ? (hit.peakSlot === 0 ? 'A' : 'B') : String(i + 1)
            return (
              <span
                key={i}
                className={`sb__pattern-step${hit ? ' sb__pattern-step--on' : ''}`}
                title={hit ? `peak ${hit.peakSlot === 0 ? 'A' : 'B'}` : 'silent'}
              >
                {label}
              </span>
            )
          })}
          <span className="sb__pattern-hint">A/B cycle through speech peaks · repeats each bar</span>
        </div>

        <button
          className="sb__process-btn"
          disabled={!canProcess}
          onClick={handleProcess}
        >
          {processing ? (
            <><span className="transcribe-spinner" /> Processing…</>
          ) : (
            'Process Scratch'
          )}
        </button>
      </div>

      {/* Result */}
      {result && (
        <div className="sb__result">
          <p className="sb__result-label">Result</p>
          <WaveCanvas buffer={result} color="#22c55e" />
          <div className="sb__result-actions">
            <button className={`ae__play ${isPlaying ? 'ae__play--active' : ''}`} onClick={handlePlay}>
              {isPlaying
                ? <><svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></svg> Pause</>
                : <><svg viewBox="0 0 20 20" fill="currentColor"><path d="M6 4l11 6-11 6V4z"/></svg> Play</>
              }
            </button>

            <button className="ae__export" disabled={exporting} onClick={handleExport}>
              {exporting ? 'Saving…' : 'Export WAV'}
            </button>

            {exportedPath && (
              <button className="ae__saved-link" onClick={() => (window as any).api.showItemInFolder(exportedPath)}>
                Saved — Show in Finder
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
