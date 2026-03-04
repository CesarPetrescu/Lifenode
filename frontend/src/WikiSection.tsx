import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import AutoStoriesIcon from '@mui/icons-material/AutoStories'
import SearchIcon from '@mui/icons-material/Search'

import type { SectionProps, SearchResult, WikiArticle, WikiArticleDetail, WikiBulkJob } from './types'
import { API_BASE, api, authHeaders, formatLocalDate, parseWikiSegments, runSafe, shortText } from './utils'

function highlightText(text: string, query: string): ReactNode {
  const trimmed = query.trim()
  if (!trimmed) return text

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'ig')
  const parts = text.split(regex)
  const lowered = trimmed.toLowerCase()

  return parts.map((part, idx) =>
    part.toLowerCase() === lowered ? (
      <Box
        key={`mark-${idx}`}
        component="mark"
        sx={{ bgcolor: 'warning.light', color: 'text.primary', px: 0.2, borderRadius: 0.4 }}
      >
        {part}
      </Box>
    ) : (
      <Box key={`txt-${idx}`} component="span">
        {part}
      </Box>
    ),
  )
}

export default function WikiSection({ token, currentUsername, setError }: SectionProps) {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'

  const [wikiTitle, setWikiTitle] = useState('')
  const [wikiResult, setWikiResult] = useState('')
  const [wikiBusy, setWikiBusy] = useState(false)
  const [wikiExportBusy, setWikiExportBusy] = useState(false)
  const [wikiIncludeImages, setWikiIncludeImages] = useState(false)
  const [wikiBulkMaxPages, setWikiBulkMaxPages] = useState(0)
  const [wikiBulkBusy, setWikiBulkBusy] = useState(false)
  const [wikiBulkJobs, setWikiBulkJobs] = useState<WikiBulkJob[]>([])
  const [wikiArticles, setWikiArticles] = useState<WikiArticle[]>([])
  const [wikiLibraryQuery, setWikiLibraryQuery] = useState('')
  const [wikiLibraryFilter, setWikiLibraryFilter] = useState<'all' | 'images' | 'text'>('all')
  const [selectedWikiArticleId, setSelectedWikiArticleId] = useState<number | null>(null)
  const [selectedWikiArticle, setSelectedWikiArticle] = useState<WikiArticleDetail | null>(null)
  const [wikiViewerTab, setWikiViewerTab] = useState<'text' | 'images'>('text')
  const [wikiViewerSearch, setWikiViewerSearch] = useState('')
  const [wikiViewerOnlyMatches, setWikiViewerOnlyMatches] = useState(false)
  const [wikiViewerLoading, setWikiViewerLoading] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchTopK, setSearchTopK] = useState(4)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])

  const wikiSegments = useMemo(
    () => parseWikiSegments(selectedWikiArticle?.content ?? ''),
    [selectedWikiArticle?.content],
  )
  const wikiImageArticleCount = useMemo(
    () => wikiArticles.filter((article) => article.image_count > 0).length,
    [wikiArticles],
  )
  const wikiFilteredArticles = useMemo(() => {
    const q = wikiLibraryQuery.trim().toLowerCase()
    return wikiArticles.filter((article) => {
      if (wikiLibraryFilter === 'images' && article.image_count <= 0) return false
      if (wikiLibraryFilter === 'text' && article.image_count > 0) return false
      if (!q) return true
      return article.title.toLowerCase().includes(q)
    })
  }, [wikiArticles, wikiLibraryFilter, wikiLibraryQuery])
  const wikiViewerSearchValue = wikiViewerSearch.trim().toLowerCase()
  const wikiMatchedSegments = useMemo(() => {
    if (!wikiViewerSearchValue) return []
    return wikiSegments.filter((segment) => segment.text.toLowerCase().includes(wikiViewerSearchValue))
  }, [wikiSegments, wikiViewerSearchValue])
  const wikiVisibleSegments = useMemo(() => {
    if (wikiViewerOnlyMatches && wikiViewerSearchValue) {
      return wikiMatchedSegments
    }
    return wikiSegments
  }, [wikiMatchedSegments, wikiSegments, wikiViewerOnlyMatches, wikiViewerSearchValue])
  const latestWikiBulkJob = wikiBulkJobs[0] ?? null
  const wikiBulkRunning =
    latestWikiBulkJob?.status === 'running' || latestWikiBulkJob?.status === 'queued'

  const loadWikiArticleDetail = useCallback(
    async (articleId: number) => {
      if (!currentUsername || !token) return
      setWikiViewerLoading(true)
      try {
        const data = await api<WikiArticleDetail>(
          `/wiki/articles/${encodeURIComponent(currentUsername)}/${articleId}`,
          { headers: authHeaders(token) },
        )
        setSelectedWikiArticle(data)
        setWikiViewerTab('text')
        setWikiViewerSearch('')
        setWikiViewerOnlyMatches(false)
      } finally {
        setWikiViewerLoading(false)
      }
    },
    [currentUsername, token],
  )

  const loadWikiArticles = useCallback(async () => {
    if (!currentUsername || !token) return
    const data = await api<WikiArticle[]>(`/wiki/articles/${encodeURIComponent(currentUsername)}`, {
      headers: authHeaders(token),
    })
    setWikiArticles(data)
    if (data.length === 0) {
      setSelectedWikiArticleId(null)
      setSelectedWikiArticle(null)
      return
    }

    setSelectedWikiArticleId((prev) => {
      const hasSelected = prev !== null && data.some((article) => article.id === prev)
      return hasSelected ? prev : data[0].id
    })
  }, [currentUsername, token])

  const loadWikiBulkJobs = useCallback(async () => {
    if (!currentUsername || !token) return
    const data = await api<WikiBulkJob[]>(`/wiki/bulk/jobs/${encodeURIComponent(currentUsername)}`, {
      headers: authHeaders(token),
    })
    setWikiBulkJobs(data)
  }, [currentUsername, token])

  useEffect(() => {
    void runSafe(setError, async () => {
      await Promise.all([loadWikiArticles(), loadWikiBulkJobs()])
    })
  }, [loadWikiArticles, loadWikiBulkJobs, setError])

  useEffect(() => {
    if (
      !currentUsername ||
      selectedWikiArticleId === null ||
      !wikiArticles.some((article) => article.id === selectedWikiArticleId)
    ) {
      return
    }
    void runSafe(setError, async () => {
      await loadWikiArticleDetail(selectedWikiArticleId)
    })
  }, [currentUsername, loadWikiArticleDetail, setError, selectedWikiArticleId, wikiArticles])

  useEffect(() => {
    if (wikiFilteredArticles.length === 0) return
    if (selectedWikiArticleId === null || !wikiFilteredArticles.some((article) => article.id === selectedWikiArticleId)) {
      setSelectedWikiArticleId(wikiFilteredArticles[0].id)
    }
  }, [selectedWikiArticleId, wikiFilteredArticles])

  useEffect(() => {
    if (!wikiBulkRunning || !currentUsername || !token) return
    const timer = window.setInterval(() => {
      void runSafe(setError, async () => {
        await loadWikiBulkJobs()
        await loadWikiArticles()
      })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [currentUsername, loadWikiArticles, loadWikiBulkJobs, setError, token, wikiBulkRunning])

  const onWikiDownload = async () => {
    if (!currentUsername || !wikiTitle.trim() || !token || wikiBusy) return
    setWikiBusy(true)
    setWikiResult('Downloading and indexing...')
    await runSafe(setError, async () => {
      const result = await api<{
        article_id: number
        title: string
        indexed_chunks: number
        image_count: number
        include_images: boolean
      }>('/wiki/download', {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          username: currentUsername,
          title: wikiTitle.trim(),
          include_images: wikiIncludeImages,
        }),
      })
      setWikiResult(
        `Indexed "${result.title}" in ${result.indexed_chunks} chunk(s). Images: ${
          result.include_images ? result.image_count : 0
        }.`,
      )
      setWikiTitle('')
      await loadWikiArticles()
      setSelectedWikiArticleId(result.article_id)
    })
    setWikiBusy(false)
  }

  const onWikiExportAllText = async () => {
    if (!currentUsername || !token || wikiExportBusy) return
    setWikiExportBusy(true)
    await runSafe(setError, async () => {
      const response = await fetch(`${API_BASE}/wiki/export/${encodeURIComponent(currentUsername)}`, {
        method: 'GET',
        headers: authHeaders(token),
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok) {
        if (contentType.includes('application/json')) {
          const err = (await response.json()) as { error?: string }
          throw new Error(err.error ?? `Request failed (${response.status})`)
        }
        throw new Error(await response.text())
      }

      const blob = await response.blob()
      const disposition = response.headers.get('content-disposition') ?? ''
      const fileMatch = disposition.match(/filename="?([^"]+)"?/)
      const filename = fileMatch?.[1] ?? `lifenode-wiki-${currentUsername}.txt`

      const objectUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(objectUrl)
      setWikiResult(`Exported all indexed Wikipedia text for ${currentUsername}.`)
    })
    setWikiExportBusy(false)
  }

  const onWikiBulkDownload = async () => {
    if (!currentUsername || !token || wikiBulkBusy || wikiBulkRunning) return
    setWikiBulkBusy(true)
    await runSafe(setError, async () => {
      const result = await api<WikiBulkJob>('/wiki/bulk/start', {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          username: currentUsername,
          include_images: wikiIncludeImages,
          max_pages: wikiBulkMaxPages <= 0 ? 0 : wikiBulkMaxPages,
        }),
      })
      setWikiBulkJobs((prev) => [result, ...prev.filter((item) => item.id !== result.id)].slice(0, 20))
      setWikiResult(
        `Started bulk Wikipedia download job #${result.id} (${wikiIncludeImages ? 'with images' : 'text-only'}).`,
      )
    })
    setWikiBulkBusy(false)
  }

  const onCancelWikiBulkJob = async (jobId: number) => {
    if (!currentUsername || !token) return
    await runSafe(setError, async () => {
      const canceled = await api<WikiBulkJob>(`/wiki/bulk/jobs/${encodeURIComponent(currentUsername)}/${jobId}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
      })
      setWikiBulkJobs((prev) => prev.map((item) => (item.id === canceled.id ? canceled : item)))
      setWikiResult(`Canceled bulk job #${jobId}.`)
    })
  }

  const onSearch = async () => {
    if (!currentUsername || !searchQuery.trim() || !token) return
    await runSafe(setError, async () => {
      const result = await api<{ results: SearchResult[] }>('/search', {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          username: currentUsername,
          query: searchQuery.trim(),
          top_k: searchTopK,
        }),
      })
      setSearchResults(result.results)
    })
  }

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Download Wikipedia
          </Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              label="Article title"
              placeholder="Ceph (software)"
              fullWidth
              value={wikiTitle}
              onChange={(e) => setWikiTitle(e.target.value)}
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={wikiIncludeImages}
                  onChange={(e) => setWikiIncludeImages(e.target.checked)}
                />
              }
              label={
                <Typography variant="body2">
                  {wikiIncludeImages ? 'Include images' : 'Text only'}
                </Typography>
              }
            />
            <Button variant="contained" onClick={onWikiDownload} disabled={wikiBusy}>
              {wikiBusy ? 'Downloading...' : 'Download + Index'}
            </Button>
            <Button variant="outlined" onClick={onWikiExportAllText} disabled={wikiExportBusy}>
              {wikiExportBusy ? 'Exporting...' : 'Export All Text'}
            </Button>
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mt: 1.5 }}>
            <TextField
              type="number"
              label="Bulk pages (0 = all)"
              value={wikiBulkMaxPages}
              onChange={(e) => setWikiBulkMaxPages(Number(e.target.value) || 0)}
              sx={{ width: { xs: '100%', md: 220 } }}
            />
            <Button
              variant="contained"
              color="secondary"
              onClick={onWikiBulkDownload}
              disabled={wikiBulkBusy || wikiBulkRunning}
            >
              {wikiBulkBusy ? 'Starting...' : wikiBulkRunning ? 'Bulk Job Running' : 'Download Entire Wikipedia'}
            </Button>
            {wikiBulkRunning && latestWikiBulkJob && (
              <Button variant="outlined" color="error" onClick={() => onCancelWikiBulkJob(latestWikiBulkJob.id)}>
                Cancel Job #{latestWikiBulkJob.id}
              </Button>
            )}
          </Stack>
          {wikiResult && (
            <Alert severity={wikiResult.includes('Indexed') ? 'success' : 'info'} sx={{ mt: 2 }}>
              {wikiResult}
            </Alert>
          )}
          {latestWikiBulkJob && (
            <Alert
              severity={
                latestWikiBulkJob.status === 'failed'
                  ? 'error'
                  : latestWikiBulkJob.status === 'completed'
                    ? 'success'
                    : latestWikiBulkJob.status === 'canceled'
                      ? 'warning'
                      : 'info'
              }
              sx={{ mt: 2 }}
            >
              {`Bulk job #${latestWikiBulkJob.id} • status: ${latestWikiBulkJob.status} • processed: ${latestWikiBulkJob.processed_pages} • indexed: ${latestWikiBulkJob.indexed_articles} • failed: ${latestWikiBulkJob.failed_pages}${
                latestWikiBulkJob.max_pages ? ` / max ${latestWikiBulkJob.max_pages}` : ''
              }`}
              {latestWikiBulkJob.last_error ? ` • error: ${latestWikiBulkJob.last_error}` : ''}
            </Alert>
          )}
          <Alert severity="info" sx={{ mt: 2 }}>
            Use flow: `1)` download one page or start bulk download, `2)` find it in Wiki Library (filter + title search),
            `3)` open it and use in-page search, `4)` run Semantic Search below for retrieval chunks.
          </Alert>
        </CardContent>
      </Card>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(290px, 360px) 1fr' },
          alignItems: 'start',
        }}
      >
        <Card variant="outlined" sx={{ position: { md: 'sticky' }, top: { md: 12 } }}>
          <CardContent sx={{ pb: 1 }}>
            <Typography variant="h6" gutterBottom>
              Wiki Library
            </Typography>
            <Tabs
              value={wikiLibraryFilter}
              onChange={(_, value) => setWikiLibraryFilter(value as 'all' | 'images' | 'text')}
              variant="fullWidth"
              sx={{ mb: 1 }}
            >
              <Tab value="all" label={`All (${wikiArticles.length})`} />
              <Tab value="images" label={`With Images (${wikiImageArticleCount})`} />
              <Tab value="text" label={`Text-Only (${wikiArticles.length - wikiImageArticleCount})`} />
            </Tabs>
            <TextField
              size="small"
              fullWidth
              placeholder="Find page by title..."
              value={wikiLibraryQuery}
              onChange={(e) => setWikiLibraryQuery(e.target.value)}
              sx={{ mb: 1 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              Showing {wikiFilteredArticles.length} of {wikiArticles.length} indexed pages
            </Typography>
            <List dense sx={{ maxHeight: { xs: 240, md: 580 }, overflowY: 'auto', pr: 0.5 }}>
              {wikiArticles.length === 0 && (
                <Stack alignItems="center" sx={{ py: 3, opacity: 0.5 }}>
                  <AutoStoriesIcon sx={{ fontSize: 36, mb: 1 }} />
                  <Typography variant="body2" color="text.secondary" textAlign="center">
                    No articles indexed yet. Download one above to get started.
                  </Typography>
                </Stack>
              )}
              {wikiArticles.length > 0 && wikiFilteredArticles.length === 0 && (
                <Stack alignItems="center" sx={{ py: 3, opacity: 0.65 }}>
                  <SearchIcon sx={{ fontSize: 30, mb: 1 }} />
                  <Typography variant="body2" color="text.secondary" textAlign="center">
                    No pages match your library search/filter.
                  </Typography>
                </Stack>
              )}
              {wikiFilteredArticles.map((article) => (
                <ListItem key={article.id} disablePadding>
                  <ListItemButton
                    selected={article.id === selectedWikiArticleId}
                    onClick={() => setSelectedWikiArticleId(article.id)}
                    sx={{ borderRadius: 1.5, mb: 0.5 }}
                  >
                    <ListItemText
                      primary={article.title}
                      secondary={`${formatLocalDate(article.downloaded_at)} • ${article.image_count} image${
                        article.image_count === 1 ? '' : 's'
                      }`}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>

        <Card
          variant="outlined"
          sx={{
            background: isDark ? 'none' : 'linear-gradient(160deg, rgba(255,255,255,0.98) 0%, rgba(241,248,255,0.95) 100%)',
          }}
        >
          <CardContent>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1}
              sx={{ mb: 1 }}
            >
              <Box>
                <Typography variant="h6">Wikipedia Viewer</Typography>
                <Typography variant="body2" color="text.secondary">
                  Read downloaded pages in a clean local reader.
                </Typography>
              </Box>
              {selectedWikiArticle?.url && (
                <Button size="small" variant="outlined" href={selectedWikiArticle.url} target="_blank" rel="noreferrer">
                  Open Source
                </Button>
              )}
            </Stack>
            <Divider sx={{ mb: 1.5 }} />

            {wikiViewerLoading && (
              <Stack direction="row" spacing={1.2} alignItems="center" sx={{ py: 2 }}>
                <CircularProgress size={20} />
                <Typography color="text.secondary">Loading article...</Typography>
              </Stack>
            )}

            {!wikiViewerLoading && !selectedWikiArticle && (
              <Typography color="text.secondary">Select an indexed article to open it in the viewer.</Typography>
            )}

            {!wikiViewerLoading && selectedWikiArticle && (
              <Box sx={{ maxHeight: { xs: 360, md: 580 }, overflowY: 'auto', pr: 1 }}>
                <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                  <Chip size="small" label={`Downloaded ${formatLocalDate(selectedWikiArticle.downloaded_at)}`} variant="outlined" />
                  <Chip size="small" label={`${selectedWikiArticle.content.length.toLocaleString()} chars`} variant="outlined" />
                  <Chip
                    size="small"
                    label={`${selectedWikiArticle.image_count} image${
                      selectedWikiArticle.image_count === 1 ? '' : 's'
                    }`}
                    variant="outlined"
                  />
                </Stack>
                <Typography variant="h5" sx={{ fontWeight: 700, mb: 1.2 }}>
                  {selectedWikiArticle.title}
                </Typography>
                <Tabs
                  value={wikiViewerTab}
                  onChange={(_, value) => setWikiViewerTab(value as 'text' | 'images')}
                  sx={{ mb: 1 }}
                >
                  <Tab value="text" label="Text" />
                  <Tab value="images" label={`Images (${selectedWikiArticle.images.length})`} />
                </Tabs>

                {wikiViewerTab === 'text' && (
                  <>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2} sx={{ mb: 1.2 }}>
                      <TextField
                        size="small"
                        fullWidth
                        placeholder="Search inside this article..."
                        value={wikiViewerSearch}
                        onChange={(e) => setWikiViewerSearch(e.target.value)}
                        InputProps={{
                          startAdornment: (
                            <InputAdornment position="start">
                              <SearchIcon fontSize="small" />
                            </InputAdornment>
                          ),
                        }}
                      />
                      <FormControlLabel
                        control={
                          <Switch
                            size="small"
                            checked={wikiViewerOnlyMatches}
                            onChange={(e) => setWikiViewerOnlyMatches(e.target.checked)}
                            disabled={!wikiViewerSearchValue}
                          />
                        }
                        label={
                          <Typography variant="body2">
                            Show Matches Only
                          </Typography>
                        }
                      />
                    </Stack>
                    {wikiViewerSearchValue && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.2 }}>
                        {wikiMatchedSegments.length} matching section{wikiMatchedSegments.length === 1 ? '' : 's'}
                      </Typography>
                    )}

                    {wikiVisibleSegments.length === 0 && wikiViewerSearchValue && (
                      <Typography color="text.secondary" sx={{ mb: 1.2 }}>
                        No text sections match your in-page search.
                      </Typography>
                    )}

                    {wikiSegments.length === 0 && (
                      <Typography color="text.secondary">This article has no readable text content.</Typography>
                    )}

                    {wikiVisibleSegments.map((segment, idx) =>
                      segment.kind === 'heading' ? (
                        <Typography
                          key={`heading-${idx}`}
                          variant={segment.level === 1 ? 'h6' : 'subtitle1'}
                          sx={{ mt: 2, mb: 0.8, fontWeight: 700 }}
                        >
                          {highlightText(segment.text, wikiViewerSearch)}
                        </Typography>
                      ) : (
                        <Typography
                          key={`paragraph-${idx}`}
                          variant="body1"
                          sx={{ mb: 1.2, color: 'text.primary', lineHeight: 1.75 }}
                        >
                          {highlightText(segment.text, wikiViewerSearch)}
                        </Typography>
                      ),
                    )}
                  </>
                )}

                {wikiViewerTab === 'images' && (
                  <>
                    {selectedWikiArticle.images.length === 0 && (
                      <Typography color="text.secondary">
                        No images downloaded for this article. Turn on &quot;Include images&quot; and download again.
                      </Typography>
                    )}
                    {selectedWikiArticle.images.length > 0 && (
                      <Box
                        sx={{
                          display: 'grid',
                          gap: 1.5,
                          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
                        }}
                      >
                        {selectedWikiArticle.images.map((image) => (
                          <Paper key={`${image.title}-${image.url}`} variant="outlined" sx={{ p: 1.2 }}>
                            <Box
                              component="img"
                              src={image.thumb_url || image.url}
                              alt={image.title}
                              sx={{
                                width: '100%',
                                height: 170,
                                objectFit: 'cover',
                                borderRadius: 1,
                                mb: 1,
                                bgcolor: 'action.hover',
                              }}
                            />
                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                              {image.title.replace(/^File:/i, '')}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.8 }}>
                              {image.width && image.height ? `${image.width} x ${image.height}` : 'Unknown size'}
                            </Typography>
                            <Button size="small" variant="outlined" href={image.url} target="_blank" rel="noreferrer">
                              View Original
                            </Button>
                          </Paper>
                        ))}
                      </Box>
                    )}
                  </>
                )}
              </Box>
            )}
          </CardContent>
        </Card>
      </Box>

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
            {searchResults.length === 0 && (
              <Stack alignItems="center" sx={{ py: 3, opacity: 0.5 }}>
                <SearchIcon sx={{ fontSize: 36, mb: 1 }} />
                <Typography variant="body2" color="text.secondary">
                  No search results yet. Enter a query above.
                </Typography>
              </Stack>
            )}
            {searchResults.map((item, idx) => (
              <Paper key={`${item.article_id}-${item.chunk_index}-${idx}`} variant="outlined" sx={{ p: 1.5 }}>
                <Typography variant="subtitle2">
                  {item.title} &middot; chunk {item.chunk_index} &middot; score {item.score.toFixed(4)}
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
  )
}
