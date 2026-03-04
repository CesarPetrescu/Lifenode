import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import PublicIcon from '@mui/icons-material/Public'
import CancelIcon from '@mui/icons-material/Cancel'
import DeleteIcon from '@mui/icons-material/Delete'
import MapIcon from '@mui/icons-material/Map'

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
  const [osmLat, setOsmLat] = useState(44.4268)
  const [osmLon, setOsmLon] = useState(26.1025)
  const [osmZoom, setOsmZoom] = useState(6)
  const [deletingJobId, setDeletingJobId] = useState<number | null>(null)
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null)

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
  }

  const onStartCustom = async () => {
    if (!currentUsername || !customUrl.trim()) return
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

  const onDeleteJob = async (job: MapDownloadJob) => {
    if (!currentUsername) return
    if (!window.confirm(`Delete this download log entry?\n\n${job.label}`)) return
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
    if (!window.confirm(`Delete file "${item.name}"?`)) return
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

  const osmEmbedUrl = useMemo(
    () => buildOsmEmbedUrl(osmLat, osmLon, osmZoom),
    [osmLat, osmLon, osmZoom],
  )

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
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Preset Downloads
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {sourceName} presets for quick offline setup.
        </Typography>
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
                      disabled={!!runningJob}
                    >
                      Download
                    </Button>
                    <Button
                      variant="text"
                      size="small"
                      startIcon={<PublicIcon />}
                      onClick={() => window.open(preset.url, '_blank', 'noopener,noreferrer')}
                    >
                      Source URL
                    </Button>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          Custom Download URL
        </Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
          <TextField
            label="Direct download URL"
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
            value={customFileName}
            onChange={(e) => setCustomFileName(e.target.value)}
            sx={{ width: { xs: '100%', md: 240 } }}
          />
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mt: 1 }}>
          <TextField
            label="Label (optional)"
            value={customLabel}
            onChange={(e) => setCustomLabel(e.target.value)}
            fullWidth
          />
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={() => void onStartCustom()}
            disabled={!customUrl.trim() || !!runningJob}
          >
            Start Custom Download
          </Button>
        </Stack>
      </Paper>

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
                          onClick={() => void onDeleteJob(job)}
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
                    onClick={() => void onDeleteFile(item)}
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
              onChange={(e) => setKiwixUrl(e.target.value)}
              helperText="Use your Kiwix web server URL. Default is port 8081 on this host."
            />
            <Button
              variant="outlined"
              onClick={() => window.open(kiwixUrl, '_blank', 'noopener,noreferrer')}
              disabled={!kiwixUrl.trim()}
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
            {kiwixUrl.trim() && hasKiwixZim ? (
              <iframe title="Kiwix" src={kiwixUrl} style={{ border: 0, width: '100%', height: '100%' }} />
            ) : (
              <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  Download at least one Kiwix `.zim` file first, then the embedded viewer will start automatically.
                </Typography>
              </Box>
            )}
          </Box>
        </Paper>
      )}

      {!isWikiMode && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            OSM Visualizer
          </Typography>
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
        </Paper>
      )}
    </Stack>
  )
}
