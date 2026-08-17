<script>
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import ThemeSwitcher from '$lib/components/ThemeSwitcher.svelte';
  import { startLcarsAudio } from '$lib/client/lcars-audio.js';
  import { DEFAULT_INTERFACE_THEME, interfaceTheme } from '$lib/client/interface-themes.js';
  import './dashboard.css';

  let { children, data } = $props();
  let themeId = $state(DEFAULT_INTERFACE_THEME);
  const theme = $derived(interfaceTheme(themeId));

  const isAcquisition = () => page.url.pathname.startsWith('/add');
  const isOperations = () => page.url.pathname === '/';

  onMount(() => startLcarsAudio());
</script>

<svelte:head>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <meta name="theme-color" content="#000000" />
</svelte:head>

<a class="skip-link" href="#main-content">Skip to main console</a>

<div class="lcars-shell">
  <aside class="lcars-rail" aria-label="Primary systems">
    <div class="lcars-rail-cap">
      <span class="rail-vessel-number">{theme.rail}</span>
      <small class="rail-vessel-class">{theme.code}</small>
      <span class="intrepid-elbow-label" aria-hidden="true">LCARS 47-ALPHA</span>
    </div>
    <div class="lcars-frame-divider" aria-hidden="true"></div>
    <nav class="lcars-nav">
      <a class:active={isAcquisition()} href="/add" aria-current={isAcquisition() ? 'page' : undefined}>
        <span>01</span>
        <strong>Acquire</strong>
      </a>
      <a class:active={isOperations()} href="/" aria-current={isOperations() ? 'page' : undefined}>
        <span>02</span>
        <strong>Operations</strong>
      </a>
      <a href="/#tactical">
        <span>03</span>
        <strong>Tactical</strong>
      </a>
    </nav>
    <div class="lcars-rail-fill" aria-hidden="true">
      <span></span><span></span><span></span>
    </div>
    <div class="lcars-rail-code" aria-hidden="true">
      {#each theme.railCode.split('\n') as line}{line}<br />{/each}
    </div>
  </aside>

  <div class="lcars-workspace">
    <header class="lcars-header">
      <div class="lcars-header-stripe" aria-hidden="true">
        <span class="stripe-violet"></span>
        <span class="stripe-salmon"></span>
        <span class="stripe-orange"></span>
        <span class="stripe-silver"></span>
        <span class="stripe-terminal"></span>
      </div>
      <div class="intrepid-data-cascade" aria-hidden="true">
        <span>DECRYPTION KEY</span><b>47</b><i>24431762</i>
        <span>SCAN PATTERN</span><b>58</b><i>35542873</i>
        <span>NUMBER SEQUENCE</span><b>69</b><i>46653984</i>
        <span>RESIDUAL PATTERN</span><b>70</b><i>57764095</i>
        <span>SIGNAL DECAY</span><b>81</b><i>68875106</i>
      </div>
      <div class="lcars-identity">
        <div>
          <span class="lcars-kicker">{theme.kicker}</span>
          <strong>TORPLEX</strong>
        </div>
        <div class="lcars-stardate">
          <span>{theme.cycleLabel}</span>
          <strong>{theme.cycle}</strong>
        </div>
        <div class="lcars-header-controls">
          <ThemeSwitcher bind:value={themeId} />
          <button id="lcarsAudioToggle" class="lcars-audio-toggle" type="button" aria-label="Mute LCARS audio" title="Mute LCARS audio">
            <svg class="audio-on" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path></svg>
            <svg class="audio-off" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="m22 9-6 6"></path><path d="m16 9 6 6"></path></svg>
          </button>
        </div>
      </div>
    </header>

    <div class="lcars-workspace-divider" aria-hidden="true"></div>

    <div id="main-content" class="lcars-content">
      {#if data.mockUi}
        <div class="simulation-banner" role="status">
          <strong>SIMULATION 47</strong>
          <span>Isolated interface evaluation / no live torrent, Plex, or Pi systems connected</span>
        </div>
      {/if}
      {@render children()}
    </div>

    <footer class="lcars-footer" aria-hidden="true">
      <span class="footer-code">{theme.footer}</span>
      <span class="footer-violet"></span>
      <span class="footer-salmon"></span>
      <span class="footer-orange"></span>
      <span class="footer-end">{theme.footerEnd}</span>
    </footer>
  </div>
</div>
