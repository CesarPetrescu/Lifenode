import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Drawer,
  Fade,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Switch,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import MenuIcon from '@mui/icons-material/Menu'
import MapIcon from '@mui/icons-material/Map'
import AutoStoriesIcon from '@mui/icons-material/AutoStories'
import ChatIcon from '@mui/icons-material/Chat'
import EventNoteIcon from '@mui/icons-material/EventNote'
import NoteAltIcon from '@mui/icons-material/NoteAlt'
import FolderIcon from '@mui/icons-material/Folder'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import LogoutIcon from '@mui/icons-material/Logout'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import LightModeIcon from '@mui/icons-material/LightMode'
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord'
import { ColorModeContext } from './main'

import type { AppSection, AuthResponse, AuthUser, HealthResponse } from './types'
import { api, formatLocalDate } from './utils'
import AuthScreen from './AuthScreen'
import MapsSection from './MapsSection'
import AskSection from './AskSection'
import CalendarSection from './CalendarSection'
import NotesSection from './NotesSection'
import DriveSection from './DriveSection'
import AdminSection from './AdminSection'

const DRAWER_WIDTH = 272
const SECTION_QUERY_KEY = 'section'
const ALLOWED_SECTIONS: AppSection[] = ['wiki', 'maps', 'ask', 'calendar', 'notes', 'drive', 'admin']

function isAppSection(value: string | null): value is AppSection {
  if (!value) return false
  return (ALLOWED_SECTIONS as string[]).includes(value)
}

function readSectionFromUrl(): AppSection | null {
  const raw = new URLSearchParams(window.location.search).get(SECTION_QUERY_KEY)
  return isAppSection(raw) ? raw : null
}

function App() {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const colorMode = useContext(ColorModeContext)
  const isDark = theme.palette.mode === 'dark'
  const shellBg = isDark ? 'rgba(10, 12, 18, 0.9)' : 'rgba(244, 247, 255, 0.92)'
  const shellText = isDark ? 'rgba(236, 241, 255, 0.95)' : 'rgba(22, 29, 44, 0.95)'
  const shellBorder = isDark ? 'rgba(160, 176, 214, 0.22)' : 'rgba(154, 166, 194, 0.38)'

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [section, setSection] = useState<AppSection>(() => readSectionFromUrl() ?? 'wiki')
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState('')

  const [authLoading, setAuthLoading] = useState(true)
  const [token, setToken] = useState<string | null>(null)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)

  const currentUsername = authUser?.username ?? ''

  const navigationItems = useMemo(
    () => [
      { key: 'wiki' as const, label: 'Wiki', icon: <AutoStoriesIcon /> },
      { key: 'maps' as const, label: 'Maps', icon: <MapIcon /> },
      { key: 'ask' as const, label: 'Ask', icon: <ChatIcon /> },
      { key: 'calendar' as const, label: 'Calendar', icon: <EventNoteIcon /> },
      { key: 'notes' as const, label: 'Notes', icon: <NoteAltIcon /> },
      { key: 'drive' as const, label: 'Drive', icon: <FolderIcon /> },
      ...(authUser?.is_admin
        ? [{ key: 'admin' as const, label: 'Admin', icon: <AdminPanelSettingsIcon /> }]
        : []),
    ],
    [authUser?.is_admin],
  )

  const updateSectionUrl = useCallback((next: AppSection, replace = false) => {
    const url = new URL(window.location.href)
    if (url.searchParams.get(SECTION_QUERY_KEY) === next && !replace) {
      return
    }
    url.searchParams.set(SECTION_QUERY_KEY, next)
    if (replace) {
      window.history.replaceState({}, '', url)
      return
    }
    window.history.pushState({}, '', url)
  }, [])

  const setSectionWithUrl = useCallback((next: AppSection, replace = false) => {
    setSection(next)
    updateSectionUrl(next, replace)
  }, [updateSectionUrl])

  const clearSession = useCallback(() => {
    localStorage.removeItem('lifenode_token')
    localStorage.removeItem('lifenode_user')
    setToken(null)
    setAuthUser(null)
    setSectionWithUrl('wiki', true)
  }, [setSectionWithUrl])

  const setSession = useCallback((authData: AuthResponse) => {
    setToken(authData.token)
    setAuthUser(authData.user)
    localStorage.setItem('lifenode_token', authData.token)
    localStorage.setItem('lifenode_user', JSON.stringify(authData.user))
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<HealthResponse>('/health')
        setHealth(data)
      } catch { /* ignore */ }
    })()
  }, [])

  useEffect(() => {
    const savedToken = localStorage.getItem('lifenode_token')
    const savedUserRaw = localStorage.getItem('lifenode_user')
    if (!savedToken) {
      setAuthLoading(false)
      return
    }

    setToken(savedToken)
    if (savedUserRaw) {
      try {
        const parsedUser = JSON.parse(savedUserRaw) as AuthUser
        setAuthUser(parsedUser)
      } catch {
        // Ignore and fetch /me below.
      }
    }

    void (async () => {
      try {
        const me = await api<AuthUser>('/auth/me', {
          headers: { Authorization: `Bearer ${savedToken}` },
        })
        setAuthUser(me)
        localStorage.setItem('lifenode_user', JSON.stringify(me))
      } catch {
        clearSession()
      } finally {
        setAuthLoading(false)
      }
    })()
  }, [clearSession])

  useEffect(() => {
    if (section === 'admin' && !authUser?.is_admin) {
      setSectionWithUrl('wiki', true)
    }
  }, [authUser?.is_admin, section, setSectionWithUrl])

  useEffect(() => {
    const onPopState = () => {
      const fromUrl = readSectionFromUrl()
      if (fromUrl) {
        setSection(fromUrl)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!readSectionFromUrl()) {
      updateSectionUrl(section, true)
    }
  }, [section, updateSectionUrl])

  useEffect(() => {
    const sectionTitle = navigationItems.find((item) => item.key === section)?.label ?? 'LifeNode'
    document.title = `LifeNode · ${sectionTitle}`
  }, [navigationItems, section])

  const onLogout = async () => {
    if (token) {
      try {
        await api('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      } catch {
        // Best effort logout.
      }
    }
    clearSession()
  }

  const onAuth = (data: AuthResponse) => {
    setSession(data)
    setError('')
    setSectionWithUrl('wiki', true)
  }

  // ── Auth loading ────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <Stack direction="row" spacing={1.2} alignItems="center">
          <CircularProgress size={24} />
          <Typography>Loading LifeNode…</Typography>
        </Stack>
      </Box>
    )
  }

  // ── Login / Register ────────────────────────────────────────────────

  if (!authUser || !token) {
    return <AuthScreen error={error} setError={setError} onAuth={onAuth} />
  }

  // ── Drawer ──────────────────────────────────────────────────────────

  const drawerContent = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2.2 }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          LifeNode
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Command Center
        </Typography>
      </Box>
      <Divider />
      <List sx={{ pt: 0.5 }}>
        {navigationItems.map((item) => (
          <ListItem key={item.key} disablePadding>
            <ListItemButton
              selected={section === item.key}
              onClick={() => {
                setSectionWithUrl(item.key)
                if (!isDesktop) {
                  setDrawerOpen(false)
                }
              }}
              sx={{
                mx: 1,
                mb: 0.5,
                borderRadius: 1.5,
              }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <Box sx={{ px: 2, py: 1.5 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" alignItems="center" spacing={1}>
            {isDark ? <DarkModeIcon fontSize="small" /> : <LightModeIcon fontSize="small" />}
            <Typography variant="body2">{isDark ? 'Dark' : 'Light'}</Typography>
          </Stack>
          <Switch size="small" checked={isDark} onChange={colorMode.toggleColorMode} />
        </Stack>
      </Box>
      <Divider />
      <Box sx={{ p: 1.5 }}>
        <Button fullWidth variant="outlined" color="inherit" startIcon={<LogoutIcon />} onClick={onLogout}>
          Sign Out
        </Button>
      </Box>
    </Box>
  )

  // ── Section content ─────────────────────────────────────────────────

  const sectionProps = { token, currentUsername, setError }

  const renderSectionContent = () => {
    const content = (() => {
      if (section === 'wiki') return <MapsSection {...sectionProps} mode="kiwix" />
      if (section === 'maps') return <MapsSection {...sectionProps} mode="osm" />
      if (section === 'ask') return <AskSection {...sectionProps} />
      if (section === 'calendar') return <CalendarSection {...sectionProps} />
      if (section === 'notes') return <NotesSection {...sectionProps} />
      if (section === 'drive') return <DriveSection {...sectionProps} />
      return <AdminSection token={token} authUser={authUser} setAuthUser={setAuthUser} setError={setError} />
    })()

    return (
      <Fade in key={section} timeout={250}>
        <div>{content}</div>
      </Fade>
    )
  }

  // ── Main app ────────────────────────────────────────────────────────

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        bgcolor: isDark ? '#0d1018' : '#eef2fb',
        backgroundImage: isDark
          ? 'radial-gradient(circle at 10% 0%, rgba(68,94,159,0.16), transparent 42%)'
          : 'radial-gradient(circle at 10% 0%, rgba(83,110,183,0.22), transparent 45%)',
      }}
    >
      <a href="#main-content" className="skip-link">Skip to content</a>
      <AppBar position="fixed" color="transparent" elevation={0}>
        <Toolbar
          sx={{
            borderBottom: 1,
            borderColor: shellBorder,
            bgcolor: shellBg,
            color: shellText,
            backdropFilter: 'blur(10px)',
          }}
        >
          <IconButton
            aria-label="Open navigation menu"
            onClick={() => setDrawerOpen(true)}
            sx={{ mr: 1, display: { md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h5" component="h1" sx={{ flexGrow: 1, fontWeight: 700 }}>
            LifeNode
          </Typography>

          <Tooltip
            title={
              health
                ? `${health.status.toUpperCase()} | ${health.embedding_backend ?? 'No embeddings'} | ${health.llm_backend ?? 'No LLM'} | ${formatLocalDate(health.time)}`
                : 'Checking backend…'
            }
          >
            <FiberManualRecordIcon
              aria-label={health?.status === 'ok' ? 'Backend healthy' : 'Backend status unknown'}
              sx={{
                fontSize: 12,
                mr: 1.5,
                color: health?.status === 'ok' ? 'success.main' : 'warning.main',
              }}
            />
          </Tooltip>

          <Chip
            label={authUser.username}
            size="small"
            variant="outlined"
            sx={{ mr: 1 }}
          />
          <Chip
            label={authUser.is_admin ? 'Admin' : 'User'}
            color={authUser.is_admin ? 'secondary' : 'default'}
            size="small"
          />
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex' }}>
        <Drawer
          variant={isDesktop ? 'permanent' : 'temporary'}
          open={isDesktop ? true : drawerOpen}
          onClose={() => setDrawerOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: 1,
              borderColor: shellBorder,
              bgcolor: shellBg,
              color: shellText,
              mt: { xs: '64px', md: '64px' },
              height: { xs: 'calc(100% - 64px)', md: 'calc(100% - 64px)' },
            },
          }}
        >
          {drawerContent}
        </Drawer>

        <Box
          component="main"
          id="main-content"
          tabIndex={-1}
          sx={{
            flexGrow: 1,
            pt: '76px',
            px: { xs: 1.5, md: 3 },
            pb: 3,
            ml: { md: `${DRAWER_WIDTH}px` },
            width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          }}
        >
          <Container maxWidth="xl">
            <Box role="status" aria-live="polite" aria-atomic="true">
              {error && (
                <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
                  {error}
                </Alert>
              )}
            </Box>

            {renderSectionContent()}
          </Container>
        </Box>
      </Box>
    </Box>
  )
}

export default App
