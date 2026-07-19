import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import StorageRoundedIcon from '@mui/icons-material/StorageRounded'
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded'
import SecurityRoundedIcon from '@mui/icons-material/SecurityRounded'

import type { AuthMode, AuthResponse } from './types'
import { api } from './utils'

type AuthScreenProps = {
  error: string
  setError: (msg: string) => void
  onAuth: (data: AuthResponse) => void
}

export default function AuthScreen({ error, setError, onAuth }: AuthScreenProps) {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'

  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authBusy, setAuthBusy] = useState(false)
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('')

  const submitLabel = authMode === 'login' ? 'Enter Workspace' : 'Create Account'
  const headline = authMode === 'login' ? 'Return to your node' : 'Create your LifeNode account'
  const subcopy = authMode === 'login'
    ? 'Sign in to your local knowledge workspace, restore your files, and continue your conversations.'
    : 'Create a local account to start managing offline libraries, notes, drive files, and chat threads.'

  const highlights = useMemo(
    () => [
      {
        icon: <StorageRoundedIcon fontSize="small" />,
        title: 'Offline knowledge base',
        text: 'Kiwix libraries, indexed Wikipedia articles, and file storage stay under your control.',
      },
      {
        icon: <SmartToyRoundedIcon fontSize="small" />,
        title: 'Local AI workspace',
        text: 'Ask, notes, drive, and calendar share one workspace instead of splitting the workflow across tools.',
      },
      {
        icon: <SecurityRoundedIcon fontSize="small" />,
        title: 'Self-hosted by default',
        text: 'LifeNode runs on your hardware with multi-user access, admin bootstrap, and private local data.',
      },
    ],
    [],
  )

  const onAuthSubmit = async () => {
    if (!authUsername.trim() || !authPassword) {
      setError('Enter both username and password.')
      return
    }
    if (authMode === 'register') {
      if (authPassword.length < 8) {
        setError('Password must be at least 8 characters.')
        return
      }
      if (authPassword !== authPasswordConfirm) {
        setError('Passwords do not match.')
        return
      }
    }

    setAuthBusy(true)
    try {
      setError('')
      const endpoint = authMode === 'register' ? '/auth/register' : '/auth/login'
      const response = await api<AuthResponse>(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: authUsername.trim(),
          password: authPassword,
        }),
      })
      setAuthPassword('')
      setAuthPasswordConfirm('')
      onAuth(response)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setAuthBusy(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        position: 'relative',
        overflow: 'hidden',
        px: { xs: 2, md: 3 },
        py: { xs: 2, md: 3 },
        background: isDark
          ? 'radial-gradient(circle at 0% 0%, rgba(122,162,255,0.2), transparent 32%), radial-gradient(circle at 88% 10%, rgba(79,209,197,0.16), transparent 26%), linear-gradient(180deg, #0d131d 0%, #101825 100%)'
          : 'radial-gradient(circle at 0% 0%, rgba(29,78,216,0.18), transparent 32%), radial-gradient(circle at 88% 10%, rgba(194,65,12,0.12), transparent 24%), linear-gradient(180deg, #f5f1e8 0%, #f8f4eb 100%)',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Box
        aria-hidden="true"
        sx={{
          position: 'absolute',
          inset: 'auto auto -18% -10%',
          width: 420,
          height: 420,
          borderRadius: '50%',
          background: isDark ? 'rgba(79,209,197,0.08)' : 'rgba(29,78,216,0.1)',
          filter: 'blur(28px)',
          animation: 'lifenodeFloat 16s ease-in-out infinite',
        }}
      />
      <Card
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 1120,
          borderRadius: { xs: 4, md: 5 },
          overflow: 'hidden',
          backdropFilter: 'blur(18px)',
        }}
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1.04fr 0.96fr' },
          }}
        >
          <Box
            sx={{
              position: 'relative',
              p: { xs: 3, md: 4.25 },
              color: isDark ? 'common.white' : '#142033',
              background: isDark
                ? 'linear-gradient(160deg, rgba(24,34,48,0.96) 0%, rgba(13,19,29,0.98) 100%)'
                : 'linear-gradient(160deg, rgba(255,252,246,0.98) 0%, rgba(246,240,231,0.98) 100%)',
              borderBottom: { xs: 1, md: 0 },
              borderRight: { xs: 0, md: 1 },
              borderColor: 'divider',
            }}
          >
            <Chip
              size="small"
              color="primary"
              label="Local-first / self-hosted"
              sx={{ mb: 2 }}
            />
            <Typography variant="h2" sx={{ maxWidth: 520 }}>
              LifeNode
            </Typography>
            <Typography
              variant="h6"
              color={isDark ? 'rgba(238,243,255,0.82)' : 'rgba(20,32,51,0.72)'}
              sx={{ mt: 1.25, maxWidth: 560, lineHeight: 1.45 }}
            >
              Private knowledge, local AI, and personal operations in one workspace.
            </Typography>

            <Stack direction="row" spacing={1} sx={{ mt: 2.5, flexWrap: 'wrap', rowGap: 1 }}>
              <Chip size="small" label="Kiwix + indexed wiki" variant="outlined" />
              <Chip size="small" label="Notes + drive + calendar" variant="outlined" />
              <Chip size="small" label="Streaming local chat" variant="outlined" />
            </Stack>

            <Stack spacing={1.25} sx={{ mt: 3.5 }}>
              {highlights.map((item) => (
                <Box
                  key={item.title}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: '44px 1fr',
                    gap: 1.5,
                    alignItems: 'start',
                    p: 1.5,
                    borderRadius: 3,
                    backgroundColor: alpha(
                      isDark ? '#ffffff' : theme.palette.primary.main,
                      isDark ? 0.04 : 0.05,
                    ),
                    border: `1px solid ${alpha(
                      isDark ? '#ffffff' : theme.palette.primary.main,
                      isDark ? 0.08 : 0.12,
                    )}`,
                  }}
                >
                  <Box
                    sx={{
                      width: 44,
                      height: 44,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 2.5,
                      bgcolor: alpha(theme.palette.primary.main, isDark ? 0.24 : 0.12),
                      color: 'primary.main',
                    }}
                  >
                    {item.icon}
                  </Box>
                  <Box>
                    <Typography variant="subtitle1">{item.title}</Typography>
                    <Typography
                      variant="body2"
                      color={isDark ? 'rgba(238,243,255,0.74)' : 'rgba(20,32,51,0.68)'}
                    >
                      {item.text}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          </Box>

          <CardContent sx={{ p: { xs: 3, md: 4.25 } }}>
            <Typography variant="overline" color="text.secondary">
              Account Access
            </Typography>
            <Typography variant="h4" sx={{ mt: 0.5 }}>
              {headline}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1, mb: 2.5, maxWidth: 520 }}>
              {subcopy}
            </Typography>

            <Box role="status" aria-live="polite" aria-atomic="true">
              {error && (
                <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
                  {error}
                </Alert>
              )}
            </Box>

            <Tabs
              value={authMode === 'login' ? 0 : 1}
              onChange={(_, value) => setAuthMode(value === 0 ? 'login' : 'register')}
              sx={{ mb: 2.5 }}
            >
              <Tab label="Sign In" />
              <Tab label="Register" />
            </Tabs>

            <Stack
              component="form"
              spacing={1.5}
              onSubmit={(event) => {
                event.preventDefault()
                void onAuthSubmit()
              }}
            >
              <TextField
                label="Username"
                placeholder="your-username"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                autoComplete="username"
                name="username"
                autoFocus
              />
              <TextField
                label="Password"
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                name="password"
                helperText={authMode === 'register' ? 'Use at least 8 characters.' : ' '}
              />
              {authMode === 'register' && (
                <TextField
                  label="Confirm Password"
                  type="password"
                  value={authPasswordConfirm}
                  onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  name="confirm_password"
                />
              )}
              <Button
                variant="contained"
                size="large"
                type="submit"
                disabled={authBusy}
                startIcon={authBusy ? <CircularProgress size={16} color="inherit" /> : undefined}
                sx={{ mt: 0.5 }}
              >
                {submitLabel}
              </Button>
            </Stack>

            <Alert severity="info" sx={{ mt: 2.5 }}>
              {authMode === 'register'
                ? 'The first registered account becomes admin automatically.'
                : 'LifeNode keeps sessions local to this node and signs you into your personal workspace.'}
            </Alert>
          </CardContent>
        </Box>
      </Card>
    </Box>
  )
}
