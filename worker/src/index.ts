// ── Bump this when publishing a new release ──────────────────────
const LATEST_VERSION = '1.0.0'
const DOWNLOAD_URL = 'https://funk-27.co.uk/video-bastard'
// ─────────────────────────────────────────────────────────────────

interface Env {
  OPENAI_API_KEY: string
  LS_API_KEY: string
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

async function validateLicence(key: string, lsApiKey: string): Promise<boolean> {
  const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lsApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ license_key: key }),
  })
  if (!res.ok) return false
  const data = await res.json() as { valid: boolean }
  return data.valid === true
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    const url = new URL(request.url)

    // GET /version — public, no auth required
    if (request.method === 'GET' && url.pathname === '/version') {
      return json({ version: LATEST_VERSION, downloadUrl: DOWNLOAD_URL })
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

    let body: Record<string, string>
    try {
      body = await request.json() as Record<string, string>
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }

    const { licenceKey } = body
    if (!licenceKey) return json({ error: 'Missing licenceKey' }, 400)

    const valid = await validateLicence(licenceKey, env.LS_API_KEY)
    if (!valid) return json({ error: 'Invalid or expired licence key' }, 401)

    // POST /activate — just validate the licence, no transcription needed
    if (url.pathname === '/activate') {
      return json({ valid: true })
    }

    // POST /transcribe — validate + call Whisper
    if (url.pathname === '/transcribe') {
      const { audioBase64 } = body
      if (!audioBase64) return json({ error: 'Missing audioBase64' }, 400)

      const audioBytes = base64ToUint8Array(audioBase64)
      const formData = new FormData()
      formData.append('file', new Blob([audioBytes], { type: 'audio/mpeg' }), 'audio.mp3')
      formData.append('model', 'whisper-1')
      formData.append('response_format', 'verbose_json')
      formData.append('timestamp_granularities[]', 'word')

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: formData,
      })

      if (!whisperRes.ok) {
        const err = await whisperRes.text()
        return json({ error: `OpenAI error: ${err}` }, 502)
      }

      const result = await whisperRes.json() as { words?: unknown[] }
      return json(result.words ?? [])
    }

    return json({ error: 'Not found' }, 404)
  },
}
