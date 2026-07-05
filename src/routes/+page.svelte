<svelte:head>
  <title>Plex Batch Control</title>
</svelte:head>

<script>
  import { onMount } from 'svelte';
  import { startDashboard } from '$lib/client/dashboard.js';
  import './dashboard.css';

  onMount(() => {
    startDashboard();
  });
</script>

<canvas id="warpCanvas" aria-hidden="true"></canvas>
<main>
  <header>
    <div>
      <h1>Plex Batch Control</h1>
      <div class="subtitle" id="subtitle">Waiting for the first live packet...</div>
    </div>
    <div class="header-actions"><button id="openIntake" class="primary-button" type="button">Add Torrent</button><div class="live"><span class="dot"></span><span id="connection">Connecting</span></div></div>
  </header>

  <section class="dashboard">
    <div class="gauge-stack">
      <div class="gauges">
        <div class="gauge">
          <div class="label">Batch</div>
          <div class="ring" id="batchRing"><span id="batchPercent">0%</span></div>
          <div class="small" id="batchText">0 of 0 complete</div>
        </div>
        <div class="gauge">
          <div class="label">Active Item</div>
          <div class="ring" id="activeRing" style="--ring-color: var(--amber);"><span id="activePercent">0%</span></div>
          <div class="small" id="activeText">No active item yet</div>
        </div>
        <div class="gauge">
          <div class="label">Disk Free</div>
          <div class="ring" id="diskRing" style="--ring-color: var(--green);"><span id="diskPercent">0%</span></div>
          <div class="small" id="diskText">Checking disk...</div>
        </div>
      </div>
      <div class="summary-strip">
        <div class="metric"><div class="label">Current</div><div class="value" id="currentMini">...</div></div>
        <div class="metric"><div class="label">ETA</div><div class="value" id="etaMini">...</div></div>
        <div class="metric"><div class="label">Remaining</div><div class="value" id="remainingMini">...</div></div>
      </div>
      <div class="hero-bar"><div id="totalFill" class="hero-fill"></div></div>
    </div>
  </section>

<dialog id="intakeDialog" class="intake-dialog"><div class="dialog-card panel intake-panel">
    <div class="map-title">
      <div class="label">Torrent Intake</div>
      <button id="closeIntake" class="secondary-button dialog-close" type="button">Close</button><div class="small" id="intakeStatus">Ready</div>
    </div>
    <form id="intakeForm" class="intake-panel">
      <div class="intake-grid">
        <div class="intake-field">
          <label for="torrentFile">Torrent</label>
          <input id="torrentFile" name="torrent" type="file" accept=".torrent,application/x-bittorrent" />
        </div>
        <div class="intake-field">
          <label for="torrentTitle">Title</label>
          <input id="torrentTitle" name="title" autocomplete="off" />
        </div>
        <div class="intake-field">
          <label for="torrentId">Id</label>
          <input id="torrentId" name="id" autocomplete="off" />
        </div>
        <div class="intake-field">
          <label for="mediaType">Type</label>
          <select id="mediaType" name="mediaType">
            <option value="show">Show</option>
            <option value="movie">Movie</option>
          </select>
        </div>
        <div class="intake-field">
          <label for="destinationPath">Destination</label>
          <input id="destinationPath" name="destinationPath" autocomplete="off" />
        </div>
        <div class="intake-field">
          <label for="organizeStrategy">Organize</label>
          <select id="organizeStrategy" name="organizeStrategy">
            <option value="mergeRoot">Merge into folder</option>
            <option value="moveRoot">Move payload folder</option>
          </select>
        </div>
        <div class="intake-field">
          <label for="targetSubdir">Subfolder</label>
          <input id="targetSubdir" name="targetSubdir" autocomplete="off" />
        </div>
      </div>
      <div class="intake-actions">
        <button id="addTorrent" class="primary-button" type="submit" disabled>Add to Queue</button>
      </div>
      <div id="torrentSummary" class="intake-summary">No torrent selected.</div>
    </form>
  </div></dialog>

  <section class="transfer-map world-panel">
    <div class="map-title">
      <div class="label">Swarm Atlas</div>
      <div class="small" id="routeStatus">Waiting for peer telemetry...</div>
    </div>
    <div class="world-shell">
      <div class="world-map-frame">
        <div id="worldMapViewport" class="world-map-viewport">
          <button id="fullscreenMap" class="icon-button" type="button" title="Fullscreen map" aria-label="Fullscreen map">
            <svg class="enter-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
            </svg>
            <svg class="exit-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M16 3v3a2 2 0 0 0 2 2h3"></path><path d="M8 21v-3a2 2 0 0 0-2-2H3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path>
            </svg>
          </button>
          <div class="map-progress-widget">
            <div id="mapTorrentTitle" class="map-progress-title">Queue idle</div>
            <div class="map-progress-meta"><span id="mapTorrentProgress">0%</span><span id="mapTorrentRate">0 B/s</span><span id="mapTorrentEta">-</span><span id="mapTorrentSeeds">Streams 0</span></div>
            <div class="map-progress-bar"><div id="mapTorrentFill" class="map-progress-fill"></div></div>
          </div>
          <div id="worldMapLayer" class="world-map-layer">
            <img class="world-map-image" src="/assets/BlankMap-Equirectangular.svg" alt="" aria-hidden="true" />
            <canvas id="worldCanvas" aria-label="Connected peer world map"></canvas>
            <div id="mapPeerLabels" class="map-peer-label-layer" aria-hidden="true"></div>
          </div>
        </div>
      </div>
      <div id="peerPills" class="peer-pills"></div>
    </div>
  </section>

  <section>
    <div class="label">Queue</div>
    <div id="items" class="items"></div>
  </section>
</main>
