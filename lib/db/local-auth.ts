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
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:15',message:'getLocalUser called',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  try {
    // Dynamic import to ensure this only runs on the server
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:19',message:'Before cookies import',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    const { cookies } = await import('next/headers');
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:22',message:'Cookies imported, calling cookies()',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    const cookieStore = await cookies();
    const cookieValue = cookieStore.get('local_session')?.value;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:25',message:'Cookie retrieved',data:{hasCookie:!!cookieValue},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
  
  if (!cookieValue) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:28',message:'No cookie found',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
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
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:50',message:'Session expired',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        return null; // Session expired
      }
    } catch (e) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:57',message:'Session decode failed',data:{error:String(e)},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      // Decoding failed
      return null;
    }
  }
  
  if (!session) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:65',message:'No session found',data:{},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
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
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:77',message:'getLocalUser returning user',data:{userId:user.id,email:user.email,role:user.user_metadata.role},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  return user;
  } catch (error: any) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lib/db/local-auth.ts:82',message:'getLocalUser error',data:{error:error?.message,stack:error?.stack?.substring(0,200)},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
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

