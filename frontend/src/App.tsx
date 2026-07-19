import { Suspense, lazy, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactElement } from 'react'
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
  Paper,
  Stack,
  Tooltip,
  Toolbar,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
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
import { ColorModeContext } from './themeContext'

import type { AppSection, AuthResponse, AuthUser, HealthResponse } from './types'
import { api, formatLocalDate } from './utils'
import AuthScreen from './AuthScreen'

const DRAWER_WIDTH = 304
const SECTION_QUERY_KEY = 'section'
const ALLOWED_SECTIONS: AppSection[] = ['wiki', 'maps', 'ask', 'calendar', 'notes', 'drive', 'admin']

const loadWikiWorkspaceSection = () => import('./WikiWorkspaceSection')
const loadMapsSection = () => import('./MapsSection')
const loadAskSection = () => import('./AskSection')
const loadCalendarSection = () => import('./CalendarSection')
const loadNotesSection = () => import('./NotesSection')
const loadDriveSection = () => import('./DriveSection')
const loadAdminSection = () => import('./AdminSection')

const WikiWorkspaceSection = lazy(loadWikiWorkspaceSection)
const MapsSection = lazy(loadMapsSection)
const AskSection = lazy(loadAskSection)
const CalendarSection = lazy(loadCalendarSection)
const NotesSection = lazy(loadNotesSection)
const DriveSection = lazy(loadDriveSection)
const AdminSection = lazy(loadAdminSection)

const SECTION_PRELOADERS: Record<AppSection, () => Promise<unknown>> = {
  wiki: loadWikiWorkspaceSection,
  maps: loadMapsSection,
  ask: loadAskSection,
  calendar: loadCalendarSection,
  notes: loadNotesSection,
  drive: loadDriveSection,
  admin: loadAdminSection,
}

type NavigationItem = {
  key: AppSection
  label: string
  eyebrow: string
  description: string
  navHint: string
  icon: ReactElement
}

function preloadSection(section: AppSection) {
  void SECTION_PRELOADERS[section]()
}

function isAppSection(value: string | null): value is AppSection {
  if (!value) return false
  return (ALLOWED_SECTIONS as string[]).includes(value)
}

function readSectionFromUrl(): AppSection | null {
  const raw = new URLSearchParams(window.location.search).get(SECTION_QUERY_KEY)
  return isAppSection(raw) ? raw : null
}

function buildSectionHref(next: AppSection): string {
  const url = new URL(window.location.href)
  url.searchParams.set(SECTION_QUERY_KEY, next)
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`
}

function SectionLoadingState({ label }: { label: string }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        minHeight: 280,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 4,
        background:
          'linear-gradient(160deg, rgba(255,255,255,0.62) 0%, rgba(255,255,255,0.34) 100%)',
      }}
    >
      <Stack spacing={1.2} alignItems="center">
        <CircularProgress size={22} />
        <Typography variant="subtitle1">{`Loading ${label}`}</Typography>
        <Typography variant="body2" color="text.secondary">
          Preparing the workspace surface and its tools.
        </Typography>
      </Stack>
    </Paper>
  )
}

function App() {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const isDark = theme.palette.mode === 'dark'
  const colorMode = useContext(ColorModeContext)

  const shellBg = isDark ? alpha('#0d131d', 0.82) : alpha('#fffaf2', 0.88)
  const shellPanelBg = isDark ? alpha(theme.palette.background.paper, 0.86) : alpha('#fffdf9', 0.94)
  const shellText = theme.palette.text.primary
  const shellBorder = alpha(theme.palette.text.primary, isDark ? 0.16 : 0.08)
  const shellHover = alpha(theme.palette.primary.main, isDark ? 0.16 : 0.08)
  const shellActive = alpha(theme.palette.primary.main, isDark ? 0.22 : 0.12)
  const todayLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date())

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [section, setSection] = useState<AppSection>(() => readSectionFromUrl() ?? 'wiki')
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState('')

  const [authLoading, setAuthLoading] = useState(true)
  const [token, setToken] = useState<string | null>(null)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)

  const currentUsername = authUser?.username ?? ''

  const navigationItems = useMemo<NavigationItem[]>(
    () => [
      {
        key: 'wiki',
        label: 'Wiki',
        eyebrow: 'Knowledge',
        description: 'Operate Kiwix libraries and indexed retrieval-ready Wikipedia content.',
        navHint: 'Offline libraries + retrieval',
        icon: <AutoStoriesIcon />,
      },
      {
        key: 'maps',
        label: 'Maps',
        eyebrow: 'Navigation',
        description: 'Download geographic datasets and inspect them in a focused offline viewer.',
        navHint: 'Dataset downloads + OSM view',
        icon: <MapIcon />,
      },
      {
        key: 'ask',
        label: 'Ask',
        eyebrow: 'Assistant',
        description: 'Run local chat workflows with thread history and optional wiki retrieval context.',
        navHint: 'Local chat + retrieval',
        icon: <ChatIcon />,
      },
      {
        key: 'calendar',
        label: 'Calendar',
        eyebrow: 'Planning',
        description: 'Track personal events without leaving the local workspace.',
        navHint: 'Events and scheduling',
        icon: <EventNoteIcon />,
      },
      {
        key: 'notes',
        label: 'Notes',
        eyebrow: 'Writing',
        description: 'Capture markdown notes in folders with editing and live preview side by side.',
        navHint: 'Markdown workspace',
        icon: <NoteAltIcon />,
      },
      {
        key: 'drive',
        label: 'Drive',
        eyebrow: 'Storage',
        description: 'Manage files, previews, downloads, and folders from the same authenticated shell.',
        navHint: 'Files and previews',
        icon: <FolderIcon />,
      },
      ...(authUser?.is_admin
        ? [{
            key: 'admin' as const,
            label: 'Admin',
            eyebrow: 'Operations',
            description: 'Inspect users and access control settings for this LifeNode instance.',
            navHint: 'Users and roles',
            icon: <AdminPanelSettingsIcon />,
          }]
        : []),
    ],
    [authUser?.is_admin],
  )

  const currentSection = navigationItems.find((item) => item.key === section) ?? navigationItems[0]
  const healthChipColor = health?.status === 'ok' ? 'success' : health ? 'warning' : 'default'
  const healthLabel = health?.status === 'ok'
    ? 'System healthy'
    : health
      ? 'Needs attention'
      : 'Checking system'
  const healthSummary = health
    ? `${health.embedding_backend ?? 'Hash embeddings'} • ${health.llm_backend ?? 'Retrieval fallback'}`
    : 'Checking backend and local model services'

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

  const onSectionNavClick = useCallback((event: MouseEvent<HTMLAnchorElement>, next: AppSection) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return
    }

    event.preventDefault()
    setSectionWithUrl(next)
    if (!isDesktop) {
      setDrawerOpen(false)
    }
  }, [isDesktop, setSectionWithUrl])

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
    preloadSection(readSectionFromUrl() ?? 'wiki')
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<HealthResponse>('/health')
        setHealth(data)
      } catch {
        // ignore
      }
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
    document.title = `LifeNode · ${currentSection.label}`
  }, [currentSection.label])

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

  if (authLoading) {
    return (
      <Box
        sx={{
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          px: 2,
        }}
      >
        <Paper variant="outlined" sx={{ px: 3, py: 2.25, borderRadius: 4 }}>
          <Stack direction="row" spacing={1.2} alignItems="center">
            <CircularProgress size={22} />
            <Box>
              <Typography variant="subtitle1">Loading LifeNode</Typography>
              <Typography variant="body2" color="text.secondary">
                Restoring your workspace shell and session state.
              </Typography>
            </Box>
          </Stack>
        </Paper>
      </Box>
    )
  }

  if (!authUser || !token) {
    return <AuthScreen error={error} setError={setError} onAuth={onAuth} />
  }

  const drawerContent = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: shellPanelBg }}>
      <Box sx={{ p: 1.5 }}>
        <Paper
          variant="outlined"
          sx={{
            p: 2.2,
            borderRadius: 4,
            position: 'relative',
            overflow: 'hidden',
            background: isDark
              ? 'linear-gradient(165deg, rgba(24,34,48,0.98) 0%, rgba(13,19,29,0.98) 100%)'
              : 'linear-gradient(165deg, rgba(255,252,246,0.98) 0%, rgba(246,240,231,0.98) 100%)',
            '&::after': {
              content: '""',
              position: 'absolute',
              width: 160,
              height: 160,
              borderRadius: '50%',
              right: -58,
              top: -72,
              background: alpha(theme.palette.primary.main, isDark ? 0.18 : 0.12),
            },
          }}
        >
          <Chip size="small" color="primary" label="Local-first knowledge node" sx={{ mb: 1.5 }} />
          <Typography variant="h5">LifeNode</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 220 }}>
            One private shell for offline knowledge, local AI, files, notes, maps, and planning.
          </Typography>
        </Paper>
      </Box>

      <List component="nav" aria-label="Primary navigation" sx={{ px: 1, pb: 1 }}>
        {navigationItems.map((item) => (
          <ListItem key={item.key} disablePadding sx={{ mb: 0.75 }}>
            <ListItemButton
              component="a"
              href={buildSectionHref(item.key)}
              aria-current={section === item.key ? 'page' : undefined}
              selected={section === item.key}
              onMouseEnter={() => preloadSection(item.key)}
              onFocus={() => preloadSection(item.key)}
              onClick={(event: MouseEvent<HTMLAnchorElement>) => onSectionNavClick(event, item.key)}
              sx={{
                alignItems: 'flex-start',
                px: 1.25,
                py: 1.15,
                borderRadius: 3,
                border: '1px solid',
                borderColor: section === item.key ? alpha(theme.palette.primary.main, 0.28) : 'transparent',
                bgcolor: section === item.key ? shellActive : 'transparent',
                '&:hover': {
                  bgcolor: shellHover,
                },
                '& .MuiListItemIcon-root': {
                  minWidth: 40,
                  mt: 0.2,
                  color: section === item.key ? 'primary.main' : 'text.secondary',
                },
              }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText
                primary={item.label}
                secondary={item.navHint}
                primaryTypographyProps={{ fontWeight: 700 }}
                secondaryTypographyProps={{
                  sx: {
                    color: 'text.secondary',
                    lineHeight: 1.35,
                    mt: 0.15,
                  },
                }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <Box sx={{ p: 1.5 }}>
        <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 3, mb: 1.25 }}>
          <Typography variant="caption" color="text.secondary">
            Signed in as
          </Typography>
          <Typography variant="subtitle1" sx={{ mt: 0.2 }}>
            {authUser.username}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
            <Chip
              size="small"
              color={authUser.is_admin ? 'secondary' : 'default'}
              label={authUser.is_admin ? 'Admin access' : 'Personal workspace'}
            />
            <Chip
              size="small"
              variant="outlined"
              label={health ? `Synced ${formatLocalDate(health.time)}` : 'Health check pending'}
            />
          </Stack>
        </Paper>
        <Button fullWidth variant="outlined" color="inherit" startIcon={<LogoutIcon />} onClick={onLogout}>
          Sign Out
        </Button>
      </Box>
    </Box>
  )

  const sectionProps = { token, currentUsername, setError }

  const renderSectionContent = () => {
    const content = (() => {
      if (section === 'wiki') return <WikiWorkspaceSection {...sectionProps} />
      if (section === 'maps') return <MapsSection {...sectionProps} mode="osm" />
      if (section === 'ask') return <AskSection {...sectionProps} />
      if (section === 'calendar') return <CalendarSection {...sectionProps} />
      if (section === 'notes') return <NotesSection {...sectionProps} />
      if (section === 'drive') return <DriveSection {...sectionProps} />
      return <AdminSection token={token} authUser={authUser} setAuthUser={setAuthUser} setError={setError} />
    })()

    return (
      <Suspense fallback={<SectionLoadingState label={currentSection.label} />}>
        <Fade in key={section} timeout={250}>
          <div>{content}</div>
        </Fade>
      </Suspense>
    )
  }

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        position: 'relative',
        bgcolor: 'background.default',
        color: shellText,
        overflow: 'hidden',
        '&::before': {
          content: '""',
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage:
            isDark
              ? 'radial-gradient(circle at 8% 0%, rgba(122,162,255,0.14), transparent 24%), radial-gradient(circle at 92% 10%, rgba(79,209,197,0.12), transparent 18%)'
              : 'radial-gradient(circle at 8% 0%, rgba(29,78,216,0.13), transparent 24%), radial-gradient(circle at 92% 10%, rgba(194,65,12,0.09), transparent 18%)',
        },
      }}
    >
      <a href="#main-content" className="skip-link">Skip to content</a>

      <AppBar position="fixed" color="transparent" elevation={0}>
        <Toolbar
          sx={{
            minHeight: 64,
            gap: 1.25,
            borderBottom: 1,
            borderColor: shellBorder,
            bgcolor: shellBg,
            color: shellText,
            backdropFilter: 'blur(16px)',
          }}
        >
          <IconButton
            aria-label="Open navigation menu"
            onClick={() => setDrawerOpen(true)}
            sx={{ display: { md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>

          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">
              LifeNode / {currentSection.eyebrow}
            </Typography>
            <Typography variant="h6" noWrap>
              {currentSection.label}
            </Typography>
          </Box>

          <Chip
            size="small"
            variant="outlined"
            label={todayLabel}
            sx={{ display: { xs: 'none', lg: 'inline-flex' } }}
          />

          <Tooltip
            title={
              health
                ? `${health.status.toUpperCase()} | ${health.embedding_backend ?? 'No embeddings'} | ${health.llm_backend ?? 'No LLM'} | ${formatLocalDate(health.time)}`
                : 'Checking backend and local services'
            }
          >
            <Chip
              size="small"
              color={healthChipColor}
              variant={health?.status === 'ok' ? 'filled' : 'outlined'}
              icon={<FiberManualRecordIcon sx={{ fontSize: '0.72rem !important' }} />}
              label={healthLabel}
            />
          </Tooltip>

          <Chip
            size="small"
            variant="outlined"
            label={authUser.is_admin ? `${authUser.username} · Admin` : authUser.username}
            sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
          />

          <Tooltip title={`Switch to ${isDark ? 'light' : 'dark'} mode`}>
            <IconButton onClick={colorMode.toggleColorMode} aria-label="Toggle color mode">
              {isDark ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>
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
              bgcolor: shellPanelBg,
              mt: '64px',
              height: 'calc(100% - 64px)',
              backdropFilter: 'blur(18px)',
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
            minWidth: 0,
            pt: '84px',
            px: { xs: 1.5, md: 3 },
            pb: 4,
          }}
        >
          <Container maxWidth="xl" sx={{ position: 'relative' }}>
            <Paper
              variant="outlined"
              sx={{
                mb: 2.5,
                p: { xs: 2.2, md: 3 },
                borderRadius: 4,
                position: 'relative',
                overflow: 'hidden',
                background: isDark
                  ? 'linear-gradient(160deg, rgba(24,34,48,0.96) 0%, rgba(13,19,29,0.98) 100%)'
                  : 'linear-gradient(160deg, rgba(255,253,249,0.98) 0%, rgba(246,240,231,0.98) 100%)',
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  width: 280,
                  height: 280,
                  borderRadius: '50%',
                  right: -140,
                  top: -160,
                  background: alpha(theme.palette.primary.main, isDark ? 0.16 : 0.12),
                },
              }}
            >
              <Stack
                direction={{ xs: 'column', xl: 'row' }}
                justifyContent="space-between"
                spacing={2}
                sx={{ position: 'relative', zIndex: 1 }}
              >
                <Box sx={{ maxWidth: 760 }}>
                  <Typography variant="overline" color="text.secondary">
                    {currentSection.eyebrow}
                  </Typography>
                  <Typography variant="h3" sx={{ mt: 0.3 }}>
                    {currentSection.label}
                  </Typography>
                  <Typography variant="body1" color="text.secondary" sx={{ mt: 1.1, maxWidth: 720 }}>
                    {currentSection.description}
                  </Typography>
                </Box>

                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, alignSelf: 'flex-start' }}>
                  <Chip
                    size="small"
                    color={authUser.is_admin ? 'secondary' : 'default'}
                    label={authUser.is_admin ? 'Admin privileges enabled' : 'Personal workspace'}
                  />
                  <Chip
                    size="small"
                    variant="outlined"
                    color={healthChipColor}
                    label={health ? `Backend ${health.status}` : 'Backend check pending'}
                  />
                  <Chip size="small" variant="outlined" label={healthSummary} />
                </Stack>
              </Stack>
            </Paper>

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
