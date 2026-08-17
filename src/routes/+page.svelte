<svelte:head>
  <title>Torplex Operations</title>
  <meta name="description" content="Torplex acquisition and transfer operations" />
</svelte:head>

<script>
  import { onMount } from 'svelte';
  import { startDashboard } from '$lib/client/dashboard.js';

  onMount(() => {
    return startDashboard();
  });
</script>

<main class="operations-page">
  <section class="command-deck" aria-labelledby="operations-title">
    <div class="lcars-section-heading">
      <span class="section-index">01</span>
      <div>
        <span class="section-eyebrow">Acquisition command</span>
        <h1 id="operations-title">Media Operations</h1>
      </div>
      <div class="system-live" aria-live="polite">
        <span class="system-live-pulse" aria-hidden="true"></span>
        <span id="connection">Connecting</span>
      </div>
    </div>

    <div class="command-grid">
      <form class="ai-command" action="/add" method="get">
        <label for="quickSearch">Acquisition directive</label>
        <div class="ai-command-entry">
          <input id="quickSearch" name="prompt" type="text" autocomplete="off" placeholder="Specify titles, series, or a collection" />
          <button class="lcars-button primary-button" type="submit">Find with AI</button>
        </div>
        <div class="ai-command-status">
          <span>SEARCH / INVENTORY / SOURCE VALIDATION</span>
          <a href="/add?mode=sources">Manual source control</a>
        </div>
      </form>

      <div class="command-status" aria-label="Operator status">
        <div class="command-status-code">SYS 47-A</div>
        <strong id="subtitle">Waiting for the first live packet...</strong>
        <div class="command-status-actions">
          <button id="openIntake" class="lcars-button primary-button" type="button">Acquire</button>
          <a id="logoutButton" class="lcars-button secondary-button" href="/auth/logout" hidden>Sign out</a>
        </div>
        <span id="authStatus" class="system-caption">Checking authorization</span>
      </div>
    </div>
  </section>

  <section class="telemetry-deck" aria-labelledby="telemetry-title">
    <div class="lcars-text-bar">
      <span id="telemetry-title">SYSTEM TELEMETRY</span>
      <i aria-hidden="true"></i>
      <b>47-710</b>
    </div>

    <div class="telemetry-grid">
      <article class="telemetry-module batch-module">
        <div class="telemetry-number">01</div>
        <div class="telemetry-copy">
          <span>Batch completion</span>
          <strong id="batchPercent">0%</strong>
          <small id="batchText">0 of 0 complete</small>
        </div>
        <div class="system-meter" id="batchRing"><span></span></div>
      </article>

      <article class="telemetry-module active-module">
        <div class="telemetry-number">02</div>
        <div class="telemetry-copy">
          <span>Active transfer</span>
          <strong id="activePercent">0%</strong>
          <small id="activeText">No active item</small>
        </div>
        <div class="system-meter" id="activeRing"><span></span></div>
      </article>

      <article class="telemetry-module storage-module">
        <div class="telemetry-number">03</div>
        <div class="telemetry-copy">
          <span>Storage available</span>
          <strong id="diskPercent">0%</strong>
          <small id="diskText">Checking disk...</small>
        </div>
        <div class="system-meter" id="diskRing"><span></span></div>
      </article>
    </div>

    <dl class="telemetry-readout">
      <div><dt>TRANSFER</dt><dd id="currentMini">-</dd></div>
      <div><dt>ESTIMATE</dt><dd id="etaMini">-</dd></div>
      <div><dt>REMAINING</dt><dd id="remainingMini">-</dd></div>
      <div><dt>STATE</dt><dd id="consoleState">BOOT</dd></div>
      <div><dt>VPN</dt><dd id="consoleVpn">CHECK</dd></div>
      <div><dt>PEERS</dt><dd id="consolePeers">000</dd></div>
      <div><dt>INGEST</dt><dd id="consoleRate">0 B/s</dd></div>
    </dl>
    <div class="fleet-progress" aria-hidden="true"><div id="totalFill"></div></div>
  </section>

  <section class="queue-deck" aria-labelledby="queue-title">
    <div class="lcars-section-heading compact">
      <span class="section-index">02</span>
      <div>
        <span class="section-eyebrow">Transfer control</span>
        <h2 id="queue-title">Operations Queue</h2>
      </div>
      <button id="clearCompleted" class="lcars-button secondary-button" type="button" disabled>Clear completed</button>
    </div>
    <div class="queue-column-head" aria-hidden="true">
      <span>Priority / title</span><span>State</span><span>Completion</span><span>Rate</span><span>ETA</span><span>Control</span>
    </div>
    <div id="items" class="items"></div>
  </section>

  <section id="tactical" class="transfer-map tactical-deck" aria-labelledby="tactical-title">
    <div class="lcars-section-heading compact map-title">
      <span class="section-index">03</span>
      <div class="map-heading">
        <span class="section-eyebrow">Subspace traffic</span>
        <h2 id="tactical-title">Swarm Tactical</h2>
      </div>
      <div class="map-status-group">
        <div id="vpnStatus" class="vpn-status checking" title="Checking VPN route">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <span id="vpnStatusText">Checking VPN...</span>
        </div>
        <button id="toggleMap" class="lcars-icon-button map-collapse-button" type="button" title="Collapse tactical display" aria-label="Collapse tactical display" aria-controls="worldShell" aria-expanded="true">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"></path></svg>
        </button>
      </div>
    </div>
    <div class="tactical-status-line"><span id="routeStatus">Waiting for peer telemetry...</span><b>TACTICAL 47-03</b></div>
    <div id="worldShell" class="world-shell">
      <div class="world-map-frame">
        <div id="worldMapViewport" class="world-map-viewport">
          <button id="fullscreenMap" class="lcars-icon-button fullscreen-control" type="button" title="Fullscreen tactical display" aria-label="Fullscreen tactical display">
            <svg class="enter-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>
            <svg class="exit-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M16 3v3a2 2 0 0 0 2 2h3"></path><path d="M8 21v-3a2 2 0 0 0-2-2H3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg>
          </button>
          <div class="map-progress-widget">
            <div id="mapTorrentTitle" class="map-progress-title">Queue idle</div>
            <div class="map-progress-meta"><span id="mapTorrentProgress">0%</span><span id="mapTorrentRate">0 B/s</span><span id="mapTorrentEta">-</span><span id="mapTorrentSeeds">Streams 0</span></div>
            <div class="map-progress-bar"><div id="mapTorrentFill" class="map-progress-fill"></div></div>
          </div>
          <div id="worldMapLayer" class="world-map-layer">
            <canvas id="worldMapRaster" class="world-map-raster" aria-hidden="true"></canvas>
            <canvas id="worldStaticCanvas" class="world-static-canvas" aria-hidden="true"></canvas>
            <canvas id="worldCanvas" aria-label="Connected peer world map"></canvas>
            <div id="mapPeerLabels" class="map-peer-label-layer" aria-hidden="true"></div>
          </div>
        </div>
      </div>
    </div>
  </section>
</main>
