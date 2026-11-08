/** Who is sending: the anonymous visitor, the current session and the signed-in user. Pure; the client keeps the one current value. */
export interface Identity {
  anonymousId: string
  sessionId: string
  lastActivity: number
  userId?: string
}

export function newIdentity(newId: () => string): Identity {
  return { anonymousId: newId(), sessionId: newId(), lastActivity: 0 }
}

/**
 * The identity after one capture at `now`. `identified` is set by `identify`.
 * - Switching to a different known user starts a new anonymous id and session; the first identification keeps both, so earlier anonymous activity links to the user.
 * - A new session starts after `sessionTimeoutMs` of inactivity, counting exactly that long as inactive (`>=`).
 */
export function advance(current: Identity, now: number, sessionTimeoutMs: number, identified: string | undefined, newId: () => string): Identity {
  const switching = identified !== undefined && current.userId !== undefined && current.userId !== identified
  const userId = identified ?? current.userId
  return {
    anonymousId: switching ? newId() : current.anonymousId,
    sessionId: switching || now - current.lastActivity >= sessionTimeoutMs ? newId() : current.sessionId,
    lastActivity: now,
    ...(userId === undefined ? {} : { userId }),
  }
}

/** `reset()`: forget the user and start a new visitor and session. */
export function reset(now: number, newId: () => string): Identity {
  return { anonymousId: newId(), sessionId: newId(), lastActivity: now }
}
