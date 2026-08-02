<svelte:head>
  <title>Torplex</title>
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
      <h1>Torplex</h1>
      <div class="subtitle" id="subtitle">Waiting for the first live packet...</div>
    </div>
    <div class="header-actions">
      <div class="auth-block">
        <button id="openIntake" class="primary-button" type="button">Unlock</button>
        <a id="logoutButton" class="secondary-button" href="/auth/logout" hidden>Sign out</a>
        <div id="authStatus" class="small">Checking auth...</div>
      </div>
      <div class="live"><span class="dot"></span><span id="connection">Connecting</span></div>
    </div>
  </header>

  <section class="operator-console" aria-label="Torplex operator console">
    <div class="console-register" aria-hidden="true">SYS/00</div>
    <form id="commandForm" class="command-line" autocomplete="off">
      <label id="commandHost" for="commandInput">torplex@pi:~$</label>
      <input id="commandInput" name="command" type="text" aria-label="Torplex command" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder=" " />
      <span class="command-cursor" aria-hidden="true">_</span>
    </form>
    <output id="commandOutput" class="console-output" aria-live="polite">MONITOR LINK READY</output>
    <dl class="telemetry-tape">
      <div><dt>STATE</dt><dd id="consoleState">BOOT</dd></div>
      <div><dt>VPN</dt><dd id="consoleVpn">CHECK</dd></div>
      <div><dt>PEERS</dt><dd id="consolePeers">000</dd></div>
      <div><dt>I/O</dt><dd id="consoleRate">0 B/s</dd></div>
      <div><dt>LOCAL</dt><dd id="consoleClock">--:--:--</dd></div>
    </dl>
  </section>

  <section class="dashboard">
    <div class="gauge-stack">
      <div class="gauges">
        <div class="gauge">
          <span class="register-address" aria-hidden="true">REG/01</span>
          <div class="label">Batch</div>
          <div class="ring" id="batchRing"><span id="batchPercent">0%</span></div>
          <div class="small" id="batchText">0 of 0 complete</div>
        </div>
        <div class="gauge">
          <span class="register-address" aria-hidden="true">REG/02</span>
          <div class="label">Active Item</div>
          <div class="ring" id="activeRing" style="--ring-color: var(--amber);"><span id="activePercent">0%</span></div>
          <div class="small" id="activeText">No active item yet</div>
        </div>
        <div class="gauge">
          <span class="register-address" aria-hidden="true">REG/03</span>
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

  <section class="transfer-map world-panel">
    <div class="map-title">
      <div class="map-heading"><div class="label">Swarm Atlas</div><span class="register-address" aria-hidden="true">MAP/04</span></div>
      <div class="map-status-group">
        <div id="vpnStatus" class="vpn-status checking" title="Checking VPN route">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <span id="vpnStatusText">Checking VPN...</span>
        </div>
        <div class="small" id="routeStatus">Waiting for peer telemetry...</div>
        <button
          id="toggleMap"
          class="icon-button map-collapse-button"
          type="button"
          title="Collapse swarm map"
          aria-label="Collapse swarm map"
          aria-controls="worldShell"
          aria-expanded="true"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m18 15-6-6-6 6"></path>
          </svg>
        </button>
      </div>
    </div>
    <div id="worldShell" class="world-shell">
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
            <canvas id="worldMapRaster" class="world-map-raster" aria-hidden="true"></canvas>
            <canvas id="worldStaticCanvas" class="world-static-canvas" aria-hidden="true"></canvas>
            <canvas id="worldCanvas" aria-label="Connected peer world map"></canvas>
            <div id="mapPeerLabels" class="map-peer-label-layer" aria-hidden="true"></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="queue-head">
      <div class="queue-heading"><div class="label">Queue</div><span class="register-address" aria-hidden="true">QUEUE/05</span></div>
      <button id="clearCompleted" class="secondary-button queue-action" type="button" disabled>Clear Completed</button>
    </div>
    <div id="items" class="items"></div>
  </section>
</main>
