import { useState, useCallback, useEffect, useRef } from 'react'
import { removeBackground } from '@imgly/background-removal'

// The preview frame is a fixed 1280×720 (16:9) stage. Loaded images keep their
// own aspect ratio (object-fit: contain) so nothing is stretched or squashed.
const FRAME_W = 1280
const FRAME_H = 720

// Cap the working resolution so segmentation stays snappy.
const MAX_SIDE = 1280

// Cutout look
const BORDER_COLOR = '#ffffff'
const CONTRAST_BOOST = 0.4 // subject contrast rises by this factor (×1.4 at full)
const FIZZ = 46 // grain amount for the black & white background
const SLIDE_FRAC = 0.12 // how far (× height) the image slides up on entry
// Reverse the direction the border traces around the outline.
const BORDER_REVERSE = false
const FPS = 30

// Cutout animation, in ordered phases. Boundaries are fractions of the clip
// length so the shape holds when the Length slider changes: the border draws
// itself through the first half; the first flash lands around the midpoint.
//   1. slide up      [0,              F_SLIDE_END]
//   2. border draws  [F_BORDER_START, F_BORDER_END]
//   3. first flash   (peak at F_FLASH_MID) — further flashes follow FLASH_GAP apart
//   4. black & white [F_BW_START,     F_BW_END]
//   5. subject moves under the flashes (see the keyframe builder)
const F_SLIDE_END = 0.11
const F_BORDER_START = 0.11
const F_BORDER_END = 0.48
const F_FLASH_MID = 0.49
const F_FLASH_HALF = 0.03
const F_BW_START = 0.48
const F_BW_END = 0.56

// Flash-driven subject motion.
const FLASH_GAP = 0.3 // seconds between successive flashes
const SLOW_ZOOM = 1.2 // 1 flash: gentle zoom-in to this scale
const MODEST_ZOOM = 1.1 // 2/3 flashes: modest zoom between flash 1 and 2
const ZOOM_IN = 1.25 // after flash 2: +0.25 scale
const ROT_LEFT = -7 // after flash 2: rotate left 7°
// After flash 3: stay a bit zoomed, swing right, and shift left — keeps the
// "cutout being moved around" feeling instead of settling back.
const END_ZOOM = 1.15
const ROT_END = 9 // rotate right ~9°
const END_SHIFT_X = -10 // move 10px to the left

// VHS 1 effect — a CRT broadcast: content beats (colour / B&W / muted colour,
// cycling) interrupted by `statics` bursts of static. The beats run at a fixed
// pace; extending the length just lets the final beat carry on.
const VHS_FPS = 24
const VHS_CONTENT_LEN = 1.3 // seconds per non-final content beat
const VHS_STATIC_DUR = 0.2 // seconds per static burst
const VHS_DUR_MIN = 2
const VHS_DUR_MAX = 10
const VHS_DUR_DEFAULT = 5
const STATICS_MIN = 1
const STATICS_MAX = 4
const STATICS_DEFAULT = 2

// Parallax effect — two ↗ and two ↖ diagonals cut the image into a 3×3 diamond
// grid: centre diamond, four edge sections, four corner sections. The centre
// pans with a slow-then-fast slide-in, the edges pan steadily/slower, the
// corners stay still. Motion ping-pongs on a fixed clock, so a longer Length
// just adds more slide-out/slide-in cycles rather than slowing each one.
const PAR_FPS = 30
const PAR_DUR_MIN = 2
const PAR_DUR_MAX = 12
const PAR_DUR_DEFAULT = 6
const PAR_GAP = 0.26 // half-width of the centre bands in (u+v, u−v) space
const PAR_OVERSCAN = 1.16 // draw the image larger so panning never bares an edge
const PAR_ZOOM_CENTER = 0.14 // centre pushes inward (zoom) by up to this fraction
const PAR_ZOOM_EDGE = 0.06 // edges push inward a little, steadily
const PAR_FLASH_HALF = 0.15 // opening white flash falls off by here (s)
const PAR_DRAW_START = 0.12
const PAR_DRAW_END = 0.82 // slices finish drawing
const PAR_PAR_START = 0.85 // parallax motion begins
const PAR_CENTER_PERIOD = 3.0
const PAR_CENTER_IN = 1.3 // seconds of the centre period spent sliding in
const PAR_EDGE_PERIOD = 4.4

// Psychedelic effect — segment the object of focus, then stretch it outward on a
// smooth, ever-accelerating warp until it is grotesque. The subject warps at full
// rate, the background at PSY_BG_RATE of it, so the two smear apart.
const PSY_FPS = 24
const PSY_MAX_SIDE = 900 // per-pixel warp: keep the working canvas modest
const PSY_DUR_MIN = 3
const PSY_DUR_MAX = 60
const PSY_DUR_DEFAULT = 10
const PSY_INT_MIN = 0.4
const PSY_INT_MAX = 4
const PSY_INT_DEFAULT = 1
// Stretch is driven by elapsed seconds, never by how long the clip is, so two
// clips look identical at the same timestamp and a long one simply gets further.
const PSY_EASE = 1.7 // seconds^EASE while ramping — barely moves at first, then runs
const PSY_RAMP_SECONDS = 10 // when the calibrated "head at the frame edge" stretch lands
// Strength is picked from the subject's own size so framing doesn't change the
// look: the head ends up spilling past the frame edges, and because the hips are
// both wider to start with and stretched harder, they end up far past it.
const PSY_HEAD_COVER = 1.05 // the head ends this × the frame width
const PSY_TARGET_COVER = 1.55 // …or, with no head found, the widest row does
const PSY_K_MIN = 1.5
const PSY_K_MAX = 25
// Everything only ever travels outward, and the further out it starts the faster
// it goes: this is the share of the push that is uniform, the rest grows with
// distance from the subject's centre. So the eyes ease apart, the sides of the
// head go noticeably faster, the shoulders faster still.
const PSY_RADIAL_LIN = 0.35
const PSY_BG_RATE = 0.32 // background stretches at this fraction of the subject's rate
const PSY_WIDTH_POW = 1 // wider rows stretch more than narrow ones
const PSY_ROW_FLOOR = 0.3 // stretch still applied on rows the subject doesn't occupy
const PSY_EYE_BUMP = 0.45 // extra sideways gain across the eye band
const PSY_HIP_BUMP = 0.35 // extra sideways gain across the widest (hip/shoulder) band
const PSY_SAG = 0.34 // droop at the outer edges, × subject height
const PSY_SAG_POW = 1.4 // droop ramps in towards the sides
const PSY_ABERRATION = 0.012 // R/B channel separation at full stretch, × frame width
const PSY_HUE = 90 // degrees of hue rotation by the end
const PSY_SAT = 1.5 // saturation by the end

// Slider bounds / defaults
const BORDER_MIN = 3
const BORDER_MAX = 20
const BORDER_DEFAULT = 10
const DUR_MIN = 0.5
const DUR_MAX = 4
const DUR_DEFAULT = 2
const FLASHES_MIN = 1
const FLASHES_MAX = 3
const FLASHES_DEFAULT = 1

interface CutoutOpts {
  borderPx: number
  duration: number
  flashes: number
}

interface VhsOpts {
  duration: number
  statics: number
}

interface ParallaxOpts {
  duration: number
}

interface PsychedelicOpts {
  duration: number
  intensity: number
}

interface Keyframe {
  t: number
  scale: number
  rot: number
  dx?: number // screen-space x shift in px (default 0)
  dy?: number // screen-space y shift in px (default 0)
}

interface Effect {
  id: string
  name: string
  implemented?: boolean
}

// First effect is the real one. The rest are placeholders for now.
const EFFECTS: Effect[] = [
  { id: 'cutout', name: 'Cutout', implemented: true },
  { id: 'vhs1', name: 'VHS 1', implemented: true },
  { id: 'parallax', name: 'Parallax', implemented: true },
  { id: 'psychedelic', name: 'Psychedelic', implemented: true },
  { id: 'lorem-4', name: 'Consectetur' },
  { id: 'lorem-5', name: 'Adipiscing' },
  { id: 'lorem-6', name: 'Tempor' },
]

const IMAGE_EXT = /\.(jpe?g|png|gif)$/i

function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') || IMAGE_EXT.test(f.name)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load that image'))
    img.src = src
  })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read that file'))
    reader.readAsDataURL(file)
  })
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3)
const smoothstep = (x: number): number => x * x * (3 - 2 * x)

// Interpolate the subject's scale/rotation/shift through an ordered keyframe list.
function interpKeyframes(
  kfs: Keyframe[],
  t: number
): { scale: number; rot: number; dx: number; dy: number } {
  const pick = (k: Keyframe) => ({ scale: k.scale, rot: k.rot, dx: k.dx ?? 0, dy: k.dy ?? 0 })
  if (t <= kfs[0].t) return pick(kfs[0])
  for (let i = 1; i < kfs.length; i++) {
    if (t <= kfs[i].t) {
      const a = kfs[i - 1]
      const b = kfs[i]
      const span = b.t - a.t
      const u = span > 0 ? smoothstep(clamp01((t - a.t) / span)) : 1
      return {
        scale: a.scale + (b.scale - a.scale) * u,
        rot: a.rot + (b.rot - a.rot) * u,
        dx: (a.dx ?? 0) + ((b.dx ?? 0) - (a.dx ?? 0)) * u,
        dy: (a.dy ?? 0) + ((b.dy ?? 0) - (a.dy ?? 0)) * u,
      }
    }
  }
  return pick(kfs[kfs.length - 1])
}

// Build the subject motion keyframes for a given flash count. Snap changes are
// concentrated in a short window at each flash, so they land while the white
// frame hides the cut — the object reads as a cutout being shuffled in place.
function buildKeyframes(flashes: number, duration: number, flashTimes: number[]): Keyframe[] {
  const tF0 = flashTimes[0]
  const gap = flashTimes.length > 1 ? flashTimes[1] - flashTimes[0] : FLASH_GAP
  const eps = Math.min(0.03, gap * 0.25)
  const kfs: Keyframe[] = [
    { t: 0, scale: 1, rot: 0 },
    { t: tF0, scale: 1, rot: 0 },
  ]
  if (flashes <= 1) {
    kfs.push({ t: duration, scale: SLOW_ZOOM, rot: 0 })
    return kfs
  }
  const tF1 = flashTimes[1]
  kfs.push({ t: Math.max(tF0 + eps, tF1 - eps), scale: MODEST_ZOOM, rot: 0 })
  kfs.push({ t: tF1, scale: ZOOM_IN, rot: ROT_LEFT })
  if (flashes === 2) {
    kfs.push({ t: duration, scale: ZOOM_IN, rot: ROT_LEFT })
    return kfs
  }
  const tF2 = flashTimes[2]
  kfs.push({ t: Math.max(tF1 + eps, tF2 - eps), scale: ZOOM_IN, rot: ROT_LEFT })
  kfs.push({ t: tF2, scale: END_ZOOM, rot: ROT_END, dx: END_SHIFT_X })
  kfs.push({ t: duration, scale: END_ZOOM, rot: ROT_END, dx: END_SHIFT_X })
  return kfs
}

// Moore-neighbour boundary trace of a binary mask → the outer contour as an
// ordered list of edge pixels. Runs once per image, so clarity over speed.
function traceContour(mask: Uint8Array, w: number, h: number): Array<[number, number]> {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1

  // First foreground pixel (top-to-bottom, left-to-right) is always on the outer contour.
  let sx = -1
  let sy = -1
  for (let y = 0; y < h && sy < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        sx = x
        sy = y
        break
      }
    }
  }
  if (sx < 0) return []

  // 8-neighbourhood, clockwise, indexed so 4 = West.
  const d: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ]
  const contour: Array<[number, number]> = []
  let px = sx
  let py = sy
  let prevDir = 4 // we entered from the West (background on the left)
  const maxSteps = w * h * 4
  for (let step = 0; step < maxSteps; step++) {
    contour.push([px, py])
    let nextIdx = -1
    for (let k = 1; k <= 8; k++) {
      const dir = (prevDir + k) % 8
      if (at(px + d[dir][0], py + d[dir][1])) {
        nextIdx = dir
        break
      }
    }
    if (nextIdx < 0) break // isolated pixel
    prevDir = (nextIdx + 4) % 8 // background neighbour for the next step
    px += d[nextIdx][0]
    py += d[nextIdx][1]
    if (px === sx && py === sy) break
  }
  return contour
}

// ─── Cutout ───────────────────────────────────────────────────────────────
// Segments the object of focus, then renders the effect as an animation. To
// stay fast across many frames, the colour and black-&-white plates are built
// once up front; each frame is just cheap canvas compositing (crossfade for the
// desaturation, an angular clip for the border draw, a transform for the zoom).
// Returns base64 JPEG frames (no data-URL prefix) ready for MP4 encoding.
async function generateCutoutFrames(src: string, opts: CutoutOpts): Promise<string[]> {
  const { borderPx, duration, flashes } = opts
  const frameCount = Math.max(2, Math.round(FPS * duration))

  const img = await loadImage(src)
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))

  // Base colour image.
  const [base, bctx] = makeCanvas(w, h)
  bctx.drawImage(img, 0, 0, w, h)

  // Subject on transparent background (its alpha channel is the mask).
  const fgBlob = await removeBackground(src, { output: { format: 'image/png' } })
  const fgUrl = URL.createObjectURL(fgBlob)
  let fg: HTMLImageElement
  try {
    fg = await loadImage(fgUrl)
  } finally {
    URL.revokeObjectURL(fgUrl)
  }

  const [, mctx] = makeCanvas(w, h)
  mctx.drawImage(fg, 0, 0, w, h)
  const maskAlpha = mctx.getImageData(0, 0, w, h).data

  // Subject centroid — the pivot for the border sweep and the zoom.
  let sx = 0
  let sy = 0
  let sw = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = maskAlpha[(y * w + x) * 4 + 3]
      if (a > 20) {
        sx += x * a
        sy += y * a
        sw += a
      }
    }
  }
  const cx = sw > 0 ? sx / sw : w / 2
  const cy = sw > 0 ? sy / sw : h / 2

  // Colour subject (masked, transparent elsewhere).
  const [subjColor, sccx] = makeCanvas(w, h)
  sccx.drawImage(base, 0, 0)
  sccx.globalCompositeOperation = 'destination-in'
  sccx.drawImage(fg, 0, 0, w, h)

  // Black-&-white grainy background plate (full frame, baked once → stays static
  // through the zoom).
  const [bwBg, bwctx] = makeCanvas(w, h)
  const bwImg = bctx.getImageData(0, 0, w, h)
  const bd = bwImg.data
  for (let j = 0; j < bd.length; j += 4) {
    const lum = 0.299 * bd[j] + 0.587 * bd[j + 1] + 0.114 * bd[j + 2]
    const v = clamp255(lum + (Math.random() - 0.5) * FIZZ)
    bd[j] = bd[j + 1] = bd[j + 2] = v
  }
  bwctx.putImageData(bwImg, 0, 0)

  // Contrast-boosted B&W subject (masked).
  const [subjBw, sbctx] = makeCanvas(w, h)
  const cImg = bctx.getImageData(0, 0, w, h)
  const cd = cImg.data
  const cf = 1 + CONTRAST_BOOST
  for (let j = 0; j < cd.length; j += 4) {
    cd[j] = clamp255((cd[j] - 128) * cf + 128)
    cd[j + 1] = clamp255((cd[j + 1] - 128) * cf + 128)
    cd[j + 2] = clamp255((cd[j + 2] - 128) * cf + 128)
  }
  sbctx.putImageData(cImg, 0, 0)
  sbctx.globalCompositeOperation = 'destination-in'
  sbctx.drawImage(fg, 0, 0, w, h)

  // Border ring: a solid silhouette dilated by stamping it around a circle, with
  // the subject punched back out so only the rim remains.
  const [sil, sictx] = makeCanvas(w, h)
  sictx.drawImage(fg, 0, 0, w, h)
  sictx.globalCompositeOperation = 'source-in'
  sictx.fillStyle = BORDER_COLOR
  sictx.fillRect(0, 0, w, h)

  const [rim, rctx] = makeCanvas(w, h)
  const steps = 40
  for (let a = 0; a < steps; a++) {
    const ang = (a / steps) * Math.PI * 2
    rctx.drawImage(sil, Math.cos(ang) * borderPx, Math.sin(ang) * borderPx)
  }
  rctx.globalCompositeOperation = 'destination-out'
  rctx.drawImage(fg, 0, 0, w, h)

  // Trace the subject outline and anchor the draw start at its bottom-centre:
  // the lowest row the subject occupies, at the horizontal middle of that row.
  // The border then reveals as a pen tracing that outline (SVG line-draw), so it
  // truly begins at the object's bottom rather than fanning out from the middle.
  const mask = new Uint8Array(w * h)
  for (let k = 0; k < w * h; k++) mask[k] = maskAlpha[k * 4 + 3] > 128 ? 1 : 0

  let maxY = -1
  for (let y = h - 1; y >= 0 && maxY < 0; y--) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        maxY = y
        break
      }
    }
  }
  let axSum = 0
  let axCnt = 0
  for (let y = Math.max(0, maxY - 2); y <= maxY && maxY >= 0; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        axSum += x
        axCnt++
      }
    }
  }
  const anchorX = axCnt ? axSum / axCnt : w / 2
  const anchorY = maxY >= 0 ? maxY : h - 1

  const contour = traceContour(mask, w, h)
  let borderPath: Path2D | null = null
  let pathLen = 0
  if (contour.length > 1) {
    if (BORDER_REVERSE) contour.reverse()
    // Rotate so the outline starts at the vertex nearest the bottom-centre anchor.
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < contour.length; i++) {
      const dx = contour[i][0] - anchorX
      const dy = contour[i][1] - anchorY
      const dd = dx * dx + dy * dy
      if (dd < bd) {
        bd = dd
        bi = i
      }
    }
    const ordered = contour.slice(bi).concat(contour.slice(0, bi))
    borderPath = new Path2D()
    borderPath.moveTo(ordered[0][0], ordered[0][1])
    for (let i = 1; i < ordered.length; i++) {
      borderPath.lineTo(ordered[i][0], ordered[i][1])
      pathLen += Math.hypot(ordered[i][0] - ordered[i - 1][0], ordered[i][1] - ordered[i - 1][1])
    }
    borderPath.closePath()
    const n = ordered.length
    pathLen += Math.hypot(ordered[0][0] - ordered[n - 1][0], ordered[0][1] - ordered[n - 1][1])
  }
  const [borderLayer, blctx] = makeCanvas(w, h)

  // Phase times in seconds.
  const tSlideEnd = F_SLIDE_END * duration
  const tBorderStart = F_BORDER_START * duration
  const tBorderEnd = F_BORDER_END * duration
  const flashHalf = F_FLASH_HALF * duration
  const tBwStart = F_BW_START * duration
  const tBwEnd = F_BW_END * duration

  // Flash times: the first near the midpoint, the rest FLASH_GAP apart — but
  // compressed if a short clip can't fit them all before the end.
  const tFlash0 = F_FLASH_MID * duration
  const gap = Math.max(0.02, Math.min(FLASH_GAP, (duration * 0.96 - tFlash0) / Math.max(1, flashes - 1)))
  const flashTimes = Array.from({ length: flashes }, (_, k) => tFlash0 + k * gap)
  const keyframes = buildKeyframes(flashes, duration, flashTimes)

  const [content, cctx] = makeCanvas(w, h)
  const [out, octx] = makeCanvas(w, h)

  const frames: string[] = []
  for (let i = 0; i < frameCount; i++) {
    const t = (duration * i) / (frameCount - 1)

    const slideP = easeOut(clamp01(t / tSlideEnd))
    const yOff = (1 - slideP) * h * SLIDE_FRAC
    const borderP = clamp01((t - tBorderStart) / (tBorderEnd - tBorderStart))
    const p = clamp01((t - tBwStart) / (tBwEnd - tBwStart))
    const { scale: zoomScale, rot, dx, dy } = interpKeyframes(keyframes, t)
    const rotRad = (rot * Math.PI) / 180
    let flash = 0
    for (const tf of flashTimes) {
      const dd = Math.abs(t - tf)
      if (dd < flashHalf) flash = Math.max(flash, 1 - dd / flashHalf)
    }

    cctx.clearRect(0, 0, w, h)

    // Background plate (static — never scales). Colour → B&W crossfade.
    cctx.drawImage(base, 0, 0)
    if (p > 0) {
      cctx.globalAlpha = p
      cctx.drawImage(bwBg, 0, 0)
      cctx.globalAlpha = 1
    }

    // Subject + border, scaled and rotated about the centroid. The subject is
    // drawn on top of the full (hole-free) background, so as it shifts it covers
    // the black cut and the faded copy of itself behind — reading as a cutout
    // being moved against its own backdrop.
    cctx.save()
    cctx.translate(dx, dy) // screen-space shift
    cctx.translate(cx, cy)
    cctx.rotate(rotRad)
    cctx.scale(zoomScale, zoomScale)
    cctx.translate(-cx, -cy)

    cctx.drawImage(subjColor, 0, 0)
    if (p > 0) {
      cctx.globalAlpha = p
      cctx.drawImage(subjBw, 0, 0)
      cctx.globalAlpha = 1
    }

    // The border draws itself: reveal the rim only along the length of the
    // outline traced so far, starting at the bottom-centre anchor. Built on a
    // scratch layer (rim kept where the growing stroke covers it), then drawn in
    // under the same zoom transform so it scales with the subject.
    if (borderPath && borderP > 0) {
      blctx.globalCompositeOperation = 'source-over'
      blctx.setLineDash([])
      blctx.clearRect(0, 0, w, h)
      blctx.drawImage(rim, 0, 0)
      blctx.globalCompositeOperation = 'destination-in'
      blctx.strokeStyle = '#fff'
      blctx.lineCap = 'round'
      blctx.lineJoin = 'round'
      blctx.lineWidth = borderPx * 4
      blctx.setLineDash([pathLen, pathLen])
      blctx.lineDashOffset = pathLen * (1 - borderP)
      blctx.stroke(borderPath)
      blctx.globalCompositeOperation = 'source-over'
      blctx.setLineDash([])
      cctx.drawImage(borderLayer, 0, 0)
    }
    cctx.restore()

    // Slide the whole frame up into place on a black stage, then flash.
    octx.fillStyle = '#000'
    octx.fillRect(0, 0, w, h)
    octx.drawImage(content, 0, yOff)
    if (flash > 0) {
      octx.fillStyle = `rgba(255,255,255,${flash})`
      octx.fillRect(0, 0, w, h)
    }

    frames.push(out.toDataURL('image/jpeg', 0.92).split(',')[1])
  }

  return frames
}

// ─── VHS 1 ──────────────────────────────────────────────────────────────────

// Recolour the source into a tone plate: grayscale, or a faded/muted "old TV" look.
function vhsTonePlate(src: ImageData, w: number, h: number, mode: 'bw' | 'muted'): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h)
  const img = new ImageData(new Uint8ClampedArray(src.data), w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (mode === 'bw') {
      d[i] = d[i + 1] = d[i + 2] = lum
    } else {
      // Desaturate, lift the blacks, compress contrast, and warm it slightly —
      // like a washed-out, over-used television screen.
      const sat = 0.55
      const fade = (v: number): number => v * 0.82 + 26
      d[i] = clamp255(fade(lum + (r - lum) * sat) * 1.04)
      d[i + 1] = clamp255(fade(lum + (g - lum) * sat))
      d[i + 2] = clamp255(fade(lum + (b - lum) * sat) * 0.95)
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

// Horizontal scanline overlay.
function vhsScanlines(w: number, h: number, darkPx: number, period: number, alpha: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h)
  ctx.fillStyle = `rgba(0,0,0,${alpha})`
  for (let y = 0; y < h; y += period) ctx.fillRect(0, y, w, darkPx)
  return c
}

// Vignette + soft curved edge darkening, to imply a curved CRT screen.
function vhsVignette(w: number, h: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h)
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(0.65, 'rgba(0,0,0,0.06)')
  g.addColorStop(1, 'rgba(0,0,0,0.6)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.filter = `blur(${Math.round(Math.min(w, h) * 0.02)}px)`
  ctx.strokeStyle = 'rgba(0,0,0,0.75)'
  ctx.lineWidth = Math.min(w, h) * 0.05
  const inset = ctx.lineWidth * 0.5
  ctx.beginPath()
  ctx.roundRect(inset, inset, w - 2 * inset, h - 2 * inset, Math.min(w, h) * 0.1)
  ctx.stroke()
  ctx.filter = 'none'
  return c
}

// Warm light-leak blob (drawn with 'screen', drifting).
function vhsLeak(w: number, h: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h)
  const g = ctx.createRadialGradient(w * 0.8, h * 0.2, 0, w * 0.8, h * 0.2, Math.max(w, h) * 0.85)
  g.addColorStop(0, 'rgba(255,185,90,0.7)')
  g.addColorStop(0.35, 'rgba(255,120,60,0.32)')
  g.addColorStop(1, 'rgba(255,80,40,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  return c
}

// A ring of gray-noise tiles, cycled per frame for animated static.
function vhsNoiseTiles(count: number, size: number): HTMLCanvasElement[] {
  const tiles: HTMLCanvasElement[] = []
  for (let n = 0; n < count; n++) {
    const [c, ctx] = makeCanvas(size, size)
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0
      d[i] = d[i + 1] = d[i + 2] = v
      d[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    tiles.push(c)
  }
  return tiles
}

// Torn, colour-shifted horizontal slices — the VHS discolouration/glitch.
function vhsGlitch(ctx: CanvasRenderingContext2D, cvs: HTMLCanvasElement, ax: number, ay: number, w: number, h: number): void {
  const gw = w * 0.3
  const gh = h * 0.13
  const x = Math.max(0, Math.min(w - gw, ax - gw / 2 + (Math.random() - 0.5) * 12))
  const y0 = Math.max(0, Math.min(h - gh, ay - gh / 2 + (Math.random() - 0.5) * 8))
  const bands = 3
  for (let b = 0; b < bands; b++) {
    const by = y0 + (b * gh) / bands
    const bh = ((gh / bands) * (0.4 + Math.random() * 0.5)) | 0
    if (bh <= 0) continue
    const shift = (Math.random() - 0.5) * 12
    // Faded: the displaced tear is a faint ghost, the colour tint is light.
    ctx.globalAlpha = 0.5
    ctx.drawImage(cvs, x, by, gw, bh, x + shift, by, gw, bh)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = b % 2 ? 'rgba(255,0,90,0.07)' : 'rgba(0,210,255,0.06)'
    ctx.fillRect(x + shift, by, gw, bh)
    ctx.globalCompositeOperation = 'source-over'
  }
}

interface VhsSeg {
  end: number
  kind: 'content' | 'static'
  plate?: HTMLCanvasElement
  thick?: boolean
  leak?: boolean
  glitch?: { x: number; y: number }
}

// Build the full VHS 1 clip. No segmentation — pure full-frame stylisation, so
// it precomputes the tone plates + overlays once and composites cheaply per frame.
async function generateVhsFrames(src: string, opts: VhsOpts): Promise<string[]> {
  const duration = opts.duration
  const statics = Math.max(STATICS_MIN, Math.min(STATICS_MAX, Math.round(opts.statics)))

  const img = await loadImage(src)
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(2, Math.round((img.naturalWidth * scale) / 2) * 2)
  const h = Math.max(2, Math.round((img.naturalHeight * scale) / 2) * 2)

  const [colorPlate, bctx] = makeCanvas(w, h)
  bctx.drawImage(img, 0, 0, w, h)
  const srcData = bctx.getImageData(0, 0, w, h)
  const bwPlate = vhsTonePlate(srcData, w, h, 'bw')
  const mutedPlate = vhsTonePlate(srcData, w, h, 'muted')

  const scanThin = vhsScanlines(w, h, 1, 3, 0.22)
  const scanThick = vhsScanlines(w, h, 2, 4, 0.32)
  const vignette = vhsVignette(w, h)
  const leak = vhsLeak(w, h)
  const noise = vhsNoiseTiles(12, 160)

  // Content beats cycle colour → B&W → muted; a random glitch anchor per beat
  // (the first sits bottom-right, the rest roam).
  const styleFor = (idx: number): { plate: HTMLCanvasElement; thick: boolean; leak: boolean } => {
    const m = idx % 3
    if (m === 1) return { plate: bwPlate, thick: true, leak: false }
    if (m === 2) return { plate: mutedPlate, thick: false, leak: true }
    return { plate: colorPlate, thick: false, leak: true }
  }
  const anchorFor = (idx: number): { x: number; y: number } =>
    idx === 0
      ? { x: w * (0.62 + Math.random() * 0.28), y: h * (0.66 + Math.random() * 0.26) }
      : { x: w * (0.1 + Math.random() * 0.55), y: h * (0.12 + Math.random() * 0.5) }

  // `statics` bursts split the clip into statics+1 content beats. Each non-final
  // beat is a fixed length so pace stays constant; the final beat fills the rest
  // (extending Length just makes it carry on rather than slowing everything).
  const segs: VhsSeg[] = []
  let cursor = 0
  for (let k = 0; k <= statics; k++) {
    const isLast = k === statics
    const st = styleFor(k)
    const end = isLast ? Math.max(cursor + 0.1, duration) : cursor + VHS_CONTENT_LEN
    segs.push({ end, kind: 'content', plate: st.plate, thick: st.thick, leak: st.leak, glitch: anchorFor(k) })
    cursor = end
    if (!isLast) {
      segs.push({ end: cursor + VHS_STATIC_DUR, kind: 'static' })
      cursor += VHS_STATIC_DUR
    }
  }

  const [out, octx] = makeCanvas(w, h)
  const frameCount = Math.max(2, Math.round(VHS_FPS * duration))
  const frames: string[] = []

  for (let i = 0; i < frameCount; i++) {
    const t = (duration * i) / (frameCount - 1)

    let seg = segs[segs.length - 1]
    for (const s of segs) {
      if (t < s.end) {
        seg = s
        break
      }
    }
    const isStatic = seg.kind === 'static'
    const plate = seg.plate ?? colorPlate
    const thick = seg.thick ?? false
    const leakOn = !isStatic && (seg.leak ?? false)
    const glitch = isStatic ? null : seg.glitch ?? null

    octx.globalAlpha = 1
    octx.globalCompositeOperation = 'source-over'
    octx.fillStyle = '#000'
    octx.fillRect(0, 0, w, h)
    octx.drawImage(plate, 0, 0)

    // Scanlines
    octx.drawImage(thick ? scanThick : scanThin, 0, 0)

    // Slow rolling tracking band
    const bandY = ((t * 0.32) % 1) * h
    octx.fillStyle = 'rgba(255,255,255,0.05)'
    octx.fillRect(0, bandY, w, h * 0.05)
    octx.fillStyle = 'rgba(0,0,0,0.10)'
    octx.fillRect(0, bandY + h * 0.05, w, h * 0.02)

    // Discolouration / glitch
    if (glitch) vhsGlitch(octx, out, glitch.x, glitch.y, w, h)

    // Light leak (colour beats only)
    if (leakOn) {
      octx.globalCompositeOperation = 'screen'
      octx.globalAlpha = 0.5 + 0.25 * Math.sin(t * 2)
      octx.drawImage(leak, Math.sin(t * 1.3) * w * 0.1, Math.cos(t * 0.9) * h * 0.05)
      octx.globalAlpha = 1
      octx.globalCompositeOperation = 'source-over'
    }

    // Grain always; heavy static during the transition beats
    const tile = noise[i % noise.length]
    if (isStatic) {
      octx.globalAlpha = 0.92
      octx.drawImage(tile, 0, 0, tile.width, tile.height, 0, 0, w, h)
      octx.globalAlpha = 1
    } else {
      octx.globalCompositeOperation = 'overlay'
      octx.globalAlpha = 0.06
      octx.drawImage(tile, 0, 0, tile.width, tile.height, 0, 0, w, h)
      octx.globalAlpha = 1
      octx.globalCompositeOperation = 'source-over'
    }

    // Vignette + curved edges last, on top of everything
    octx.drawImage(vignette, 0, 0)

    frames.push(out.toDataURL('image/jpeg', 0.9).split(',')[1])
  }

  return frames
}

// ─── Parallax ───────────────────────────────────────────────────────────────

// Where the line a·(x/w) + b·(y/h) = c meets the image rectangle (≤2 points).
function parLineEndpoints(a: number, b: number, c: number, w: number, h: number): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  const push = (x: number, y: number): void => {
    if (x >= -0.5 && x <= w + 0.5 && y >= -0.5 && y <= h + 0.5) {
      pts.push({ x: Math.max(0, Math.min(w, x)), y: Math.max(0, Math.min(h, y)) })
    }
  }
  if (b !== 0) {
    push(0, (c * h) / b)
    push(w, ((c - a) * h) / b)
  }
  if (a !== 0) {
    push((c * w) / a, 0)
    push(((c - b) * w) / a, h)
  }
  const uniq: Array<{ x: number; y: number }> = []
  for (const p of pts) {
    if (!uniq.some((q) => Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) < 1)) uniq.push(p)
  }
  return uniq.slice(0, 2)
}

// Centre pan: slide in (slow→fast, cubic) then slowly slide back out, ping-ponging.
function parCenterPan(tp: number, amp: number): number {
  if (tp <= 0) return 0
  const p = tp % PAR_CENTER_PERIOD
  if (p < PAR_CENTER_IN) {
    const u = p / PAR_CENTER_IN
    return u * u * u * amp
  }
  const u = (p - PAR_CENTER_IN) / (PAR_CENTER_PERIOD - PAR_CENTER_IN)
  return (1 - u) * amp
}

// Edge pan: steady (linear) triangle ping-pong at a slower cadence.
function parEdgePan(tp: number, amp: number): number {
  if (tp <= 0) return 0
  const p = (tp % PAR_EDGE_PERIOD) / PAR_EDGE_PERIOD
  return (p < 0.5 ? p * 2 : (1 - p) * 2) * amp
}

async function generateParallaxFrames(src: string, opts: ParallaxOpts): Promise<string[]> {
  const duration = opts.duration
  const img = await loadImage(src)
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(2, Math.round((img.naturalWidth * scale) / 2) * 2)
  const h = Math.max(2, Math.round((img.naturalHeight * scale) / 2) * 2)
  const g = PAR_GAP

  // Tier masks (0 = corner/static, 1 = edge, 2 = centre) from the diamond grid.
  const [maskCorner, mcCtx] = makeCanvas(w, h)
  const [maskEdge, meCtx] = makeCanvas(w, h)
  const [maskCenter, mmCtx] = makeCanvas(w, h)
  const dCorner = mcCtx.createImageData(w, h)
  const dEdge = meCtx.createImageData(w, h)
  const dCenter = mmCtx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w
      const v = y / h
      const sMid = Math.abs(u + v - 1) <= g
      const dMid = Math.abs(u - v) <= g
      const arr = sMid && dMid ? dCenter.data : sMid || dMid ? dEdge.data : dCorner.data
      const idx = (y * w + x) * 4
      arr[idx] = arr[idx + 1] = arr[idx + 2] = 255
      arr[idx + 3] = 255
    }
  }
  mcCtx.putImageData(dCorner, 0, 0)
  meCtx.putImageData(dEdge, 0, 0)
  mmCtx.putImageData(dCenter, 0, 0)
  const masks = [maskCorner, maskEdge, maskCenter]

  // The four slice lines = the boundaries of the centre bands. Ordered so family
  // A draws bottom-left→top-right and family B draws bottom-right→top-left.
  const defs = [
    { a: 1, b: 1, c: 1 - g, dir: 'A' },
    { a: 1, b: 1, c: 1 + g, dir: 'A' },
    { a: 1, b: -1, c: -g, dir: 'B' },
    { a: 1, b: -1, c: g, dir: 'B' },
  ]
  const lines: Array<[{ x: number; y: number }, { x: number; y: number }]> = []
  for (const d of defs) {
    const p = parLineEndpoints(d.a, d.b, d.c, w, h)
    if (p.length < 2) continue
    p.sort((m, n) => (d.dir === 'A' ? m.x - n.x : n.x - m.x))
    lines.push([p[0], p[1]])
  }

  const ow = w * PAR_OVERSCAN
  const oh = h * PAR_OVERSCAN
  const ox = -(ow - w) / 2
  const oy = -(oh - h) / 2

  const [layer, lctx] = makeCanvas(w, h)
  const [out, octx] = makeCanvas(w, h)
  const frameCount = Math.max(2, Math.round(PAR_FPS * duration))
  const frames: string[] = []

  for (let i = 0; i < frameCount; i++) {
    const t = (duration * i) / (frameCount - 1)
    const tp = t - PAR_PAR_START
    const zC = 1 + parCenterPan(tp, PAR_ZOOM_CENTER) // centre: slow→fast push-in
    const zE = 1 + parEdgePan(tp, PAR_ZOOM_EDGE) // edges: gentle steady push-in

    octx.setTransform(1, 0, 0, 1, 0, 0)
    octx.globalAlpha = 1
    octx.globalCompositeOperation = 'source-over'
    octx.fillStyle = '#000'
    octx.fillRect(0, 0, w, h)

    // Each tier: draw the (overscanned) image — the centre and edges both zoom
    // inward about the frame centre (centre more/faster), corners stay put — then
    // mask to the tier's regions and composite. Regions are disjoint so order
    // doesn't matter.
    for (let tier = 0; tier < 3; tier++) {
      lctx.globalCompositeOperation = 'source-over'
      lctx.clearRect(0, 0, w, h)
      if (tier === 0) {
        lctx.drawImage(img, ox, oy, ow, oh) // corners: static
      } else {
        const z = tier === 2 ? zC : zE
        const dw = ow * z
        const dh = oh * z
        lctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
      }
      lctx.globalCompositeOperation = 'destination-in'
      lctx.drawImage(masks[tier], 0, 0)
      lctx.globalCompositeOperation = 'source-over'
      octx.drawImage(layer, 0, 0)
    }

    // Faint slices, drawing themselves across during the draw phase.
    const drawP = clamp01((t - PAR_DRAW_START) / (PAR_DRAW_END - PAR_DRAW_START))
    if (drawP > 0) {
      octx.strokeStyle = 'rgba(255,255,255,0.22)'
      octx.lineWidth = Math.max(1, Math.round(Math.min(w, h) * 0.0016))
      octx.lineCap = 'round'
      for (const [s0, e0] of lines) {
        octx.beginPath()
        octx.moveTo(s0.x, s0.y)
        octx.lineTo(s0.x + (e0.x - s0.x) * drawP, s0.y + (e0.y - s0.y) * drawP)
        octx.stroke()
      }
    }

    // Opening white flash.
    const flash = t >= PAR_FLASH_HALF ? 0 : 1 - t / PAR_FLASH_HALF
    if (flash > 0) {
      octx.fillStyle = `rgba(255,255,255,${flash})`
      octx.fillRect(0, 0, w, h)
    }

    frames.push(out.toDataURL('image/jpeg', 0.9).split(',')[1])
  }

  return frames
}

// ─── Psychedelic ────────────────────────────────────────────────────────────

const clampIdx = (i: number, n: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i)

// Separable box blur over a scalar field, edges clamped.
function psyBlurField(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const win = 2 * r + 1
  const tmp = new Float32Array(w * h)
  const dst = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[row + clampIdx(x, w)]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win
      acc += src[row + clampIdx(x + r + 1, w)] - src[row + clampIdx(x - r, w)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[clampIdx(y, h) * w + x]
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / win
      acc += tmp[clampIdx(y + r + 1, h) * w + x] - tmp[clampIdx(y - r, h) * w + x]
    }
  }
  return dst
}

// Box blur over a 1-D profile, edges clamped.
function psyBlur1d(src: Float32Array, r: number): Float32Array {
  const n = src.length
  const dst = new Float32Array(n)
  const win = 2 * r + 1
  let acc = 0
  for (let i = -r; i <= r; i++) acc += src[clampIdx(i, n)]
  for (let i = 0; i < n; i++) {
    dst[i] = acc / win
    acc += src[clampIdx(i + r + 1, n)] - src[clampIdx(i - r, n)]
  }
  return dst
}

// How far along the stretch is at t seconds — a function of elapsed time alone.
// It ramps to the calibrated stretch over PSY_RAMP_SECONDS, then keeps climbing
// for as long as the clip runs, smoothly and at an ever-gentler rate. The two
// pieces meet with matching slope, so there is no kick where they join.
function psyStretchAt(t: number): number {
  const tau = t / PSY_RAMP_SECONDS
  return tau <= 1 ? Math.pow(tau, PSY_EASE) : 1 + PSY_EASE * Math.log(tau)
}

// A point u (in subject half-widths out from the centre) is pushed outward to
//   u · (1 + c · (LIN + (1 − LIN) · u))
// — a push that grows with distance, so outer features travel further, and get
// there faster, than inner ones. Nothing ever comes back in. That expression is
// a quadratic in u, so the inverse the warp actually needs is its positive root:
// exact, one sqrt, no iteration.
function psyUnstretch(v: number, c: number): number {
  if (c < 1e-6) return v
  const a = (1 - PSY_RADIAL_LIN) * c
  const b = 1 + PSY_RADIAL_LIN * c
  return (Math.sqrt(b * b + 4 * a * v) - b) / (2 * a)
}

// Read the subject's anatomy straight off its silhouette: how wide the mask is on
// every row. The narrowest row in the upper half is the neck (everything above it
// is the head); the widest row lower down is the hips/shoulders. No facial
// landmarks are involved, so a vase or a mug degrades to the same treatment.
interface PsyShape {
  cx: number
  top: number
  bottom: number
  maxWidth: number
  gain: Float32Array // sideways stretch factor per source row
  sagProfile: Float32Array // where the droop bites, per source row
  // The band the stretch strength is calibrated against: the head if there is
  // one, otherwise the subject's widest row.
  focusWidth: number
  focusGain: number
  focusCover: number
}

function psyAnalyse(mask: Float32Array, w: number, h: number): PsyShape {
  const rowW = new Float32Array(h)
  let top = -1
  let bottom = -1
  let cxSum = 0
  let cxWeight = 0
  for (let y = 0; y < h; y++) {
    let l = -1
    let r = -1
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] > 0.5) {
        if (l < 0) l = x
        r = x
      }
    }
    if (l < 0) continue
    rowW[y] = r - l + 1
    cxSum += ((l + r + 1) / 2) * rowW[y]
    cxWeight += rowW[y]
    if (top < 0) top = y
    bottom = y
  }

  // No subject found — treat the whole frame as the object of focus.
  if (top < 0) {
    top = 0
    bottom = h - 1
    for (let y = 0; y < h; y++) rowW[y] = w
    cxSum = (w / 2) * w * h
    cxWeight = w * h
  }

  const cx = cxSum / cxWeight
  const subjH = bottom - top + 1
  const rowS = psyBlur1d(rowW, Math.max(1, Math.round(h / 40)))

  let maxWidth = 1
  let maxRow = top
  for (let y = top; y <= bottom; y++) {
    if (rowS[y] > maxWidth) {
      maxWidth = rowS[y]
      maxRow = y
    }
  }

  // Neck = narrowest row in the upper band; only believed if it actually pinches.
  let neckY = -1
  let neckW = Infinity
  const nFrom = top + Math.round(subjH * 0.12)
  const nTo = top + Math.round(subjH * 0.55)
  for (let y = nFrom; y <= nTo; y++) {
    if (rowS[y] < neckW) {
      neckW = rowS[y]
      neckY = y
    }
  }
  let headW = 0
  for (let y = top; y <= Math.max(top, neckY); y++) headW = Math.max(headW, rowS[y])
  const hasHead = neckY > top && neckW < headW * 0.8 && neckY - top > subjH * 0.1
  const headH = hasHead ? neckY - top : subjH
  const eyeY = hasHead ? top + headH * 0.42 : top + subjH * 0.3

  // Hips/sides: widest row in the lower part of the subject.
  let hipY = top + subjH * 0.5
  let hipW = -1
  for (let y = top + Math.round(subjH * 0.45); y <= bottom; y++) {
    if (rowS[y] > hipW) {
      hipW = rowS[y]
      hipY = y
    }
  }

  const eyeSigma = Math.max(4, headH * 0.45)
  const hipSigma = Math.max(4, subjH * 0.22)
  const fadeSigma = Math.max(4, subjH * 0.5)
  const gain = new Float32Array(h)
  for (let y = 0; y < h; y++) {
    let base: number
    if (y >= top && y <= bottom) {
      base = Math.pow(rowS[y] / maxWidth, PSY_WIDTH_POW)
    } else {
      // Above/below the subject, carry the nearest row's gain out and let it fade.
      const edge = Math.pow(rowS[y < top ? top : bottom] / maxWidth, PSY_WIDTH_POW)
      const d = y < top ? top - y : y - bottom
      base = edge * Math.exp(-((d / fadeSigma) ** 2))
    }
    let g = PSY_ROW_FLOOR + (1 - PSY_ROW_FLOOR) * base
    if (hasHead) g += PSY_EYE_BUMP * Math.exp(-(((y - eyeY) / eyeSigma) ** 2))
    g += PSY_HIP_BUMP * Math.exp(-(((y - hipY) / hipSigma) ** 2))
    gain[y] = g
  }

  // The droop is centred on the eye band and reaches across the whole subject.
  const sagProfile = new Float32Array(h)
  const sagSigma = Math.max(4, subjH * 0.5)
  for (let y = 0; y < h; y++) sagProfile[y] = Math.exp(-(((y - eyeY) / sagSigma) ** 2))

  return {
    cx,
    top,
    bottom,
    maxWidth,
    gain,
    sagProfile,
    focusWidth: hasHead ? headW : maxWidth,
    focusGain: hasHead ? gain[clampIdx(Math.round(eyeY), h)] : gain[maxRow],
    focusCover: hasHead ? PSY_HEAD_COVER : PSY_TARGET_COVER,
  }
}

// Build the psychedelic clip. Every frame is an inverse-mapped per-pixel warp:
// for each output pixel we work out where it came from in the original, so the
// stretch stays smooth and hole-free however extreme it gets. Sampling clamps at
// the border, which is what smears the subject's sides out to the frame edges.
async function generatePsychedelicFrames(src: string, opts: PsychedelicOpts): Promise<string[]> {
  const duration = Math.min(PSY_DUR_MAX, opts.duration)
  const intensity = opts.intensity

  const img = await loadImage(src)
  const scale = Math.min(1, PSY_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(2, Math.round((img.naturalWidth * scale) / 2) * 2)
  const h = Math.max(2, Math.round((img.naturalHeight * scale) / 2) * 2)

  const [, bctx] = makeCanvas(w, h)
  bctx.drawImage(img, 0, 0, w, h)
  const sd = bctx.getImageData(0, 0, w, h).data

  // Object of focus. The segmentation alpha doubles as the "how much is this the
  // subject" field; blurring it makes the warp rate cross the outline smoothly
  // instead of tearing along it.
  const fgBlob = await removeBackground(src, { output: { format: 'image/png' } })
  const fgUrl = URL.createObjectURL(fgBlob)
  let fg: HTMLImageElement
  try {
    fg = await loadImage(fgUrl)
  } finally {
    URL.revokeObjectURL(fgUrl)
  }
  const [, mctx] = makeCanvas(w, h)
  mctx.drawImage(fg, 0, 0, w, h)
  const alpha = mctx.getImageData(0, 0, w, h).data
  const hard = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) hard[i] = alpha[i * 4 + 3] / 255
  const field = psyBlurField(hard, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.02)))

  const shape = psyAnalyse(hard, w, h)
  const { cx, top, bottom, maxWidth, gain, sagProfile } = shape
  const subjH = bottom - top + 1
  const spanX = Math.max(1, maxWidth / 2)

  // Pick the stretch strength from the subject's own size, so the focus band ends
  // spilling past the frame edges whatever the framing was. Solve the forward
  // push for the c that carries the focus band's edge out to the target.
  const uFocus = shape.focusWidth / 2 / spanX
  const vFocus = (w * shape.focusCover) / 2 / spanX
  const ramp = uFocus * (PSY_RADIAL_LIN + (1 - PSY_RADIAL_LIN) * uFocus)
  const kMax = clamp(
    (ramp > 1e-6 ? (vFocus - uFocus) / ramp : PSY_K_MAX) / Math.max(0.05, shape.focusGain),
    PSY_K_MIN,
    PSY_K_MAX
  )

  // Per-column terms that never change: how far out this column sits, which side
  // of the subject it is on, and how hard the droop pulls on it.
  const absX = new Float32Array(w)
  const signX = new Float32Array(w)
  const sideCurve = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const n = (x - cx) / spanX
    absX[x] = n < 0 ? -n : n
    signX[x] = n < 0 ? -1 : 1
    sideCurve[x] = Math.pow(Math.min(1, absX[x]), PSY_SAG_POW)
  }

  const [warp, wctx] = makeCanvas(w, h)
  const warpImg = wctx.createImageData(w, h)
  const dst = warpImg.data
  const [out, octx] = makeCanvas(w, h)

  const frameCount = Math.max(2, Math.round(PSY_FPS * duration))
  const frames: string[] = []

  for (let i = 0; i < frameCount; i++) {
    const t = (duration * i) / (frameCount - 1)
    const e = psyStretchAt(t) * intensity
    // Colour tops out where the ramp does and holds; left on `e` a long clip
    // would rotate the hue right the way round and come back to where it started.
    const cp = clamp01(e)
    const kH = e * kMax
    const sagAmp = e * PSY_SAG * subjH
    const ab = cp * PSY_ABERRATION * w
    const doAb = ab > 0.5

    for (let y = 0; y < h; y++) {
      const sagRow = sagProfile[y] * sagAmp
      const rowOff = y * w
      for (let x = 0; x < w; x++) {
        // Pass 1: assume this pixel belongs to the subject, and see where that
        // would have pulled it from.
        const sag0 = sagRow * sideCurve[x]
        const sy0 = y - sag0
        const g = gain[clampIdx(sy0 | 0, h)]
        const sx0 = cx + signX[x] * psyUnstretch(absX[x], g * kH) * spanX

        // Pass 2: the source point tells us whether it really is subject or
        // background, so redo the warp at that region's own rate.
        const fx0 = sx0 < 0 ? 0 : sx0 > w - 1 ? w - 1 : sx0
        const fy0 = sy0 < 0 ? 0 : sy0 > h - 1 ? h - 1 : sy0
        const a = field[(fy0 | 0) * w + (fx0 | 0)]
        const amp = PSY_BG_RATE + (1 - PSY_BG_RATE) * a

        const sy = y - sag0 * amp
        const sx = cx + signX[x] * psyUnstretch(absX[x], g * kH * amp) * spanX

        // Bilinear sample, clamped at the border.
        const cxf = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx
        const cyf = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy
        const x0 = cxf | 0
        const y0i = cyf | 0
        const x1 = x0 + 1 < w ? x0 + 1 : x0
        const y1i = y0i + 1 < h ? y0i + 1 : y0i
        const fx = cxf - x0
        const fy = cyf - y0i
        const i00 = (y0i * w + x0) * 4
        const i10 = (y0i * w + x1) * 4
        const i01 = (y1i * w + x0) * 4
        const i11 = (y1i * w + x1) * 4
        const w00 = (1 - fx) * (1 - fy)
        const w10 = fx * (1 - fy)
        const w01 = (1 - fx) * fy
        const w11 = fx * fy

        const o = (rowOff + x) * 4
        dst[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11
        dst[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11
        dst[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11
        dst[o + 3] = 255

        // Chromatic separation, once the stretch is far enough along to show it:
        // red and blue are pulled from either side of the true source point.
        if (doAb) {
          const rx = clamp(sx - ab, 0, w - 1)
          const bx = clamp(sx + ab, 0, w - 1)
          const rx0 = rx | 0
          const bx0 = bx | 0
          const rx1 = rx0 + 1 < w ? rx0 + 1 : rx0
          const bx1 = bx0 + 1 < w ? bx0 + 1 : bx0
          const rf = rx - rx0
          const bf = bx - bx0
          dst[o] =
            (sd[(y0i * w + rx0) * 4] * (1 - rf) + sd[(y0i * w + rx1) * 4] * rf) * (1 - fy) +
            (sd[(y1i * w + rx0) * 4] * (1 - rf) + sd[(y1i * w + rx1) * 4] * rf) * fy
          dst[o + 2] =
            (sd[(y0i * w + bx0) * 4 + 2] * (1 - bf) + sd[(y0i * w + bx1) * 4 + 2] * bf) * (1 - fy) +
            (sd[(y1i * w + bx0) * 4 + 2] * (1 - bf) + sd[(y1i * w + bx1) * 4 + 2] * bf) * fy
        }
      }
    }

    wctx.putImageData(warpImg, 0, 0)
    octx.filter = `hue-rotate(${PSY_HUE * cp}deg) saturate(${1 + (PSY_SAT - 1) * cp})`
    octx.drawImage(warp, 0, 0)
    octx.filter = 'none'

    frames.push(out.toDataURL('image/jpeg', 0.9).split(',')[1])
  }

  return frames
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ImageStudio() {
  const [originalSrc, setOriginalSrc] = useState<string | null>(null)
  const [resultVideo, setResultVideo] = useState<string | null>(null)
  const [activeEffect, setActiveEffect] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')

  // Slider-governed effect settings.
  const [borderPx, setBorderPx] = useState(BORDER_DEFAULT)
  const [duration, setDuration] = useState(DUR_DEFAULT)
  const [flashes, setFlashes] = useState(FLASHES_DEFAULT)
  const [vhsDuration, setVhsDuration] = useState(VHS_DUR_DEFAULT)
  const [statics, setStatics] = useState(STATICS_DEFAULT)
  const [parDuration, setParDuration] = useState(PAR_DUR_DEFAULT)
  const [psyDuration, setPsyDuration] = useState(PSY_DUR_DEFAULT)
  const [psyIntensity, setPsyIntensity] = useState(PSY_INT_DEFAULT)

  // Playback transport for the rendered clip.
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(true)
  const [videoTime, setVideoTime] = useState(0)
  const [videoDur, setVideoDur] = useState(0)
  const [resultFps, setResultFps] = useState(FPS)

  const loadSrc = useCallback((src: string) => {
    setOriginalSrc(src)
    setResultVideo(null)
    setActiveEffect(null)
    setError(null)
  }, [])

  const loadFile = useCallback(async (file: File) => {
    if (!isImageFile(file)) {
      setError('Please use a JPEG, PNG or GIF image')
      return
    }
    try {
      loadSrc(await fileToDataUrl(file))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file')
    }
  }, [loadSrc])

  const loadFromUrl = useCallback(async (raw: string) => {
    const link = raw.trim()
    if (!link) return
    setError(null)
    try {
      const dataUrl = await window.api.fetchImageUrl(link)
      loadSrc(dataUrl)
      setUrl('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that URL')
    }
  }, [loadSrc])

  // Drag & drop onto the stage.
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = Array.from(e.dataTransfer.files).find(isImageFile)
    if (file) {
      loadFile(file)
    } else {
      const text = e.dataTransfer.getData('text')
      if (text) loadFromUrl(text)
    }
  }, [loadFile, loadFromUrl])

  // Paste an image or an image URL while the Images tab is open.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) {
              loadFile(file)
              return
            }
          }
        }
      }
      const text = e.clipboardData?.getData('text')
      if (text && (/^https?:\/\//i.test(text) || text.startsWith('data:image/'))) {
        loadFromUrl(text)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadFile, loadFromUrl])

  // Generic render: produce frames via the effect's factory, encode to MP4.
  const runRender = useCallback(
    async (effectId: string, factory: () => Promise<string[]>, fps: number) => {
      setActiveEffect(effectId)
      setProcessing(true)
      setError(null)
      try {
        const frames = await factory()
        const video = await window.api.encodeMp4({ frames, fps })
        setResultFps(fps)
        setResultVideo(video)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That effect could not be applied')
        setActiveEffect(null)
      } finally {
        setProcessing(false)
      }
    },
    []
  )

  const runEffect = useCallback((effect: Effect) => {
    if (!effect.implemented || !originalSrc || processing) return
    if (effect.id === 'cutout') {
      runRender('cutout', () => generateCutoutFrames(originalSrc, { borderPx, duration, flashes }), FPS)
    } else if (effect.id === 'vhs1') {
      runRender('vhs1', () => generateVhsFrames(originalSrc, { duration: vhsDuration, statics }), VHS_FPS)
    } else if (effect.id === 'parallax') {
      runRender('parallax', () => generateParallaxFrames(originalSrc, { duration: parDuration }), PAR_FPS)
    } else if (effect.id === 'psychedelic') {
      runRender(
        'psychedelic',
        () => generatePsychedelicFrames(originalSrc, { duration: psyDuration, intensity: psyIntensity }),
        PSY_FPS
      )
    }
  }, [originalSrc, processing, borderPx, duration, flashes, vhsDuration, statics, parDuration, psyDuration, psyIntensity, runRender])

  // Auto re-render half a second after a dial is nudged — but only once a cutout
  // is already applied. Latest state is read from refs so a late-firing timer
  // never renders a stale image or stacks on an in-flight render.
  const originalRef = useRef(originalSrc)
  const activeRef = useRef(activeEffect)
  const processingRef = useRef(processing)
  originalRef.current = originalSrc
  activeRef.current = activeEffect
  processingRef.current = processing

  useEffect(() => {
    if (!activeRef.current || !originalRef.current) return
    const id = setTimeout(() => {
      const s = originalRef.current
      if (!s || processingRef.current) return
      if (activeRef.current === 'cutout') {
        runRender('cutout', () => generateCutoutFrames(s, { borderPx, duration, flashes }), FPS)
      } else if (activeRef.current === 'vhs1') {
        runRender('vhs1', () => generateVhsFrames(s, { duration: vhsDuration, statics }), VHS_FPS)
      } else if (activeRef.current === 'parallax') {
        runRender('parallax', () => generateParallaxFrames(s, { duration: parDuration }), PAR_FPS)
      } else if (activeRef.current === 'psychedelic') {
        runRender(
          'psychedelic',
          () => generatePsychedelicFrames(s, { duration: psyDuration, intensity: psyIntensity }),
          PSY_FPS
        )
      }
    }, 500)
    return () => clearTimeout(id)
  }, [borderPx, duration, flashes, vhsDuration, statics, parDuration, psyDuration, psyIntensity, runRender])

  const canUndo = resultVideo !== null && !processing

  const undo = useCallback(() => {
    if (!canUndo) return
    setResultVideo(null)
    setActiveEffect(null)
  }, [canUndo])

  // Keep the scrubber tracking playback. `timeupdate` alone fires a few times a
  // second, which reads as a stuttering playhead, so drive it off rAF while the
  // clip is actually running.
  useEffect(() => {
    if (!resultVideo || !playing) return
    let raf = 0
    const tick = (): void => {
      const el = videoRef.current
      if (el) setVideoTime(el.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [resultVideo, playing])

  // A fresh render starts from the top.
  useEffect(() => {
    setVideoTime(0)
    setVideoDur(0)
  }, [resultVideo])

  const seek = useCallback(
    (to: number) => {
      const el = videoRef.current
      if (!el) return
      const at = clamp(to, 0, videoDur || 0)
      el.currentTime = at
      setVideoTime(at)
    },
    [videoDur]
  )

  // Stepping is for inspecting a single moment, so it always pauses first.
  const stepFrame = useCallback(
    (dir: number) => {
      const el = videoRef.current
      if (!el) return
      el.pause()
      seek(el.currentTime + dir / resultFps)
    },
    [seek, resultFps]
  )

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }, [])

  const reset = useCallback(() => {
    setOriginalSrc(null)
    setResultVideo(null)
    setActiveEffect(null)
    setError(null)
    setUrl('')
  }, [])

  // Which effect's dials to show. Defaults to cutout until another is active.
  const dialCtx =
    activeEffect === 'vhs1'
      ? 'vhs'
      : activeEffect === 'parallax'
        ? 'parallax'
        : activeEffect === 'psychedelic'
          ? 'psychedelic'
          : 'cutout'

  return (
    <div className="is">
      {/* Effects rail */}
      <aside className="is__rail">
        <p className="is__rail-title">Effects</p>
        <div className="is__effects">
          {EFFECTS.map((fx) => (
            <button
              key={fx.id}
              className={`is__effect ${activeEffect === fx.id ? 'is__effect--active' : ''} ${
                fx.implemented ? '' : 'is__effect--soon'
              }`}
              onClick={() => runEffect(fx)}
              disabled={!fx.implemented || !originalSrc || processing}
              title={fx.implemented ? fx.name : 'Coming soon'}
            >
              <span className="is__effect-square">
                {fx.id === 'cutout' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path
                      d="M4 8V5a1 1 0 011-1h3M20 8V5a1 1 0 00-1-1h-3M4 16v3a1 1 0 001 1h3M20 16v3a1 1 0 01-1 1h-3"
                      strokeLinecap="round"
                    />
                    <circle cx="12" cy="12" r="3.5" />
                  </svg>
                ) : fx.id === 'vhs1' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="3" y="7" width="18" height="12" rx="2" />
                    <path d="M8 3l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    <line x1="7" y1="19" x2="7" y2="21" strokeLinecap="round" />
                    <line x1="17" y1="19" x2="17" y2="21" strokeLinecap="round" />
                  </svg>
                ) : fx.id === 'parallax' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M12 2l10 10-10 10L2 12 12 2z" strokeLinejoin="round" />
                    <path d="M12 8l4 4-4 4-4-4 4-4z" strokeLinejoin="round" />
                  </svg>
                ) : fx.id === 'psychedelic' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path
                      d="M12 12a2.5 2.5 0 114.5 1.5A5 5 0 0119 10a7 7 0 11-12.5 4.3A9.5 9.5 0 0012 21"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <span className="is__effect-dot" />
                )}
              </span>
              <span className="is__effect-name">{fx.name}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Stage */}
      <div className="is__stage-wrap">
        <div
          className={`is__stage ${dragOver ? 'is__stage--over' : ''}`}
          style={{ aspectRatio: `${FRAME_W} / ${FRAME_H}` }}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {resultVideo ? (
            <video
              className="is__image"
              ref={videoRef}
              src={resultVideo}
              autoPlay
              loop
              muted
              playsInline
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration
                setVideoDur(Number.isFinite(d) ? d : 0)
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => setVideoTime(e.currentTarget.currentTime)}
            />
          ) : originalSrc ? (
            <img className="is__image" src={originalSrc} alt="preview" />
          ) : (
            <div className="is__empty">
              <div className="is__empty-icon">🖼️</div>
              <p className="is__empty-title">Drop, paste, or link an image</p>
              <p className="is__empty-sub">JPEG · PNG · GIF · 1280 × 720 stage</p>
            </div>
          )}

          {processing && (
            <div className="is__overlay">
              <span className="transcribe-spinner" />
              <span>Working the magic…</span>
            </div>
          )}

          {originalSrc && (
            <button
              className="is__undo"
              onClick={undo}
              disabled={!canUndo}
              title="Undo effect"
              aria-label="Undo effect"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 14L4 9l5-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 9h11a5 5 0 015 5v1a5 5 0 01-5 5H8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>

        {/* Transport — scrub straight to the end instead of sitting through it */}
        {resultVideo && videoDur > 0 && (
          <div className="is__transport">
            <button
              className="is__tbtn"
              onClick={() => stepFrame(-1)}
              title="Previous frame"
              aria-label="Previous frame"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 5v14l-11-7 11-7zM6 5h2v14H6z" />
              </svg>
            </button>
            <button
              className="is__tbtn"
              onClick={togglePlay}
              title={playing ? 'Pause' : 'Play'}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 5l12 7-12 7z" />
                </svg>
              )}
            </button>
            <button
              className="is__tbtn"
              onClick={() => stepFrame(1)}
              title="Next frame"
              aria-label="Next frame"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 5l11 7-11 7zM16 5h2v14h-2z" />
              </svg>
            </button>
            <input
              className="is__scrub"
              type="range"
              min={0}
              max={videoDur}
              step={1 / resultFps}
              value={Math.min(videoTime, videoDur)}
              onChange={(e) => {
                videoRef.current?.pause()
                seek(Number(e.target.value))
              }}
            />
            <span className="is__ttime">
              {videoTime.toFixed(2)}s / {videoDur.toFixed(2)}s
            </span>
          </div>
        )}

        {/* Loader / actions */}
        <div className="is__loader">
          <input
            className="is__url-input"
            type="text"
            placeholder="Paste an image URL…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') loadFromUrl(url)
            }}
          />
          <button className="is__url-btn" onClick={() => loadFromUrl(url)} disabled={!url.trim()}>
            Load
          </button>
          <label className="is__browse">
            Browse
            <input
              type="file"
              accept="image/jpeg,image/png,image/gif"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) loadFile(f)
                e.target.value = ''
              }}
            />
          </label>
          {resultVideo && (
            <a className="is__download" href={resultVideo} download={`${activeEffect ?? 'effect'}.mp4`}>
              Download MP4
            </a>
          )}
          {originalSrc && (
            <button className="btn-ghost" onClick={reset}>
              Clear
            </button>
          )}
        </div>

        {/* Effect dials — contextual to the active effect */}
        {dialCtx === 'psychedelic' ? (
          <div className="is__controls">
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Length</span>
                <span className="is__slider-val">{psyDuration.toFixed(1)}s</span>
              </span>
              <input
                type="range"
                min={PSY_DUR_MIN}
                max={PSY_DUR_MAX}
                step={0.5}
                value={psyDuration}
                disabled={processing}
                onChange={(e) => setPsyDuration(Number(e.target.value))}
              />
            </label>
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Intensity</span>
                <span className="is__slider-val">{psyIntensity.toFixed(1)}×</span>
              </span>
              <input
                type="range"
                min={PSY_INT_MIN}
                max={PSY_INT_MAX}
                step={0.1}
                value={psyIntensity}
                disabled={processing}
                onChange={(e) => setPsyIntensity(Number(e.target.value))}
              />
            </label>
          </div>
        ) : dialCtx === 'parallax' ? (
          <div className="is__controls">
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Length</span>
                <span className="is__slider-val">{parDuration.toFixed(1)}s</span>
              </span>
              <input
                type="range"
                min={PAR_DUR_MIN}
                max={PAR_DUR_MAX}
                step={0.5}
                value={parDuration}
                disabled={processing}
                onChange={(e) => setParDuration(Number(e.target.value))}
              />
            </label>
          </div>
        ) : dialCtx === 'vhs' ? (
          <div className="is__controls">
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Length</span>
                <span className="is__slider-val">{vhsDuration.toFixed(1)}s</span>
              </span>
              <input
                type="range"
                min={VHS_DUR_MIN}
                max={VHS_DUR_MAX}
                step={0.5}
                value={vhsDuration}
                disabled={processing}
                onChange={(e) => setVhsDuration(Number(e.target.value))}
              />
            </label>
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Statics</span>
                <span className="is__slider-val">{statics}</span>
              </span>
              <input
                type="range"
                min={STATICS_MIN}
                max={STATICS_MAX}
                step={1}
                value={statics}
                disabled={processing}
                onChange={(e) => setStatics(Number(e.target.value))}
              />
            </label>
          </div>
        ) : (
          <div className="is__controls">
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Border thickness</span>
                <span className="is__slider-val">{borderPx}px</span>
              </span>
              <input
                type="range"
                min={BORDER_MIN}
                max={BORDER_MAX}
                step={1}
                value={borderPx}
                disabled={processing}
                onChange={(e) => setBorderPx(Number(e.target.value))}
              />
            </label>
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Length</span>
                <span className="is__slider-val">{duration.toFixed(1)}s</span>
              </span>
              <input
                type="range"
                min={DUR_MIN}
                max={DUR_MAX}
                step={0.1}
                value={duration}
                disabled={processing}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </label>
            <label className="is__slider">
              <span className="is__slider-head">
                <span>Flashes</span>
                <span className="is__slider-val">{flashes}</span>
              </span>
              <input
                type="range"
                min={FLASHES_MIN}
                max={FLASHES_MAX}
                step={1}
                value={flashes}
                disabled={processing}
                onChange={(e) => setFlashes(Number(e.target.value))}
              />
            </label>
          </div>
        )}

        {error && <p className="is__error">{error}</p>}
      </div>
    </div>
  )
}
