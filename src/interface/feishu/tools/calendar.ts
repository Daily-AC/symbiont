import { getClient } from '../client.ts'

// ============ Helpers ============

/** Cache the primary calendar ID with 1-hour TTL. */
let primaryCalendarId: string | null = null
let primaryCalendarCachedAt = 0
const CALENDAR_CACHE_TTL = 3600_000 // 1 hour

async function getPrimaryCalendarId(): Promise<string> {
  if (primaryCalendarId && Date.now() - primaryCalendarCachedAt < CALENDAR_CACHE_TTL) {
    return primaryCalendarId
  }

  const client = getClient()
  const res = await client.calendar.calendar.primary()
  if (res.code !== 0) throw new Error(`Failed to get primary calendar: ${res.msg}`)

  const calId = res.data?.calendars?.[0]?.calendar?.calendar_id
  if (!calId) throw new Error('No primary calendar found')

  primaryCalendarId = calId
  primaryCalendarCachedAt = Date.now()
  return primaryCalendarId
}

/** Convert ISO 8601 datetime string to Unix timestamp string (seconds). */
function isoToTimestamp(iso: string): string {
  const ms = new Date(iso).getTime()
  if (isNaN(ms)) throw new Error(`Invalid datetime: ${iso}`)
  return Math.floor(ms / 1000).toString()
}

// ============ Exported Functions ============

/**
 * Create a calendar event.
 */
export async function createCalendarEvent(params: {
  title: string
  startTime: string
  endTime: string
  description?: string
  attendees?: string[]
}): Promise<{
  eventId: string | undefined
  // deno-lint-ignore no-explicit-any
  event: any
}> {
  const client = getClient()
  const calendarId = await getPrimaryCalendarId()

  // deno-lint-ignore no-explicit-any
  const data: Record<string, any> = {
    summary: params.title,
    start_time: { timestamp: isoToTimestamp(params.startTime) },
    end_time: { timestamp: isoToTimestamp(params.endTime) },
  }
  if (params.description) {
    data.description = params.description
  }

  const res = await client.calendar.calendarEvent.create({
    path: { calendar_id: calendarId },
    data: data as any,
  })
  if (res.code !== 0) throw new Error(`Failed to create event: ${res.msg}`)

  const eventId = res.data?.event?.event_id

  // Auto-add owner as attendee so the event appears on their personal calendar
  const ownerOpenId = process.env.FEISHU_OWNER_OPEN_ID
  const allAttendees = [...(params.attendees ?? [])]
  if (ownerOpenId && !allAttendees.includes(ownerOpenId)) {
    allAttendees.push(ownerOpenId)
  }

  // Add attendees if any
  if (allAttendees.length && eventId) {
    try {
      await client.calendar.calendarEventAttendee.create({
        path: { calendar_id: calendarId, event_id: eventId },
        data: {
          attendees: allAttendees.map((userId) => ({
            type: 'user' as const,
            user_id: userId,
          })),
        },
        params: { user_id_type: 'open_id' },
      })
    } catch (err) {
      // Non-critical: event is created, attendees failed
      console.warn(`[calendar] Failed to add attendees: ${err}`)
    }
  }

  return {
    eventId,
    event: res.data?.event,
  }
}

/**
 * List calendar events in a time range.
 */
export async function listCalendarEvents(params: {
  startTime: string
  endTime: string
}): Promise<{
  // deno-lint-ignore no-explicit-any
  events: any[]
  total: number
}> {
  const client = getClient()
  const calendarId = await getPrimaryCalendarId()

  const res = await client.calendar.calendarEvent.list({
    path: { calendar_id: calendarId },
    params: {
      start_time: isoToTimestamp(params.startTime),
      end_time: isoToTimestamp(params.endTime),
    },
  })
  if (res.code !== 0) throw new Error(`Failed to list events: ${res.msg}`)

  const events = res.data?.items ?? []
  return { events, total: events.length }
}

/**
 * Update a calendar event.
 */
export async function updateCalendarEvent(params: {
  eventId: string
  title?: string
  startTime?: string
  endTime?: string
  description?: string
}): Promise<{
  // deno-lint-ignore no-explicit-any
  event: any
}> {
  const client = getClient()
  const calendarId = await getPrimaryCalendarId()

  // deno-lint-ignore no-explicit-any
  const data: Record<string, any> = {}
  if (params.title !== undefined) data.summary = params.title
  if (params.startTime) data.start_time = { timestamp: isoToTimestamp(params.startTime) }
  if (params.endTime) data.end_time = { timestamp: isoToTimestamp(params.endTime) }
  if (params.description !== undefined) data.description = params.description

  const res = await client.calendar.calendarEvent.patch({
    path: { calendar_id: calendarId, event_id: params.eventId },
    data,
  })
  if (res.code !== 0) throw new Error(`Failed to update event: ${res.msg}`)

  return { event: res.data?.event }
}

/**
 * Delete a calendar event.
 */
export async function deleteCalendarEvent(params: {
  eventId: string
}): Promise<{ success: true }> {
  const client = getClient()
  const calendarId = await getPrimaryCalendarId()

  const res = await client.calendar.calendarEvent.delete({
    path: { calendar_id: calendarId, event_id: params.eventId },
  })
  if (res.code !== 0) throw new Error(`Failed to delete event: ${res.msg}`)

  return { success: true }
}
