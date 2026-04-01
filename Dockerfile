# BDR Commission Tracking - Docker build
# Uses Debian-based image for better-sqlite3 native module compatibility

FROM node:20-bookworm-slim AS builder

# Install build deps for better-sqlite3 (native module)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install all deps (including devDependencies for build)
# --legacy-peer-deps: @tremor/react declares react@^18 while project uses React 19
RUN npm ci --legacy-peer-deps

# Copy source
COPY . .

# Build Next.js (standalone output for smaller runtime image)
ENV NEXT_TELEMETRY_DISABLED=1
ENV USE_LOCAL_DB=true
RUN npm run build

# Production stage
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV USE_LOCAL_DB=true

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Create directory for SQLite database (persisted via volume)
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Database path for Docker volume persistence
ENV LOCAL_DB_PATH=/app/data/local.db

CMD ["node", "server.js"]
