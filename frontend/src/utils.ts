import type { WikiSegment } from './types'

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, options)
  const contentType = res.headers.get('content-type') ?? ''
  const body = contentType.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    if (typeof body === 'object' && body && 'error' in body) {
      throw new Error(String(body.error))
    }
    throw new Error(typeof body === 'string' ? body : `Request failed (${res.status})`)
  }
  return body as T
}

export function shortText(value: string, max = 360) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

export function parseWikiSegments(raw: string): WikiSegment[] {
  const normalized = raw
    .replace(/\r/g, '')
    .replace(/\s*(==+[^=].*?==+)\s*/g, '\n$1\n')

  const segments: WikiSegment[] = []
  for (const lineRaw of normalized.split('\n')) {
    const line = lineRaw.trim()
    if (!line) continue

    const headingMatch = line.match(/^(=+)\s*(.*?)\s*\1$/)
    if (headingMatch) {
      const markerWidth = headingMatch[1].length
      const headingText = headingMatch[2].trim()
      if (headingText) {
        segments.push({
          kind: 'heading',
          text: headingText,
          level: Math.max(1, Math.min(3, markerWidth - 1)),
        })
      }
      continue
    }

    segments.push({ kind: 'paragraph', text: line })
  }
  return segments
}

export function formatLocalDate(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

export function formatChatTime(ts: string) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

let msgIdCounter = 0
export function nextMsgId() {
  return `msg_${Date.now()}_${++msgIdCounter}`
}

export function authHeaders(token: string, headers?: HeadersInit) {
  const out = new Headers(headers)
  out.set('Authorization', `Bearer ${token}`)
  return out
}

export async function runSafe(setError: (msg: string) => void, fn: () => Promise<void>) {
  try {
    setError('')
    await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setError(msg)
  }
}
