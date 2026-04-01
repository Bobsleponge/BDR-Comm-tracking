# Investigation: Recurring .next Cache Corruption (Internal Error)

This document summarizes why the internal error keeps happening (~4th occurrence) and what drives it.

---

## Root Cause Chain

From the terminal logs, the sequence is:

1. **Compilation completes** → `✓ Compiled in 162ms (454 modules)`
2. **Fast Refresh triggers a full reload** → `Fast Refresh had to perform a full reload when ?608e changed`
3. **Race condition during rebuild** → During the full reload, webpack:
   - Deletes or moves files in `.next/` (e.g. `routes-manifest.json`)
   - Writes new cache files (e.g. `0.pack.gz_` → `0.pack.gz`)
   - Sometimes deletes the old file before the new one is finished
4. **ENOENT** → Browser requests `/deals` or `/login` while `routes-manifest.json` is missing
5. **500 errors** → Next.js fails to serve the page
6. **Cascade** → Next.js DevTools (segment-explorer) tries to load `segment-explorer-node.js#SegmentViewNode` → another manifest error → `__webpack_modules__[moduleId] is not a function`

So the core issue is a **race between Fast Refresh’s full reload and incoming requests**.

---

## Contributing Factors

### 1. Fast Refresh full reloads

Full reloads happen when:

- Multiple exports in a file (e.g. components + utilities)
- Anonymous components (`export default () => {}`)
- Class components
- Non-React imports used outside the React tree
- HOCs returning class components

Full reloads cause a full rebuild of `.next`, which increases the chance of hitting the race.

### 2. Custom webpack config

Your `next.config.js` customizes `splitChunks` for the client bundle. That:

- Adds work during each rebuild
- Can interact badly with webpack’s cache (`0.pack.gz` rename errors)
- Extends the window where `.next` is in an inconsistent state

### 3. Experimental features

- `optimizePackageImports` for recharts, date-fns, lucide-react
- Extra module resolution and bundling during dev can worsen the race.

### 4. Cursor / AI edits

Frequent saves from Cursor or AI-assisted edits can:

- Trigger many Fast Refresh cycles
- Cause multiple full reloads in quick succession
- Keep `.next` in flux while the dev server is busy

### 5. Next.js 15 + webpack dev server

There are known issues around:

- `routes-manifest.json` ENOENT in dev
- `segment-explorer-node.js` / React Client Manifest errors

These are framework-level bugs that favor the race.

### 6. Project path with space

`/Users/Matty/BDR Comm Tracking` – spaces can introduce edge cases in some tools, though they’re less likely to be the main cause here.

---

## Mitigations

### Short-term (do all)

1. **Clear `.next` and restart when it happens**
   ```bash
   rm -rf .next && npm run dev
   ```

2. **Avoid rapid edits** – Small pauses between edits (especially from AI) let Fast Refresh settle before another reload.

3. **Simplify dev config** – Disable heavy optimizations in development (see Recommended Config Changes below).

### Medium-term (config changes)

1. **Tone down custom webpack in dev** – Only apply `splitChunks` in production.
2. **Disable dev indicators** – Reduces DevTools overhead (`devIndicators: false`).
3. **Optionally try Turbopack** – Different bundler, may avoid this race: `next dev --turbo`.

### Long-term (if it keeps happening)

1. **Move project** – Use a path without spaces, e.g. `~/BDRCommTracking`.
2. **Use production build for day-to-day dev** – `npm run build && npm run start` when the dev server is unreliable.

---

## Recommended Config Changes

These changes aim to reduce the chance of cache corruption during development:

### 1. Apply custom webpack only in production

```js
webpack: (config, { isServer, dev }) => {
  // Skip custom splitChunks in dev - reduces rebuild complexity
  if (dev || isServer) return config;
  config.optimization = { ... };
  return config;
}
```

### 2. Disable dev indicators in dev

```js
devIndicators: false,
```

### 3. Optional: Turbopack dev script

```json
"dev:turbo": "next dev -p 3000 -H 0.0.0.0 --turbo"
```

Try `npm run dev:turbo` if the issue persists with the default dev server.

---

## Summary

| Factor              | Impact | Fixable? |
|---------------------|--------|----------|
| Fast Refresh full reload | High   | Partially (code style) |
| Custom webpack       | Medium | Yes (dev-only skip) |
| Cursor rapid edits   | Medium | Yes (pause between edits) |
| Next.js 15 bugs      | High   | No (framework) |
| optimizePackageImports | Low  | Yes (can disable) |
| Path with space      | Low    | Yes (move project) |

The recurring internal error is driven by a race during Fast Refresh full reloads (likely triggered by edits), combined with Next.js 15 dev server bugs and your custom webpack setup. Simplifying dev config and slowing down edit bursts should reduce how often it occurs.
