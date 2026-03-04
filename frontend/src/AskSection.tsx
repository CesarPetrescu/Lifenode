import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Avatar,
  Box,
  Button,
  CircularProgress,
  Fade,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import AddCommentIcon from '@mui/icons-material/AddComment'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import SmartToyIcon from '@mui/icons-material/SmartToy'
import PersonIcon from '@mui/icons-material/Person'
import SendIcon from '@mui/icons-material/Send'
import ChatIcon from '@mui/icons-material/Chat'

import type {
  AskSampling,
  AskThread,
  AskThreadDetail,
  ChatMessage,
  SectionProps,
} from './types'
import { API_BASE, api, authHeaders, formatChatTime, formatLocalDate, nextMsgId } from './utils'

const ASK_WIKI_RETRIEVAL_KEY = 'lifenode_ask_wiki_retrieval'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toUiMessage(message: AskThreadDetail['messages'][number]): ChatMessage {
  return {
    id: `srv_${message.id}`,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    contexts: message.contexts ?? undefined,
    sampling: message.sampling ?? undefined,
    thinking: message.thinking,
  }
}

export default function AskSection({ token, currentUsername, setError }: SectionProps) {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const [threads, setThreads] = useState<AskThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null)
  const [loadingThreads, setLoadingThreads] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)

  const [askQuestion, setAskQuestion] = useState('')
  const [askThinking, setAskThinking] = useState(false)
  const [askWikiRetrieval, setAskWikiRetrieval] = useState<boolean>(() => localStorage.getItem(ASK_WIKI_RETRIEVAL_KEY) === '1')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [askLoading, setAskLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages])

  useEffect(() => {
    localStorage.setItem(ASK_WIKI_RETRIEVAL_KEY, askWikiRetrieval ? '1' : '0')
  }, [askWikiRetrieval])

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  )

  const loadThreads = useCallback(async (preferredThreadId?: number | null) => {
    if (!currentUsername || !token) return
    setLoadingThreads(true)
    try {
      setError('')
      const data = await api<AskThread[]>(`/ask/threads/${encodeURIComponent(currentUsername)}`, {
        headers: authHeaders(token),
      })
      setThreads(data)
      setSelectedThreadId((prev) => {
        const preferred = preferredThreadId ?? prev
        if (preferred != null && data.some((thread) => thread.id === preferred)) return preferred
        return data[0]?.id ?? null
      })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingThreads(false)
    }
  }, [currentUsername, setError, token])

  const loadThreadMessages = useCallback(async (threadId: number | null) => {
    if (!threadId || !currentUsername || !token) {
      setChatMessages([])
      return
    }

    setLoadingMessages(true)
    try {
      setError('')
      const detail = await api<AskThreadDetail>(
        `/ask/threads/${encodeURIComponent(currentUsername)}/${threadId}`,
        { headers: authHeaders(token) },
      )
      setChatMessages(detail.messages.map(toUiMessage))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingMessages(false)
    }
  }, [currentUsername, setError, token])

  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  useEffect(() => {
    void loadThreadMessages(selectedThreadId)
  }, [loadThreadMessages, selectedThreadId])

  const onCreateThread = async () => {
    if (!currentUsername || !token) return
    try {
      setError('')
      const created = await api<AskThread>(`/ask/threads/${encodeURIComponent(currentUsername)}`, {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: 'New chat' }),
      })
      setSelectedThreadId(created.id)
      setChatMessages([])
      await loadThreads(created.id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onRenameThread = async (thread: AskThread) => {
    if (!currentUsername || !token) return
    const nextTitle = window.prompt('Rename chat…', thread.title)?.trim()
    if (!nextTitle) return
    try {
      setError('')
      await api<AskThread>(
        `/ask/threads/${encodeURIComponent(currentUsername)}/${thread.id}`,
        {
          method: 'PUT',
          headers: authHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ title: nextTitle }),
        },
      )
      await loadThreads(thread.id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onDeleteThread = async (threadId: number) => {
    if (!currentUsername || !token) return
    if (!window.confirm('Delete this chat and its messages?')) return
    try {
      setError('')
      await api(
        `/ask/threads/${encodeURIComponent(currentUsername)}/${threadId}`,
        {
          method: 'DELETE',
          headers: authHeaders(token),
        },
      )
      if (selectedThreadId === threadId) {
        setSelectedThreadId(null)
        setChatMessages([])
      }
      await loadThreads()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const onAsk = async () => {
    if (!currentUsername || !token || askLoading) return
    if (!askQuestion.trim()) {
      setError('Enter a question before sending.')
      return
    }
    setAskLoading(true)
    setError('')

    let activeThreadId = selectedThreadId
    if (!activeThreadId) {
      try {
        const created = await api<AskThread>(`/ask/threads/${encodeURIComponent(currentUsername)}`, {
          method: 'POST',
          headers: authHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ title: askQuestion.trim() }),
        })
        activeThreadId = created.id
        setSelectedThreadId(created.id)
      } catch (err) {
        setAskLoading(false)
        setError(errorMessage(err))
        return
      }
    }

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'user',
      content: askQuestion.trim(),
      timestamp: new Date().toISOString(),
    }

    const placeholderId = nextMsgId()
    const placeholder: ChatMessage = {
      id: placeholderId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      loading: true,
      thinking: askThinking,
    }

    setChatMessages((prev) => [...prev, userMsg, placeholder])
    const questionText = askQuestion.trim()
    setAskQuestion('')

    try {
      const res = await fetch(`${API_BASE}/ask/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: currentUsername,
          question: questionText,
          thinking: askThinking,
          use_wiki_retrieval: askWikiRetrieval,
          thread_id: activeThreadId,
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        let errMsg: string
        try {
          const obj = JSON.parse(text) as { error?: string }
          errMsg = obj.error ?? text
        } catch {
          errMsg = text || `Request failed (${res.status})`
        }
        throw new Error(errMsg)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''
      let msgSampling: AskSampling | undefined
      let msgThinking = false
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const rawLine of lines) {
          const line = rawLine.trim()

          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
            continue
          }

          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()

          if (currentEvent === 'meta') {
            try {
              const meta = JSON.parse(data) as {
                thread_id?: number
                sampling?: AskSampling
                thinking?: boolean
              }
              if (meta.thread_id) {
                activeThreadId = meta.thread_id
                setSelectedThreadId(meta.thread_id)
              }
              msgSampling = meta.sampling ?? undefined
              msgThinking = meta.thinking ?? false
            } catch {
              // ignore parse errors
            }
          } else if (currentEvent === 'delta') {
            try {
              const delta = JSON.parse(data) as { t?: string }
              accumulated += delta.t ?? ''
            } catch {
              accumulated += data
            }
            setChatMessages((prev) =>
              prev.map((msg) =>
                msg.id === placeholderId
                  ? { ...msg, content: accumulated, loading: false }
                  : msg,
              ),
            )
          } else if (currentEvent === 'done') {
            setChatMessages((prev) =>
              prev.map((msg) =>
                msg.id === placeholderId
                  ? {
                      ...msg,
                      content: accumulated,
                      sampling: msgSampling,
                      thinking: msgThinking,
                      loading: false,
                    }
                  : msg,
              ),
            )
          }
        }
      }

      setChatMessages((prev) =>
        prev.map((msg) =>
          msg.id === placeholderId && msg.loading
            ? {
                ...msg,
                content: accumulated || 'No response received.',
                sampling: msgSampling,
                thinking: msgThinking,
                loading: false,
              }
            : msg,
        ),
      )

      await loadThreads(activeThreadId)
      await loadThreadMessages(activeThreadId)
    } catch (err) {
      const msg = errorMessage(err)
      setError(msg)
      setChatMessages((prev) =>
        prev.map((item) =>
          item.id === placeholderId
            ? { ...item, content: 'Failed to get a response. Check the error above.', loading: false }
            : item,
        ),
      )
    }

    setAskLoading(false)
  }

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          height: { xs: 'calc(100dvh - 140px)', md: 'calc(100dvh - 170px)' },
        }}
      >
        <Box
          sx={{
            width: { xs: '100%', md: 320 },
            borderRight: { xs: 0, md: 1 },
            borderBottom: { xs: 1, md: 0 },
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
        <Box sx={{ p: 1.5 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Chats</Typography>
            {loadingThreads && <CircularProgress size={16} />}
          </Stack>
          <Button variant="outlined" size="small" startIcon={<AddCommentIcon />} onClick={() => void onCreateThread()} sx={{ mt: 1 }}>
            New Chat
          </Button>
        </Box>
        <Box sx={{ px: 1, pb: 1, overflowY: 'auto', overscrollBehavior: 'contain', flex: 1 }}>
          {threads.length === 0 && !loadingThreads ? (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="body2" color="text.secondary">
                No chat history yet. Start a new chat.
              </Typography>
            </Paper>
          ) : (
            <Stack spacing={0.5}>
              {threads.map((thread) => (
                <Paper
                  key={thread.id}
                  variant={selectedThreadId === thread.id ? 'elevation' : 'outlined'}
                  elevation={selectedThreadId === thread.id ? 2 : 0}
                  sx={{
                    p: 1,
                    bgcolor: selectedThreadId === thread.id
                      ? (t) => alpha(t.palette.primary.main, 0.09)
                      : 'transparent',
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <IconButton size="small" aria-label={`Open chat ${thread.title}`} onClick={() => setSelectedThreadId(thread.id)}>
                      <ChatIcon fontSize="small" />
                    </IconButton>
                    <Box
                      component="button"
                      type="button"
                      onClick={() => setSelectedThreadId(thread.id)}
                      sx={{
                        flex: 1,
                        cursor: 'pointer',
                        minWidth: 0,
                        p: 0,
                        m: 0,
                        border: 0,
                        bgcolor: 'transparent',
                        color: 'inherit',
                        textAlign: 'left',
                        font: 'inherit',
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {thread.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {thread.last_message_preview || 'No messages yet'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatLocalDate(thread.updated_at)}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip title="Rename…">
                        <IconButton size="small" aria-label={`Rename chat ${thread.title}`} onClick={() => void onRenameThread(thread)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete chat">
                        <IconButton size="small" color="error" aria-label={`Delete chat ${thread.title}`} onClick={() => void onDeleteThread(thread.id)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </Box>
        </Box>

        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Box
          sx={{
            flex: 1,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            px: { xs: 1.5, md: 3 },
            py: 2,
          }}
        >
          {loadingMessages ? (
            <Stack alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
              <CircularProgress size={30} />
            </Stack>
          ) : chatMessages.length === 0 ? (
            <Stack alignItems="center" justifyContent="center" sx={{ height: '100%', opacity: 0.45 }}>
              <SmartToyIcon sx={{ fontSize: 64, mb: 2, color: 'text.secondary' }} />
              <Typography variant="h6" color="text.secondary">
                {selectedThread ? selectedThread.title : 'Start a chat'}
              </Typography>
              <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 460, mt: 0.5 }}>
                Ask the local assistant directly. Each conversation is saved in the chat sidebar.
              </Typography>
            </Stack>
          ) : (
            chatMessages.map((msg) => (
              <Fade in key={msg.id}>
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    mb: 2,
                  }}
                >
                  {msg.role === 'assistant' && (
                    <Avatar
                      sx={{
                        bgcolor: 'secondary.main',
                        width: 32,
                        height: 32,
                        mr: 1,
                        mt: 0.5,
                      }}
                    >
                      <SmartToyIcon sx={{ fontSize: 18 }} />
                    </Avatar>
                  )}

                  <Box sx={{ maxWidth: { xs: '88%', md: '78%' }, minWidth: 0 }}>
                    <Paper
                      elevation={0}
                      sx={{
                        px: 2,
                        py: 1.5,
                        borderRadius:
                          msg.role === 'user'
                            ? '16px 16px 4px 16px'
                            : '16px 16px 16px 4px',
                        bgcolor:
                          msg.role === 'user'
                            ? 'primary.main'
                            : (t) => alpha(t.palette.text.primary, 0.06),
                        color:
                          msg.role === 'user'
                            ? 'primary.contrastText'
                            : 'text.primary',
                      }}
                    >
                      {msg.loading ? (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <CircularProgress size={16} color="inherit" />
                          <Typography variant="body2">
                            {msg.thinking ? 'Thinking deeply…' : 'Generating answer…'}
                          </Typography>
                        </Stack>
                      ) : (
                        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, wordBreak: 'break-word' }}>
                          {msg.content}
                        </Typography>
                      )}
                    </Paper>

                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: 'block',
                        mt: 0.5,
                        textAlign: msg.role === 'user' ? 'right' : 'left',
                        px: 1,
                      }}
                    >
                      {formatChatTime(msg.timestamp)}
                      {msg.thinking && !msg.loading && ' \u00b7 thinking'}
                      {msg.sampling && !msg.loading && ` \u00b7 T=${msg.sampling.temperature}`}
                    </Typography>
                  </Box>

                  {msg.role === 'user' && (
                    <Avatar
                      sx={{
                        bgcolor: 'primary.dark',
                        width: 32,
                        height: 32,
                        ml: 1,
                        mt: 0.5,
                      }}
                    >
                      <PersonIcon sx={{ fontSize: 18 }} />
                    </Avatar>
                  )}
                </Box>
              </Fade>
            ))
          )}
          <div ref={chatEndRef} />
        </Box>

        <Paper
          elevation={3}
          sx={{
            p: 1.5,
            borderTop: 1,
            borderColor: (t) => (t.palette.mode === 'dark'
              ? alpha(t.palette.common.white, 0.12)
              : alpha(t.palette.common.black, 0.14)),
            bgcolor: (t) => (t.palette.mode === 'dark'
              ? 'rgba(12, 16, 24, 0.94)'
              : 'rgba(248, 251, 255, 0.96)'),
            color: (t) => (t.palette.mode === 'dark' ? 'rgba(236, 241, 255, 0.95)' : 'inherit'),
            borderRadius: 0,
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={askThinking}
                  onChange={(e) => setAskThinking(e.target.checked)}
                />
              }
              label={
                <Typography variant="body2">
                  {askThinking ? 'Thinking' : 'Fast'}
                </Typography>
              }
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={askWikiRetrieval}
                  onChange={(e) => setAskWikiRetrieval(e.target.checked)}
                />
              }
              label={
                <Typography variant="body2">
                  {askWikiRetrieval ? 'Wiki Retrieval: On' : 'Wiki Retrieval: Off'}
                </Typography>
              }
            />
          </Stack>
          <Stack
            component="form"
            direction="row"
            spacing={1}
            alignItems="flex-end"
            onSubmit={(event) => {
              event.preventDefault()
              void onAsk()
            }}
          >
            <TextField
              fullWidth
              multiline
              maxRows={4}
              placeholder="Ask a question…"
              value={askQuestion}
              onChange={(e) => setAskQuestion(e.target.value)}
              autoFocus={isDesktop}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void onAsk()
                }
              }}
              helperText="Press Enter for newline. Press Ctrl/Cmd + Enter to send."
              size="small"
            />
            <Button
              color="primary"
              variant="contained"
              type="submit"
              disabled={askLoading}
              startIcon={askLoading ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
            >
              Send
            </Button>
          </Stack>
        </Paper>
        </Box>
      </Box>
    </Paper>
  )
}
