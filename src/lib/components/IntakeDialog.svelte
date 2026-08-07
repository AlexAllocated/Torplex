<script>
  import { goto } from '$app/navigation';
  import { onDestroy, onMount } from 'svelte';
  import { beginCrtActivity } from '$lib/client/crt-activity.js';
  import IntakeItem from './IntakeItem.svelte';

  let items = [];
  let snapshots = new Map();
  let sequence = 0;
  let activeView = 'workspace';
  let searchPrompt = '';
  let searchRightsConfirmed = false;
  let searchRunning = false;
  let searchController = null;
  let activeSearchId = '';
  let searchProgress = [];
  let searchProposal = null;
  let selectedProposals = new Set();
  let queueRightsConfirmed = false;
  let queueRunning = false;
  let dialogStatus = 'Ready';
  let dialogMode = 'idle';
  let queueError = '';
  let stopSearchActivity = null;
  let retryingTargets = new Set();
  const qualityPresets = {
    balanced: { preset: 'balanced', preferredResolution: 1080, minimumResolution: 720, maximumResolution: 2160, hdrMode: 'allow', codec: 'any', directPlay: false, maxSourceGiB: 0 },
    compatibility: { preset: 'compatibility', preferredResolution: 1080, minimumResolution: 480, maximumResolution: 1080, hdrMode: 'avoid', codec: 'h264', directPlay: true, maxSourceGiB: 0 },
    compact: { preset: 'compact', preferredResolution: 720, minimumResolution: 480, maximumResolution: 1080, hdrMode: 'allow', codec: 'h265', directPlay: false, maxSourceGiB: 12 },
    maximum: { preset: 'maximum', preferredResolution: 2160, minimumResolution: 1080, maximumResolution: 2160, hdrMode: 'prefer', codec: 'any', directPlay: false, maxSourceGiB: 0 },
  };
  let qualityProfile = { ...qualityPresets.compatibility };

  $: readyItems = items.map((item) => snapshots.get(item.clientId)).filter((item) => item?.ready);
  $: unresolvedItems = items.length - readyItems.length;

  function makeClientId() {
    sequence += 1;
    return `intake-${Date.now().toString(36)}-${sequence}`;
  }

  function fmt(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
  }

  function addItem(initial = {}) {
    const item = {
      clientId: makeClientId(),
      sourceUrl: initial.sourceUrl || '',
      instructions: initial.instructions || '',
      work: initial.work || null,
      alternatives: initial.alternatives || [],
    };
    items = [...items, item];
    activeView = 'workspace';
    return item;
  }

  function removeItem(clientId) {
    items = items.filter((item) => item.clientId !== clientId);
    const next = new Map(snapshots);
    next.delete(clientId);
    snapshots = next;
  }

  function updateItem(snapshot) {
    const previous = snapshots.get(snapshot.clientId);
    if (
      previous?.ready === snapshot.ready
      && previous?.sourceUrl === snapshot.sourceUrl
      && previous?.title === snapshot.title
      && previous?.status === snapshot.status
      && previous?.file === snapshot.file
      && JSON.stringify(previous?.fields) === JSON.stringify(snapshot.fields)
    ) return;
    snapshots = new Map(snapshots).set(snapshot.clientId, snapshot);
  }

  function selectAllProposals(proposal) {
    selectedProposals = new Set((proposal?.selections || []).map((selection) => selection.selectionId || selection.candidateId));
  }

  function applySearchSession(session, { select = false } = {}) {
    if (!session) return;
    activeView = 'search';
    activeSearchId = session.id;
    searchPrompt = session.prompt || searchPrompt;
    if (session.qualityProfile) qualityProfile = { ...session.qualityProfile };
    searchProgress = Array.isArray(session.progress) ? session.progress : [];
    searchRunning = session.status === 'running';
    if (session.proposal) {
      searchProposal = session.proposal;
      if (select) selectAllProposals(searchProposal);
    }
    if (session.status === 'running') {
      dialogStatus = 'Searching';
      dialogMode = 'busy';
    } else if (session.status === 'completed') {
      dialogStatus = `${session.proposal?.selections?.length || 0} proposed`;
      dialogMode = 'ready';
    } else if (session.status === 'cancelled') {
      dialogStatus = 'Search cancelled';
      dialogMode = 'idle';
    } else if (session.status === 'failed') {
      queueError = session.error || 'Search failed';
      dialogStatus = queueError;
      dialogMode = 'error';
    }
  }

  async function readNdjson(response, onProgress, onSession = () => {}) {
    if (!response.ok || !response.body) {
      let message = `Request failed with HTTP ${response.status}`;
      try { message = (await response.json()).error || message; } catch { /* response was not JSON */ }
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'progress') onProgress(event.message);
        else if (event.type === 'session') {
          onSession(event.session);
          if (event.session?.status === 'completed') result = { proposal: event.session.proposal };
          else if (event.session?.status === 'failed') throw new Error(event.session.error || 'Search failed');
          else if (event.session?.status === 'cancelled') result = { cancelled: true };
        }
        else if (event.type === 'result') result = event;
        else if (event.type === 'error') throw new Error(event.error || 'Request failed');
      }
    }
    if (!result) throw new Error('Request ended without a result');
    return result;
  }

  async function watchSearchSession(searchId, controller, { select = false } = {}) {
    const response = await fetch(`/api/torrent/search/events?searchId=${encodeURIComponent(searchId)}`, {
      signal: controller.signal,
    });
    return readNdjson(
      response,
      (message) => searchProgress = [...searchProgress, message],
      (session) => applySearchSession(session, { select: select && session.status === 'completed' }),
    );
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

  async function runSearch() {
    if (!searchPrompt.trim() || !searchRightsConfirmed || searchRunning) return;
    searchRunning = true;
    searchProposal = null;
    selectedProposals = new Set();
    searchProgress = ['Starting catalog search'];
    dialogStatus = 'Searching';
    dialogMode = 'busy';
    queueError = '';
    const controller = new AbortController();
    const searchId = `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    searchController = controller;
    activeSearchId = searchId;
    localStorage.removeItem('torplex:search-consumed');
    const stopActivity = beginCrtActivity('ai');
    stopSearchActivity = stopActivity;
    try {
      const response = await fetch('/api/torrent/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: searchPrompt.trim(), rightsConfirmed: true, searchId, qualityProfile }),
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/x-ndjson')) {
        const result = await readNdjson(response, (message) => searchProgress = [...searchProgress, message]);
        searchProposal = result.proposal;
        selectAllProposals(searchProposal);
        dialogStatus = `${searchProposal.selections.length} proposed`;
        dialogMode = 'ready';
      } else {
        const payload = await responsePayload(response);
        if (!response.ok) throw new Error(payload.error || `Search failed with HTTP ${response.status}`);
        applySearchSession(payload.session);
        await watchSearchSession(searchId, controller, { select: true });
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        if (searchController === controller) {
          searchProgress = [...searchProgress, 'Search cancelled'];
          dialogStatus = 'Search cancelled';
          dialogMode = 'idle';
        }
      } else {
        queueError = caught instanceof Error ? caught.message : String(caught);
        dialogStatus = queueError;
        dialogMode = 'error';
      }
    } finally {
      stopActivity();
      if (stopSearchActivity === stopActivity) stopSearchActivity = null;
      if (searchController === controller) {
        searchController = null;
        searchRunning = false;
      }
    }
  }

  function cancelSearch() {
    if (!searchController || !searchRunning) return;
    const controller = searchController;
    const searchId = activeSearchId;
    searchController = null;
    searchRunning = false;
    searchProgress = [...searchProgress, 'Search cancelled'];
    dialogStatus = 'Search cancelled';
    dialogMode = 'idle';
    void fetch('/api/torrent/search/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchId }),
    }).catch(() => {});
    controller.abort();
  }

  function chooseQualityPreset(preset) {
    if (qualityPresets[preset]) qualityProfile = { ...qualityPresets[preset] };
  }

  function customizeQuality(field, value) {
    qualityProfile = { ...qualityProfile, preset: 'custom', [field]: value };
  }

  async function retrySearchTarget(targetId) {
    if (!activeSearchId || retryingTargets.has(targetId)) return;
    retryingTargets = new Set(retryingTargets).add(targetId);
    queueError = '';
    dialogStatus = 'Retrying source';
    dialogMode = 'busy';
    const stopActivity = beginCrtActivity('ai');
    try {
      const response = await fetch('/api/torrent/search/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchId: activeSearchId, targetId }),
      });
      const result = await readNdjson(response, (message) => searchProgress = [...searchProgress, message]);
      searchProposal = result.proposal;
      const nextSelections = new Set(selectedProposals);
      const retried = searchProposal.selections.find((selection) => selection.targetId === targetId);
      if (retried) nextSelections.add(retried.selectionId || retried.candidateId);
      selectedProposals = nextSelections;
      dialogStatus = retried ? 'Retry found a source' : 'Retry finished without a source';
      dialogMode = retried ? 'ready' : 'error';
    } catch (caught) {
      queueError = caught instanceof Error ? caught.message : String(caught);
      dialogStatus = queueError;
      dialogMode = 'error';
    } finally {
      stopActivity();
      const next = new Set(retryingTargets);
      next.delete(targetId);
      retryingTargets = next;
    }
  }

  function toggleProposal(selectionId, checked) {
    const next = new Set(selectedProposals);
    if (checked) next.add(selectionId);
    else next.delete(selectionId);
    selectedProposals = next;
  }

  function acceptProposal() {
    const selected = (searchProposal?.selections || []).filter((selection) => selectedProposals.has(selection.selectionId || selection.candidateId));
    const emptyIds = new Set(items
      .filter((item) => {
        const snapshot = snapshots.get(item.clientId);
        return snapshot && !snapshot.sourceUrl && !snapshot.file;
      })
      .map((item) => item.clientId));
    if (emptyIds.size) {
      items = items.filter((item) => !emptyIds.has(item.clientId));
      snapshots = new Map([...snapshots].filter(([clientId]) => !emptyIds.has(clientId)));
    }
    for (const selection of selected) {
      const year = selection.work.year ? ` (${selection.work.year})` : '';
      const season = selection.seasonNumber ? String(selection.seasonNumber).padStart(2, '0') : '';
      const seasonScope = selection.seasonNumber
        ? ` Include only Season ${season} (S${season}) and organize it as a single TV season under ${selection.work.title}${year}/Season ${season}.`
        : selection.work.type === 'show'
          ? ` Include every requested season (${(selection.work.requiredSeasons || []).map((season) => `S${String(season).padStart(2, '0')}`).join(', ') || 'complete series'}) and organize each season separately under ${selection.work.title}${year}.`
          : '';
      addItem({
        sourceUrl: selection.candidate.sourceUrl,
        alternatives: selection.alternatives || [],
        work: selection.work,
        instructions: `Include only ${selection.work.title}${year}, matching the requested ${selection.work.type}.${seasonScope} Exclude unrelated titles, samples, and extras.`,
      });
    }
    searchProposal = null;
    selectedProposals = new Set();
    searchProgress = [];
    searchPrompt = '';
    searchRightsConfirmed = false;
    if (activeSearchId) localStorage.setItem('torplex:search-consumed', activeSearchId);
    dialogStatus = `${selected.length} item${selected.length === 1 ? '' : 's'} preparing`;
    dialogMode = 'busy';
  }

  async function queueBatch() {
    if (!items.length || unresolvedItems || !queueRightsConfirmed || queueRunning) return;
    queueRunning = true;
    queueError = '';
    dialogStatus = `Adding ${readyItems.length} item${readyItems.length === 1 ? '' : 's'}`;
    dialogMode = 'busy';
    try {
      const data = new FormData();
      data.set('rightsConfirmed', 'on');
      const payload = readyItems.map((item) => ({
        clientId: item.clientId,
        sourceUrl: item.sourceUrl || undefined,
        fields: item.fields,
      }));
      data.set('items', JSON.stringify(payload));
      for (const item of readyItems) {
        if (item.file) data.set(`torrent:${item.clientId}`, item.file);
      }
      const response = await fetch('/api/torrents/bulk', { method: 'POST', body: data });
      const result = await responsePayload(response);
      if (!response.ok) throw new Error(result.error || 'Bulk add failed');
      dialogStatus = result.restartMessage || 'Queued';
      dialogMode = 'ready';
      items = [];
      snapshots = new Map();
      queueRightsConfirmed = false;
      await goto('/');
    } catch (caught) {
      queueError = caught instanceof Error ? caught.message : String(caught);
      dialogStatus = queueError;
      dialogMode = 'error';
    } finally {
      queueRunning = false;
    }
  }

  onDestroy(() => {
    searchController?.abort();
    searchController = null;
    stopSearchActivity?.();
    stopSearchActivity = null;
  });

  onMount(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/torrent/search');
        if (!response.ok) return;
        const payload = await response.json();
        const session = payload.session;
        if (!session) return;
        const consumed = localStorage.getItem('torplex:search-consumed');
        if (session.status === 'completed' && consumed === session.id) return;
        applySearchSession(session, { select: session.status === 'completed' });
        if (session.status !== 'running') return;
        searchController = controller;
        const stopActivity = beginCrtActivity('ai');
        stopSearchActivity = stopActivity;
        try { await watchSearchSession(session.id, controller, { select: true }); }
        finally {
          stopActivity();
          if (stopSearchActivity === stopActivity) stopSearchActivity = null;
          if (searchController === controller) searchController = null;
        }
      } catch (caught) {
        if (!controller.signal.aborted) queueError = caught instanceof Error ? caught.message : String(caught);
      }
    })();
    return () => controller.abort();
  });

  addItem();
</script>

<section class="intake-page">
  <div class="bulk-intake-workspace intake-page-card">
    <div class="dialog-head">
      <div>
        <div class="label">Torrent Intake</div>
        <div class="dialog-title">Add to Torplex</div>
      </div>
      <div class="dialog-actions">
        <div class="status-pill" data-mode={dialogMode}>{dialogStatus}</div>
        <a class="secondary-button" href="/">Dashboard</a>
      </div>
    </div>

    <div class="intake-tabs" role="tablist" aria-label="Torrent intake mode">
      <button class:active={activeView === 'workspace'} type="button" role="tab" aria-selected={activeView === 'workspace'} on:click={() => activeView = 'workspace'}>Add sources <span>{items.length}</span></button>
      <button class:active={activeView === 'search'} type="button" role="tab" aria-selected={activeView === 'search'} on:click={() => activeView = 'search'}>Find with AI</button>
    </div>

    {#if activeView === 'search'}
      <section class="search-workspace">
        <div class="search-intro">
          <div><div class="step-title">Describe a collection</div><div class="small">Torplex resolves exact titles, verifies complete-series coverage, and falls back to independent season sources when needed. Nothing is queued until you review the proposal and finish Smart Setup.</div></div>
          <div class="search-provider-note">Admin-installed providers only</div>
        </div>
        <div class="intake-field search-prompt-field">
          <label for="catalogSearchPrompt">What do you want to find?</label>
          <textarea id="catalogSearchPrompt" rows="4" bind:value={searchPrompt} placeholder="Example: All live-action Batman movies starting with the 1989 Michael Keaton film"></textarea>
        </div>
        <div class="search-quality-panel">
          <div class="intake-field quality-preset-field">
            <label for="searchQualityPreset">Quality profile</label>
            <select id="searchQualityPreset" value={qualityProfile.preset} on:change={(event) => chooseQualityPreset(event.currentTarget.value)}>
              <option value="compatibility">Direct play (recommended)</option>
              <option value="balanced">Balanced 1080p</option>
              <option value="compact">Compact files</option>
              <option value="maximum">Maximum quality</option>
              {#if qualityProfile.preset === 'custom'}<option value="custom">Custom</option>{/if}
            </select>
          </div>
          <details class="quality-controls">
            <summary>Customize quality constraints</summary>
            <div class="quality-control-grid">
              <div class="intake-field"><label for="qualityMinimum">Minimum</label><select id="qualityMinimum" value={qualityProfile.minimumResolution} on:change={(event) => customizeQuality('minimumResolution', Number(event.currentTarget.value))}><option value="0">Any</option><option value="480">480p</option><option value="720">720p</option><option value="1080">1080p</option><option value="2160">2160p</option></select></div>
              <div class="intake-field"><label for="qualityPreferred">Preferred</label><select id="qualityPreferred" value={qualityProfile.preferredResolution} on:change={(event) => customizeQuality('preferredResolution', Number(event.currentTarget.value))}><option value="0">Any</option><option value="720">720p</option><option value="1080">1080p</option><option value="2160">2160p</option></select></div>
              <div class="intake-field"><label for="qualityMaximum">Maximum</label><select id="qualityMaximum" value={qualityProfile.maximumResolution} on:change={(event) => customizeQuality('maximumResolution', Number(event.currentTarget.value))}><option value="0">No limit</option><option value="720">720p</option><option value="1080">1080p</option><option value="2160">2160p</option></select></div>
              <div class="intake-field"><label for="qualityCodec">Codec</label><select id="qualityCodec" value={qualityProfile.codec} on:change={(event) => customizeQuality('codec', event.currentTarget.value)}><option value="any">Any</option><option value="h264">H.264</option><option value="h265">H.265 / HEVC</option></select></div>
              <div class="intake-field"><label for="qualityHdr">HDR</label><select id="qualityHdr" value={qualityProfile.hdrMode} on:change={(event) => customizeQuality('hdrMode', event.currentTarget.value)}><option value="allow">Allow</option><option value="avoid">Avoid</option><option value="prefer">Prefer</option></select></div>
              <div class="intake-field"><label for="qualityDirectPlay">Codec verification</label><select id="qualityDirectPlay" value={qualityProfile.directPlay ? 'strict' : 'flexible'} on:change={(event) => customizeQuality('directPlay', event.currentTarget.value === 'strict')}><option value="strict">Require verified direct play</option><option value="flexible">Allow unknown formats</option></select></div>
              <div class="intake-field"><label for="qualitySize">Max source GiB</label><input id="qualitySize" type="number" min="0" max="1000" step="1" value={qualityProfile.maxSourceGiB} on:change={(event) => customizeQuality('maxSourceGiB', Number(event.currentTarget.value))} /><span class="field-hint">0 means no limit</span></div>
            </div>
          </details>
        </div>
        <label class="rights-attestation search-attestation" for="searchRightsConfirmed">
          <input id="searchRightsConfirmed" type="checkbox" bind:checked={searchRightsConfirmed} />
          <span>I will use these search results only for content I own or am otherwise authorized to download. I accept responsibility for complying with applicable laws and service terms.</span>
        </label>
        <div class="search-actions">
          <span class="small">Search does not add a torrent or download media.</span>
          {#if searchRunning}
            <button class="secondary-button" type="button" on:click={cancelSearch}>Cancel search</button>
          {:else}
            <button class="primary-button" type="button" disabled={!searchPrompt.trim() || !searchRightsConfirmed} on:click={runSearch}>Build proposal</button>
          {/if}
        </div>

        {#if searchProgress.length}
          <div class="search-progress" aria-live="polite">
            {#each searchProgress.slice(-8) as message, index}
              <div class:done={index < searchProgress.slice(-8).length - 1 || !searchRunning} class="smart-progress-line">{message}</div>
            {/each}
          </div>
        {/if}

        {#if searchProposal}
          <div class="proposal-head">
            <div><div class="step-title">Review search proposal</div><div class="small">{searchProposal.summary}</div></div>
            <div class="proposal-count">{selectedProposals.size} / {searchProposal.selections.length} sources selected</div>
          </div>
          <div class="proposal-list">
            {#each searchProposal.selections as selection}
              <label class="proposal-row">
                <input type="checkbox" checked={selectedProposals.has(selection.selectionId || selection.candidateId)} on:change={(event) => toggleProposal(selection.selectionId || selection.candidateId, event.currentTarget.checked)} />
                <div class="proposal-work"><strong>{selection.work.title}{selection.work.year ? ` (${selection.work.year})` : ''}</strong><span>{selection.work.type} · {selection.scopeLabel || (selection.work.type === 'show' ? 'Complete series' : 'Movie')}</span></div>
                <div class="proposal-release"><strong title={selection.candidate.name}>{selection.candidate.name}</strong><span>{selection.candidate.provider} · {selection.candidate.seeders} seeds · {selection.metadata?.fileCount || 0} files · {fmt(selection.metadata?.totalBytes || selection.candidate.sizeBytes)} · metadata verified{selection.candidate.providerReliability?.attempts ? ` · ${Math.round(selection.candidate.providerReliability.manifestSuccessRate * 100)}% provider manifests (${selection.candidate.providerReliability.attempts})` : ' · new provider'}{selection.alternatives?.length ? ` · ${selection.alternatives.length} fallback${selection.alternatives.length === 1 ? '' : 's'}` : ''}</span><small>{selection.reason}</small></div>
              </label>
            {/each}
          </div>
          {#if searchProposal.alreadyOwned?.length}
            <details class="owned-results" open><summary>{searchProposal.alreadyOwned.length} existing title{searchProposal.alreadyOwned.length === 1 ? '' : 's'} skipped</summary>{#each searchProposal.alreadyOwned as entry}<div><strong>{entry.inventoryItem.title}{entry.inventoryItem.year ? ` (${entry.inventoryItem.year})` : ''}</strong><span>{entry.inventoryItem.source === 'plex' ? 'Already in Plex' : `Already ${entry.inventoryItem.status} in Torplex`}. {entry.reason}</span></div>{/each}</details>
          {/if}
          {#if searchProposal.missing.length}
            <details class="missing-results" open><summary>{searchProposal.missing.length} source{searchProposal.missing.length === 1 ? '' : 's'} still need sourcing</summary>{#each searchProposal.missing as entry}<div class="missing-result-row"><strong>{entry.work.title}{entry.work.year ? ` (${entry.work.year})` : ''} · {entry.scopeLabel || entry.work.type}</strong><span>{entry.reason}</span><button class="secondary-button retry-source-button" type="button" disabled={retryingTargets.has(entry.targetId)} on:click={() => retrySearchTarget(entry.targetId)}>{retryingTargets.has(entry.targetId) ? 'Retrying...' : `Retry ${entry.scopeLabel || 'source'}`}</button></div>{/each}</details>
          {/if}
          <div class="search-actions proposal-actions">
            <span class="small">Confirming creates editable intake sections and starts Smart Setup for each selected result.</span>
            <button class="primary-button" type="button" disabled={!selectedProposals.size} on:click={acceptProposal}>Prepare {selectedProposals.size} selected</button>
          </div>
        {/if}
      </section>
    {:else}
      <section class="bulk-workspace">
        <div class="bulk-workspace-head">
          <div><div class="step-title">Review each source</div><div class="small">Each item inspects and runs Smart Setup independently. Expand an item to change files, Plex placement, checks, or instructions.</div></div>
          <button class="secondary-button" type="button" on:click={() => addItem()}>Add another</button>
        </div>
        <div class="bulk-item-list">
          {#each items as item, index (item.clientId)}
            <IntakeItem clientId={item.clientId} initialSourceUrl={item.sourceUrl} initialInstructions={item.instructions} initialAlternatives={item.alternatives} ordinal={index + 1} onremove={removeItem} onchange={updateItem} />
          {/each}
        </div>
        {#if !items.length}
          <div class="bulk-empty"><strong>No intake items</strong><span>Add a source manually or build an AI search proposal.</span><button class="primary-button" type="button" on:click={() => addItem()}>Add a source</button></div>
        {/if}

        <label class="rights-attestation" for="bulkRightsConfirmed">
          <input id="bulkRightsConfirmed" type="checkbox" bind:checked={queueRightsConfirmed} />
          <span>I confirm that I have the rights or authorization required to download and store every selected item. I accept responsibility for complying with applicable laws and service terms.</span>
        </label>
        {#if queueError}<div class="bulk-item-error">{queueError}</div>{/if}
        <div class="intake-actions bulk-submit-actions">
          <div class="small">{items.length ? (unresolvedItems ? `${unresolvedItems} of ${items.length} still need attention` : `${readyItems.length} ready to queue`) : 'Add at least one source.'}</div>
          <button class="primary-button" type="button" disabled={!items.length || unresolvedItems > 0 || !queueRightsConfirmed || queueRunning} on:click={queueBatch}>{queueRunning ? 'Adding batch...' : `Add ${readyItems.length} selected item${readyItems.length === 1 ? '' : 's'}`}</button>
        </div>
      </section>
    {/if}
  </div>
</section>
