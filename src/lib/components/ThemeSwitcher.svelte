<script>
  import { onMount } from 'svelte';
  import {
    DEFAULT_INTERFACE_THEME,
    INTERFACE_THEMES,
    INTERFACE_THEME_STORAGE_KEY,
    applyInterfaceTheme,
    interfaceTheme,
    normalizeInterfaceTheme,
  } from '$lib/client/interface-themes.js';

  let { value = $bindable(DEFAULT_INTERFACE_THEME) } = $props();
  let open = $state(false);
  let root;

  const selected = $derived(interfaceTheme(value));

  function choose(id) {
    value = applyInterfaceTheme(id);
    open = false;
  }

  function toggle() {
    open = !open;
  }

  onMount(() => {
    const container = root || document.getElementById('interfaceThemeSwitcher');
    value = applyInterfaceTheme(
      normalizeInterfaceTheme(
        document.documentElement.dataset.interfaceTheme ||
        localStorage.getItem(INTERFACE_THEME_STORAGE_KEY),
      ),
      { persist: false },
    );

    const onPointerDown = (event) => {
      if (open && container && !container.contains(event.target)) open = false;
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') open = false;
    };
    const onClick = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const option = target?.closest('[data-interface-theme-option]');
      if (option) {
        choose(option.dataset.interfaceThemeOption);
        return;
      }
      if (target?.closest('.interface-theme-trigger')) toggle();
    };
    container?.addEventListener('click', onClick);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      container?.removeEventListener('click', onClick);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  });
</script>

<div id="interfaceThemeSwitcher" class="interface-theme-switcher" class:open bind:this={root}>
  <button
    class="interface-theme-trigger"
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={`Change interface theme. Current theme: ${selected.name}`}
    title="Change interface system"
  >
    <span class="theme-trigger-glyph" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="theme-trigger-copy">
      <small>Interface</small>
      <strong>{selected.code}</strong>
    </span>
  </button>

  {#if open}
    <div class="interface-theme-menu" role="menu" aria-label="Interface systems">
      <div class="theme-menu-heading">
        <span>Display matrix</span>
        <strong>02 systems online</strong>
      </div>
      {#each INTERFACE_THEMES as theme, index}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={value === theme.id}
          data-interface-theme-option={theme.id}
          class:active={value === theme.id}
        >
          <span class="theme-sample" data-preview-theme={theme.id} aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
          <span class="theme-option-copy">
            <strong>{theme.name}</strong>
            <small>{theme.civilization}</small>
          </span>
            <span class="theme-option-code">{String(index + 1).padStart(2, '0')} / {theme.code}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
