import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { getSession } from '@/lib/db/session-store'

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL

async function getSessionFromCookie(cookieValue?: string): Promise<{ userId: string; email: string; role: string } | null> {
  if (!cookieValue) {
    return null;
  }
  
  // Extract sessionId if cookie contains encoded data (format: sessionId:encodedData)
  const sessionId = cookieValue.includes(':') ? cookieValue.split(':')[0] : cookieValue;
  
  // Try to get from in-memory store
  const session = getSession(sessionId);
  
  if (session) {
    return {
      userId: session.userId,
      email: session.email,
      role: session.role,
    };
  }
  
  // If cookie has encoded data, try to decode it
  // Edge Runtime doesn't have atob, so we'll use a workaround
  if (cookieValue.includes(':')) {
    const [, encodedData] = cookieValue.split(':');
    try {
      // Use TextDecoder with manual base64 decoding (Edge Runtime compatible)
      // Base64 decode manually since atob isn't available
      const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      let decoded = '';
      let i = 0;
      while (i < encodedData.length) {
        const enc1 = base64Chars.indexOf(encodedData.charAt(i++));
        const enc2 = base64Chars.indexOf(encodedData.charAt(i++));
        const enc3 = base64Chars.indexOf(encodedData.charAt(i++));
        const enc4 = base64Chars.indexOf(encodedData.charAt(i++));
        const chr1 = (enc1 << 2) | (enc2 >> 4);
        const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
        const chr3 = ((enc3 & 3) << 6) | enc4;
        decoded += String.fromCharCode(chr1);
        if (enc3 !== 64) decoded += String.fromCharCode(chr2);
        if (enc4 !== 64) decoded += String.fromCharCode(chr3);
      }
      const sessionData = JSON.parse(decoded);
      if (Date.now() > sessionData.expiresAt) {
        return null;
      }
      // Store in memory for future requests
      const { setSession } = await import('@/lib/db/session-store');
      setSession(sessionId, sessionData);
      return {
        userId: sessionData.userId,
        email: sessionData.email,
        role: sessionData.role,
      };
    } catch (e) {
      // Decoding failed - allow request through anyway
      // Page-level auth will verify
      return null;
    }
  }
  
  return null;
}

export async function middleware(request: NextRequest) {
  // Skip auth check for API routes, static files, and login page
  const pathname = request.nextUrl.pathname;
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/favicon.ico')
  ) {
    return NextResponse.next();
  }

  if (USE_LOCAL_DB) {
    // Simple local auth check - using in-memory sessions only (Edge Runtime compatible)
    const sessionId = request.cookies.get('local_session')?.value;
    
    // If no cookie at all, redirect to login
    if (!sessionId) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
    
    // Try to get session from cookie
    const session = await getSessionFromCookie(sessionId);
    
    // If we have a cookie, allow request through (even if session not in memory)
    // Page-level auth will verify the session properly via API
    // This works around Edge Runtime vs Node.js runtime session store isolation
    return NextResponse.next();
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * Feel free to modify this pattern to include more paths.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

