# Torplex

Torplex is a SvelteKit and Bun dashboard for managing a Plex-oriented torrent intake queue. It gives you a real-time batch view, a torrent upload dialog, disk and queue metrics, Plex refresh hooks, and a swarm map showing peer locations and transfer rates.

Torplex does not search for torrents or provide media. It only manages `.torrent` files you upload, magnet links, direct `.torrent` URLs, or pages that contain an extractable magnet or `.torrent` link. Use it only with media you have the legal right to download and store.

## What It Does

- Serves a real-time dashboard over server-sent events.
- Lets an authenticated user upload `.torrent` files, paste magnet links, paste direct `.torrent` URLs, or paste pages that contain an extractable torrent source.
- Inspects complete torrent metadata and lets the user select individual files or folders before downloading.
- Optionally runs a constrained OpenAI Smart Setup plan automatically after source inspection to fill the same visible selection, routing, and verification controls available manually.
- Requires an explicit rights attestation for every newly queued torrent.
- Rejects executable and script payloads and requires a clean ClamAV scan before downloaded files leave staging; there is no UI or API bypass.
- Stores queue state in a runtime `manifest.json`.
- Runs a long-lived downloader worker that picks up new queue entries without restart.
- Persists drag-and-drop queue priority changes and safely pauses the active transfer when another item is promoted above it.
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
- `curl`, `find`, `df`, `ps`, and `ss`.
- Plex Media Server running locally or reachable over HTTP.
- A media directory writable by the user running the worker, or passwordless `sudo` for the configured ownership/mode commands.
- Optional but recommended: an HTTPS domain, reverse proxy, or tunnel URL.

Install the OS dependencies on Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y aria2 curl iproute2 procps
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
ORIGIN=http://SERVER_IP:8787
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
| `SHUTDOWN_TIMEOUT` | `30` | Seconds adapter-node waits before closing live connections during shutdown. Torplex recommends `3` for a supervised service. |
| `BATCH_DIR` | `/media/plex/.downloads/torrent-batch` | Runtime state, torrent files, staging, and logs. |
| `ARIA2_CHECK_INTEGRITY` | disabled | Set to `true`, `yes`, or `1` to hash existing partial data before resuming. Recommended after an unclean shutdown or storage disconnect. |
| `IGNORED_PEER_IPS` | empty | Comma-separated public IPs to hide from the peer map. |
| `MAX_CONCURRENT_DOWNLOADS` | `0` (unlimited) | Fixed maximum simultaneous torrent jobs when adaptive scheduling is disabled. |
| `ADAPTIVE_CONCURRENCY` | `false` | Dynamically open download slots based on aggregate ingress and measured block-device write activity. |
| `ADAPTIVE_MIN_CONCURRENCY` | `1` | Jobs started immediately by the adaptive scheduler. |
| `ADAPTIVE_MAX_CONCURRENCY` | `4` | Hard ceiling for the adaptive scheduler. |
| `DISK_WRITE_BUDGET_MIB` | `35` | Conservative sustained write budget used to decide whether another job may start. |
| `ADAPTIVE_INGRESS_THRESHOLD` | `0.75` | Fraction of the write budget below which ingress may open another slot. |
| `ADAPTIVE_DISK_BUSY_PERCENT` | `80` | Maximum smoothed block-device utilization allowed before opening another slot. |
| `ADAPTIVE_SETTLE_SECONDS` | `30` | Observation window after starting a job before another slot can open. |
| `ADAPTIVE_SCALE_DOWN_DISK_BUSY_PERCENT` | `95` | Sustained block-device utilization that triggers a scale-down. |
| `ADAPTIVE_SCALE_DOWN_WRITE_RATIO` | `1.0` | Fraction of the disk write budget that counts as scale-down pressure. |
| `ADAPTIVE_SCALE_DOWN_SECONDS` | `20` | Time pressure must remain high before pausing the lowest-priority active transfer. |
| `ADAPTIVE_COOLDOWN_SECONDS` | `45` | Minimum delay between concurrency changes to prevent pause/resume churn. |
| `MAX_MAP_PEERS` | `320` | Maximum aria2 connections retained for the swarm map. |
| `MAP_ORIGIN_LABEL` | `SERVER` | Label shown above the receiving node on the swarm map. |
| `MAP_ORIGIN_LAT`, `MAP_ORIGIN_LON` | automatic | Optional fixed receiving-node coordinates. By default Torplex geolocates its public IP. |
| `MAP_ORIGIN_IP` | automatic | Optional public IP metadata used with fixed map coordinates. |
| `PRIVATE_SEED_IPS` | empty | Comma-separated public IPs for private webseeds or seed hosts that should receive priority map labels. |
| `PRIVATE_SEED_LABEL` | `VM SEED` | Label shown for configured private seed connections. |

### Media Paths

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_ROOT` | `/media/plex` | Base media mount. |
| `MOVIES_DIR` | `$MEDIA_ROOT/Movies` | Movie destination root. |
| `TV_DIR` | `$MEDIA_ROOT/TV Shows` | TV destination root. |
| `DISK_USAGE_PATH` | `$MEDIA_ROOT` | Path used for dashboard disk usage. |

Torplex validates uploaded items so their destination is under `MOVIES_DIR` or `TV_DIR`.

### Smart Setup

Smart Setup is optional. Without an API key, the normal torrent inspector, per-file selection, destination controls, and queue remain fully functional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | empty | Enables Smart Setup. Keep the value in an ignored `.env` or service credential file; never commit it. |
| `TORPLEX_AI_MODEL` | `gpt-5.6-terra` | OpenAI model used for structured intake plans. |
| `TORPLEX_AI_EXTRA_INSTRUCTIONS` | empty | Optional installation-wide rules appended to Torplex's built-in planning policy. |

The dialog also accepts per-torrent **Additional instructions**. Those instructions are appended to the fixed Torplex policy; they do not replace its path, selection, validation, or review requirements.

Smart Setup runs once automatically when source inspection succeeds. It sends the torrent filename, payload name, file paths, file sizes, automatic suggestions, configured media roots, and any additional instructions to the OpenAI API. It does not send media bytes. The model returns a draft that fills the same visible controls a user can edit manually; the button remains available for an intentional rerun. Torplex validates all selected indexes and destinations server-side before queueing.

Smart Setup only prepares a reviewable plan and does not require an attestation. Queue submission remains disabled until the user confirms that they have the rights or authorization needed for the selected content, and Torplex records that attestation timestamp in the queue manifest. This feature is not a substitute for determining whether a download is permitted in the user's jurisdiction or under applicable service terms.

### Post-download checks

New queue entries always pass through ClamAV before leaving staging. The **Verify media streams** control uses `ffprobe` to reject unreadable containers, files without a video stream or duration, and executable/script attachments. The **Ensure English captions** control recognizes embedded English tracks, renames an exact same-stem sidecar such as `Episode.srt` to Plex's explicit `Episode.en.srt` convention, and can fetch a missing caption only when OpenSubtitles reports an exact file-hash match. A fetched caption is validated as timed text and scanned with ClamAV before it is kept. After the library refresh, the metadata and artwork checks query Plex by the organized file paths and record whether the matched entries contain a title, release date, description, and artwork.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENSUBTITLES_API_KEY` | empty | Enables exact-hash English subtitle search and download. |
| `OPENSUBTITLES_USER_AGENT` | `Torplex v1` | Application identifier required by OpenSubtitles. |
| `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD` | empty | Optional account login for authenticated download limits. Keep these only in the runtime secret environment. |
| `OPENSUBTITLES_TOKEN` | empty | Optional pre-issued token; normally leave empty and let Torplex log in. |

Without an OpenSubtitles API key, Torplex still audits embedded and sidecar captions and records missing-caption counts, but it cannot fetch replacements. Provider download quotas still apply.

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
| `ORIGIN` | inferred as HTTPS | Exact browser-facing origin used by adapter-node for request URLs, CSRF validation, and secure session cookies. For example, `http://192.168.1.10:8787`. |
| `APP_ORIGIN` | `ORIGIN` or request origin | Legacy session-cookie origin override. Prefer `ORIGIN`, which also configures adapter-node. |
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

The web app writes uploaded or URL-resolved torrent files to `BATCH_DIR/torrents/` or stores magnet links directly in `BATCH_DIR/manifest.json`. During inspection, magnet links use aria2's metadata-only mode to cache the small torrent manifest under `BATCH_DIR/torrent-metadata/`; media payload bytes are not downloaded. Uploaded files and resolved magnets therefore share the same file picker and Smart Setup flow. Selected file indexes are stored in the manifest and passed to aria2 with `--select-file`; unselected files are not downloaded. Mixed bundles can use visible folder routes to place separate titles or seasons into independent Plex destinations.

For pasted HTTP(S) URLs, Torplex fetches the URL server-side. A direct `.torrent` response is stored as a torrent file. An HTML page is scanned for the first magnet link and then for the first `.torrent` link. URL fetching rejects localhost, private network addresses, credentialed URLs, oversized torrent files, oversized HTML pages, and excessive redirects.

The worker polls the manifest every two seconds. For each item that is not completed, failed, organizing, or already running, it starts an `aria2c` process and resumes partial downloads with `--continue=true`. Set `MAX_CONCURRENT_DOWNLOADS` for a fixed cap. With `ADAPTIVE_CONCURRENCY=true`, the runner starts the minimum immediately, observes aggregate aria2 ingress plus the media block device's actual write rate and busy time, and opens at most one additional slot per settling window up to `ADAPTIVE_MAX_CONCURRENCY`. Sustained write pressure pauses the lowest-priority active transfer, preserving its partial files and aria2 resume state. Separate pressure and cooldown windows keep the scheduler from oscillating. Set `ARIA2_CHECK_INTEGRITY=true` after an unclean shutdown or storage disconnect to validate existing pieces before resuming.

Pending rows can be reordered from the dashboard with animated position changes. Moving one above an active transfer gracefully stops the displaced `aria2c` process, keeps its partial files, preserves its displayed progress, and resumes it later from the saved pieces. An item already in the organizing phase cannot be preempted.

When a download finishes, the worker:

1. Moves files from `staging/` into the configured Plex destination.
2. Applies configured ownership and modes.
3. Refreshes the matching Plex section.
4. Marks the item completed in `state.json`.

For a single-file torrent using the `moveRoot` strategy, Torplex creates the destination directory and preserves the downloaded file's original name and extension inside it.

If the media is organized successfully but Plex cannot refresh its section,
Torplex records a scan warning and still marks the item completed. This avoids
retrying a download whose staging files have already moved into the library.

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
Include `iproute2` and `procps` in the web service's `PATH`; the swarm map uses `ss` and `ps` to associate live sockets with torrent jobs.

## Development

```bash
bun install
bun run dev
```

Build check:

```bash
bun run check
bun run build
```

Live browser check:

```bash
bunx playwright install chromium
TORPLEX_E2E_URL=http://SERVER_IP:8787 \
TORPLEX_E2E_PASSWORD=your-password \
bun run test:e2e
```

Set `TORPLEX_E2E_REQUIRE_PEERS=1` when active downloads should also be required during the check, and
`TORPLEX_E2E_REQUIRE_MAPPED_ORIGIN=1` when public-IP geolocation must succeed.

## Security Notes

- Keep `AUTH_REQUIRED=true` for internet-reachable installs.
- Torrent upload APIs always require a valid password session.
- Pasted HTTP(S) URLs are fetched by the Torplex server, so keep the app behind authentication and use only sources you trust.
- Run Torplex behind HTTPS, a firewall, VPN, reverse proxy, or private network if the dashboard is reachable outside your LAN.
- Do not commit `.env`, `manifest.json`, torrent files, logs, or Plex tokens.
- Set `AUTH_COOKIE_SECRET` to a strong random value before enabling login.

## Troubleshooting

- **Dashboard says `AUTH_PASSWORD` is not configured:** set `AUTH_PASSWORD`, then restart the web app.
- **Login returns `Cross-site POST form submissions are forbidden`:** set `ORIGIN` to the exact URL origin shown in the browser (scheme, host, and port), then restart the web app.
- **Login works over HTTP but not HTTPS:** set `ORIGIN` to the public HTTPS origin and restart the web app.
- **Plex refresh fails:** set `PLEX_TOKEN` explicitly or make sure the worker can read `PLEX_PREFERENCES_PATH`.
- **Files organize but Plex cannot see them:** check `MEDIA_CHOWN`, `MEDIA_DIR_MODE`, `MEDIA_FILE_MODE`, and Plex library folder permissions.
- **No peer map data:** make sure `ss` and `ps` are installed and `aria2c` is running on the same host as the web app.
- **Downloads do not start after upload:** make sure `run-batch.ts` is running and watching the same `BATCH_DIR` as the web app.
- **Pasted page URL returns a Cloudflare challenge:** open the page in a browser and paste its magnet link, or download and upload the `.torrent` file. Torplex does not bypass browser challenges.
