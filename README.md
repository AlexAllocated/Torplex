# Torplex

Torplex is a SvelteKit and Bun dashboard for managing a Plex-oriented torrent intake queue. It gives you a real-time batch view, a torrent upload dialog, disk and queue metrics, Plex refresh hooks, and a swarm map showing peer locations and transfer rates.

Torplex does not search for torrents or provide media. It only manages `.torrent` files you upload. Use it only with media you have the legal right to download and store.

## What It Does

- Serves a real-time dashboard over server-sent events.
- Lets an authenticated user upload `.torrent` files through a dialog.
- Inspects torrent metadata and suggests Plex destination paths.
- Stores queue state in a runtime `manifest.json`.
- Runs a long-lived downloader worker that picks up new queue entries without restart.
- Uses `aria2c` with seeding disabled by default.
- Moves completed downloads into Movies or TV directories.
- Refreshes Plex library sections after organizing media.
- Shows disk usage, queue progress, active peers, peer locations, and transfer speeds.

## Current Shape

Torplex is intentionally simple:

- One SvelteKit web app for UI and API routes.
- One separate Bun worker: `run-batch.ts`.
- Runtime state lives under `BATCH_DIR`.
- Upload authentication uses a password from environment configuration.
- It is designed for Linux hosts where Plex, `aria2c`, and the media filesystem are available.

## Requirements

- Linux server or VM.
- Bun 1.3 or newer.
- `aria2c` installed and available on `PATH`.
- `curl`, `find`, `df`, and `ss`.
- Plex Media Server running locally or reachable over HTTP.
- A media directory writable by the user running the worker, or passwordless `sudo` for the configured ownership/mode commands.
- Optional but recommended: an HTTPS domain, reverse proxy, or tunnel URL.

Install the OS dependencies on Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y aria2 curl iproute2
```

## Quick Start

Clone and install:

```bash
git clone https://github.com/AlexAllocated/Torplex.git
cd Torplex
bun install
cp .env.example .env
```

Edit `.env` for your Plex and media paths. At minimum, set:

```bash
BATCH_DIR=/media/plex/.downloads/torrent-batch
MEDIA_ROOT=/media/plex
MOVIES_DIR=/media/plex/Movies
TV_DIR="/media/plex/TV Shows"
PLEX_URL=http://127.0.0.1:32400
AUTH_PASSWORD=replace-with-a-login-password
AUTH_COOKIE_SECRET=replace-with-a-long-random-secret
```

Build and start the web app:

```bash
bun run build
set -a
source .env
set +a
bun build/index.js
```

In another shell, start the worker:

```bash
set -a
source .env
set +a
bun run-batch.ts
```

Open the app at:

```text
http://SERVER_IP:8787
```

By default, Torplex requires password login for the dashboard, status API, live event stream, and torrent uploads. For local-only experiments, set `AUTH_REQUIRED=false`.

## Configuration

### Server

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Host interface for the web server. |
| `PORT` | `8787` | Port for the web server. |
| `BATCH_DIR` | `/media/plex/.downloads/torrent-batch` | Runtime state, torrent files, staging, and logs. |
| `IGNORED_PEER_IPS` | empty | Comma-separated public IPs to hide from the peer map. |

### Media Paths

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_ROOT` | `/media/plex` | Base media mount. |
| `MOVIES_DIR` | `$MEDIA_ROOT/Movies` | Movie destination root. |
| `TV_DIR` | `$MEDIA_ROOT/TV Shows` | TV destination root. |
| `DISK_USAGE_PATH` | `$MEDIA_ROOT` | Path used for dashboard disk usage. |

Torplex validates uploaded items so their destination is under `MOVIES_DIR` or `TV_DIR`.

### Plex

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLEX_URL` | `http://127.0.0.1:32400` | Plex server URL used for library refreshes. |
| `PLEX_TOKEN` | empty | Optional Plex token. If set, this is used directly. |
| `PLEX_PREFERENCES_PATH` | `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml` | Token source when `PLEX_TOKEN` is not set. |
| `PLEX_MOVIE_SECTION_ID` | `1` | Plex library section refreshed for movies. |
| `PLEX_SHOW_SECTION_ID` | `2` | Plex library section refreshed for shows. |

If `PLEX_TOKEN` is not set, the worker reads `PLEX_PREFERENCES_PATH` with `sudo sed`. For a reusable install, setting `PLEX_TOKEN` explicitly is usually cleaner.

Quote `.env` values that contain spaces when using `source .env`, for example `TV_DIR="/media/plex/TV Shows"`.

### File Ownership

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_CHOWN` | empty | Ownership applied to organized media. Example: `plex:plex`. Set empty to skip `chown`. |
| `MEDIA_DIR_MODE` | `775` | Directory mode applied after organizing. Set empty to skip. |
| `MEDIA_FILE_MODE` | `664` | File mode applied after organizing. Set empty to skip. |

If these commands need `sudo`, configure the service user accordingly or set the variables empty and manage permissions another way.

### Authentication

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` | request origin | Public origin used for secure session cookies behind a reverse proxy. |
| `AUTH_REQUIRED` | `true` | Require a valid password session for the dashboard, status API, live event stream, and uploads. Set `false` only for trusted local/private installs. |
| `AUTH_PASSWORD` | empty | Password used to unlock Torplex. Required when `AUTH_REQUIRED=true`. |
| `AUTH_COOKIE_SECRET` | development fallback | Secret used to sign session cookies. Use a long random value. |

When `AUTH_REQUIRED=true`, dashboard data is locked until `AUTH_PASSWORD` is set.

## Runtime Directory

Torplex creates and uses this structure under `BATCH_DIR`:

```text
manifest.json
torrents/
staging/
logs/
state.json
batch.log
runner.pid
server.pid
```

These files are runtime state and are intentionally ignored by git.

## Queue Model

The web app writes uploaded torrents to `BATCH_DIR/torrents/` and appends entries to `BATCH_DIR/manifest.json`.

The worker polls the manifest every two seconds. For each item that is not completed, failed, organizing, or already running, it starts an `aria2c` process and resumes partial downloads with `--continue=true`.

When a download finishes, the worker:

1. Moves files from `staging/` into the configured Plex destination.
2. Applies configured ownership and modes.
3. Refreshes the matching Plex section.
4. Marks the item completed in `state.json`.

## Running as Services

For a VM or home server, run the web app and worker as separate services.

Example web command:

```bash
cd /opt/torplex
set -a
source .env
set +a
bun build/index.js
```

Example worker command:

```bash
cd /opt/torplex
set -a
source .env
set +a
bun run-batch.ts
```

If you use systemd, create one service for each command so the dashboard can restart independently from the downloader.

## Development

```bash
bun install
bun run dev
```

Build check:

```bash
bun run build
```

## Security Notes

- Keep `AUTH_REQUIRED=true` for internet-reachable installs.
- Torrent upload APIs always require a valid password session.
- Run Torplex behind HTTPS, a firewall, VPN, reverse proxy, or private network if the dashboard is reachable outside your LAN.
- Do not commit `.env`, `manifest.json`, torrent files, logs, or Plex tokens.
- Set `AUTH_COOKIE_SECRET` to a strong random value before enabling login.

## Troubleshooting

- **Dashboard says `AUTH_PASSWORD` is not configured:** set `AUTH_PASSWORD`, then restart the web app.
- **Login works over HTTP but not HTTPS:** set `APP_ORIGIN` to the public HTTPS origin and restart the web app.
- **Plex refresh fails:** set `PLEX_TOKEN` explicitly or make sure the worker can read `PLEX_PREFERENCES_PATH`.
- **Files organize but Plex cannot see them:** check `MEDIA_CHOWN`, `MEDIA_DIR_MODE`, `MEDIA_FILE_MODE`, and Plex library folder permissions.
- **No peer map data:** make sure `ss` is installed and `aria2c` is running on the same host as the web app.
- **Downloads do not start after upload:** make sure `run-batch.ts` is running and watching the same `BATCH_DIR` as the web app.
