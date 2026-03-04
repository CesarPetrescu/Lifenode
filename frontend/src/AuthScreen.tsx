import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'

import type { AuthMode, AuthResponse } from './types'
import { api, formatLocalDate } from './utils'

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
  const submitLabel = authMode === 'login' ? 'Sign In' : 'Create Account'

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
        background: isDark
          ? 'radial-gradient(circle at 8% 10%, #1a1d27 0%, #0f1117 38%, #0f1117 100%)'
          : 'radial-gradient(circle at 8% 10%, #e0efff 0%, #f4f8ff 38%, #f9fbff 100%)',
        display: 'grid',
        placeItems: 'center',
        px: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 520, borderRadius: 4 }}>
        <CardContent sx={{ p: 3 }}>
          <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>
            LifeNode
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            Local Knowledge + Personal Ops Hub
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
            sx={{ mb: 2 }}
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
            >
              {submitLabel}
            </Button>
          </Stack>

          {authMode === 'register' && (
            <Alert severity="info" sx={{ mt: 2 }}>
              First registered user becomes admin automatically.
            </Alert>
          )}
        </CardContent>
      </Card>
    </Box>
  )
}

// Keep formatLocalDate usage in the welcome message accessible from App.tsx
export { formatLocalDate }
