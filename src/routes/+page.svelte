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

  <dialog id="intakeDialog" class="intake-dialog">
    <div class="dialog-card panel">
      <div class="dialog-head">
        <div>
          <div class="label">Torrent Intake</div>
          <div class="dialog-title">Add to Torplex</div>
        </div>
        <div class="dialog-actions">
          <div class="status-pill" id="intakeStatus">Ready</div>
          <button id="closeIntake" class="secondary-button dialog-close" type="button">Close</button>
        </div>
      </div>
      <form id="intakeForm" class="intake-panel">
        <section class="intake-step">
          <div class="step-heading">
            <span class="step-number">1</span>
            <div>
              <div class="step-title">Choose a torrent source</div>
              <div class="small">Paste a magnet or web link, or upload a .torrent file. Torplex inspects it before anything is queued.</div>
            </div>
          </div>
          <div class="source-card">
            <div class="intake-field source-field">
              <label for="sourceUrl">Magnet or link</label>
              <input id="sourceUrl" name="sourceUrl" type="text" autocomplete="off" placeholder="magnet:?xt=... or https://..." />
            </div>
            <button id="inspectTorrent" class="secondary-button inspect-button" type="button" disabled>Inspect</button>
            <div class="intake-field file-field">
              <label for="torrentFile">Torrent file</label>
              <input id="torrentFile" name="torrent" type="file" accept=".torrent,application/x-bittorrent" />
            </div>
          </div>

          <div id="torrentSummary" class="intake-summary">Waiting for a source.</div>
        </section>

        <section id="contentSelection" class="intake-step" hidden>
          <div class="step-heading selection-heading">
            <span class="step-number">2</span>
            <div>
              <div class="step-title">Choose what to download</div>
              <div id="selectionSummary" class="small">Everything is selected.</div>
            </div>
            <div class="selection-actions">
              <button id="selectMedia" class="secondary-button small-button" type="button">Media + captions</button>
              <button id="selectAllFiles" class="secondary-button small-button" type="button">Select all</button>
              <button id="clearFileSelection" class="secondary-button small-button" type="button">Clear</button>
            </div>
          </div>
          <div class="file-filter-row">
            <input id="fileFilter" type="search" autocomplete="off" placeholder="Filter torrent contents" aria-label="Filter torrent contents" />
            <span id="visibleFileCount" class="small"></span>
          </div>
          <input id="selectedFiles" name="selectedFiles" type="hidden" />
          <div id="torrentFileTree" class="torrent-file-tree" aria-label="Torrent contents"></div>

          <div id="smartSetupPanel" class="smart-setup" hidden>
            <div class="smart-setup-copy">
              <div class="step-title">Smart Setup</div>
              <div class="small">Describe any special scope. The model will fill the same controls shown in this dialog for you to review.</div>
            </div>
            <div class="intake-field smart-instructions">
              <label for="additionalInstructions">Additional instructions</label>
              <textarea id="additionalInstructions" name="additionalInstructions" rows="3" placeholder="Example: Only the two animated series. Skip the live-action movie and extras."></textarea>
            </div>
            <div class="smart-actions">
              <div id="smartSetupStatus" class="small">Optional</div>
              <button id="runSmartSetup" class="primary-button" type="button">Fill with Smart Setup</button>
            </div>
            <div id="smartProgress" class="smart-progress" hidden aria-live="polite"></div>
            <div id="smartPlanReview" class="smart-plan-review" hidden></div>
          </div>
        </section>

        <section id="plexSetup" class="intake-step" hidden>
          <div class="step-heading">
            <span class="step-number">3</span>
            <div>
              <div class="step-title">Review Plex placement</div>
              <div class="small">Torplex has filled in a safe default. Change it only when the torrent belongs somewhere else.</div>
            </div>
          </div>
          <div class="intake-grid plex-grid">
            <div class="intake-field">
              <label for="torrentTitle">Queue name</label>
              <input id="torrentTitle" name="title" autocomplete="off" />
            </div>
            <div class="intake-field compact-field">
              <label for="mediaType">Plex library</label>
              <select id="mediaType" name="mediaType">
                <option value="show">TV Shows</option>
                <option value="movie">Movies</option>
              </select>
            </div>
            <div class="intake-field destination-field">
              <label for="destinationPath">Plex folder</label>
              <input id="destinationPath" name="destinationPath" autocomplete="off" />
            </div>
          </div>

          <details class="advanced-settings">
            <summary>Advanced organization settings</summary>
            <div class="intake-grid advanced-grid">
              <div class="intake-field">
                <label for="torrentId">Queue ID</label>
                <input id="torrentId" name="id" autocomplete="off" />
              </div>
              <div class="intake-field compact-field">
                <label for="organizeStrategy">Organizer</label>
                <select id="organizeStrategy" name="organizeStrategy">
                  <option value="mergeRoot">Merge into folder</option>
                  <option value="moveRoot">Move payload folder</option>
                  <option value="routeDirectories">Route selected folders</option>
                </select>
              </div>
              <div class="intake-field">
                <label for="targetSubdir">Season or subfolder</label>
                <input id="targetSubdir" name="targetSubdir" autocomplete="off" />
              </div>
            </div>
            <input id="organizationRoutes" name="organizationRoutes" type="hidden" />
            <div id="routeEditor" class="route-editor" hidden>
              <div class="route-editor-head">
                <div>
                  <div class="step-title">Folder routes</div>
                  <div class="small">Move each selected source folder into its own Plex destination.</div>
                </div>
                <button id="addRoute" class="secondary-button small-button" type="button">Add route</button>
              </div>
              <div id="routeRows" class="route-rows"></div>
            </div>
          </details>
        </section>

        <section id="postDownloadSetup" class="intake-step" hidden>
          <div class="step-heading">
            <span class="step-number">4</span>
            <div>
              <div class="step-title">After download</div>
              <div class="small">Choose the checks Torplex should run before considering the item ready in Plex.</div>
            </div>
          </div>
          <div class="post-download-options">
            <label><input id="scanForMalware" type="checkbox" checked disabled /> <span><strong>Scan for malware <em>Required</em></strong><small>ClamAV must report clean before files move into Plex. This cannot be bypassed.</small></span></label>
            <label><input id="verifyStreams" name="verifyStreams" type="checkbox" checked /> <span><strong>Verify media streams</strong><small>Confirm downloaded video files can be read.</small></span></label>
            <label><input id="ensureEnglishSubtitles" name="ensureEnglishSubtitles" type="checkbox" checked /> <span><strong>Ensure English captions</strong><small>Check embedded and sidecar captions; fetch a match when configured.</small></span></label>
            <label><input id="verifyCanonicalMetadata" name="verifyCanonicalMetadata" type="checkbox" checked /> <span><strong>Verify title and date</strong><small>Reconcile the Plex match with canonical metadata.</small></span></label>
            <label><input id="verifyArtwork" name="verifyArtwork" type="checkbox" checked /> <span><strong>Verify artwork</strong><small>Make sure the Plex item has appropriate poster art.</small></span></label>
            <label><input id="refreshPlex" name="refreshPlex" type="checkbox" checked /> <span><strong>Refresh Plex</strong><small>Scan the affected library after organization.</small></span></label>
          </div>
        </section>

        <label class="rights-attestation" for="rightsConfirmed">
          <input id="rightsConfirmed" name="rightsConfirmed" type="checkbox" />
          <span>I confirm that I have the rights or authorization required to download and store the selected content. I accept responsibility for complying with applicable laws and service terms.</span>
        </label>

        <div class="intake-actions">
          <div id="queueReadiness" class="small">Inspect a source to continue.</div>
          <button id="addTorrent" class="primary-button" type="submit" disabled>Add selected content</button>
        </div>
      </form>
    </div>
  </dialog>

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
            <canvas id="worldMapRaster" class="world-map-raster" aria-hidden="true"></canvas>
            <canvas id="worldCanvas" aria-label="Connected peer world map"></canvas>
            <div id="mapPeerLabels" class="map-peer-label-layer" aria-hidden="true"></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="queue-head">
      <div class="label">Queue</div>
      <button id="clearCompleted" class="secondary-button queue-action" type="button" disabled>Clear Completed</button>
    </div>
    <div id="items" class="items"></div>
  </section>
</main>
