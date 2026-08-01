<script>
  import IntakeItem from './IntakeItem.svelte';

  let items = [];
  let snapshots = new Map();
  let sequence = 0;
  let activeView = 'workspace';
  let searchPrompt = '';
  let searchRightsConfirmed = false;
  let searchRunning = false;
  let searchProgress = [];
  let searchProposal = null;
  let selectedProposals = new Set();
  let queueRightsConfirmed = false;
  let queueRunning = false;
  let dialogStatus = 'Ready';
  let dialogMode = 'idle';
  let queueError = '';

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

  async function readNdjson(response, onProgress) {
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
        else if (event.type === 'result') result = event;
        else if (event.type === 'error') throw new Error(event.error || 'Request failed');
      }
    }
    if (!result) throw new Error('Request ended without a result');
    return result;
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
    try {
      const response = await fetch('/api/torrent/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: searchPrompt.trim(), rightsConfirmed: true }),
      });
      const result = await readNdjson(response, (message) => searchProgress = [...searchProgress, message]);
      searchProposal = result.proposal;
      selectedProposals = new Set((searchProposal.selections || []).map((selection) => selection.candidateId));
      dialogStatus = `${searchProposal.selections.length} proposed`;
      dialogMode = 'ready';
    } catch (caught) {
      queueError = caught instanceof Error ? caught.message : String(caught);
      dialogStatus = queueError;
      dialogMode = 'error';
    } finally {
      searchRunning = false;
    }
  }

  function toggleProposal(candidateId, checked) {
    const next = new Set(selectedProposals);
    if (checked) next.add(candidateId);
    else next.delete(candidateId);
    selectedProposals = next;
  }

  function acceptProposal() {
    const selected = (searchProposal?.selections || []).filter((selection) => selectedProposals.has(selection.candidateId));
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
      addItem({
        sourceUrl: selection.candidate.sourceUrl,
        alternatives: selection.alternatives || [],
        work: selection.work,
        instructions: `Include only ${selection.work.title}${year}, matching the requested ${selection.work.type}. Exclude unrelated titles, samples, and extras.`,
      });
    }
    searchProposal = null;
    selectedProposals = new Set();
    searchProgress = [];
    searchPrompt = '';
    searchRightsConfirmed = false;
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
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Bulk add failed');
      dialogStatus = result.restartMessage || 'Queued';
      dialogMode = 'ready';
      items = [];
      snapshots = new Map();
      queueRightsConfirmed = false;
      addItem();
      document.getElementById('intakeDialog')?.close();
      window.dispatchEvent(new Event('torplex:refresh'));
    } catch (caught) {
      queueError = caught instanceof Error ? caught.message : String(caught);
      dialogStatus = queueError;
      dialogMode = 'error';
    } finally {
      queueRunning = false;
    }
  }

  addItem();
</script>

<dialog id="intakeDialog" class="intake-dialog">
  <div class="dialog-card panel bulk-intake-dialog">
    <div class="dialog-head">
      <div>
        <div class="label">Torrent Intake</div>
        <div class="dialog-title">Add to Torplex</div>
      </div>
      <div class="dialog-actions">
        <div class="status-pill" data-mode={dialogMode}>{dialogStatus}</div>
        <button id="closeIntake" class="secondary-button dialog-close" type="button">Close</button>
      </div>
    </div>

    <div class="intake-tabs" role="tablist" aria-label="Torrent intake mode">
      <button class:active={activeView === 'workspace'} type="button" role="tab" aria-selected={activeView === 'workspace'} on:click={() => activeView = 'workspace'}>Add sources <span>{items.length}</span></button>
      <button class:active={activeView === 'search'} type="button" role="tab" aria-selected={activeView === 'search'} on:click={() => activeView = 'search'}>Find with AI</button>
    </div>

    {#if activeView === 'search'}
      <section class="search-workspace">
        <div class="search-intro">
          <div><div class="step-title">Describe a collection</div><div class="small">Torplex resolves exact titles, searches the configured qBittorrent Nova providers, and proposes one release per title. Nothing is queued until you review the proposal and finish Smart Setup.</div></div>
          <div class="search-provider-note">Admin-installed providers only</div>
        </div>
        <div class="intake-field search-prompt-field">
          <label for="catalogSearchPrompt">What do you want to find?</label>
          <textarea id="catalogSearchPrompt" rows="4" bind:value={searchPrompt} placeholder="Example: All live-action Batman movies starting with the 1989 Michael Keaton film"></textarea>
        </div>
        <label class="rights-attestation search-attestation" for="searchRightsConfirmed">
          <input id="searchRightsConfirmed" type="checkbox" bind:checked={searchRightsConfirmed} />
          <span>I will use these search results only for content I own or am otherwise authorized to download. I accept responsibility for complying with applicable laws and service terms.</span>
        </label>
        <div class="search-actions">
          <span class="small">Search does not add a torrent or download media.</span>
          <button class="primary-button" type="button" disabled={!searchPrompt.trim() || !searchRightsConfirmed || searchRunning} on:click={runSearch}>{searchRunning ? 'Searching...' : 'Build proposal'}</button>
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
            <div class="proposal-count">{selectedProposals.size} selected</div>
          </div>
          <div class="proposal-list">
            {#each searchProposal.selections as selection}
              <label class="proposal-row">
                <input type="checkbox" checked={selectedProposals.has(selection.candidateId)} on:change={(event) => toggleProposal(selection.candidateId, event.currentTarget.checked)} />
                <div class="proposal-work"><strong>{selection.work.title}{selection.work.year ? ` (${selection.work.year})` : ''}</strong><span>{selection.work.type}</span></div>
                <div class="proposal-release"><strong title={selection.candidate.name}>{selection.candidate.name}</strong><span>{selection.candidate.provider} · {selection.candidate.seeders} seeds · {selection.metadata?.fileCount || 0} files · {fmt(selection.metadata?.totalBytes || selection.candidate.sizeBytes)} · metadata verified{selection.alternatives?.length ? ` · ${selection.alternatives.length} fallback${selection.alternatives.length === 1 ? '' : 's'}` : ''}</span><small>{selection.reason}</small></div>
              </label>
            {/each}
          </div>
          {#if searchProposal.missing.length}
            <details class="missing-results"><summary>{searchProposal.missing.length} title{searchProposal.missing.length === 1 ? '' : 's'} need manual sourcing</summary>{#each searchProposal.missing as entry}<div><strong>{entry.work.title}</strong><span>{entry.reason}</span></div>{/each}</details>
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
</dialog>
