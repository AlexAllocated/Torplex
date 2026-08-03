<script>
  import { onDestroy, onMount } from 'svelte';
  import { beginCrtActivity } from '$lib/client/crt-activity.js';
  import { withSmartSetupSlot } from '$lib/client/smart-setup-queue.js';

  export let clientId;
  export let initialSourceUrl = '';
  export let initialInstructions = '';
  export let initialAlternatives = [];
  export let ordinal = 1;
  export let onremove = () => {};
  export let onchange = () => {};

  const mediaPattern = /\.(?:mkv|mp4|m4v|avi|mov|webm|ts|m2ts|srt|ass|ssa|vtt|sub|idx)$/i;
  const riskyPattern = /\.(?:exe|dll|com|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|reg|lnk|desktop|appimage|apk|jar|dmg|pkg|deb|rpm|sh|bash|zsh|fish|py|pl|rb)$/i;

  let sourceUrl = initialSourceUrl;
  let torrentFile = null;
  let inspection = null;
  let sourceKey = '';
  let status = initialSourceUrl ? 'Waiting to inspect' : 'Needs a source';
  let mode = 'idle';
  let error = '';
  let selectedFiles = [];
  let filter = '';
  let additionalInstructions = initialInstructions;
  let progress = [];
  let smartPlan = null;
  let timer;
  let operation = 0;
  let inspectStartedAt = 0;
  let elapsedTimer;
  let fallbackSources = [...new Map((Array.isArray(initialAlternatives) ? initialAlternatives : [])
    .filter((candidate) => candidate?.sourceUrl && candidate.sourceUrl !== initialSourceUrl)
    .map((candidate) => [candidate.sourceUrl, candidate])).values()];
  let fallbackAttempt = 0;
  let fallbackHistory = [];
  let fields = {
    title: '', id: '', mediaType: 'show', destinationPath: '', organizeStrategy: 'mergeRoot', targetSubdir: '',
    verifyStreams: true, ensureEnglishSubtitles: true, verifyCanonicalMetadata: true, verifyArtwork: true, validateMetadataWithAi: true, refreshPlex: true,
  };
  let routes = [];
  const activeActivityStops = new Set();

  $: visibleFiles = (inspection?.files || []).filter((entry) => !filter || entry.path.toLowerCase().includes(filter.toLowerCase()));
  $: selectedBytes = (inspection?.files || []).filter((entry) => selectedFiles.includes(entry.index)).reduce((sum, entry) => sum + entry.length, 0);
  $: ready = Boolean(inspection && selectedFiles.length && fields.title && fields.id && fields.destinationPath && !['busy', 'planning'].includes(mode) && !error);
  $: emitChange(ready, sourceUrl, torrentFile, fields, routes, selectedFiles);

  function fmt(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
  }

  async function responsePayload(response) {
    const body = await response.text();
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch {
      return { error: body.trim() };
    }
  }

  function emitChange(isReady, url, file, currentFields, currentRoutes, currentSelection) {
    onchange({
      clientId,
      ready: isReady,
      sourceUrl: url.trim(),
      file,
      title: currentFields.title || `Item ${ordinal}`,
      status,
      fields: {
        ...currentFields,
        selectedFiles: currentSelection,
        organizationRoutes: currentRoutes,
      },
    });
  }

  function applySuggested(suggested = {}) {
    fields = {
      ...fields,
      title: suggested.title || fields.title,
      id: suggested.id || fields.id,
      mediaType: suggested.mediaType === 'movie' ? 'movie' : 'show',
      destinationPath: suggested.destinationPath || fields.destinationPath,
      organizeStrategy: suggested.organizeStrategy || 'mergeRoot',
      targetSubdir: suggested.targetSubdir || '',
    };
  }

  function resetInspection() {
    operation += 1;
    clearTimeout(timer);
    clearInterval(elapsedTimer);
    inspection = null;
    selectedFiles = [];
    smartPlan = null;
    progress = [];
    sourceKey = '';
    error = '';
    routes = [];
  }

  function clearFallbackPlan() {
    fallbackSources = [];
    fallbackAttempt = 0;
    fallbackHistory = [];
  }

  function tryNextFallback(failure) {
    const candidate = fallbackSources[fallbackAttempt];
    if (!candidate) return false;
    fallbackAttempt += 1;
    fallbackHistory = [...fallbackHistory, {
      sourceUrl,
      message: failure,
      replacementName: candidate.name || `Fallback ${fallbackAttempt}`,
    }];
    sourceUrl = candidate.sourceUrl;
    torrentFile = null;
    inspection = null;
    selectedFiles = [];
    smartPlan = null;
    progress = [];
    sourceKey = '';
    error = '';
    routes = [];
    status = `Trying fallback ${fallbackAttempt} of ${fallbackSources.length}: ${candidate.name || candidate.provider || 'alternate source'}`;
    mode = 'busy';
    timer = setTimeout(inspectSource, 150);
    return true;
  }

  function currentSourceKey() {
    if (torrentFile) return `file:${torrentFile.name}:${torrentFile.size}:${torrentFile.lastModified}`;
    return sourceUrl.trim() ? `url:${sourceUrl.trim()}` : '';
  }

  function scheduleInspect(delay = 450) {
    clearTimeout(timer);
    if (!currentSourceKey()) {
      resetInspection();
      status = 'Needs a source';
      mode = 'idle';
      return;
    }
    status = 'Waiting to inspect';
    mode = 'idle';
    timer = setTimeout(inspectSource, delay);
  }

  async function inspectSource() {
    clearTimeout(timer);
    const key = currentSourceKey();
    if (!key || (key === sourceKey && inspection)) return;
    const nonce = ++operation;
    clearInterval(elapsedTimer);
    inspection = null;
    selectedFiles = [];
    smartPlan = null;
    progress = [];
    error = '';
    routes = [];
    status = 'Inspecting source';
    mode = 'busy';
    inspectStartedAt = Date.now();
    if (sourceUrl.toLowerCase().startsWith('magnet:')) {
      elapsedTimer = setInterval(() => {
        if (nonce === operation) status = `Fetching peer metadata - ${Math.floor((Date.now() - inspectStartedAt) / 1000)}s`;
      }, 1000);
    }
    try {
      const data = new FormData();
      if (sourceUrl.trim()) data.set('sourceUrl', sourceUrl.trim());
      else if (torrentFile) data.set('torrent', torrentFile);
      const response = await fetch('/api/torrent/inspect', { method: 'POST', body: data });
      const payload = await responsePayload(response);
      if (nonce !== operation) return;
      if (!response.ok) throw new Error(payload.error || 'Inspection failed');
      inspection = payload;
      sourceKey = key;
      selectedFiles = (payload.files || []).filter((entry) => !riskyPattern.test(entry.path)).map((entry) => entry.index);
      applySuggested(payload.suggested || {});
      status = payload.smartSetup?.available && payload.files?.length ? 'Starting Smart Setup' : 'Ready for review';
      mode = payload.smartSetup?.available && payload.files?.length ? 'busy' : 'ready';
      if (payload.smartSetup?.available && payload.files?.length) await runSmartSetup(nonce);
    } catch (caught) {
      if (nonce !== operation) return;
      const failure = caught instanceof Error ? caught.message : String(caught);
      if (tryNextFallback(failure)) return;
      error = failure;
      status = error;
      mode = 'error';
    } finally {
      if (nonce === operation) clearInterval(elapsedTimer);
    }
  }

  async function runSmartSetup(existingNonce = operation) {
    if (!inspection || mode === 'planning') return;
    const nonce = existingNonce;
    mode = 'planning';
    status = 'Smart Setup planning';
    error = '';
    progress = ['Reading the inspected torrent'];
    try {
      const result = await withSmartSetupSlot(async () => {
        if (nonce !== operation) return null;
        status = 'Smart Setup slot acquired';
        const stopActivity = beginCrtActivity('ai');
        activeActivityStops.add(stopActivity);
        try {
          const data = new FormData();
          if (sourceUrl.trim()) data.set('sourceUrl', sourceUrl.trim());
          else if (torrentFile) data.set('torrent', torrentFile);
          data.set('additionalInstructions', additionalInstructions.trim());
          const response = await fetch('/api/torrent/plan', { method: 'POST', body: data });
          if (!response.ok) {
            const payload = await responsePayload(response);
            throw new Error(payload.error || 'Smart Setup could not start');
          }
          if (!response.body) throw new Error('Smart Setup could not start');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let payload = null;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line);
              if (event.type === 'progress') {
                progress = [...progress, event.message];
                status = event.message;
              } else if (event.type === 'result') payload = event;
              else if (event.type === 'error') throw new Error(event.error || 'Smart Setup failed');
            }
          }
          return payload;
        } finally {
          activeActivityStops.delete(stopActivity);
          stopActivity();
        }
      });
      if (nonce !== operation) return;
      if (!result?.plan) throw new Error('Smart Setup ended without a plan');
      const plan = result.plan;
      smartPlan = plan;
      selectedFiles = plan.selectedFiles || [];
      applySuggested(plan);
      routes = plan.routes || [];
      fields = {
        ...fields,
        organizeStrategy: plan.organizeStrategy || fields.organizeStrategy,
        targetSubdir: plan.targetSubdir || '',
        verifyStreams: Boolean(plan.postDownloadChecks?.verifyStreams),
        ensureEnglishSubtitles: Boolean(plan.postDownloadChecks?.ensureEnglishSubtitles),
        verifyCanonicalMetadata: Boolean(plan.postDownloadChecks?.verifyCanonicalMetadata),
        verifyArtwork: Boolean(plan.postDownloadChecks?.verifyArtwork),
        validateMetadataWithAi: Boolean(plan.postDownloadChecks?.validateMetadataWithAi),
        refreshPlex: Boolean(plan.postDownloadChecks?.refreshPlex),
      };
      status = `${result.model} plan ready`;
      mode = 'ready';
    } catch (caught) {
      if (nonce !== operation) return;
      error = caught instanceof Error ? caught.message : String(caught);
      status = error;
      mode = 'error';
    }
  }

  function handleUrlInput() {
    if (sourceUrl.trim()) torrentFile = null;
    clearFallbackPlan();
    resetInspection();
    scheduleInspect();
  }

  function handleFile(event) {
    torrentFile = event.currentTarget.files?.[0] || null;
    if (torrentFile) sourceUrl = '';
    clearFallbackPlan();
    resetInspection();
    scheduleInspect(80);
  }

  function toggleFile(index, checked) {
    selectedFiles = checked
      ? [...new Set([...selectedFiles, index])].sort((a, b) => a - b)
      : selectedFiles.filter((value) => value !== index);
  }

  function updateRoute(index, key, value) {
    routes = routes.map((route, routeIndex) => routeIndex === index ? { ...route, [key]: value } : route);
  }

  onMount(() => {
    if (initialSourceUrl) scheduleInspect(20);
  });
  onDestroy(() => {
    clearTimeout(timer);
    clearInterval(elapsedTimer);
    operation += 1;
    activeActivityStops.forEach((stopActivity) => stopActivity());
    activeActivityStops.clear();
  });
</script>

<section class:ready class:error={mode === 'error'} class="bulk-intake-item">
  <div class="bulk-item-head">
    <div class="bulk-item-index">{ordinal}</div>
    <div class="bulk-item-title">
      <strong>{fields.title || inspection?.payloadName || `New torrent ${ordinal}`}</strong>
      <span>{inspection ? `${selectedFiles.length} of ${inspection.fileCount} files - ${fmt(selectedBytes)}` : status}</span>
    </div>
    <span class="status-pill" data-mode={mode === 'planning' ? 'busy' : mode}>{status}</span>
    <button class="danger-button small-button" type="button" on:click={() => onremove(clientId)}>Remove</button>
  </div>

  <div class="bulk-source-row">
    <div class="intake-field source-field">
      <label for={`source-${clientId}`}>Magnet or link</label>
      <input id={`source-${clientId}`} bind:value={sourceUrl} on:input={handleUrlInput} on:paste={() => setTimeout(() => scheduleInspect(100), 0)} autocomplete="off" placeholder="magnet:?xt=... or https://..." />
    </div>
    <div class="intake-field file-field">
      <label for={`file-${clientId}`}>Torrent file</label>
      <input id={`file-${clientId}`} type="file" accept=".torrent,application/x-bittorrent" on:change={handleFile} />
    </div>
    <button class="secondary-button inspect-button" type="button" disabled={!currentSourceKey() || mode === 'busy' || mode === 'planning'} on:click={inspectSource}>Inspect</button>
  </div>
  <div class="intake-field bulk-preflight-instructions">
    <label for={`instructions-${clientId}`}>Smart Setup instructions <span>Optional</span></label>
    <textarea id={`instructions-${clientId}`} rows="2" bind:value={additionalInstructions} placeholder="Example: Include only seasons 1-4 and matching English captions. Exclude the movie and extras."></textarea>
  </div>

  {#if error}
    <div class="bulk-item-error">{error}</div>
  {/if}

  {#if fallbackHistory.length}
    <div class="bulk-fallback-note">
      <strong>{mode === 'error' ? 'Fallbacks exhausted' : mode === 'ready' ? 'Fallback source active' : 'Trying fallback source'}</strong>
      <span>{fallbackHistory.length} earlier source{fallbackHistory.length === 1 ? '' : 's'} could not provide metadata. {mode === 'error' ? 'No reviewed source was usable.' : `Torplex is using ${fallbackHistory.at(-1).replacementName}.`}</span>
    </div>
  {/if}

  {#if progress.length && (mode === 'planning' || mode === 'busy')}
    <div class="smart-progress bulk-progress" aria-live="polite">
      {#each progress.slice(-4) as message, index}
        <div class:done={index < progress.slice(-4).length - 1} class="smart-progress-line">{message}</div>
      {/each}
    </div>
  {/if}

  {#if inspection}
    <div class="bulk-review-grid">
      <div class="intake-field">
        <label for={`title-${clientId}`}>Queue name</label>
        <input id={`title-${clientId}`} bind:value={fields.title} />
      </div>
      <div class="intake-field compact-field">
        <label for={`type-${clientId}`}>Plex library</label>
        <select id={`type-${clientId}`} bind:value={fields.mediaType}>
          <option value="show">TV Shows</option>
          <option value="movie">Movies</option>
        </select>
      </div>
      <div class="intake-field destination-field">
        <label for={`destination-${clientId}`}>Plex folder</label>
        <input id={`destination-${clientId}`} bind:value={fields.destinationPath} />
      </div>
    </div>

    <details class="bulk-details">
      <summary>Files, Smart Setup, and advanced organization</summary>
      <div class="bulk-detail-body">
        <div class="selection-actions bulk-selection-actions">
          <button class="secondary-button small-button" type="button" on:click={() => selectedFiles = (inspection.files || []).filter((entry) => mediaPattern.test(entry.path) && !riskyPattern.test(entry.path)).map((entry) => entry.index)}>Media + captions</button>
          <button class="secondary-button small-button" type="button" on:click={() => selectedFiles = (inspection.files || []).filter((entry) => !riskyPattern.test(entry.path)).map((entry) => entry.index)}>Select safe files</button>
          <button class="secondary-button small-button" type="button" on:click={() => selectedFiles = []}>Clear</button>
        </div>
        <div class="file-filter-row bulk-filter-row">
          <input bind:value={filter} type="search" autocomplete="off" placeholder="Filter torrent contents" aria-label="Filter torrent contents" />
          <span class="small">{visibleFiles.length} shown</span>
        </div>
        <div class="torrent-file-tree bulk-file-tree">
          {#each visibleFiles as entry}
            <label class:risky-file={riskyPattern.test(entry.path)} class="torrent-file-row">
              <input type="checkbox" checked={selectedFiles.includes(entry.index)} disabled={riskyPattern.test(entry.path)} on:change={(event) => toggleFile(entry.index, event.currentTarget.checked)} />
              <span class="file-name" title={entry.path}>{entry.path}</span>
              <span class="file-size">{fmt(entry.length)}</span>
            </label>
          {/each}
        </div>

        <div class="bulk-smart-row">
          <div><div class="step-title">Smart Setup</div><div class="small">Edit the instructions above, then rerun to replace the current plan.</div></div>
          <button class="primary-button" type="button" disabled={mode === 'planning' || mode === 'busy'} on:click={() => runSmartSetup()}>Run Smart Setup again</button>
        </div>
        {#if smartPlan}
          <div class="smart-plan-review">
            <strong>{smartPlan.summary}</strong>
            <span>Confidence: {smartPlan.confidence}. {smartPlan.decisions?.join(' ')}</span>
            {#if smartPlan.warnings?.length}<span class="smart-plan-warning">{smartPlan.warnings.join(' ')}</span>{/if}
          </div>
        {/if}

        <div class="bulk-advanced-grid">
          <div class="intake-field"><label for={`id-${clientId}`}>Queue ID</label><input id={`id-${clientId}`} bind:value={fields.id} /></div>
          <div class="intake-field"><label for={`organizer-${clientId}`}>Organizer</label><select id={`organizer-${clientId}`} bind:value={fields.organizeStrategy}><option value="mergeRoot">Merge into folder</option><option value="moveRoot">Move payload folder</option><option value="routeDirectories">Route selected folders</option></select></div>
          <div class="intake-field"><label for={`subdir-${clientId}`}>Season or subfolder</label><input id={`subdir-${clientId}`} bind:value={fields.targetSubdir} /></div>
        </div>
        {#if fields.organizeStrategy === 'routeDirectories'}
          <div class="route-editor">
            <div class="route-editor-head"><div><div class="step-title">Folder routes</div><div class="small">Every selected file must match exactly one source prefix.</div></div><button class="secondary-button small-button" type="button" on:click={() => routes = [...routes, { sourcePath: '', destinationPath: '' }]}>Add route</button></div>
            <div class="route-rows">
              {#each routes as route, routeIndex}
                <div class="route-row">
                  <div class="intake-field"><label for={`route-source-${clientId}-${routeIndex}`}>Source folder</label><input id={`route-source-${clientId}-${routeIndex}`} value={route.sourcePath} on:input={(event) => updateRoute(routeIndex, 'sourcePath', event.currentTarget.value)} /></div>
                  <div class="intake-field"><label for={`route-destination-${clientId}-${routeIndex}`}>Plex destination</label><input id={`route-destination-${clientId}-${routeIndex}`} value={route.destinationPath} on:input={(event) => updateRoute(routeIndex, 'destinationPath', event.currentTarget.value)} /></div>
                  <button class="danger-button route-remove" type="button" aria-label="Remove route" on:click={() => routes = routes.filter((_, index) => index !== routeIndex)}>×</button>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="post-download-options bulk-post-options">
          <label><input type="checkbox" checked disabled /><span><strong>Scan for malware <em>Required</em></strong><small>Blocked unless ClamAV reports clean.</small></span></label>
          <label><input type="checkbox" bind:checked={fields.verifyStreams} /><span><strong>Verify media streams</strong><small>Confirm video files can be read.</small></span></label>
          <label><input type="checkbox" bind:checked={fields.ensureEnglishSubtitles} /><span><strong>Ensure English captions</strong><small>Check embedded, sidecar, and configured lookup.</small></span></label>
          <label><input type="checkbox" bind:checked={fields.verifyCanonicalMetadata} /><span><strong>Verify title and date</strong><small>Reconcile the Plex match.</small></span></label>
          <label><input type="checkbox" bind:checked={fields.verifyArtwork} /><span><strong>Verify artwork</strong><small>Check poster metadata.</small></span></label>
          <label><input type="checkbox" bind:checked={fields.validateMetadataWithAi} /><span><strong>AI metadata curator</strong><small>Research and correct high-confidence Plex metadata.</small></span></label>
          <label><input type="checkbox" bind:checked={fields.refreshPlex} /><span><strong>Refresh Plex</strong><small>Scan the affected library.</small></span></label>
        </div>
      </div>
    </details>
  {/if}
</section>
