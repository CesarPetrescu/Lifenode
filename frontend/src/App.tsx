import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import UploadFileIcon from '@mui/icons-material/UploadFile'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

type HealthResponse = {
  status: string
  time: string
}

type WikiArticle = {
  id: number
  title: string
  url: string
  downloaded_at: string
}

type SearchResult = {
  article_id: number
  title: string
  chunk_index: number
  text: string
  score: number
}

type CalendarEvent = {
  id: number
  title: string
  start_ts: string
  end_ts: string
  details: string
}

type NoteItem = {
  content: string
  updated_at: string
}

type DriveFile = {
  filename: string
  size: number
  modified_at: string
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
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

function shortText(value: string, max = 360) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...`
}

function App() {
  const [tab, setTab] = useState(0)
  const [username, setUsername] = useState(() => localStorage.getItem('lifenode_username') ?? 'cesar')
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string>('')

  const [wikiTitle, setWikiTitle] = useState('')
  const [wikiResult, setWikiResult] = useState('')
  const [wikiArticles, setWikiArticles] = useState<WikiArticle[]>([])

  const [searchQuery, setSearchQuery] = useState('')
  const [searchTopK, setSearchTopK] = useState(4)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])

  const [askQuestion, setAskQuestion] = useState('')
  const [askTopK, setAskTopK] = useState(4)
  const [askAnswer, setAskAnswer] = useState('')
  const [askContexts, setAskContexts] = useState<SearchResult[]>([])

  const [noteContent, setNoteContent] = useState('')
  const [noteUpdatedAt, setNoteUpdatedAt] = useState('')

  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [eventTitle, setEventTitle] = useState('')
  const [eventStart, setEventStart] = useState('')
  const [eventEnd, setEventEnd] = useState('')
  const [eventDetails, setEventDetails] = useState('')

  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([])
  const [uploading, setUploading] = useState(false)

  const usernameClean = useMemo(() => username.trim(), [username])

  const runSafe = useCallback(async (fn: () => Promise<void>) => {
    try {
      setError('')
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    }
  }, [])

  const loadHealth = useCallback(async () => {
    const data = await api<HealthResponse>('/health')
    setHealth(data)
  }, [])

  const loadWikiArticles = useCallback(async () => {
    if (!usernameClean) return
    const data = await api<WikiArticle[]>(`/wiki/articles/${encodeURIComponent(usernameClean)}`)
    setWikiArticles(data)
  }, [usernameClean])

  const loadEvents = useCallback(async () => {
    if (!usernameClean) return
    const data = await api<CalendarEvent[]>(`/calendar/events/${encodeURIComponent(usernameClean)}`)
    setEvents(data)
  }, [usernameClean])

  const loadNote = useCallback(async () => {
    if (!usernameClean) return
    const data = await api<NoteItem>(`/notes/${encodeURIComponent(usernameClean)}`)
    setNoteContent(data.content)
    setNoteUpdatedAt(data.updated_at)
  }, [usernameClean])

  const loadDriveFiles = useCallback(async () => {
    if (!usernameClean) return
    const data = await api<DriveFile[]>(`/drive/files/${encodeURIComponent(usernameClean)}`)
    setDriveFiles(data)
  }, [usernameClean])

  useEffect(() => {
    localStorage.setItem('lifenode_username', usernameClean)
  }, [usernameClean])

  useEffect(() => {
    void runSafe(async () => {
      await loadHealth()
      await Promise.all([loadWikiArticles(), loadEvents(), loadNote(), loadDriveFiles()])
    })
  }, [loadDriveFiles, loadEvents, loadHealth, loadNote, loadWikiArticles, runSafe])

  const onWikiDownload = async () => {
    if (!usernameClean || !wikiTitle.trim()) return
    setWikiResult('Downloading and indexing...')
    await runSafe(async () => {
      const result = await api<Record<string, unknown>>('/wiki/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameClean,
          title: wikiTitle.trim(),
        }),
      })
      setWikiResult(JSON.stringify(result, null, 2))
      setWikiTitle('')
      await loadWikiArticles()
    })
  }

  const onSearch = async () => {
    if (!usernameClean || !searchQuery.trim()) return
    await runSafe(async () => {
      const result = await api<{ results: SearchResult[] }>('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameClean,
          query: searchQuery.trim(),
          top_k: searchTopK,
        }),
      })
      setSearchResults(result.results)
    })
  }

  const onAsk = async () => {
    if (!usernameClean || !askQuestion.trim()) return
    setAskAnswer('Thinking...')
    await runSafe(async () => {
      const result = await api<{ answer: string; contexts: SearchResult[] }>('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameClean,
          question: askQuestion.trim(),
          top_k: askTopK,
        }),
      })
      setAskAnswer(result.answer)
      setAskContexts(result.contexts)
    })
  }

  const onSaveNote = async () => {
    if (!usernameClean) return
    await runSafe(async () => {
      const result = await api<NoteItem>(`/notes/${encodeURIComponent(usernameClean)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent }),
      })
      setNoteUpdatedAt(result.updated_at)
    })
  }

  const onCreateEvent = async () => {
    if (!usernameClean || !eventTitle.trim() || !eventStart || !eventEnd) return
    await runSafe(async () => {
      await api<CalendarEvent>(`/calendar/events/${encodeURIComponent(usernameClean)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: eventTitle.trim(),
          start_ts: eventStart,
          end_ts: eventEnd,
          details: eventDetails.trim(),
        }),
      })
      setEventTitle('')
      setEventStart('')
      setEventEnd('')
      setEventDetails('')
      await loadEvents()
    })
  }

  const onDeleteEvent = async (eventId: number) => {
    if (!usernameClean) return
    await runSafe(async () => {
      await api(`/calendar/events/${encodeURIComponent(usernameClean)}/${eventId}`, { method: 'DELETE' })
      await loadEvents()
    })
  }

  const onUploadFile = async (file: File | null) => {
    if (!usernameClean || !file) return
    setUploading(true)
    await runSafe(async () => {
      const formData = new FormData()
      formData.append('file', file)
      await api(`/drive/upload/${encodeURIComponent(usernameClean)}`, {
        method: 'POST',
        body: formData,
      })
      await loadDriveFiles()
    })
    setUploading(false)
  }

  const onDeleteFile = async (filename: string) => {
    if (!usernameClean) return
    await runSafe(async () => {
      await api(`/drive/files/${encodeURIComponent(usernameClean)}/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      })
      await loadDriveFiles()
    })
  }

  const downloadUrl = (filename: string) =>
    `${API_BASE}/drive/download/${encodeURIComponent(usernameClean)}/${encodeURIComponent(filename)}`

  return (
    <Box sx={{ minHeight: '100vh', background: 'linear-gradient(180deg, #f2f6ff 0%, #fbfcff 100%)' }}>
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar sx={{ borderBottom: '1px solid #d9e4ff', bgcolor: 'rgba(255,255,255,0.72)' }}>
          <Typography variant="h5" sx={{ flexGrow: 1, fontWeight: 700 }}>
            LifeNode
          </Typography>
          <TextField
            size="small"
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            sx={{ width: 220, bgcolor: 'white' }}
          />
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Chip
            label={health ? `Backend ${health.status.toUpperCase()}` : 'Backend ...'}
            color={health?.status === 'ok' ? 'success' : 'default'}
          />
          <Chip label={health ? new Date(health.time).toLocaleString() : 'No health data'} variant="outlined" />
          <Chip label={`User: ${usernameClean || '-'}`} color="primary" variant="outlined" />
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Paper sx={{ borderRadius: 3, overflow: 'hidden' }}>
          <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto">
            <Tab label="Wiki + Search" />
            <Tab label="Ask" />
            <Tab label="Calendar" />
            <Tab label="Notes" />
            <Tab label="Drive" />
          </Tabs>
          <Divider />

          <Box sx={{ p: 2.5 }}>
            {tab === 0 && (
              <Stack spacing={2}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Download Wikipedia
                    </Typography>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                      <TextField
                        label="Article title"
                        placeholder="Raspberry Pi"
                        fullWidth
                        value={wikiTitle}
                        onChange={(e) => setWikiTitle(e.target.value)}
                      />
                      <Button variant="contained" onClick={onWikiDownload}>
                        Download + Index
                      </Button>
                    </Stack>
                    {wikiResult && (
                      <Box component="pre" sx={{ mt: 2, p: 1.5, bgcolor: '#0f172a', color: '#e2e8f0', borderRadius: 2, overflowX: 'auto' }}>
                        {wikiResult}
                      </Box>
                    )}
                  </CardContent>
                </Card>

                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Indexed Articles
                    </Typography>
                    <List dense>
                      {wikiArticles.length === 0 && <ListItem><ListItemText primary="No articles yet." /></ListItem>}
                      {wikiArticles.map((article) => (
                        <ListItem key={article.id}>
                          <ListItemText
                            primary={article.title}
                            secondary={`${new Date(article.downloaded_at).toLocaleString()} • ${article.url}`}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </CardContent>
                </Card>

                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Semantic Search
                    </Typography>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
                      <TextField
                        fullWidth
                        label="Search query"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      <TextField
                        type="number"
                        label="Top K"
                        value={searchTopK}
                        onChange={(e) => setSearchTopK(Number(e.target.value) || 4)}
                        sx={{ width: 120 }}
                      />
                      <Button variant="contained" onClick={onSearch}>
                        Search
                      </Button>
                    </Stack>
                    <Stack spacing={1.2}>
                      {searchResults.length === 0 && <Typography color="text.secondary">No search results yet.</Typography>}
                      {searchResults.map((item, idx) => (
                        <Paper key={`${item.article_id}-${item.chunk_index}-${idx}`} variant="outlined" sx={{ p: 1.5 }}>
                          <Typography variant="subtitle2">
                            {item.title} • chunk {item.chunk_index} • score {item.score.toFixed(4)}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {shortText(item.text)}
                          </Typography>
                        </Paper>
                      ))}
                    </Stack>
                  </CardContent>
                </Card>
              </Stack>
            )}

            {tab === 1 && (
              <Stack spacing={2}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Ask over indexed context
                    </Typography>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
                      <TextField
                        fullWidth
                        label="Question"
                        value={askQuestion}
                        onChange={(e) => setAskQuestion(e.target.value)}
                      />
                      <TextField
                        type="number"
                        label="Top K"
                        value={askTopK}
                        onChange={(e) => setAskTopK(Number(e.target.value) || 4)}
                        sx={{ width: 120 }}
                      />
                      <Button variant="contained" onClick={onAsk}>
                        Ask
                      </Button>
                    </Stack>
                    <Paper sx={{ p: 1.5, bgcolor: '#081329', color: '#dbeafe', whiteSpace: 'pre-wrap' }}>{askAnswer || 'No answer yet.'}</Paper>
                  </CardContent>
                </Card>

                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Context chunks
                    </Typography>
                    <Stack spacing={1.2}>
                      {askContexts.length === 0 && <Typography color="text.secondary">No context yet.</Typography>}
                      {askContexts.map((ctx, idx) => (
                        <Paper key={`${ctx.article_id}-${ctx.chunk_index}-${idx}`} variant="outlined" sx={{ p: 1.5 }}>
                          <Typography variant="subtitle2">
                            {ctx.title} • chunk {ctx.chunk_index} • score {ctx.score.toFixed(4)}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {shortText(ctx.text)}
                          </Typography>
                        </Paper>
                      ))}
                    </Stack>
                  </CardContent>
                </Card>
              </Stack>
            )}

            {tab === 2 && (
              <Stack spacing={2}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Create event
                    </Typography>
                    <Stack spacing={1.2}>
                      <TextField label="Title" value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} />
                      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2}>
                        <TextField
                          label="Start"
                          type="datetime-local"
                          value={eventStart}
                          onChange={(e) => setEventStart(e.target.value)}
                          InputLabelProps={{ shrink: true }}
                          fullWidth
                        />
                        <TextField
                          label="End"
                          type="datetime-local"
                          value={eventEnd}
                          onChange={(e) => setEventEnd(e.target.value)}
                          InputLabelProps={{ shrink: true }}
                          fullWidth
                        />
                      </Stack>
                      <TextField
                        label="Details"
                        multiline
                        minRows={2}
                        value={eventDetails}
                        onChange={(e) => setEventDetails(e.target.value)}
                      />
                      <Button variant="contained" onClick={onCreateEvent}>
                        Add event
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>

                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Events
                    </Typography>
                    <List>
                      {events.length === 0 && <ListItem><ListItemText primary="No events yet." /></ListItem>}
                      {events.map((event) => (
                        <ListItem
                          key={event.id}
                          secondaryAction={
                            <IconButton edge="end" aria-label="delete" onClick={() => onDeleteEvent(event.id)}>
                              <DeleteIcon />
                            </IconButton>
                          }
                        >
                          <ListItemText
                            primary={event.title}
                            secondary={`${event.start_ts} → ${event.end_ts}${event.details ? ` • ${event.details}` : ''}`}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </CardContent>
                </Card>
              </Stack>
            )}

            {tab === 3 && (
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Notes
                  </Typography>
                  <TextField
                    fullWidth
                    multiline
                    minRows={12}
                    value={noteContent}
                    onChange={(e) => setNoteContent(e.target.value)}
                  />
                  <Stack direction="row" spacing={1.5} sx={{ mt: 1.5 }}>
                    <Button variant="contained" onClick={onSaveNote}>
                      Save
                    </Button>
                    <Chip label={noteUpdatedAt ? `Updated ${new Date(noteUpdatedAt).toLocaleString()}` : 'Not saved yet'} />
                  </Stack>
                </CardContent>
              </Card>
            )}

            {tab === 4 && (
              <Stack spacing={2}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Upload file
                    </Typography>
                    <Button
                      component="label"
                      variant="contained"
                      startIcon={<UploadFileIcon />}
                      disabled={uploading}
                    >
                      {uploading ? 'Uploading...' : 'Select file'}
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
                  </CardContent>
                </Card>

                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Files
                    </Typography>
                    <List>
                      {driveFiles.length === 0 && <ListItem><ListItemText primary="No files yet." /></ListItem>}
                      {driveFiles.map((file) => (
                        <ListItem
                          key={file.filename}
                          secondaryAction={
                            <Stack direction="row" spacing={1}>
                              <Button size="small" href={downloadUrl(file.filename)} target="_blank">
                                Download
                              </Button>
                              <IconButton edge="end" onClick={() => onDeleteFile(file.filename)}>
                                <DeleteIcon />
                              </IconButton>
                            </Stack>
                          }
                        >
                          <ListItemText
                            primary={file.filename}
                            secondary={`${file.size} bytes • ${new Date(file.modified_at).toLocaleString()}`}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </CardContent>
                </Card>
              </Stack>
            )}
          </Box>
        </Paper>
      </Container>
    </Box>
  )
}

export default App
