import 'server-only';

import { getLocalDB } from '../db/local-db';
import { getLocalUser, createLocalSession, deleteLocalSession, LocalUser } from '../db/local-auth';
import { generateUUID } from '../utils/uuid';

export async function createLocalClient() {
  const db = getLocalDB();
  const user = await getLocalUser();

  return {
    auth: {
      getUser: async () => {
        return {
          data: { user },
          error: null,
        };
      },
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        const result = await createLocalSession(email, password);
        if (!result) {
          return {
            data: { user: null, session: null },
            error: { message: 'Invalid credentials' },
          };
        }

        // Dynamic import to ensure this only runs on the server
        const { cookies } = await import('next/headers');
        const cookieStore = await cookies();
        cookieStore.set('local_session', result.sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 7, // 7 days
        });

        return {
          data: {
            user: result.user,
            session: { access_token: result.sessionId },
          },
          error: null,
        };
      },
      signOut: async () => {
        // Dynamic import to ensure this only runs on the server
        const { cookies } = await import('next/headers');
        const cookieStore = await cookies();
        const sessionId = cookieStore.get('local_session')?.value;
        if (sessionId) {
          await deleteLocalSession(sessionId);
          cookieStore.delete('local_session');
        }
        return { error: null };
      },
      onAuthStateChange: () => ({
        data: { subscription: null },
        unsubscribe: () => {},
      }),
    },
    from: (table: string) => {
      return {
        select: (columns: string = '*') => {
          // Store original columns string for result transformation
          const originalColumns = columns;
          
          // Parse Supabase nested select syntax: "*, deals(client_name, service_type), bdr_reps(name, email)"
          // Convert to SQL JOINs
          let selectColumns: string[] = [];
          let joins: string[] = [];
          let joinParams: any[] = [];
          
          if (columns === '*') {
            selectColumns.push(`${table}.*`);
          } else {
            // Parse the columns string
            const parts = columns.split(',').map(p => p.trim());
            for (const part of parts) {
              if (part === '*') {
                selectColumns.push(`${table}.*`);
              } else if (part.includes('(') && part.includes(')')) {
                // Nested select: "deals(client_name, service_type)"
                const match = part.match(/(\w+)\(([^)]+)\)/);
                if (match) {
                  const relatedTable = match[1];
                  const relatedColumns = match[2].split(',').map(c => c.trim());
                  
                  // Determine foreign key relationship
                  let fkColumn = '';
                  let relatedPk = 'id';
                  
                  if (relatedTable === 'deals') {
                    fkColumn = 'deal_id';
                  } else if (relatedTable === 'bdr_reps') {
                    fkColumn = 'bdr_id';
                  } else if (relatedTable === 'clients') {
                    fkColumn = 'client_id';
                  }
                  
                  if (fkColumn) {
                    // Add JOIN
                    joins.push(`LEFT JOIN ${relatedTable} ON ${table}.${fkColumn} = ${relatedTable}.${relatedPk}`);
                    
                    // Add columns with table prefix
                    for (const col of relatedColumns) {
                      if (col === '*') {
                        // Handle wildcard: select all columns from related table
                        // We need to get all columns from the related table
                        // For now, use a subquery or select all with proper aliasing
                        selectColumns.push(`${relatedTable}.*`);
                      } else {
                        selectColumns.push(`${relatedTable}.${col} AS ${relatedTable}_${col}`);
                      }
                    }
                  }
                }
              } else {
                // Regular column
                selectColumns.push(part.includes('.') ? part : `${table}.${part}`);
              }
            }
          }
          
          const selectClause = selectColumns.length > 0 ? selectColumns.join(', ') : `${table}.*`;
          const joinClause = joins.length > 0 ? ' ' + joins.join(' ') : '';
          const baseQuery = `SELECT ${selectClause} FROM ${table}${joinClause}`;
          let whereClauses: string[] = [];
          let whereParams: any[] = [];
          let orderClause = '';
          let limitClause = '';
          let limitValue: number | null = null;

          // Create a builder object that supports chaining
          const createBuilder = () => ({
            eq: (col: string, val: any) => {
              if (whereClauses.length === 0) {
                whereClauses.push(`WHERE ${col} = ?`);
              } else {
                whereClauses.push(`AND ${col} = ?`);
              }
              whereParams.push(val);
              return createBuilder();
            },
            or: (condition: string) => {
              // Parse Supabase-style or condition: "name.ilike.%search%,company.ilike.%search%"
              // Convert to SQLite: (name LIKE '%search%' OR company LIKE '%search%')
              const conditions = condition.split(',').map(c => {
                const [col, op, ...valueParts] = c.trim().split('.');
                if (op === 'ilike') {
                  const value = valueParts.join('.').replace(/%/g, '');
                  return `${col} LIKE ?`;
                }
                return null;
              }).filter(Boolean);
              
              if (conditions.length > 0) {
                const values = condition.split(',').map(c => {
                  const parts = c.trim().split('.');
                  const valuePart = parts.slice(2).join('.');
                  return `%${valuePart.replace(/%/g, '')}%`;
                });
                
                if (whereClauses.length === 0) {
                  whereClauses.push(`WHERE (${conditions.join(' OR ')})`);
                } else {
                  whereClauses.push(`AND (${conditions.join(' OR ')})`);
                }
                whereParams.push(...values);
              }
              return createBuilder();
            },
            order: (col: string, options?: { ascending?: boolean }) => {
              orderClause = ` ORDER BY ${col} ${options?.ascending === false ? 'DESC' : 'ASC'}`;
              const builder = createBuilder();
              return builder;
            },
            limit: (n: number) => {
              limitClause = ` LIMIT ?`;
              limitValue = n;
              return createBuilder();
            },
            single: async () => {
              const whereClause = whereClauses.length > 0 ? ' ' + whereClauses.join(' ') : '';
              const fullQuery = baseQuery + whereClause + orderClause;
              const row = db.prepare(fullQuery).get(...whereParams);
              return { data: row, error: null };
            },
            then: (onResolve?: any, onReject?: any) => {
              const whereClause = whereClauses.length > 0 ? ' ' + whereClauses.join(' ') : '';
              const fullQuery = baseQuery + whereClause + orderClause + limitClause;
              const params = limitValue !== null ? [...whereParams, limitValue] : whereParams;
              try {
                const rows = db.prepare(fullQuery).all(...params) as any[];
                
                // Transform flat results to nested structure matching Supabase format
                const transformedRows = rows.map((row: any) => {
                  const result: any = {};
                  
                  // Copy base table columns
                  for (const key in row) {
                    if (key.includes('_') && (key.startsWith('deals_') || key.startsWith('bdr_reps_') || key.startsWith('clients_'))) {
                      // Skip prefixed columns, we'll handle them below
                      continue;
                    }
                    result[key] = row[key];
                  }
                  
                  // Build nested objects for related tables
                  if (originalColumns.includes('deals(')) {
                    result.deals = {};
                    for (const key in row) {
                      if (key.startsWith('deals_')) {
                        const nestedKey = key.replace('deals_', '');
                        result.deals[nestedKey] = row[key];
                      }
                    }
                    // Remove null nested objects
                    if (Object.keys(result.deals).length === 0 || Object.values(result.deals).every(v => v === null)) {
                      result.deals = null;
                    }
                  }
                  
                  if (originalColumns.includes('bdr_reps(')) {
                    result.bdr_reps = {};
                    for (const key in row) {
                      if (key.startsWith('bdr_reps_')) {
                        const nestedKey = key.replace('bdr_reps_', '');
                        result.bdr_reps[nestedKey] = row[key];
                      }
                    }
                    if (Object.keys(result.bdr_reps).length === 0 || Object.values(result.bdr_reps).every(v => v === null)) {
                      result.bdr_reps = null;
                    }
                  }
                  
                  if (originalColumns.includes('clients(')) {
                    result.clients = {};
                    for (const key in row) {
                      if (key.startsWith('clients_')) {
                        const nestedKey = key.replace('clients_', '');
                        result.clients[nestedKey] = row[key];
                      }
                    }
                    if (Object.keys(result.clients).length === 0 || Object.values(result.clients).every(v => v === null)) {
                      result.clients = null;
                    }
                  }
                  
                  return result;
                });
                
                const result = { data: transformedRows, error: null };
                return Promise.resolve(result).then(onResolve, onReject);
              } catch (error: any) {
                const result = { data: null, error: { message: error.message } };
                return Promise.resolve(result).then(onResolve, onReject);
              }
            },
          });

          return createBuilder();
        },
        insert: (data: any) => {
          const id = generateUUID();
          const row = { ...data, id };
          const keys = Object.keys(row).filter(k => k !== 'id' && row[k] !== undefined);
          const values = keys.map(k => row[k]);
          const placeholders = keys.map(() => '?').join(', ');
          const insertQuery = `INSERT INTO ${table} (id, ${keys.join(', ')}) VALUES (?, ${placeholders})`;
          
          try {
            db.prepare(insertQuery).run(id, ...values);
            return {
              select: () => ({
                single: async () => ({ data: row, error: null }) as any,
              }),
            };
          } catch (error: any) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: { message: error.message } }) as any,
              }),
            };
          }
        },
        update: (data: any) => {
          const keys = Object.keys(data).filter(k => data[k] !== undefined);
          const setClause = keys.map(k => `${k} = ?`).join(', ');
          const values = keys.map(k => data[k]);
          
          return {
            eq: (col: string, val: any) => {
              return {
                select: () => ({
                  single: async () => {
                    try {
                      const updateQuery = `UPDATE ${table} SET ${setClause}, updated_at = datetime('now') WHERE ${col} = ?`;
                      db.prepare(updateQuery).run(...values, val);
                      const updated = db.prepare(`SELECT * FROM ${table} WHERE ${col} = ?`).get(val);
                      return { data: updated, error: null };
                    } catch (error: any) {
                      return { data: null, error: { message: error.message } };
                    }
                  },
                }),
                then: async (callback: any) => {
                  try {
                    const updateQuery = `UPDATE ${table} SET ${setClause}, updated_at = datetime('now') WHERE ${col} = ?`;
                    db.prepare(updateQuery).run(...values, val);
                    return { error: null };
                  } catch (error: any) {
                    return { error: { message: error.message } };
                  }
                },
              };
            },
          };
        },
        delete: () => {
          return {
            eq: (col: string, val: any) => {
              try {
                db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(val);
                return { error: null };
              } catch (error: any) {
                return { error: { message: error.message } };
              }
            },
          };
        },
        upsert: (data: any, options?: any) => {
          const id = data.id || generateUUID();
          const row = { ...data, id };
          const keys = Object.keys(row).filter(k => k !== 'id' && row[k] !== undefined);
          const values = keys.map(k => row[k]);
          const placeholders = keys.map(() => '?').join(', ');
          const updateClause = keys.map(k => `${k} = excluded.${k}`).join(', ');
          
          // SQLite UPSERT syntax
          const upsertQuery = `
            INSERT INTO ${table} (id, ${keys.join(', ')}) 
            VALUES (?, ${placeholders})
            ON CONFLICT(${options?.onConflict?.split(',')[0] || 'id'}) 
            DO UPDATE SET ${updateClause}, updated_at = datetime('now')
          `;
          
          try {
            db.prepare(upsertQuery).run(id, ...values);
            return {
              select: () => ({
                single: async () => {
                  const result = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
                  return { data: result, error: null };
                },
              }),
            };
          } catch (error: any) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: { message: error.message } }) as any,
              }),
            };
          }
        },
      };
    },
  };
}



