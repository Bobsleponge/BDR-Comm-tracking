# Docker Setup

The app can run in Docker when local `npm run dev` has issues. Uses SQLite in a persistent volume.

## Prerequisites

1. **Start Docker Desktop** (Docker daemon must be running)
2. Ensure Docker is running: `docker ps` should work without errors

## Run with Docker Compose

```bash
# Build and start
docker compose up --build -d

# View logs
docker compose logs -f app

# Stop
docker compose down
```

The app is mapped to **http://localhost:3001** (container still listens on 3000) so it can run alongside local `npm run dev` on port 3000. To use 3000 for Docker only, change `docker-compose.yml` to `"3000:3000"`.

## First Run

- Database is created automatically on first request
- Test users: `admin@example.com` and `test@example.com` (any password)
- Data persists in the `bdr-data` Docker volume

## Rebuild After Code Changes

```bash
docker compose up --build -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_LOCAL_DB` | `true` | Use SQLite (set automatically in Docker) |
| `LOCAL_DB_PATH` | `/app/data/local.db` | Database file path (for volume persistence) |

## Troubleshooting

**Docker daemon not running**
- Start Docker Desktop from Applications
- Wait for it to fully start (whale icon in menu bar)

**Port 3000 already in use**
- Stop any local `npm run dev` process
- Or change the port in `docker-compose.yml`: `"3001:3000"`

**Database reset**
```bash
docker compose down -v   # Remove volumes (deletes all data)
docker compose up --build -d
```
