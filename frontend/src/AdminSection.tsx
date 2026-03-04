import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  CardContent,
  CircularProgress,
  List,
  ListItem,
  ListItemText,
  Typography,
} from '@mui/material'

import type { AdminUser, AuthUser } from './types'
import { api, authHeaders, formatLocalDate, runSafe } from './utils'

type AdminSectionProps = {
  token: string
  authUser: AuthUser
  setAuthUser: (user: AuthUser) => void
  setError: (msg: string) => void
}

export default function AdminSection({ token, authUser, setAuthUser, setError }: AdminSectionProps) {
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([])
  const [adminBusyId, setAdminBusyId] = useState<number | null>(null)

  const loadAdminUsers = useCallback(async () => {
    if (!token || !authUser.is_admin) return
    const data = await api<AdminUser[]>('/auth/users', { headers: authHeaders(token) })
    setAdminUsers(data)
  }, [authUser.is_admin, token])

  useEffect(() => {
    void runSafe(setError, loadAdminUsers)
  }, [loadAdminUsers, setError])

  const onToggleAdminRole = async (targetUser: AdminUser) => {
    if (!authUser.is_admin || !token) return
    setAdminBusyId(targetUser.id)
    await runSafe(setError, async () => {
      await api(`/auth/users/${targetUser.id}/role`, {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ is_admin: !targetUser.is_admin }),
      })
      await loadAdminUsers()
      const me = await api<AuthUser>('/auth/me', { headers: authHeaders(token) })
      setAuthUser(me)
      localStorage.setItem('lifenode_user', JSON.stringify(me))
    })
    setAdminBusyId(null)
  }

  if (!authUser.is_admin) {
    return (
      <Alert severity="warning">Only admin accounts can access this section.</Alert>
    )
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Admin Accounts
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          First registered account is admin by default. Use this panel to grant or revoke admin rights.
        </Typography>
        <List>
          {adminUsers.length === 0 && (
            <ListItem>
              <ListItemText primary="No users found." />
            </ListItem>
          )}
          {adminUsers.map((user) => (
            <ListItem
              key={user.id}
              secondaryAction={
                <Button
                  size="small"
                  variant={user.is_admin ? 'outlined' : 'contained'}
                  onClick={() => onToggleAdminRole(user)}
                  disabled={adminBusyId === user.id}
                  startIcon={adminBusyId === user.id ? <CircularProgress size={14} color="inherit" /> : undefined}
                >
                  {user.is_admin ? 'Revoke Admin' : 'Make Admin'}
                </Button>
              }
            >
              <ListItemText
                primary={`${user.username}${user.id === authUser.id ? ' (you)' : ''}`}
                secondary={`Role: ${user.is_admin ? 'Admin' : 'User'} \u00b7 Created ${formatLocalDate(user.created_at)}`}
              />
            </ListItem>
          ))}
        </List>
      </CardContent>
    </Card>
  )
}
