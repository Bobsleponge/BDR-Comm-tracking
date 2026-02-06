import { getLocalDB } from '../db/local-db';
import { generateUUID } from '../utils/uuid';

// Simple in-memory session store for local dev
const sessions = new Map<string, { userId: string; email: string; role?: string }>();

export class LocalSupabaseClient {
  private sessionId: string | null = null;

  auth = {
    getUser: async () => {
      if (!this.sessionId || !sessions.has(this.sessionId)) {
        return { data: { user: null }, error: null };
      }
      const session = sessions.get(this.sessionId)!;
      return {
        data: {
          user: {
            id: session.userId,
            email: session.email,
            user_metadata: { role: session.role || 'bdr' },
          },
        },
        error: null,
      };
    },
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const db = getLocalDB();
      // Simple auth - just check if email exists in bdr_reps
      const rep = db.prepare('SELECT * FROM bdr_reps WHERE email = ?').get(email) as any;
      
      if (!rep) {
        return { data: { user: null, session: null }, error: { message: 'Invalid credentials' } };
      }

      // Create session
      const sessionId = generateUUID();
      sessions.set(sessionId, {
        userId: rep.id,
        email: rep.email,
        role: rep.email === 'admin@example.com' ? 'admin' : 'bdr',
      });

      this.sessionId = sessionId;

      return {
        data: {
          user: {
            id: rep.id,
            email: rep.email,
            user_metadata: { role: rep.email === 'admin@example.com' ? 'admin' : 'bdr' },
          },
          session: { access_token: sessionId },
        },
        error: null,
      };
    },
    signOut: async () => {
      if (this.sessionId) {
        sessions.delete(this.sessionId);
        this.sessionId = null;
      }
      return { error: null };
    },
    onAuthStateChange: (callback: (event: string, session: any) => void) => {
      // Simple implementation
      return {
        data: { subscription: null },
        unsubscribe: () => {},
      };
    },
  };

  from = (table: string) => {
    const db = getLocalDB();
    return {
      select: (columns: string = '*') => ({
        eq: (col: string, val: any) => ({
          single: () => {
            const row = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${col} = ?`).get(val);
            return { data: row, error: null };
          },
          order: (col: string, options?: { ascending?: boolean }) => ({
            limit: (n: number) => {
              const order = options?.ascending === false ? 'DESC' : 'ASC';
              const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${col} = ? ORDER BY ${col} ${order} LIMIT ?`).all(val, n);
              return { data: rows, error: null };
            },
          }),
        }),
        order: (col: string, options?: { ascending?: boolean }) => ({
          limit: (n: number) => {
            const order = options?.ascending === false ? 'DESC' : 'ASC';
            const rows = db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${col} ${order} LIMIT ?`).all(n);
            return { data: rows, error: null };
          },
        }),
      }),
      insert: (data: any) => ({
        select: () => ({
          single: () => {
            const id = generateUUID();
            const row = { ...data, id };
            // Simple insert - you'd need to implement proper SQL here
            return { data: row, error: null };
          },
        }),
      }),
      update: (data: any) => ({
        eq: (col: string, val: any) => ({
          select: () => ({
            single: () => {
              return { data: { ...data }, error: null };
            },
          }),
        }),
      }),
      delete: () => ({
        eq: (col: string, val: any) => ({
          then: (callback: any) => {
            return { error: null };
          },
        }),
      }),
    };
  };
}





