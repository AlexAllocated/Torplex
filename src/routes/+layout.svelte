<script>
  import { onMount } from 'svelte';
  import { startCrtTerminal } from '$lib/client/crt-terminal.js';

  let { children } = $props();

  onMount(() => startCrtTerminal());
</script>

<div id="crtPicture" class="crt-picture">
  {@render children()}
</div>

<button id="crtBootTrigger" class="crt-boot-screen" type="button" aria-label="Power on Torplex terminal">
  <span class="crt-boot-mark" aria-hidden="true">TORPLEX // CRT-01</span>
  <span class="crt-boot-prompt">PRESS ANY KEY TO POWER ON<span class="terminal-cursor" aria-hidden="true">_</span></span>
</button>

<div id="crtPowerFx" class="crt-power-fx" aria-hidden="true"><span></span></div>

<button id="crtAudioToggle" class="crt-audio-toggle icon-button" type="button" aria-label="Mute terminal audio" title="Mute terminal audio">
  <svg class="audio-on-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path>
  </svg>
  <svg class="audio-off-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="m22 9-6 6"></path><path d="m16 9 6 6"></path>
  </svg>
</button>
