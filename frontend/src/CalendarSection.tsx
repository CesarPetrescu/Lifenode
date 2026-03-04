import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import EventNoteIcon from '@mui/icons-material/EventNote'

import ConfirmDialog from './ConfirmDialog'
import type { CalendarEvent, SectionProps } from './types'
import { api, authHeaders, formatLocalDate, runSafe } from './utils'

export default function CalendarSection({ token, currentUsername, setError }: SectionProps) {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [eventTitle, setEventTitle] = useState('')
  const [eventStart, setEventStart] = useState('')
  const [eventEnd, setEventEnd] = useState('')
  const [eventDetails, setEventDetails] = useState('')
  const [creatingEvent, setCreatingEvent] = useState(false)
  const [deletingEventId, setDeletingEventId] = useState<number | null>(null)
  const [deleteEventTarget, setDeleteEventTarget] = useState<CalendarEvent | null>(null)

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => a.start_ts.localeCompare(b.start_ts)),
    [events],
  )

  const loadEvents = useCallback(async () => {
    if (!currentUsername || !token) return
    const data = await api<CalendarEvent[]>(`/calendar/events/${encodeURIComponent(currentUsername)}`, {
      headers: authHeaders(token),
    })
    setEvents(data)
  }, [currentUsername, token])

  useEffect(() => {
    void runSafe(setError, loadEvents)
  }, [loadEvents, setError])

  const onCreateEvent = async () => {
    if (!currentUsername || !token) return
    if (!eventTitle.trim() || !eventStart || !eventEnd) {
      setError('Complete title, start, and end before creating an event.')
      return
    }
    if (new Date(eventEnd).getTime() <= new Date(eventStart).getTime()) {
      setError('Event end must be after the start time.')
      return
    }
    setCreatingEvent(true)
    await runSafe(setError, async () => {
      await api<CalendarEvent>(`/calendar/events/${encodeURIComponent(currentUsername)}`, {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
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
    setCreatingEvent(false)
  }

  const onDeleteEvent = async () => {
    const eventId = deleteEventTarget?.id
    if (!currentUsername || !token) return
    if (!eventId) return
    setDeletingEventId(eventId)
    await runSafe(setError, async () => {
      await api(`/calendar/events/${encodeURIComponent(currentUsername)}/${eventId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      })
      await loadEvents()
    })
    setDeleteEventTarget(null)
    setDeletingEventId(null)
  }

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Create Event
          </Typography>
          <Stack
            component="form"
            spacing={1.2}
            onSubmit={(event) => {
              event.preventDefault()
              void onCreateEvent()
            }}
          >
            <TextField
              label="Title"
              placeholder="Event title…"
              fullWidth
              value={eventTitle}
              onChange={(e) => setEventTitle(e.target.value)}
            />
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
              placeholder="Optional details…"
              value={eventDetails}
              onChange={(e) => setEventDetails(e.target.value)}
            />
            <Button
              type="submit"
              variant="contained"
              disabled={creatingEvent}
              startIcon={creatingEvent ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              Add Event
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
            {sortedEvents.length === 0 && (
              <Stack alignItems="center" sx={{ py: 3, opacity: 0.5 }}>
                <EventNoteIcon sx={{ fontSize: 36, mb: 1 }} />
                <Typography variant="body2" color="text.secondary">
                  No events yet. Create one above.
                </Typography>
              </Stack>
            )}
            {sortedEvents.map((event) => (
              <ListItem
                key={event.id}
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label={`Delete event ${event.title}`}
                    onClick={() => setDeleteEventTarget(event)}
                    disabled={deletingEventId === event.id}
                  >
                    <DeleteIcon />
                  </IconButton>
                }
              >
                <ListItemText
                  primary={event.title}
                  secondary={`${formatLocalDate(event.start_ts)} \u2192 ${formatLocalDate(event.end_ts)}${event.details ? ` \u00b7 ${event.details}` : ''}`}
                />
              </ListItem>
            ))}
          </List>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={deleteEventTarget != null}
        title="Delete Event"
        message={`Delete "${deleteEventTarget?.title ?? ''}"?`}
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleteEventTarget != null && deletingEventId === deleteEventTarget.id}
        onClose={() => setDeleteEventTarget(null)}
        onConfirm={() => void onDeleteEvent()}
      />
    </Stack>
  )
}
