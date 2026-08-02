const TYPE_SELECTOR = [
  'h1',
  '.subtitle',
  '.label',
  '.small',
  '.value',
  '.ring span',
  '.chip',
  '.title-copy > span',
  '[data-role="progress-label"]',
  '[data-role="rate"]',
  '[data-role="eta"]',
  '.map-progress-title',
  '.map-progress-meta span',
  '.console-output',
  '.register-address',
  '.status-pill',
  '.step-title',
  '.dialog-title',
  'button:not(.icon-button):not(.crt-boot-screen)',
  'a.secondary-button',
].join(',');

const CRT_THEMES = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta']);
const CRT_THEME_STORAGE_KEY = 'torplex:crt-theme';
const normalizeTheme = (theme) => theme === 'purple' ? 'magenta' : theme;

const hasReadableText = (node) => Boolean(node?.textContent?.trim());

function createWavUrl(durationSeconds, sampleAt) {
  const sampleRate = 22050;
  const sampleCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, Number(sampleAt(index / sampleRate, index, sampleCount)) || 0));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function createTerminalMediaBank() {
  const tau = Math.PI * 2;
  const urls = {
    enabled: createWavUrl(.38, (time, index, count) => {
      const progress = index / count;
      const frequency = progress < .48 ? 220 : 330;
      const envelope = Math.sin(Math.PI * progress) ** .45;
      return Math.sin(tau * frequency * time) * envelope * .38;
    }),
    action: createWavUrl(.085, (time, index, count) => {
      const progress = index / count;
      const frequency = 190 + progress * 55;
      return Math.sin(tau * frequency * time) * Math.sin(Math.PI * progress) ** .65 * .3;
    }),
    confirm: createWavUrl(.16, (time, index, count) => {
      const progress = index / count;
      const frequency = progress < .48 ? 240 : 360;
      const localProgress = (progress % .5) * 2;
      return Math.sin(tau * frequency * time) * Math.sin(Math.PI * localProgress) ** .55 * .31;
    }),
    navigate: createWavUrl(.11, (time, index, count) => {
      const progress = index / count;
      const frequency = 330 - progress * 110;
      return Math.sin(tau * frequency * time) * Math.sin(Math.PI * progress) ** .7 * .28;
    }),
    warning: createWavUrl(.18, (time, index, count) => {
      const progress = index / count;
      const pulse = Math.sin(Math.PI * ((progress * 2) % 1)) ** .7;
      return Math.sin(tau * 145 * time) * pulse * .3;
    }),
    power: createWavUrl(.72, (time, index, count) => {
      const progress = index / count;
      const noise = ((Math.sin(index * 78.233) * 43758.5453) % 1) * 2 - 1;
      const sweep = Math.sin(tau * (58 + progress * 520) * time);
      return (noise * .46 + sweep * .54) * Math.sin(Math.PI * progress) ** .8 * .5;
    }),
    hum: createWavUrl(60, (time) => (
      Math.sin(tau * 72 * time) * .72
      + Math.sin(tau * 144 * time) * .14
      + Math.sin(tau * 36 * time) * .08
    ) * .11),
  };
  const audio = (url, volume, loop = false) => {
    const element = new Audio(url);
    element.preload = 'auto';
    element.volume = volume;
    element.loop = loop;
    return element;
  };
  return {
    urls,
    enabled: audio(urls.enabled, .72),
    power: audio(urls.power, .62),
    hum: audio(urls.hum, .32, true),
    controls: Object.fromEntries(['action', 'confirm', 'navigate', 'warning'].map((name) => [
      name,
      Array.from({ length: 4 }, () => audio(urls[name], .5)),
    ])),
  };
}

export function startCrtTerminal() {
  const body = document.body;
  const boot = document.getElementById('crtBootTrigger');
  const audioToggle = document.getElementById('crtAudioToggle');
  const themeButtons = Array.from(document.querySelectorAll('.crt-theme-dot'));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealed = new WeakSet();
  const pendingTargets = new Set();
  const media = createTerminalMediaBank();
  let mediaUnlocked = false;
  let audioError = '';
  const controlVoices = new Map();
  let themeTimer = 0;
  let themeSwapTimer = 0;
  let lastKeyClickAt = 0;
  let activated = false;
  let destroyed = false;
  let muted = localStorage.getItem('torplex:crt-muted') === '1';
  const storedTheme = normalizeTheme(localStorage.getItem(CRT_THEME_STORAGE_KEY));
  let activeTheme = CRT_THEMES.has(storedTheme) ? storedTheme : 'green';
  let pendingTheme = activeTheme;

  document.documentElement.dataset.crtTheme = activeTheme;
  localStorage.setItem(CRT_THEME_STORAGE_KEY, activeTheme);
  themeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.theme === activeTheme));
  });

  body.classList.add('crt-awaiting-power');
  body.classList.toggle('crt-audio-muted', muted);

  const allMedia = () => [media.enabled, media.power, media.hum, ...Object.values(media.controls).flat()];

  const setAudioUi = () => {
    const state = muted ? 'muted' : audioError ? 'error' : mediaUnlocked ? 'running' : 'armed';
    body.dataset.audioState = state;
    body.dataset.audioBackend = 'html-media';
    if (audioError) body.dataset.audioError = audioError;
    else delete body.dataset.audioError;
    if (!audioToggle) return;
    const label = state === 'muted'
      ? 'Enable terminal audio'
      : state === 'running'
        ? 'Mute terminal audio'
        : state === 'error'
          ? `Audio failed: ${audioError}`
          : 'Terminal audio armed - interact to enable';
    audioToggle.setAttribute('aria-label', label);
    audioToggle.title = label;
    audioToggle.setAttribute('aria-pressed', String(state === 'running'));
    audioToggle.dataset.audioState = state;
  };

  const reportAudioError = (error) => {
    audioError = error instanceof Error ? error.message : String(error || 'Playback failed');
    mediaUnlocked = false;
    setAudioUi();
  };

  const playElement = (element, { restart = true } = {}) => {
    if (muted) return Promise.resolve(false);
    if (restart) {
      try { element.currentTime = 0; } catch {}
    }
    return Promise.resolve(element.play()).then(() => true).catch((error) => {
      reportAudioError(error);
      return false;
    });
  };

  const stopHum = () => {
    media.hum.pause();
    try { media.hum.currentTime = 0; } catch {}
  };

  const startHum = () => {
    if (muted || !mediaUnlocked || !media.hum.paused) return;
    void playElement(media.hum, { restart: false });
  };

  const playPowerOn = () => {
    if (!mediaUnlocked) return;
    void playElement(media.power);
  };

  const playControlSound = (target, forcedKind = '') => {
    if (muted || !mediaUnlocked || document.hidden) return;
    const wallClock = performance.now();
    if (wallClock - lastKeyClickAt < 45) return;
    lastKeyClickAt = wallClock;
    const control = target instanceof Element ? target.closest('button, a, summary, [role="button"], input[type="checkbox"]') : null;
    const kind = forcedKind
      || (control?.matches('.danger-button, [data-sound="warning"]') ? 'warning'
        : control?.matches('.primary-button, [data-sound="confirm"]') ? 'confirm'
          : control?.matches('a, summary, [role="tab"], .crt-theme-dot, [data-sound="navigate"]') ? 'navigate'
            : 'action');
    const voices = media.controls[kind] || media.controls.action;
    const index = controlVoices.get(kind) || 0;
    const voice = voices[index % voices.length];
    controlVoices.set(kind, index + 1);
    void playElement(voice);
  };

  const enableAudio = () => {
    if (muted || mediaUnlocked) return;
    audioError = '';
    setAudioUi();
    try { media.enabled.currentTime = 0; } catch {}
    Promise.resolve(media.enabled.play()).then(() => {
      mediaUnlocked = true;
      audioError = '';
      body.dataset.audioProbe = 'played';
      setAudioUi();
      if (activated) startHum();
    }).catch(reportAudioError);
  };
  setAudioUi();

  const applyTheme = (theme, { persist = true, animate = true } = {}) => {
    theme = normalizeTheme(theme);
    if (!CRT_THEMES.has(theme)) return;
    const changed = pendingTheme !== theme || activeTheme !== theme;
    pendingTheme = theme;
    themeButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
    });
    if (persist) localStorage.setItem(CRT_THEME_STORAGE_KEY, theme);
    if (changed && animate && !reducedMotion) {
      if (themeTimer) clearTimeout(themeTimer);
      if (themeSwapTimer) clearTimeout(themeSwapTimer);
      body.classList.remove('crt-theme-switching');
      body.classList.remove('crt-theme-restoring');
      void body.offsetWidth;
      body.classList.add('crt-theme-switching');
      themeSwapTimer = window.setTimeout(() => {
        themeSwapTimer = 0;
        activeTheme = pendingTheme;
        document.documentElement.dataset.crtTheme = activeTheme;
        body.classList.remove('crt-theme-switching');
        body.classList.add('crt-theme-restoring');
        themeTimer = window.setTimeout(() => {
          themeTimer = 0;
          body.classList.remove('crt-theme-restoring');
        }, 230);
      }, 150);
    } else if (changed) {
      if (themeTimer) clearTimeout(themeTimer);
      if (themeSwapTimer) clearTimeout(themeSwapTimer);
      themeTimer = 0;
      themeSwapTimer = 0;
      body.classList.remove('crt-theme-switching');
      body.classList.remove('crt-theme-restoring');
      activeTheme = theme;
      pendingTheme = theme;
      document.documentElement.dataset.crtTheme = theme;
    }
  };

  const onThemeClick = (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLElement)) return;
    applyTheme(button.dataset.theme);
  };
  themeButtons.forEach((button) => button.addEventListener('click', onThemeClick));

  const onThemeStorage = (event) => {
    const theme = normalizeTheme(event.newValue);
    if (event.key === CRT_THEME_STORAGE_KEY && CRT_THEMES.has(theme)) {
      applyTheme(theme, { persist: false });
    }
  };
  window.addEventListener('storage', onThemeStorage);

  const reveal = (node, delay = 0) => {
    if (!(node instanceof HTMLElement) || revealed.has(node) || !hasReadableText(node)) return;
    revealed.add(node);
    if (reducedMotion) return;
    const characters = Math.max(1, Math.min(80, node.textContent.trim().length));
    node.style.setProperty('--terminal-chars', String(characters));
    node.style.setProperty('--terminal-type-delay', `${delay}ms`);
    node.style.setProperty('--terminal-type-duration', `${Math.min(760, 120 + characters * 9)}ms`);
    node.classList.add('terminal-type-in');
  };

  const queueTargets = (root) => {
    if (!(root instanceof Element)) return;
    if (root.matches(TYPE_SELECTOR)) pendingTargets.add(root);
    root.querySelectorAll(TYPE_SELECTOR).forEach((node) => pendingTargets.add(node));
    requestAnimationFrame(() => {
      let index = 0;
      for (const node of pendingTargets) {
        pendingTargets.delete(node);
        reveal(node, Math.min(520, index * 18));
        index += 1;
      }
    });
  };

  const refreshText = (node) => {
    const element = node instanceof HTMLElement ? node : node?.parentElement;
    if (!element || !element.matches(TYPE_SELECTOR) || !hasReadableText(element)) return;
    if (!revealed.has(element)) {
      reveal(element);
      return;
    }
    if (reducedMotion) return;
    element.classList.remove('terminal-text-refresh');
    void element.offsetWidth;
    element.classList.add('terminal-text-refresh');
  };
  const onAnimationEnd = (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.animationName === 'terminalTextRefresh') {
      event.target.classList.remove('terminal-text-refresh');
      return;
    }
    if (event.animationName !== 'terminalTypeIn') return;
    event.target.classList.remove('terminal-type-in');
  };
  document.addEventListener('animationend', onAnimationEnd);

  const observer = new MutationObserver((mutations) => {
    if (!activated) return;
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') refreshText(mutation.target);
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) queueTargets(node);
        else if (node.nodeType === Node.TEXT_NODE) refreshText(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  const activate = async () => {
    if (activated) return;
    activated = true;
    boot?.removeEventListener('click', activate);
    window.removeEventListener('keydown', onBootKey);
    body.classList.remove('crt-awaiting-power');
    body.classList.add('crt-powering-on');
    if (boot) boot.setAttribute('aria-hidden', 'true');
    if (!muted) void playPowerOn();
    window.setTimeout(() => {
      if (destroyed) return;
      body.classList.remove('crt-powering-on');
      body.classList.add('crt-powered-on');
      queueTargets(document.body);
      if (!muted) void startHum();
    }, reducedMotion ? 0 : 720);
  };

  const onBootKey = (event) => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    void activate();
  };
  boot?.addEventListener('click', activate);
  window.addEventListener('keydown', onBootKey);

  const unlockAudio = (event) => {
    if (event?.target instanceof Element && event.target.closest('#crtAudioToggle')) return;
    enableAudio();
  };
  const onUiActivate = (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('button, a, summary, [role="button"], input[type="checkbox"]')) return;
    if (event.target.closest('#crtBootTrigger, #crtAudioToggle')) return;
    void playControlSound(event.target);
  };
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('keydown', unlockAudio, { capture: true });
  document.addEventListener('click', onUiActivate);

  const toggleAudio = () => {
    if (muted || !mediaUnlocked) {
      muted = false;
      mediaUnlocked = false;
      audioError = '';
      localStorage.setItem('torplex:crt-muted', '0');
      body.classList.remove('crt-audio-muted');
      setAudioUi();
      enableAudio();
      return;
    }
    muted = true;
    mediaUnlocked = false;
    localStorage.setItem('torplex:crt-muted', '1');
    body.classList.add('crt-audio-muted');
    allMedia().forEach((element) => element.pause());
    stopHum();
    setAudioUi();
  };
  audioToggle?.addEventListener('click', toggleAudio);

  const onVisibility = () => {
    if (muted || !mediaUnlocked) return;
    if (document.hidden) media.hum.pause();
    else startHum();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    destroyed = true;
    observer.disconnect();
    boot?.removeEventListener('click', activate);
    window.removeEventListener('keydown', onBootKey);
    audioToggle?.removeEventListener('click', toggleAudio);
    document.removeEventListener('pointerdown', unlockAudio, { capture: true });
    document.removeEventListener('keydown', unlockAudio, { capture: true });
    document.removeEventListener('click', onUiActivate);
    themeButtons.forEach((button) => button.removeEventListener('click', onThemeClick));
    window.removeEventListener('storage', onThemeStorage);
    document.removeEventListener('animationend', onAnimationEnd);
    document.removeEventListener('visibilitychange', onVisibility);
    if (themeTimer) clearTimeout(themeTimer);
    if (themeSwapTimer) clearTimeout(themeSwapTimer);
    stopHum();
    allMedia().forEach((element) => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    });
    Object.values(media.urls).forEach((url) => URL.revokeObjectURL(url));
  };
}
