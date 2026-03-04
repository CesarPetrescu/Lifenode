import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder'
import NoteAddIcon from '@mui/icons-material/NoteAdd'
import FolderIcon from '@mui/icons-material/Folder'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import DescriptionIcon from '@mui/icons-material/Description'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import SaveIcon from '@mui/icons-material/Save'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import RestoreIcon from '@mui/icons-material/Restore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import ConfirmDialog from './ConfirmDialog'
import type {
  NoteFileDetail,
  NoteFileListItem,
  NoteFolder,
  NotesTree,
  SectionProps,
} from './types'
import { api, authHeaders, formatLocalDate } from './utils'

type ViewMode = 'split' | 'edit' | 'preview'

function normalizeFolderId(id?: number | null): number | null {
  return id ?? null
}

function toSelectValue(id?: number | null): number | '' {
  return id ?? ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function NotesSection({ token, currentUsername, setError }: SectionProps) {
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [files, setFiles] = useState<NoteFileListItem[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<number>>(new Set())
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null)

  const [currentFile, setCurrentFile] = useState<NoteFileDetail | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftFolderId, setDraftFolderId] = useState<number | null>(null)

  const [loadingTree, setLoadingTree] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [savingFile, setSavingFile] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('split')

  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [createFolderName, setCreateFolderName] = useState('')
  const [createFolderParent, setCreateFolderParent] = useState<number | ''>('')

  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [createFileName, setCreateFileName] = useState('')
  const [createFileFolder, setCreateFileFolder] = useState<number | ''>('')

  const [renameFolderOpen, setRenameFolderOpen] = useState(false)
  const [renameFolderName, setRenameFolderName] = useState('')
  const [confirmDeleteFolderOpen, setConfirmDeleteFolderOpen] = useState(false)
  const [confirmDeleteFileOpen, setConfirmDeleteFileOpen] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState(false)
  const [deletingFile, setDeletingFile] = useState(false)

  const folderById = useMemo(() => {
    const map = new Map<number, NoteFolder>()
    for (const folder of folders) map.set(folder.id, folder)
    return map
  }, [folders])

  const folderOptions = useMemo(
    () => [{ id: null as number | null, name: 'Root' }, ...folders.map((f) => ({ id: f.id, name: f.name }))],
    [folders],
  )

  const filesByFolder = useMemo(() => {
    const map = new Map<number | null, NoteFileListItem[]>()
    for (const file of files) {
      const key = normalizeFolderId(file.folder_id)
      const arr = map.get(key) ?? []
      arr.push(file)
      map.set(key, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [files])

  const foldersByParent = useMemo(() => {
    const map = new Map<number | null, NoteFolder[]>()
    for (const folder of folders) {
      const key = normalizeFolderId(folder.parent_id)
      const arr = map.get(key) ?? []
      arr.push(folder)
      map.set(key, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [folders])

  const isDirty = useMemo(() => {
    if (!currentFile) return false
    return (
      draftName !== currentFile.name
      || draftContent !== currentFile.content
      || normalizeFolderId(draftFolderId) !== normalizeFolderId(currentFile.folder_id)
    )
  }, [currentFile, draftName, draftContent, draftFolderId])

  const selectedFolder = useMemo(
    () => (selectedFolderId == null ? null : folderById.get(selectedFolderId) ?? null),
    [folderById, selectedFolderId],
  )

  const loadTree = useCallback(async (preferredFileId?: number | null) => {
    if (!currentUsername || !token) return
    setLoadingTree(true)
    try {
      setError('')
      const data = await api<NotesTree>(`/notes/tree/${encodeURIComponent(currentUsername)}`, {
        headers: authHeaders(token),
      })
      setFolders(data.folders)
      setFiles(data.files)

      setExpandedFolders((prev) => {
        const next = new Set<number>()
        for (const id of prev) {
          if (data.folders.some((f) => f.id === id)) next.add(id)
        }
        for (const folder of data.folders) {
          if (folder.parent_id == null) next.add(folder.id)
        }
        return next
      })

      setSelectedFolderId((prev) => {
        if (prev != null && data.folders.some((f) => f.id === prev)) return prev
        return null
      })

      const preferred = preferredFileId ?? selectedFileId
      const chosenId = preferred != null && data.files.some((f) => f.id === preferred)
        ? preferred
        : (data.files[0]?.id ?? null)
      setSelectedFileId(chosenId)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingTree(false)
    }
  }, [currentUsername, selectedFileId, setError, token])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  useEffect(() => {
    if (!selectedFileId || !currentUsername || !token) {
      setCurrentFile(null)
      setDraftName('')
      setDraftContent('')
      setDraftFolderId(null)
      return
    }

    let cancelled = false
    void (async () => {
      setLoadingFile(true)
      try {
        setError('')
        const detail = await api<NoteFileDetail>(
          `/notes/files/${encodeURIComponent(currentUsername)}/${selectedFileId}`,
          { headers: authHeaders(token) },
        )
        if (cancelled) return
        setCurrentFile(detail)
        setDraftName(detail.name)
        setDraftContent(detail.content)
        setDraftFolderId(normalizeFolderId(detail.folder_id))
        setSelectedFolderId(normalizeFolderId(detail.folder_id))
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      } finally {
        if (!cancelled) setLoadingFile(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [currentUsername, selectedFileId, setError, token])

  const onCreateFolder = async () => {
    if (!currentUsername || !token) return
    if (!createFolderName.trim()) return
    try {
      setError('')
      const created = await api<NoteFolder>(`/notes/folders/${encodeURIComponent(currentUsername)}`, {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: createFolderName.trim(),
          parent_id: createFolderParent === '' ? null : createFolderParent,
        }),
      })
      setCreateFolderOpen(false)
      setCreateFolderName('')
      setCreateFolderParent('')
      setSelectedFolderId(created.id)
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        if (created.parent_id != null) next.add(created.parent_id)
        next.add(created.id)
        return next
      })
      await loadTree(selectedFileId)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onCreateFile = async () => {
    if (!currentUsername || !token) return
    if (!createFileName.trim()) return
    try {
      setError('')
      const created = await api<NoteFileDetail>(`/notes/files/${encodeURIComponent(currentUsername)}`, {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: createFileName.trim(),
          folder_id: createFileFolder === '' ? null : createFileFolder,
          content: '',
        }),
      })
      setCreateFileOpen(false)
      setCreateFileName('')
      setCreateFileFolder('')
      setSelectedFileId(created.id)
      setSelectedFolderId(normalizeFolderId(created.folder_id))
      if (created.folder_id != null) {
        setExpandedFolders((prev) => new Set(prev).add(created.folder_id as number))
      }
      await loadTree(created.id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onRenameFolder = async () => {
    if (!selectedFolder || !currentUsername || !token) return
    if (!renameFolderName.trim()) return
    try {
      setError('')
      await api<NoteFolder>(
        `/notes/folders/${encodeURIComponent(currentUsername)}/${selectedFolder.id}`,
        {
          method: 'PUT',
          headers: authHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ name: renameFolderName.trim() }),
        },
      )
      setRenameFolderOpen(false)
      setRenameFolderName('')
      await loadTree(selectedFileId)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onDeleteFolder = async () => {
    if (!selectedFolder || !currentUsername || !token) return
    setDeletingFolder(true)
    try {
      setError('')
      await api(
        `/notes/folders/${encodeURIComponent(currentUsername)}/${selectedFolder.id}`,
        {
          method: 'DELETE',
          headers: authHeaders(token),
        },
      )
      setSelectedFolderId(null)
      setConfirmDeleteFolderOpen(false)
      await loadTree(selectedFileId)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setDeletingFolder(false)
    }
  }

  const onDeleteCurrentFile = async () => {
    if (!currentFile || !currentUsername || !token) return
    setDeletingFile(true)
    try {
      setError('')
      await api(
        `/notes/files/${encodeURIComponent(currentUsername)}/${currentFile.id}`,
        {
          method: 'DELETE',
          headers: authHeaders(token),
        },
      )
      setCurrentFile(null)
      setSelectedFileId(null)
      setConfirmDeleteFileOpen(false)
      await loadTree()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setDeletingFile(false)
    }
  }

  const onSaveFile = useCallback(async () => {
    if (!currentFile || !currentUsername || !token || savingFile) return
    setSavingFile(true)
    try {
      setError('')
      const updated = await api<NoteFileDetail>(
        `/notes/files/${encodeURIComponent(currentUsername)}/${currentFile.id}`,
        {
          method: 'PUT',
          headers: authHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            name: draftName.trim(),
            folder_id: draftFolderId,
            content: draftContent,
          }),
        },
      )
      setCurrentFile(updated)
      setDraftName(updated.name)
      setDraftContent(updated.content)
      setDraftFolderId(normalizeFolderId(updated.folder_id))
      setSelectedFolderId(normalizeFolderId(updated.folder_id))
      await loadTree(updated.id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSavingFile(false)
    }
  }, [currentFile, currentUsername, draftContent, draftFolderId, draftName, loadTree, savingFile, setError, token])

  const onDiscardChanges = () => {
    if (!currentFile) return
    setDraftName(currentFile.name)
    setDraftContent(currentFile.content)
    setDraftFolderId(normalizeFolderId(currentFile.folder_id))
  }

  const onSelectFile = (fileId: number, folderId: number | null) => {
    if (isDirty) {
      setError('Unsaved changes detected. Save or discard before switching files.')
      return
    }
    setSelectedFileId(fileId)
    setSelectedFolderId(folderId)
    setError('')
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void onSaveFile()
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [onSaveFile])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  const renderFiles = (folderId: number | null, depth: number) => {
    const list = filesByFolder.get(folderId) ?? []
    return list.map((file) => (
      <Button
        key={`file-${file.id}`}
        fullWidth
        aria-label={`Open note file ${file.name}`}
        onClick={() => onSelectFile(file.id, normalizeFolderId(file.folder_id))}
        sx={{
          justifyContent: 'flex-start',
          textTransform: 'none',
          pl: `${1 + depth * 1.4}rem`,
          py: 0.55,
          borderRadius: 1,
          bgcolor: selectedFileId === file.id ? (t) => alpha(t.palette.primary.main, 0.14) : 'transparent',
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
          <DescriptionIcon fontSize="small" />
          <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}
          </Typography>
        </Stack>
      </Button>
    ))
  }

  const renderFolderTree = (folder: NoteFolder, depth: number): ReactNode => {
    const isExpanded = expandedFolders.has(folder.id)
    const children = foldersByParent.get(folder.id) ?? []
    return (
      <Box key={`folder-${folder.id}`}>
        <Box
          sx={{
            borderRadius: 1,
            bgcolor: selectedFolderId === folder.id ? (t) => alpha(t.palette.secondary.main, 0.14) : 'transparent',
          }}
        >
          <Stack
            direction="row"
            spacing={0.35}
            alignItems="center"
            sx={{ pl: `${0.35 + depth * 1.4}rem`, pr: 0.35, py: 0.2 }}
          >
            <IconButton
              size="small"
              aria-label={isExpanded ? `Collapse folder ${folder.name}` : `Expand folder ${folder.name}`}
              onClick={() => {
                setExpandedFolders((prev) => {
                  const next = new Set(prev)
                  if (next.has(folder.id)) next.delete(folder.id)
                  else next.add(folder.id)
                  return next
                })
              }}
            >
              {isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
            </IconButton>
            <Button
              fullWidth
              aria-label={`Open folder ${folder.name}`}
              onClick={() => setSelectedFolderId(folder.id)}
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
          </Stack>
        </Box>
        {isExpanded && (
          <>
            {renderFiles(folder.id, depth + 1)}
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
            width: { xs: '100%', md: 330 },
            borderRight: { xs: 0, md: 1 },
            borderBottom: { xs: 1, md: 0 },
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <Box sx={{ px: 1.5, py: 1.2 }}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Typography variant="h6">Notes</Typography>
              {loadingTree && <CircularProgress size={16} />}
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Tooltip title="New folder">
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<CreateNewFolderIcon />}
                    onClick={() => {
                      setCreateFolderName('')
                      setCreateFolderParent(toSelectValue(selectedFolderId))
                      setCreateFolderOpen(true)
                    }}
                  >
                    Folder
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title="New markdown file">
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<NoteAddIcon />}
                    onClick={() => {
                      setCreateFileName('Untitled.md')
                      setCreateFileFolder(toSelectValue(selectedFolderId))
                      setCreateFileOpen(true)
                    }}
                  >
                    File
                  </Button>
                </span>
              </Tooltip>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button
                size="small"
                variant="text"
                startIcon={<EditIcon />}
                disabled={!selectedFolder}
                onClick={() => {
                  if (!selectedFolder) return
                  setRenameFolderName(selectedFolder.name)
                  setRenameFolderOpen(true)
                }}
              >
                Rename Folder
              </Button>
              <Button
                size="small"
                color="error"
                variant="text"
                startIcon={<DeleteIcon />}
                disabled={!selectedFolder}
                onClick={() => setConfirmDeleteFolderOpen(true)}
              >
                Delete Folder
              </Button>
            </Stack>
          </Box>
          <Divider />
          <Box sx={{ p: 1, flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {files.length === 0 && folders.length === 0 && !loadingTree ? (
              <Alert severity="info">
                No notes yet. Create a folder or file from the toolbar above.
              </Alert>
            ) : (
              <>
                {renderFiles(null, 0)}
                {(foldersByParent.get(null) ?? []).map((folder) => renderFolderTree(folder, 0))}
              </>
            )}
          </Box>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {!currentFile ? (
            <Stack sx={{ height: '100%' }} alignItems="center" justifyContent="center" spacing={1.5}>
              {loadingFile ? (
                <CircularProgress size={28} />
              ) : (
                <>
                  <Typography variant="h6" color="text.secondary">
                    Select or create a note file
                  </Typography>
                  <Button
                    variant="contained"
                    startIcon={<NoteAddIcon />}
                    onClick={() => {
                      setCreateFileName('Untitled.md')
                      setCreateFileFolder(toSelectValue(selectedFolderId))
                      setCreateFileOpen(true)
                    }}
                  >
                    New File
                  </Button>
                </>
              )}
            </Stack>
          ) : (
            <>
              <Box sx={{ p: 1.5 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                  <TextField
                    label="File name"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    size="small"
                    sx={{ minWidth: { xs: '100%', md: 280 } }}
                  />
                  <FormControl size="small" sx={{ minWidth: { xs: '100%', md: 220 } }}>
                    <InputLabel id="notes-folder-label">Folder</InputLabel>
                    <Select<number | ''>
                      labelId="notes-folder-label"
                      label="Folder"
                      value={toSelectValue(draftFolderId)}
                      onChange={(e) => {
                        const value = e.target.value
                        setDraftFolderId(value === '' ? null : Number(value))
                      }}
                    >
                      {folderOptions.map((option) => (
                        <MenuItem key={`opt-${option.id ?? 'root'}`} value={option.id ?? ''}>
                          {option.name}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Box sx={{ flex: 1 }} />
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    <Button
                      variant="contained"
                      startIcon={<SaveIcon />}
                      onClick={() => void onSaveFile()}
                      disabled={savingFile || !isDirty || !draftName.trim()}
                      endIcon={savingFile ? <CircularProgress size={14} color="inherit" /> : undefined}
                    >
                      Save
                    </Button>
                    <Button
                      variant="outlined"
                      startIcon={<RestoreIcon />}
                      onClick={onDiscardChanges}
                      disabled={!isDirty}
                    >
                      Discard
                    </Button>
                    <Button
                      color="error"
                      variant="outlined"
                      startIcon={<DeleteIcon />}
                      onClick={() => setConfirmDeleteFileOpen(true)}
                      disabled={deletingFile}
                    >
                      Delete
                    </Button>
                  </Stack>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
                  <Chip label={isDirty ? 'Unsaved changes' : 'Saved'} color={isDirty ? 'warning' : 'success'} size="small" />
                  <Chip label={`Updated ${formatLocalDate(currentFile.updated_at)}`} size="small" variant="outlined" />
                </Stack>
              </Box>
              <Divider />
              <Box sx={{ px: 1.5, pt: 1 }}>
                <Tabs
                  value={viewMode}
                  onChange={(_, next: ViewMode) => setViewMode(next)}
                  aria-label="Note editor mode"
                  sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36 } }}
                >
                  <Tab value="split" label="Split" />
                  <Tab value="edit" label="Edit" />
                  <Tab value="preview" label="Preview" />
                </Tabs>
              </Box>
              <Stack
                direction={{ xs: 'column', md: viewMode === 'split' ? 'row' : 'column' }}
                spacing={1}
                sx={{ p: 1.5, flex: 1, minHeight: 0 }}
              >
                {viewMode !== 'preview' && (
                  <TextField
                    multiline
                    fullWidth
                    minRows={16}
                    label="Markdown Content"
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder="Write markdown…"
                    sx={{
                      flex: 1,
                      minHeight: 0,
                      '& .MuiInputBase-root': {
                        alignItems: 'flex-start',
                        height: '100%',
                      },
                      '& textarea': {
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        fontSize: 16,
                        lineHeight: 1.45,
                      },
                    }}
                  />
                )}
                {viewMode !== 'edit' && (
                  <Paper
                    variant="outlined"
                    sx={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: 'auto',
                      p: 2,
                      bgcolor: (t) => alpha(t.palette.text.primary, 0.02),
                      '& h1, & h2, & h3': { mt: 2.2, mb: 1 },
                      '& p': { lineHeight: 1.65, mb: 1.2 },
                      '& pre': {
                        bgcolor: (t) => alpha(t.palette.text.primary, 0.08),
                        p: 1.25,
                        borderRadius: 1,
                        overflowX: 'auto',
                      },
                      '& code': {
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        fontSize: 13,
                      },
                      '& blockquote': {
                        borderLeft: 3,
                        borderColor: 'divider',
                        ml: 0,
                        pl: 1.25,
                        color: 'text.secondary',
                      },
                    }}
                  >
                    {draftContent.trim() ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{draftContent}</ReactMarkdown>
                    ) : (
                      <Typography color="text.secondary">Markdown preview appears here.</Typography>
                    )}
                  </Paper>
                )}
              </Stack>
            </>
          )}
        </Box>
      </Stack>

      <Dialog open={createFolderOpen} onClose={() => setCreateFolderOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>New Folder</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <TextField
              autoFocus
              label="Folder name"
              value={createFolderName}
              onChange={(e) => setCreateFolderName(e.target.value)}
            />
            <FormControl>
              <InputLabel id="create-folder-parent-label">Parent</InputLabel>
              <Select<number | ''>
                labelId="create-folder-parent-label"
                label="Parent"
                value={createFolderParent}
                onChange={(e) => {
                  const value = e.target.value
                  setCreateFolderParent(value === '' ? '' : Number(value))
                }}
              >
                {folderOptions.map((option) => (
                  <MenuItem key={`parent-${option.id ?? 'root'}`} value={option.id ?? ''}>
                    {option.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateFolderOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void onCreateFolder()} disabled={!createFolderName.trim()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={createFileOpen} onClose={() => setCreateFileOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>New Markdown File</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <TextField
              autoFocus
              label="File name"
              value={createFileName}
              onChange={(e) => setCreateFileName(e.target.value)}
            />
            <FormControl>
              <InputLabel id="create-file-folder-label">Folder</InputLabel>
              <Select<number | ''>
                labelId="create-file-folder-label"
                label="Folder"
                value={createFileFolder}
                onChange={(e) => {
                  const value = e.target.value
                  setCreateFileFolder(value === '' ? '' : Number(value))
                }}
              >
                {folderOptions.map((option) => (
                  <MenuItem key={`file-parent-${option.id ?? 'root'}`} value={option.id ?? ''}>
                    {option.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateFileOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void onCreateFile()} disabled={!createFileName.trim()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={renameFolderOpen} onClose={() => setRenameFolderOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Rename Folder</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Folder name"
            value={renameFolderName}
            onChange={(e) => setRenameFolderName(e.target.value)}
            sx={{ mt: 0.5 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameFolderOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void onRenameFolder()} disabled={!renameFolderName.trim()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog
        open={confirmDeleteFolderOpen}
        title="Delete Folder"
        message={`Delete folder "${selectedFolder?.name ?? ''}" and all nested files/folders?`}
        confirmLabel="Delete"
        confirmColor="error"
        loading={deletingFolder}
        onClose={() => setConfirmDeleteFolderOpen(false)}
        onConfirm={() => void onDeleteFolder()}
      />
      <ConfirmDialog
        open={confirmDeleteFileOpen}
        title="Delete File"
        message={`Delete file "${currentFile?.name ?? ''}"?`}
        confirmLabel="Delete"
        confirmColor="error"
        loading={deletingFile}
        onClose={() => setConfirmDeleteFileOpen(false)}
        onConfirm={() => void onDeleteCurrentFile()}
      />
    </Paper>
  )
}
