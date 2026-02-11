# Performance Debugging Guide

If your website is taking minutes to load, use these tools to diagnose the issue:

## 1. Check Database Health

Visit: `http://localhost:3000/api/debug/db-health` (as admin)

This will show:
- Database file size (large files = slow)
- Table row counts
- Missing indexes
- Query performance test
- Recommendations

## 2. View Slow Queries

Visit: `http://localhost:3000/api/debug/performance` (as admin)

This shows all queries taking more than 100ms. Look for:
- Queries taking > 1000ms (very slow)
- Repeated slow queries
- Queries with many parameters

## 3. Common Issues & Fixes

### Database File Too Large
If `local.db` is > 100MB:
```bash
# Backup first!
cp local.db local.db.backup

# Vacuum database (reclaims space, optimizes)
sqlite3 local.db "VACUUM;"
```

### Missing Indexes
If health check shows missing indexes, they're already created in the schema. If not, the database might need to be reinitialized.

### Database Locked
If you see "database is locked" errors:
- Close any other programs accessing the database
- Restart the Next.js server
- Check if there are multiple instances running

### Too Many Rows
If tables have > 100,000 rows:
- Consider pagination
- Archive old data
- Add date filters to queries

## 4. Quick Performance Fixes

### Enable Query Logging
Set in `.env.local`:
```
ENABLE_DB_LOGGING=true
```

This will log all slow queries (>100ms) to console.

### Optimize Database
Run this SQL to update query statistics:
```sql
ANALYZE;
```

### Check for Blocking Operations
Look in the console for:
- `[SLOW QUERY]` warnings
- Long stack traces
- Repeated errors

## 5. Emergency Fixes

If pages are completely unresponsive:

1. **Stop the server** (Ctrl+C)

2. **Check database file**:
   ```bash
   ls -lh local.db*
   ```

3. **Backup and optimize**:
   ```bash
   cp local.db local.db.backup
   sqlite3 local.db "VACUUM; ANALYZE;"
   ```

4. **Restart server**:
   ```bash
   npm run dev
   ```

5. **Check health endpoint** again

## 6. What to Look For

### Red Flags:
- Database file > 500MB
- Queries taking > 5 seconds
- Missing indexes on frequently queried columns
- WAL file > 100MB
- Table with > 1 million rows

### Good Signs:
- Database file < 50MB
- Queries < 100ms
- All indexes present
- WAL file < 10MB

## 7. Next Steps

If issues persist:
1. Share the output from `/api/debug/db-health`
2. Share the slow queries from `/api/debug/performance`
3. Check browser DevTools Network tab for slow API calls
4. Check server console for errors



