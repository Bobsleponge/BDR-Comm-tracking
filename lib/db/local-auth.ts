import 'server-only';

import { getLocalDB } from './local-db';
import { generateUUID } from '../utils/uuid';
import { getSession, setSession, deleteSession } from './session-store';

export interface LocalUser {
  id: string;
  email: string;
  user_metadata: {
    role: string;
  };
}

export async function getLocalUser(): Promise<LocalUser | null> {
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const cookieValue = cookieStore.get('local_session')?.value;
  
  if (!cookieValue) {
    return null;
  }

  // Extract sessionId if cookie contains encoded data (format: sessionId:encodedData)
  const sessionId = cookieValue.includes(':') ? cookieValue.split(':')[0] : cookieValue;
  
  // Try to get from in-memory store first
  let session = getSession(sessionId);
  
  // If not in memory but cookie has encoded data, decode it
  if (!session && cookieValue.includes(':')) {
    const [, encodedData] = cookieValue.split(':');
    try {
      const decoded = Buffer.from(encodedData, 'base64').toString('utf-8');
      const sessionData = JSON.parse(decoded);
      if (Date.now() <= sessionData.expiresAt) {
        // Store in memory for future requests
        setSession(sessionId, sessionData);
        session = sessionData;
      } else {
        return null; // Session expired
      }
    } catch (e) {
      return null; // Decoding failed
    }
  }
  
  if (!session) {
    return null;
  }

  // OPTIMIZATION: Don't query database - we already have all the info we need in the session!
  // The session contains userId (which is the bdr_reps.id) and email
  // Only query if we need additional fields that aren't in the session
  // For now, construct user from session data to avoid DB query
  const user = {
    id: session.userId,
    email: session.email,
    user_metadata: {
      role: session.role,
    },
  };
  return user;
  } catch (error: any) {
    throw error;
  }
}

export async function createLocalSession(email: string, password: string): Promise<{ user: LocalUser; sessionId: string } | null> {
  const db = getLocalDB();
  
  // Simple auth - check if email exists (password ignored for local dev)
  // Use case-insensitive email lookup
  const emailLower = email.toLowerCase().trim();
  const rep = db.prepare('SELECT * FROM bdr_reps WHERE LOWER(email) = ?').get(emailLower) as any;
  
  if (!rep) {
    return null;
  }

  // Determine role (admin if email contains 'admin', otherwise 'bdr')
  const role = email.includes('admin') || email === 'admin@example.com' ? 'admin' : 'bdr';

  const sessionId = generateUUID();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

  // Store in memory (for API routes)
  setSession(sessionId, {
    userId: rep.id,
    email: rep.email,
    role,
    expiresAt,
  });

  // Also encode session data in the sessionId for Edge Runtime compatibility
  // Format: sessionId:encodedData (base64 encoded)
  const sessionData = {
    userId: rep.id,
    email: rep.email,
    role,
    expiresAt,
  };
  // Use btoa for base64 encoding (works in both Node.js and browser/Edge Runtime)
  const encodedSession = typeof Buffer !== 'undefined' 
    ? Buffer.from(JSON.stringify(sessionData)).toString('base64')
    : btoa(JSON.stringify(sessionData));
  const enhancedSessionId = `${sessionId}:${encodedSession}`;

  return {
    user: {
      id: rep.id,
      email: rep.email,
      user_metadata: { role },
    },
    sessionId: enhancedSessionId,
  };
}

export async function deleteLocalSession(sessionId: string): Promise<void> {
  deleteSession(sessionId);
}

export function getSessionFromCookie(cookieValue?: string): { userId: string; email: string; role: string } | null {
  if (!cookieValue) {
    return null;
  }
  const session = getSession(cookieValue);
  if (!session) {
    return null;
  }
  return {
    userId: session.userId,
    email: session.email,
    role: session.role,
  };
}

