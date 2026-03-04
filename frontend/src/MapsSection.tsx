import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import PublicIcon from '@mui/icons-material/Public'
import CancelIcon from '@mui/icons-material/Cancel'
import DeleteIcon from '@mui/icons-material/Delete'
import MapIcon from '@mui/icons-material/Map'

import ConfirmDialog from './ConfirmDialog'
import type {
  MapDatasetPreset,
  MapDownloadJob,
  MapFileItem,
  MapsCatalog,
  SectionProps,
} from './types'
import { api, authHeaders, formatLocalDate } from './utils'

type OfflineSource = 'kiwix' | 'osm'
type MapsSectionProps = SectionProps & { mode: OfflineSource }
type ConfirmAction = {
  title: string
  message: string
  confirmLabel: string
  confirmColor?: 'primary' | 'error' | 'warning' | 'success' | 'info'
  onConfirm: () => Promise<void> | void
}
type KiwixCatalogEntry = {
  id: string
  title: string
  summary: string
  name: string
  language: string
  category: string
  updated: string
  contentUrl: string
}

function bytesLabel(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value
  let idx = 0
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024
    idx += 1
  }
  return `${n.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`
}

function statusColor(status: MapDownloadJob['status']): 'default' | 'warning' | 'success' | 'error' {
  if (status === 'running' || status === 'queued') return 'warning'
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  return 'default'
}

function buildOsmEmbedUrl(lat: number, lon: number, zoom: number): string {
  const clampedZoom = Math.max(1, Math.min(18, zoom))
  const delta = 0.25 / clampedZoom
  const left = lon - delta
  const right = lon + delta
  const top = lat + delta
  const bottom = lat - delta
  const bbox = `${left}%2C${bottom}%2C${right}%2C${top}`
  const marker = `${lat}%2C${lon}`
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${marker}`
}

function fileNameFromUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    if (!last) return null
    return decodeURIComponent(last)
  } catch {
    return null
  }
}

function inferOsmViewport(pathOrName: string): { lat: number, lon: number, zoom: number } | null {
  const value = pathOrName.toLowerCase()
  if (value.includes('romania')) return { lat: 45.9432, lon: 24.9668, zoom: 6 }
  if (value.includes('europe')) return { lat: 54.526, lon: 15.2551, zoom: 4 }
  if (value.includes('us') || value.includes('usa') || value.includes('united-states')) {
    return { lat: 39.8283, lon: -98.5795, zoom: 4 }
  }
  if (value.includes('planet')) return { lat: 20, lon: 0, zoom: 2 }
  return null
}

function textFromXmlTag(parent: Element, tag: string): string {
  const node = parent.getElementsByTagNameNS('*', tag)[0] ?? parent.getElementsByTagName(tag)[0]
  return node?.textContent?.trim() ?? ''
}

const KIWIX_PORTAL_LINKS = [
  { title: 'Kiwix Library', url: 'https://library.kiwix.org/', description: 'Browse all Kiwix datasets by topic and language.' },
  { title: 'All ZIM Index', url: 'https://download.kiwix.org/zim/', description: 'Master index for all downloadable ZIM categories.' },
  { title: 'Wiktionary', url: 'https://download.kiwix.org/zim/wiktionary/', description: 'Offline dictionaries and translations.' },
  { title: 'Wikivoyage', url: 'https://download.kiwix.org/zim/wikivoyage/', description: 'Offline travel guides and destinations.' },
  { title: 'Wikibooks', url: 'https://download.kiwix.org/zim/wikibooks/', description: 'Textbooks and manuals.' },
  { title: 'Wikiversity', url: 'https://download.kiwix.org/zim/wikiversity/', description: 'Course-style learning resources.' },
  { title: 'Wikiquote', url: 'https://download.kiwix.org/zim/wikiquote/', description: 'Quotes and citation collections.' },
  { title: 'Wikisource', url: 'https://download.kiwix.org/zim/wikisource/', description: 'Source texts and public domain works.' },
  { title: 'Wikinews', url: 'https://download.kiwix.org/zim/wikinews/', description: 'Archived news content.' },
  { title: 'DevDocs', url: 'https://download.kiwix.org/zim/devdocs/', description: 'Offline developer documentation bundles.' },
  { title: 'Stack Exchange', url: 'https://download.kiwix.org/zim/stack_exchange/', description: 'Offline Q&A archives including Stack Overflow.' },
]

export default function MapsSection({ token, currentUsername, setError, mode }: MapsSectionProps) {
  const isWikiMode = mode === 'kiwix'
  const sourceLabel = isWikiMode ? 'Wiki' : 'Maps'
  const sourceName = isWikiMode ? 'KIWIX' : 'OSM'

  const [catalog, setCatalog] = useState<MapsCatalog | null>(null)
  const [jobs, setJobs] = useState<MapDownloadJob[]>([])
  const [files, setFiles] = useState<MapFileItem[]>([])

  const [customUrl, setCustomUrl] = useState('')
  const [customFileName, setCustomFileName] = useState('')
  const [customLabel, setCustomLabel] = useState('')

  const [kiwixUrl, setKiwixUrl] = useState('')
  const [kiwixViewUrl, setKiwixViewUrl] = useState('')
  const [kiwixCatalogEntries, setKiwixCatalogEntries] = useState<KiwixCatalogEntry[]>([])
  const [kiwixCatalogLoading, setKiwixCatalogLoading] = useState(false)
  const [kiwixCatalogError, setKiwixCatalogError] = useState('')
  const [kiwixCatalogFilter, setKiwixCatalogFilter] = useState('')
  const [osmLat, setOsmLat] = useState(44.4268)
  const [osmLon, setOsmLon] = useState(26.1025)
  const [osmZoom, setOsmZoom] = useState(6)
  const [osmUseDownloadedView, setOsmUseDownloadedView] = useState(false)
  const [osmSelectedDatasetPath, setOsmSelectedDatasetPath] = useState('')
  const [deletingJobId, setDeletingJobId] = useState<number | null>(null)
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

  const sourceJobs = useMemo(() => jobs.filter((job) => job.source === mode), [jobs, mode])
  const sourceFiles = useMemo(() => files.filter((item) => item.source === mode), [files, mode])
  const runningJob = sourceJobs.find((job) => job.status === 'running' || job.status === 'queued') ?? null

  const loadCatalog = useCallback(async () => {
    const data = await api<MapsCatalog>('/maps/catalog', {
      headers: authHeaders(token),
    })
    setCatalog(data)
    setKiwixUrl((prev) => {
      if (prev.trim()) return prev
      const fallback = `http://${window.location.hostname}:8081`
      const raw = data.kiwix_embed_url?.trim() || fallback
      try {
        const parsed = new URL(raw)
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          parsed.hostname = window.location.hostname
        }
        return parsed.toString()
      } catch {
        return fallback
      }
    })
  }, [token])

  const loadJobs = useCallback(async () => {
    if (!currentUsername) return
    const data = await api<MapDownloadJob[]>(`/maps/jobs/${encodeURIComponent(currentUsername)}`, {
      headers: authHeaders(token),
    })
    setJobs(data)
  }, [currentUsername, token])

  const loadFiles = useCallback(async () => {
    if (!currentUsername) return
    const data = await api<MapFileItem[]>(`/maps/files/${encodeURIComponent(currentUsername)}`, {
      headers: authHeaders(token),
    })
    setFiles(data)
  }, [currentUsername, token])

  const refreshAll = useCallback(async () => {
    setError('')
    await Promise.all([loadCatalog(), loadJobs(), loadFiles()])
  }, [loadCatalog, loadFiles, loadJobs, setError])

  useEffect(() => {
    void refreshAll().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [refreshAll, setError])

  useEffect(() => {
    if (!runningJob) return
    const timer = window.setInterval(() => {
      void Promise.all([loadJobs(), loadFiles()]).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [loadFiles, loadJobs, runningJob, setError])

  const onStartPreset = async (preset: MapDatasetPreset) => {
    if (!currentUsername) return
    const inferredName = fileNameFromUrl(preset.url)
    const existing = inferredName
      ? sourceFiles.find((item) => item.name === inferredName)
      : undefined
    setConfirmAction({
      title: existing ? 'Overwrite Existing File?' : 'Start Download?',
      message: existing
        ? `"${existing.name}" already exists.\n\nRe-download and overwrite it with:\n${preset.title}\nApprox size: ${preset.approx_size}`
        : `Start download now?\n\n${preset.title}\nApprox size: ${preset.approx_size}`,
      confirmLabel: existing ? 'Overwrite & Download' : 'Download',
      confirmColor: existing ? 'warning' : 'primary',
      onConfirm: async () => {
        try {
          setError('')
          await api<MapDownloadJob>(`/maps/jobs/${encodeURIComponent(currentUsername)}`, {
            method: 'POST',
            headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ preset_id: preset.id }),
          })
          await Promise.all([loadJobs(), loadFiles()])
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      },
    })
  }

  const onStartCustom = async () => {
    if (!currentUsername || !customUrl.trim()) return
    const requestedName = customFileName.trim() || fileNameFromUrl(customUrl.trim()) || ''
    const existing = requestedName
      ? sourceFiles.find((item) => item.name === requestedName)
      : undefined
    setConfirmAction({
      title: existing ? 'Overwrite Existing File?' : 'Start Custom Download?',
      message: existing
        ? `"${existing.name}" already exists.\n\nRe-download and overwrite it from:\n${customUrl.trim()}`
        : `Start custom download from:\n${customUrl.trim()}`,
      confirmLabel: existing ? 'Overwrite & Download' : 'Start Download',
      confirmColor: existing ? 'warning' : 'primary',
      onConfirm: async () => {
        try {
          setError('')
          await api<MapDownloadJob>(`/maps/jobs/${encodeURIComponent(currentUsername)}`, {
            method: 'POST',
            headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              source: mode,
              url: customUrl.trim(),
              file_name: customFileName.trim() || undefined,
              label: customLabel.trim() || undefined,
            }),
          })
          setCustomUrl('')
          setCustomFileName('')
          setCustomLabel('')
          await Promise.all([loadJobs(), loadFiles()])
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      },
    })
  }

  const runConfirmAction = async () => {
    if (!confirmAction) return
    setConfirmLoading(true)
    try {
      await confirmAction.onConfirm()
      setConfirmAction(null)
    } finally {
      setConfirmLoading(false)
    }
  }

  const onDeleteJob = async (job: MapDownloadJob) => {
    if (!currentUsername) return
    try {
      setDeletingJobId(job.id)
      setError('')
      await api<void>(`/maps/jobs/${encodeURIComponent(currentUsername)}/${job.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      })
      await loadJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingJobId(null)
    }
  }

  const onCancelJob = async (jobId: number) => {
    if (!currentUsername) return
    try {
      setError('')
      await api<MapDownloadJob>(`/maps/jobs/${encodeURIComponent(currentUsername)}/${jobId}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
      })
      await loadJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDownloadFile = async (item: MapFileItem) => {
    if (!currentUsername) return
    try {
      setError('')
      const res = await fetch(
        `/api/maps/download/${encodeURIComponent(currentUsername)}?path=${encodeURIComponent(item.path)}`,
        { headers: authHeaders(token) },
      )
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Download failed (${res.status})`)
      }
      const blob = await res.blob()
      const objectUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = item.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(objectUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDeleteFile = async (item: MapFileItem) => {
    if (!currentUsername) return
    try {
      setDeletingFilePath(item.path)
      setError('')
      await api<void>(
        `/maps/files/${encodeURIComponent(currentUsername)}?path=${encodeURIComponent(item.path)}`,
        {
          method: 'DELETE',
          headers: authHeaders(token),
        },
      )
      await loadFiles()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingFilePath(null)
    }
  }

  const visiblePresets = useMemo(() => {
    if (!catalog) return []
    return isWikiMode ? catalog.kiwix : catalog.osm
  }, [catalog, isWikiMode])

  const hasKiwixZim = useMemo(
    () => sourceFiles.some((f) => f.name.toLowerCase().endsWith('.zim')),
    [sourceFiles],
  )
  const osmDownloadedFiles = useMemo(
    () =>
      sourceFiles.filter((f) => {
        const lower = f.name.toLowerCase()
        return lower.endsWith('.osm.pbf') || lower.endsWith('.osm') || lower.endsWith('.pbf')
      }),
    [sourceFiles],
  )

  const osmEmbedUrl = useMemo(
    () => buildOsmEmbedUrl(osmLat, osmLon, osmZoom),
    [osmLat, osmLon, osmZoom],
  )
  const kiwixViewerUrl = useMemo(
    () => (kiwixViewUrl.trim() ? kiwixViewUrl.trim() : kiwixUrl.trim()),
    [kiwixUrl, kiwixViewUrl],
  )
  const visibleKiwixCatalogEntries = useMemo(() => {
    const q = kiwixCatalogFilter.trim().toLowerCase()
    if (!q) return kiwixCatalogEntries
    return kiwixCatalogEntries.filter((entry) => {
      const haystack = `${entry.title} ${entry.name} ${entry.category} ${entry.language}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [kiwixCatalogEntries, kiwixCatalogFilter])

  useEffect(() => {
    if (!osmUseDownloadedView) return
    if (osmSelectedDatasetPath && osmDownloadedFiles.some((item) => item.path === osmSelectedDatasetPath)) return
    setOsmSelectedDatasetPath(osmDownloadedFiles[0]?.path ?? '')
  }, [osmDownloadedFiles, osmSelectedDatasetPath, osmUseDownloadedView])

  useEffect(() => {
    if (!osmUseDownloadedView || !osmSelectedDatasetPath) return
    const inferred = inferOsmViewport(osmSelectedDatasetPath)
    if (!inferred) return
    setOsmLat(inferred.lat)
    setOsmLon(inferred.lon)
    setOsmZoom(inferred.zoom)
  }, [osmSelectedDatasetPath, osmUseDownloadedView])

  const loadKiwixCatalog = useCallback(async () => {
    if (!isWikiMode || !kiwixUrl.trim() || !hasKiwixZim) {
      setKiwixCatalogEntries([])
      setKiwixCatalogError('')
      return
    }
    setKiwixCatalogLoading(true)
    setKiwixCatalogError('')
    try {
      const catalogUrl = new URL('/catalog/v2/entries?count=-1', kiwixUrl).toString()
      const res = await fetch(catalogUrl)
      if (!res.ok) {
        throw new Error(`Failed to load Kiwix catalog (${res.status})`)
      }
      const xmlText = await res.text()
      const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
      const parseError = doc.querySelector('parsererror')
      if (parseError) {
        throw new Error('Kiwix catalog parse error')
      }
      const nodes = Array.from(doc.getElementsByTagNameNS('*', 'entry'))
      const entries = nodes.map((node) => {
        const title = textFromXmlTag(node, 'title')
        const summary = textFromXmlTag(node, 'summary')
        const name = textFromXmlTag(node, 'name')
        const id = textFromXmlTag(node, 'id') || name || title
        const language = textFromXmlTag(node, 'language')
        const category = textFromXmlTag(node, 'category')
        const updated = textFromXmlTag(node, 'updated')
        const linkNodes = Array.from(node.getElementsByTagNameNS('*', 'link'))
        const contentHref =
          linkNodes.find((linkNode) => (linkNode.getAttribute('type') || '').includes('text/html'))
            ?.getAttribute('href')
          || ''
        const contentUrl = contentHref ? new URL(contentHref, kiwixUrl).toString() : kiwixUrl
        return {
          id,
          title,
          summary,
          name,
          language,
          category,
          updated,
          contentUrl,
        }
      })
      entries.sort((a, b) => a.title.localeCompare(b.title))
      setKiwixCatalogEntries(entries)
    } catch (err) {
      setKiwixCatalogError(err instanceof Error ? err.message : String(err))
      setKiwixCatalogEntries([])
    } finally {
      setKiwixCatalogLoading(false)
    }
  }, [hasKiwixZim, isWikiMode, kiwixUrl])

  useEffect(() => {
    void loadKiwixCatalog()
  }, [loadKiwixCatalog])

  return (
    <Stack spacing={2.2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} justifyContent="space-between">
          <Box>
            <Typography variant="h5">{isWikiMode ? 'Wiki + Offline Knowledge' : 'Maps + Offline'}</Typography>
            <Typography variant="body2" color="text.secondary">
              {isWikiMode
                ? 'Kiwix-powered Wikipedia downloader with embedded offline reader.'
                : 'OpenStreetMap downloader with in-app map visualizer.'}
            </Typography>
          </Box>
          <Chip
            icon={<MapIcon />}
            color={runningJob ? 'warning' : 'default'}
            label={runningJob ? `Downloading: ${runningJob.label}` : `No active ${sourceLabel.toLowerCase()} download`}
          />
        </Stack>
        <Alert severity="info" sx={{ mt: 1.4 }}>
          Downloads start only when you press <strong>Download</strong> or <strong>Start Custom Download</strong> and confirm.
        </Alert>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Preset Downloads
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {sourceName} presets for quick offline setup.
        </Typography>
        {visiblePresets.length === 0 ? (
          <Alert severity="warning" sx={{ mb: 1.2 }}>
            Presets are unavailable right now. Refresh the page and try again.
          </Alert>
        ) : (
          <Stack spacing={1.2}>
            {visiblePresets.map((preset) => (
              <Card key={preset.id} variant="outlined">
                <CardContent>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2} justifyContent="space-between">
                    <Box>
                      <Typography variant="subtitle1">{preset.title}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {preset.description}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Size: {preset.approx_size}
                      </Typography>
                    </Box>
                    <Stack direction={{ xs: 'row', md: 'column' }} spacing={1} alignItems={{ md: 'flex-end' }}>
                      <Button
                        variant="contained"
                        size="small"
                        startIcon={<DownloadIcon />}
                        onClick={() => void onStartPreset(preset)}
                        disabled={!!runningJob || confirmLoading}
                      >
                        Download
                      </Button>
                      <Button
                        variant="text"
                        size="small"
                        startIcon={<PublicIcon />}
                        component="a"
                        href={preset.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Source URL
                      </Button>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          Custom Download URL
        </Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
          <TextField
            label="Direct download URL"
            placeholder={isWikiMode ? 'https://download.kiwix.org/zim/…' : 'https://download.geofabrik.de/…'}
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            fullWidth
            helperText={
              isWikiMode
                ? 'Use direct .zim files from Kiwix mirrors.'
                : 'Use direct .osm.pbf files (Geofabrik or planet mirrors).'
            }
          />
          <TextField
            label="File name (optional)"
            placeholder={isWikiMode ? 'wikipedia_en_….zim' : 'romania-latest.osm.pbf'}
            value={customFileName}
            onChange={(e) => setCustomFileName(e.target.value)}
            sx={{ width: { xs: '100%', md: 240 } }}
          />
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mt: 1 }}>
          <TextField
            label="Label (optional)"
            placeholder="Friendly label…"
            value={customLabel}
            onChange={(e) => setCustomLabel(e.target.value)}
            fullWidth
          />
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={() => void onStartCustom()}
            disabled={!customUrl.trim() || !!runningJob || confirmLoading}
          >
            Start Custom Download
          </Button>
        </Stack>
      </Paper>

      {isWikiMode && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            More Kiwix Sources
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Direct entry points for Wikimedia projects and other offline datasets.
          </Typography>
          <Stack spacing={1}>
            {KIWIX_PORTAL_LINKS.map((item) => (
              <Stack
                key={item.url}
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                spacing={1}
                sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}
              >
                <Box>
                  <Typography variant="subtitle2">{item.title}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {item.description}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant="text"
                  startIcon={<PublicIcon />}
                  component="a"
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Source
                </Button>
              </Stack>
            ))}
          </Stack>
        </Paper>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          {sourceLabel} Download Jobs
        </Typography>
        {sourceJobs.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No {sourceLabel.toLowerCase()} jobs yet.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {sourceJobs.map((job) => (
              <Card key={job.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" spacing={1}>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="subtitle2">{job.label}</Typography>
                        <Chip size="small" label={job.status} color={statusColor(job.status)} />
                        <Chip size="small" variant="outlined" label={job.source.toUpperCase()} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {job.target_path}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {bytesLabel(job.bytes_downloaded)} /{' '}
                        {job.bytes_total != null ? bytesLabel(job.bytes_total) : 'unknown'}
                        {' • '}
                        updated {formatLocalDate(job.updated_at)}
                      </Typography>
                      {job.error_message && (
                        <Typography variant="caption" color="error" sx={{ display: 'block' }}>
                          {job.error_message}
                        </Typography>
                      )}
                    </Box>
                    <Stack direction="row" spacing={1}>
                      {(job.status === 'running' || job.status === 'queued') && (
                        <Button
                          color="error"
                          variant="text"
                          startIcon={<CancelIcon />}
                          onClick={() => void onCancelJob(job.id)}
                        >
                          Cancel
                        </Button>
                      )}
                      {job.status !== 'running' && job.status !== 'queued' && (
                        <Button
                          color="error"
                          variant="text"
                          startIcon={<DeleteIcon />}
                          onClick={() =>
                            setConfirmAction({
                              title: 'Delete Download Log Entry',
                              message: `Delete this download job log?\n\n${job.label}`,
                              confirmLabel: 'Delete',
                              confirmColor: 'error',
                              onConfirm: async () => {
                                await onDeleteJob(job)
                              },
                            })}
                          disabled={deletingJobId === job.id}
                        >
                          {deletingJobId === job.id ? 'Deleting…' : 'Delete'}
                        </Button>
                      )}
                    </Stack>
                  </Stack>
                  <LinearProgress
                    variant={job.progress != null ? 'determinate' : 'indeterminate'}
                    value={job.progress ?? undefined}
                    sx={{ mt: 1.2 }}
                  />
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Downloaded Files
        </Typography>
        {sourceFiles.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No {sourceLabel.toLowerCase()} files downloaded yet.
          </Typography>
        ) : (
          <Stack spacing={0.8}>
            {sourceFiles.map((item) => (
              <Stack
                key={`${item.path}-${item.modified_at}`}
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                spacing={1}
                sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}
              >
                <Box>
                  <Typography variant="subtitle2">{item.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {item.source.toUpperCase()} • {bytesLabel(item.size)} • {formatLocalDate(item.modified_at)}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => void onDownloadFile(item)}
                    disabled={deletingFilePath === item.path}
                  >
                    Download
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    variant="text"
                    startIcon={<DeleteIcon />}
                    onClick={() =>
                      setConfirmAction({
                        title: 'Delete Downloaded File',
                        message: `Delete file "${item.name}"?`,
                        confirmLabel: 'Delete',
                        confirmColor: 'error',
                        onConfirm: async () => {
                          await onDeleteFile(item)
                        },
                      })}
                    disabled={deletingFilePath === item.path}
                  >
                    {deletingFilePath === item.path ? 'Deleting…' : 'Delete'}
                  </Button>
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Paper>

      {isWikiMode && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Kiwix Viewer (Embedded)
          </Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mb: 1.2 }}>
            <TextField
              fullWidth
              label="Kiwix URL"
              value={kiwixUrl}
              onChange={(e) => {
                setKiwixUrl(e.target.value)
                setKiwixViewUrl('')
              }}
              helperText="Use your Kiwix web server URL. To switch datasets, return to Kiwix home and clear category filters."
            />
            <Button
              variant="text"
              onClick={() => setKiwixViewUrl('')}
              disabled={!kiwixViewUrl.trim()}
            >
              Library Home
            </Button>
            <Button
              variant="outlined"
              component="a"
              href={kiwixViewerUrl.trim() ? kiwixViewerUrl : undefined}
              target="_blank"
              rel="noopener noreferrer"
              disabled={!kiwixViewerUrl.trim()}
            >
              Open Fullscreen
            </Button>
          </Stack>
          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              overflow: 'hidden',
              height: { xs: 360, md: 520 },
            }}
          >
            {kiwixViewerUrl.trim() && hasKiwixZim ? (
              <iframe
                title="Kiwix"
                src={kiwixViewerUrl}
                style={{
                  border: 0,
                  width: '100%',
                  height: '100%',
                }}
              />
            ) : (
              <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  Download at least one Kiwix `.zim` file first, then the embedded viewer will start automatically.
                </Typography>
              </Box>
            )}
          </Box>
          <Divider sx={{ my: 1.5 }} />
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
            <Typography variant="subtitle1" sx={{ minWidth: { md: 180 } }}>
              ZIM Viewer Navigator
            </Typography>
            <TextField
              size="small"
              label="Filter Datasets"
              placeholder="Wikipedia, DevDocs…"
              value={kiwixCatalogFilter}
              onChange={(e) => setKiwixCatalogFilter(e.target.value)}
              fullWidth
            />
            <Button
              size="small"
              variant="outlined"
              onClick={() => void loadKiwixCatalog()}
              disabled={kiwixCatalogLoading}
            >
              {kiwixCatalogLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </Stack>
          {kiwixCatalogError && (
            <Alert severity="warning" sx={{ mt: 1.2 }}>
              {kiwixCatalogError}
            </Alert>
          )}
          {kiwixCatalogLoading ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.2 }}>
              Loading catalog…
            </Typography>
          ) : visibleKiwixCatalogEntries.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.2 }}>
              No catalog entries found yet.
            </Typography>
          ) : (
            <Stack spacing={0.8} sx={{ mt: 1.2, maxHeight: 300, overflowY: 'auto', pr: 0.5 }}>
              {visibleKiwixCatalogEntries.map((entry) => (
                <Stack
                  key={entry.id}
                  direction={{ xs: 'column', md: 'row' }}
                  justifyContent="space-between"
                  spacing={1}
                  sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.title || entry.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {entry.summary || 'No description'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {(entry.category || 'uncategorized').toUpperCase()}
                      {entry.language ? ` • ${entry.language.toUpperCase()}` : ''}
                      {entry.updated ? ` • ${formatLocalDate(entry.updated)}` : ''}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => setKiwixViewUrl(entry.contentUrl)}
                    >
                      View Here
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      component="a"
                      href={entry.contentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open Tab
                    </Button>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          )}
        </Paper>
      )}

      {!isWikiMode && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            OSM Visualizer
          </Typography>
          <FormControlLabel
            sx={{ mb: 1 }}
            control={
              <Switch
                size="small"
                checked={osmUseDownloadedView}
                onChange={(e) => setOsmUseDownloadedView(e.target.checked)}
                disabled={osmDownloadedFiles.length === 0}
              />
            }
            label="Center map from downloaded dataset (no local rendering)"
          />
          {osmDownloadedFiles.length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Download an `.osm` or `.osm.pbf` file first to enable downloaded dataset view.
            </Typography>
          )}
          {osmUseDownloadedView && (
            <FormControl size="small" sx={{ mb: 1.2, width: { xs: '100%', md: 420 } }}>
              <InputLabel id="osm-dataset-label">Downloaded Dataset</InputLabel>
              <Select
                labelId="osm-dataset-label"
                label="Downloaded Dataset"
                value={osmSelectedDatasetPath}
                onChange={(e) => setOsmSelectedDatasetPath(e.target.value)}
              >
                {osmDownloadedFiles.map((item) => (
                  <MenuItem key={item.path} value={item.path}>
                    {item.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mb: 1.2 }}>
            <TextField
              type="number"
              label="Latitude"
              value={osmLat}
              onChange={(e) => setOsmLat(Number(e.target.value))}
              sx={{ width: { xs: '100%', md: 180 } }}
            />
            <TextField
              type="number"
              label="Longitude"
              value={osmLon}
              onChange={(e) => setOsmLon(Number(e.target.value))}
              sx={{ width: { xs: '100%', md: 180 } }}
            />
            <TextField
              type="number"
              label="Zoom"
              value={osmZoom}
              onChange={(e) => setOsmZoom(Number(e.target.value))}
              sx={{ width: { xs: '100%', md: 120 } }}
            />
          </Stack>
          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              overflow: 'hidden',
              height: { xs: 340, md: 500 },
            }}
          >
            <iframe title="OSM Visualizer" src={osmEmbedUrl} style={{ border: 0, width: '100%', height: '100%' }} />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            {osmUseDownloadedView
              ? 'This mode uses your downloaded file name to pick a map center/zoom when recognized. Tile rendering is still online OpenStreetMap.'
              : 'Viewer uses OpenStreetMap online tiles.'}
          </Typography>
        </Paper>
      )}
      <ConfirmDialog
        open={confirmAction != null}
        title={confirmAction?.title ?? 'Confirm Action'}
        message={confirmAction?.message ?? ''}
        confirmLabel={confirmAction?.confirmLabel ?? 'Confirm'}
        confirmColor={confirmAction?.confirmColor ?? 'primary'}
        loading={confirmLoading}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => void runConfirmAction()}
      />
    </Stack>
  )
}
