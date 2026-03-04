import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import DeleteIcon from '@mui/icons-material/Delete'
import FolderIcon from '@mui/icons-material/Folder'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import DownloadIcon from '@mui/icons-material/Download'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { DriveFolder, DriveTree, DriveTreeFile, SectionProps } from './types'
import { API_BASE, api, authHeaders, formatLocalDate } from './utils'

type PreviewKind = 'markdown' | 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'binary'

type FilePreview = {
  kind: PreviewKind
  name: string
  path: string
  objectUrl?: string
  textContent?: string
  mimeType: string
  size: number
  modifiedAt: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function detectPreviewKind(name: string): PreviewKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'txt' || ext === 'log' || ext === 'json' || ext === 'csv' || ext === 'xml' || ext === 'yml' || ext === 'yaml') return 'text'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'svg' || ext === 'bmp' || ext === 'avif') return 'image'
  if (ext === 'mp3' || ext === 'wav' || ext === 'ogg' || ext === 'm4a' || ext === 'flac' || ext === 'aac') return 'audio'
  if (ext === 'mp4' || ext === 'webm' || ext === 'mov' || ext === 'mkv' || ext === 'avi' || ext === 'm4v') return 'video'
  return 'binary'
}

function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'md': return 'text/markdown'
    case 'txt': return 'text/plain'
    case 'json': return 'application/json'
    case 'csv': return 'text/csv'
    case 'pdf': return 'application/pdf'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'ogg': return 'audio/ogg'
    case 'm4a': return 'audio/mp4'
    case 'flac': return 'audio/flac'
    case 'mp4': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'mov': return 'video/quicktime'
    case 'mkv': return 'video/x-matroska'
    default: return 'application/octet-stream'
  }
}

function folderKey(path?: string | null): string | null {
  return path ?? null
}

export default function DriveSection({ token, currentUsername, setError }: SectionProps) {
  const [folders, setFolders] = useState<DriveFolder[]>([])
  const [files, setFiles] = useState<DriveTreeFile[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loadingTree, setLoadingTree] = useState(false)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)

  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [createFolderName, setCreateFolderName] = useState('')

  const lastObjectUrlRef = useRef<string | null>(null)

  const foldersByParent = useMemo(() => {
    const map = new Map<string | null, DriveFolder[]>()
    for (const folder of folders) {
      const key = folderKey(folder.parent_path)
      const arr = map.get(key) ?? []
      arr.push(folder)
      map.set(key, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [folders])

  const filesByParent = useMemo(() => {
    const map = new Map<string | null, DriveTreeFile[]>()
    for (const file of files) {
      const key = folderKey(file.parent_path)
      const arr = map.get(key) ?? []
      arr.push(file)
      map.set(key, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [files])

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedFilePath) ?? null,
    [files, selectedFilePath],
  )

  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.path === selectedFolderPath) ?? null,
    [folders, selectedFolderPath],
  )

  const replacePreview = useCallback((next: FilePreview | null) => {
    setPreview((prev) => {
      if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl)
      return next
    })
  }, [])

  useEffect(() => () => {
    if (lastObjectUrlRef.current) {
      URL.revokeObjectURL(lastObjectUrlRef.current)
      lastObjectUrlRef.current = null
    }
  }, [])

  useEffect(() => {
    if (preview?.objectUrl) {
      if (lastObjectUrlRef.current && lastObjectUrlRef.current !== preview.objectUrl) {
        URL.revokeObjectURL(lastObjectUrlRef.current)
      }
      lastObjectUrlRef.current = preview.objectUrl
    }
  }, [preview])

  const loadTree = useCallback(async (preferredPath?: string | null) => {
    if (!currentUsername || !token) return
    setLoadingTree(true)
    try {
      setError('')
      const data = await api<DriveTree>(`/drive/tree/${encodeURIComponent(currentUsername)}`, {
        headers: authHeaders(token),
      })
      setFolders(data.folders)
      setFiles(data.files)
      setExpandedFolders((prev) => {
        const next = new Set<string>()
        for (const path of prev) {
          if (data.folders.some((folder) => folder.path === path)) next.add(path)
        }
        for (const folder of data.folders) {
          if (!folder.parent_path) next.add(folder.path)
        }
        return next
      })
      setSelectedFolderPath((prev) => {
        if (prev && data.folders.some((folder) => folder.path === prev)) return prev
        return null
      })
      const target = preferredPath ?? selectedFilePath
      const nextFile = target && data.files.some((file) => file.path === target)
        ? target
        : (data.files[0]?.path ?? null)
      setSelectedFilePath(nextFile)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingTree(false)
    }
  }, [currentUsername, selectedFilePath, setError, token])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  const loadPreview = useCallback(async (file: DriveTreeFile | null) => {
    if (!file || !currentUsername || !token) {
      replacePreview(null)
      return
    }

    setLoadingPreview(true)
    try {
      setError('')
      const res = await fetch(
        `${API_BASE}/drive/content/${encodeURIComponent(currentUsername)}?path=${encodeURIComponent(file.path)}`,
        { headers: authHeaders(token) },
      )
      if (!res.ok) {
        const text = await res.text()
        try {
          const obj = JSON.parse(text) as { error?: string }
          throw new Error(obj.error ?? text)
        } catch {
          throw new Error(text || `Request failed (${res.status})`)
        }
      }

      const originalBlob = await res.blob()
      const kind = detectPreviewKind(file.name)
      const mimeType = mimeFromName(file.name)

      if (kind === 'markdown' || kind === 'text') {
        const textContent = await originalBlob.text()
        replacePreview({
          kind,
          name: file.name,
          path: file.path,
          textContent,
          mimeType,
          size: file.size,
          modifiedAt: file.modified_at,
        })
        return
      }

      if (kind === 'pdf' || kind === 'image' || kind === 'audio' || kind === 'video') {
        const blob = new Blob([originalBlob], { type: mimeType })
        const objectUrl = URL.createObjectURL(blob)
        replacePreview({
          kind,
          name: file.name,
          path: file.path,
          objectUrl,
          mimeType,
          size: file.size,
          modifiedAt: file.modified_at,
        })
        return
      }

      replacePreview({
        kind: 'binary',
        name: file.name,
        path: file.path,
        mimeType,
        size: file.size,
        modifiedAt: file.modified_at,
      })
    } catch (err) {
      replacePreview(null)
      setError(errorMessage(err))
    } finally {
      setLoadingPreview(false)
    }
  }, [currentUsername, replacePreview, setError, token])

  useEffect(() => {
    void loadPreview(selectedFile)
  }, [loadPreview, selectedFile])

  const onCreateFolder = async () => {
    if (!currentUsername || !token || !createFolderName.trim()) return
    setCreatingFolder(true)
    try {
      setError('')
      const created = await api<DriveFolder>(`/drive/folders/${encodeURIComponent(currentUsername)}`, {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: createFolderName.trim(),
          parent_path: selectedFolderPath,
        }),
      })
      setCreateFolderOpen(false)
      setCreateFolderName('')
      setSelectedFolderPath(created.path)
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        if (created.parent_path) next.add(created.parent_path)
        next.add(created.path)
        return next
      })
      await loadTree(selectedFilePath)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCreatingFolder(false)
    }
  }

  const onUploadFile = async (file: File | null) => {
    if (!currentUsername || !token || !file) return
    setUploading(true)
    try {
      setError('')
      const formData = new FormData()
      formData.append('folder_path', selectedFolderPath ?? '')
      formData.append('file', file)
      const result = await api<{ path?: string }>(`/drive/upload/${encodeURIComponent(currentUsername)}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: formData,
      })
      await loadTree(result.path ?? selectedFilePath)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setUploading(false)
    }
  }

  const onDeleteFile = async (path: string) => {
    if (!currentUsername || !token) return
    if (!window.confirm('Delete this file?')) return
    try {
      setError('')
      await api(
        `/drive/content/${encodeURIComponent(currentUsername)}?path=${encodeURIComponent(path)}`,
        {
          method: 'DELETE',
          headers: authHeaders(token),
        },
      )
      if (selectedFilePath === path) {
        setSelectedFilePath(null)
        replacePreview(null)
      }
      await loadTree()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onDeleteFolder = async (path: string) => {
    if (!currentUsername || !token) return
    if (!window.confirm('Delete this folder and all nested files/folders?')) return
    try {
      setError('')
      await api(
        `/drive/folders/${encodeURIComponent(currentUsername)}?path=${encodeURIComponent(path)}`,
        {
          method: 'DELETE',
          headers: authHeaders(token),
        },
      )
      if (selectedFolderPath === path) setSelectedFolderPath(null)
      if (selectedFilePath?.startsWith(`${path}/`) || selectedFilePath === path) {
        setSelectedFilePath(null)
        replacePreview(null)
      }
      await loadTree()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onDownloadFile = async (file: DriveTreeFile) => {
    if (!currentUsername || !token) return
    try {
      setError('')
      const res = await fetch(
        `${API_BASE}/drive/download/${encodeURIComponent(currentUsername)}?path=${encodeURIComponent(file.path)}`,
        { headers: authHeaders(token) },
      )
      if (!res.ok) {
        const text = await res.text()
        try {
          const obj = JSON.parse(text) as { error?: string }
          throw new Error(obj.error ?? text)
        } catch {
          throw new Error(text || `Request failed (${res.status})`)
        }
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const renderFiles = (parentPath: string | null, depth: number) => {
    const list = filesByParent.get(parentPath) ?? []
    return list.map((file) => (
      <Button
        key={`file-${file.path}`}
        fullWidth
        aria-label={`Open file ${file.name}`}
        onClick={() => {
          setSelectedFolderPath(file.parent_path ?? null)
          setSelectedFilePath(file.path)
        }}
        sx={{
          justifyContent: 'space-between',
          textTransform: 'none',
          pl: `${1 + depth * 1.35}rem`,
          py: 0.55,
          borderRadius: 1,
          bgcolor: selectedFilePath === file.path ? (t) => alpha(t.palette.primary.main, 0.15) : 'transparent',
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
          <InsertDriveFileIcon fontSize="small" />
          <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {Math.max(1, Math.ceil(file.size / 1024))} KB
        </Typography>
      </Button>
    ))
  }

  const renderFolderTree = (folder: DriveFolder, depth: number): ReactNode => {
    const isExpanded = expandedFolders.has(folder.path)
    const children = foldersByParent.get(folder.path) ?? []
    return (
      <Box key={`folder-${folder.path}`}>
        <Box
          sx={{
            borderRadius: 1,
            bgcolor: selectedFolderPath === folder.path ? (t) => alpha(t.palette.secondary.main, 0.15) : 'transparent',
          }}
        >
          <Stack
            direction="row"
            spacing={0.35}
            alignItems="center"
            sx={{ pl: `${0.35 + depth * 1.35}rem`, pr: 0.35, py: 0.2 }}
          >
            <IconButton
              size="small"
              aria-label={isExpanded ? `Collapse folder ${folder.name}` : `Expand folder ${folder.name}`}
              onClick={() => {
                setExpandedFolders((prev) => {
                  const next = new Set(prev)
                  if (next.has(folder.path)) next.delete(folder.path)
                  else next.add(folder.path)
                  return next
                })
              }}
            >
              {isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
            </IconButton>
            <Button
              fullWidth
              aria-label={`Open folder ${folder.name}`}
              onClick={() => setSelectedFolderPath(folder.path)}
              sx={{
                justifyContent: 'flex-start',
                textTransform: 'none',
                py: 0.3,
                borderRadius: 1,
                minWidth: 0,
              }}
            >
              <Stack direction="row" spacing={0.6} alignItems="center" sx={{ minWidth: 0 }}>
                {isExpanded ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />}
                <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {folder.name}
                </Typography>
              </Stack>
            </Button>
            <IconButton
              size="small"
              color="error"
              aria-label={`Delete folder ${folder.name}`}
              onClick={() => {
                void onDeleteFolder(folder.path)
              }}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Stack>
        </Box>
        {isExpanded && (
          <>
            {renderFiles(folder.path, depth + 1)}
            {children.map((child) => renderFolderTree(child, depth + 1))}
          </>
        )}
      </Box>
    )
  }

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} sx={{ minHeight: { xs: 720, md: 'calc(100dvh - 170px)' } }}>
        <Box
          sx={{
            width: { xs: '100%', md: 360 },
            borderRight: { xs: 0, md: 1 },
            borderBottom: { xs: 1, md: 0 },
            borderColor: 'divider',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box sx={{ p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6">Drive</Typography>
              {loadingTree && <CircularProgress size={16} />}
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<CreateNewFolderIcon />}
                onClick={() => {
                  setCreateFolderName('')
                  setCreateFolderOpen(true)
                }}
              >
                Folder
              </Button>
              <Button
                component="label"
                size="small"
                variant="outlined"
                startIcon={uploading ? <CircularProgress size={14} color="inherit" /> : <UploadFileIcon />}
                disabled={uploading}
              >
                Upload
                <input
                  hidden
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null
                    void onUploadFile(file)
                    e.currentTarget.value = ''
                  }}
                />
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              Current folder: {selectedFolder?.path ?? 'Root'}
            </Typography>
          </Box>
          <Divider />
          <Box sx={{ p: 1, flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {folders.length === 0 && files.length === 0 && !loadingTree ? (
              <Alert severity="info">No files yet. Create a folder or upload a file.</Alert>
            ) : (
              <>
                {renderFiles(null, 0)}
                {(foldersByParent.get(null) ?? []).map((folder) => renderFolderTree(folder, 0))}
              </>
            )}
          </Box>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h6" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedFile?.name ?? 'Preview'}
                </Typography>
                {selectedFile && (
                  <Typography variant="caption" color="text.secondary">
                    {selectedFile.path} | {Math.max(1, Math.ceil(selectedFile.size / 1024))} KB | {formatLocalDate(selectedFile.modified_at)}
                  </Typography>
                )}
              </Box>
              {selectedFile && (
                <Stack direction="row" spacing={1}>
                  <Tooltip title="Download">
                    <IconButton aria-label={`Download file ${selectedFile.name}`} onClick={() => void onDownloadFile(selectedFile)}>
                      <DownloadIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete file">
                    <IconButton color="error" aria-label={`Delete file ${selectedFile.name}`} onClick={() => void onDeleteFile(selectedFile.path)}>
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </Stack>
              )}
            </Stack>
          </Box>
          <Divider />
          <Box sx={{ p: 1.5, flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {!selectedFile ? (
              <Stack alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
                <Typography color="text.secondary">Select a file from the left to preview it.</Typography>
              </Stack>
            ) : loadingPreview ? (
              <Stack alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
                <CircularProgress size={28} />
              </Stack>
            ) : preview ? (
              <Paper
                variant="outlined"
                sx={{
                  height: '100%',
                  overflow: 'auto',
                  p: preview.kind === 'video' || preview.kind === 'audio' || preview.kind === 'pdf' || preview.kind === 'image' ? 1 : 2,
                  '& h1, & h2, & h3': { mt: 2, mb: 1 },
                  '& p': { lineHeight: 1.65, mb: 1.2 },
                  '& pre': {
                    bgcolor: (t) => alpha(t.palette.text.primary, 0.08),
                    p: 1.25,
                    borderRadius: 1,
                    overflowX: 'auto',
                  },
                }}
              >
                {preview.kind === 'markdown' && (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.textContent ?? ''}</ReactMarkdown>
                )}
                {preview.kind === 'text' && (
                  <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', m: 0, fontFamily: 'ui-monospace, monospace' }}>
                    {preview.textContent ?? ''}
                  </Typography>
                )}
                {preview.kind === 'pdf' && preview.objectUrl && (
                  <Box component="iframe" src={preview.objectUrl} sx={{ width: '100%', height: '100%', border: 0, minHeight: 480 }} />
                )}
                {preview.kind === 'image' && preview.objectUrl && (
                  <Box
                    component="img"
                    src={preview.objectUrl}
                    alt={preview.name}
                    sx={{ display: 'block', maxWidth: '100%', maxHeight: '100%', mx: 'auto' }}
                  />
                )}
                {preview.kind === 'audio' && preview.objectUrl && (
                  <Box component="audio" src={preview.objectUrl} controls sx={{ width: '100%' }} />
                )}
                {preview.kind === 'video' && preview.objectUrl && (
                  <Box component="video" src={preview.objectUrl} controls sx={{ width: '100%', maxHeight: '100%' }} />
                )}
                {preview.kind === 'binary' && (
                  <Alert severity="info">
                    Preview is not available for this file type. Use Download.
                  </Alert>
                )}
              </Paper>
            ) : (
              <Alert severity="warning">Could not load file preview.</Alert>
            )}
          </Box>
        </Box>
      </Stack>

      <Dialog open={createFolderOpen} onClose={() => setCreateFolderOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>New Folder</DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary">
            Parent: {selectedFolder?.path ?? 'Root'}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            sx={{ mt: 1 }}
            label="Folder name"
            placeholder="Folder name…"
            value={createFolderName}
            onChange={(e) => setCreateFolderName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateFolderOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!createFolderName.trim() || creatingFolder}
            onClick={() => void onCreateFolder()}
            startIcon={creatingFolder ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  )
}
