<script>
  import { onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { startCrtTerminal } from '$lib/client/crt-terminal.js';

  let { children } = $props();

  onMount(() => startCrtTerminal());
  afterNavigate(() => document.getElementById('crtPicture')?.scrollTo({ top: 0, left: 0 }));
</script>

<svelte:head>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
</svelte:head>

<svg class="crt-filter-defs" aria-hidden="true">
  <defs>
    <filter id="crtBarrelWarp" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
      <feImage id="crtBarrelMap" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="barrelMap" />
      <feDisplacementMap in="SourceGraphic" in2="barrelMap" scale="96" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  </defs>
</svg>

<div id="crtPicture" class="crt-picture">
  {@render children()}
</div>

<div id="crtThemeSwitcher" class="crt-theme-switcher" role="group" aria-label="Terminal phosphor color">
  <button class="crt-theme-dot" type="button" data-theme="red" aria-label="Red phosphor" title="Red phosphor"></button>
  <button class="crt-theme-dot" type="button" data-theme="orange" aria-label="Orange phosphor" title="Orange phosphor"></button>
  <button class="crt-theme-dot" type="button" data-theme="yellow" aria-label="Yellow phosphor" title="Yellow phosphor"></button>
  <button class="crt-theme-dot" type="button" data-theme="green" aria-label="Green phosphor" title="Green phosphor"></button>
  <button class="crt-theme-dot" type="button" data-theme="cyan" aria-label="Cyan phosphor" title="Cyan phosphor"></button>
  <button class="crt-theme-dot" type="button" data-theme="blue" aria-label="Blue phosphor" title="Blue phosphor"></button>
  <button class="crt-theme-dot" type="button" data-theme="magenta" aria-label="Magenta phosphor" title="Magenta phosphor"></button>
</div>

<button id="crtBootTrigger" class="crt-boot-screen" type="button" aria-label="Power on Torplex terminal">
  <span class="crt-boot-mark" aria-hidden="true">TORPLEX // CRT-01</span>
  <span class="crt-boot-prompt">PRESS ANY KEY TO POWER ON<span class="terminal-cursor" aria-hidden="true">_</span></span>
</button>

<div id="crtPowerFx" class="crt-power-fx" aria-hidden="true"><span></span></div>

<div class="crt-artifacts" aria-hidden="true">
  <span class="crt-signal-tear crt-signal-tear-a"></span>
  <span class="crt-signal-tear crt-signal-tear-b"></span>
  <span class="crt-signal-tear crt-signal-tear-c"></span>
  <span class="crt-signal-block crt-signal-block-a"></span>
  <span class="crt-signal-block crt-signal-block-b"></span>
  <span class="crt-glitch-readout crt-glitch-readout-a">SYNC_LOSS // 0x17</span>
  <span class="crt-glitch-readout crt-glitch-readout-b">FRAME_BUF // RECOVER</span>
</div>

<div class="crt-curved-glass" aria-hidden="true">
  <span class="crt-scan-sweep"></span>
</div>

<button id="crtAudioToggle" class="crt-audio-toggle icon-button" type="button" aria-label="Mute terminal audio" title="Mute terminal audio">
  <svg class="audio-on-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path>
  </svg>
  <svg class="audio-off-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="m22 9-6 6"></path><path d="m16 9 6 6"></path>
  </svg>
</button>
