# Torplex

Torplex is a private Plex batch control dashboard built with SvelteKit and Bun. It tracks torrent intake, download progress, disk space, Plex scan state, and swarm telemetry on a visual world map.

## Features

- Real-time dashboard over server-sent events.
- Torrent upload/intake dialog with metadata inspection.
- Google OAuth gate for uploads, whitelisted to configured email addresses.
- Continuous batch runner that picks up new manifest entries without restarting.
- Plex library refresh after completed items are organized.
- Swarm atlas with peer locations, speeds, and active/inactive state.

## Development

```bash
bun install
bun run dev
```

## Production

```bash
bun install --frozen-lockfile
bun run build
PORT=8787 HOST=0.0.0.0 BATCH_DIR=/media/plex/.downloads/torrent-batch bun build/index.js
```

Run the downloader separately:

```bash
BATCH_DIR=/media/plex/.downloads/torrent-batch bun run-batch.ts
```

## Google OAuth

Uploads require a Google session. Configure:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `AUTH_COOKIE_SECRET`
- `AUTH_ALLOWED_EMAILS`
- `APP_ORIGIN`

The Google OAuth redirect URI must be:

```text
${APP_ORIGIN}/auth/callback
```

Google does not allow public raw-IP HTTP redirect URIs, so `APP_ORIGIN` should be an HTTPS domain or tunnel URL.

## Runtime Data

Runtime state is intentionally ignored by git:

- `manifest.json`
- `torrents/`
- `staging/`
- `logs/`
- `state.json`

The app creates an empty manifest automatically when needed.
