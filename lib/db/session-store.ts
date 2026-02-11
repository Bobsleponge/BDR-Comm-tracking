// Shared session store that works in both Edge Runtime (middleware) and Node.js runtime
// This is a simple in-memory store - in production, use Redis or a database

export interface SessionData {
  userId: string;
  email: string;
  role: string;
  expiresAt: number;
}

// Global session store (shared across all instances)
// Note: In serverless environments, this will be per-instance, but that's fine for local dev
const sessions = new Map<string, SessionData>();

export function getSession(sessionId: string): SessionData | null {
  if (!sessionId || !sessions.has(sessionId)) {
    return null;
  }
  const session = sessions.get(sessionId)!;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

export function setSession(sessionId: string, data: SessionData): void {
  sessions.set(sessionId, data);
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}







