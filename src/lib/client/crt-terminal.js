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

export function startCrtTerminal() {
  const body = document.body;
  const boot = document.getElementById('crtBootTrigger');
  const audioToggle = document.getElementById('crtAudioToggle');
  const themeButtons = Array.from(document.querySelectorAll('.crt-theme-dot'));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealed = new WeakSet();
  const pendingTargets = new Set();
  let audioContext = null;
  let audioOutput = null;
  let humNodes = null;
  let typingTimer = 0;
  let themeTimer = 0;
  let themeSwapTimer = 0;
  let activeTyping = 0;
  let lastKeyClickAt = 0;
  let audioUnlocked = false;
  let activated = false;
  let destroyed = false;
  let muted = localStorage.getItem('torplex:crt-muted') === '1';
  const warmStart = sessionStorage.getItem('torplex:crt-powered') === '1';
  const storedTheme = normalizeTheme(localStorage.getItem(CRT_THEME_STORAGE_KEY));
  let activeTheme = CRT_THEMES.has(storedTheme) ? storedTheme : 'green';
  let pendingTheme = activeTheme;

  document.documentElement.dataset.crtTheme = activeTheme;
  localStorage.setItem(CRT_THEME_STORAGE_KEY, activeTheme);
  themeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.theme === activeTheme));
  });

  body.classList.add(warmStart ? 'crt-powering-on' : 'crt-awaiting-power');
  body.classList.toggle('crt-audio-muted', muted);

  const setAudioUi = () => {
    const state = muted ? 'muted' : audioContext?.state === 'running' ? 'running' : 'armed';
    body.dataset.audioState = state;
    if (!audioToggle) return;
    const label = state === 'muted'
      ? 'Enable terminal audio'
      : state === 'running'
        ? 'Mute terminal audio'
        : 'Terminal audio armed - interact to enable';
    audioToggle.setAttribute('aria-label', label);
    audioToggle.title = label;
    audioToggle.setAttribute('aria-pressed', String(state === 'running'));
    audioToggle.dataset.audioState = state;
  };
  setAudioUi();

  const ensureAudio = async () => {
    if (muted) return null;
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      audioContext = new AudioContextClass();
      audioOutput = audioContext.createGain();
      audioOutput.gain.value = .9;
      audioOutput.connect(audioContext.destination);
      audioContext.addEventListener('statechange', setAudioUi);
    }
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    if (audioContext.state === 'running') audioUnlocked = true;
    setAudioUi();
    return audioContext.state === 'running' ? audioContext : null;
  };

  const playPowerOn = async () => {
    const context = await ensureAudio();
    if (!context || !audioOutput) return;
    const now = context.currentTime;
    const duration = .66;
    const sampleCount = Math.floor(context.sampleRate * duration);
    const noiseBuffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      const envelope = Math.sin(Math.PI * index / sampleCount) ** 1.8;
      samples[index] = (Math.random() * 2 - 1) * envelope;
    }
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noise.buffer = noiseBuffer;
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(180, now);
    filter.frequency.exponentialRampToValueAtTime(3100, now + .3);
    filter.frequency.exponentialRampToValueAtTime(760, now + duration);
    filter.Q.value = .7;
    noiseGain.gain.setValueAtTime(.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(.07, now + .09);
    noiseGain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    noise.connect(filter).connect(noiseGain).connect(audioOutput);
    noise.start(now);
    noise.stop(now + duration);

    const beam = context.createOscillator();
    const beamGain = context.createGain();
    beam.type = 'sawtooth';
    beam.frequency.setValueAtTime(48, now);
    beam.frequency.exponentialRampToValueAtTime(118, now + .34);
    beam.frequency.exponentialRampToValueAtTime(76, now + duration);
    beamGain.gain.setValueAtTime(.0001, now);
    beamGain.gain.exponentialRampToValueAtTime(.034, now + .12);
    beamGain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    beam.connect(beamGain).connect(audioOutput);
    beam.start(now);
    beam.stop(now + duration);
  };

  const stopHum = () => {
    if (!humNodes || !audioContext) return;
    const { master, oscillators, lfo, gains } = humNodes;
    humNodes = null;
    const now = audioContext.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(.0001, master.gain.value), now);
    master.gain.exponentialRampToValueAtTime(.0001, now + .12);
    window.setTimeout(() => {
      oscillators.forEach((oscillator) => {
        try { oscillator.stop(); } catch {}
        oscillator.disconnect();
      });
      try { lfo.stop(); } catch {}
      lfo.disconnect();
      gains.forEach((gain) => gain.disconnect());
      master.disconnect();
    }, 150);
  };

  const startHum = async () => {
    if (muted || humNodes) return;
    const context = await ensureAudio();
    if (!context || !audioOutput || humNodes) return;
    const master = context.createGain();
    const low = context.createOscillator();
    const high = context.createOscillator();
    const lowGain = context.createGain();
    const highGain = context.createGain();
    const lfo = context.createOscillator();
    const lfoDepth = context.createGain();
    master.gain.value = .006;
    low.type = 'sine';
    low.frequency.value = 72;
    high.type = 'triangle';
    high.frequency.value = 144;
    lowGain.gain.value = .72;
    highGain.gain.value = .18;
    lfo.type = 'sine';
    lfo.frequency.value = .42;
    lfoDepth.gain.value = .001;
    low.connect(lowGain).connect(master);
    high.connect(highGain).connect(master);
    lfo.connect(lfoDepth).connect(master.gain);
    master.connect(audioOutput);
    low.start();
    high.start();
    lfo.start();
    humNodes = { master, oscillators: [low, high], lfo, gains: [lowGain, highGain, lfoDepth] };
  };

  const playKeyClick = async () => {
    if (muted || document.hidden) return;
    const wallClock = performance.now();
    if (wallClock - lastKeyClickAt < 34) return;
    lastKeyClickAt = wallClock;
    const context = await ensureAudio();
    if (!context || !audioOutput) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = Math.random() > .45 ? 'square' : 'triangle';
    oscillator.frequency.value = 760 + Math.random() * 520;
    gain.gain.setValueAtTime(.018 + Math.random() * .008, now);
    gain.gain.exponentialRampToValueAtTime(.0001, now + .022 + Math.random() * .012);
    oscillator.connect(gain).connect(audioOutput);
    oscillator.start(now);
    oscillator.stop(now + .04);
  };

  const applyTheme = (theme, { persist = true, animate = true, sound = true } = {}) => {
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
    if (changed && sound) void playKeyClick();
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
      applyTheme(theme, { persist: false, sound: false });
    }
  };
  window.addEventListener('storage', onThemeStorage);
  const onTerminalKey = () => void playKeyClick();
  window.addEventListener('torplex:terminal-key', onTerminalKey);

  const runTypingMotor = () => {
    if (typingTimer || activeTyping <= 0 || muted) return;
    const tick = () => {
      typingTimer = 0;
      if (activeTyping <= 0 || muted || destroyed) return;
      void playKeyClick();
      typingTimer = window.setTimeout(tick, 42 + Math.random() * 38);
    };
    tick();
  };

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
    void playKeyClick();
  };

  const onAnimationStart = (event) => {
    if (!(event.target instanceof HTMLElement) || event.animationName !== 'terminalTypeIn') return;
    activeTyping += 1;
    runTypingMotor();
  };
  const onAnimationEnd = (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.animationName === 'terminalTextRefresh') {
      event.target.classList.remove('terminal-text-refresh');
      return;
    }
    if (event.animationName !== 'terminalTypeIn') return;
    activeTyping = Math.max(0, activeTyping - 1);
    event.target.classList.remove('terminal-type-in');
    if (!activeTyping && typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = 0;
    }
  };
  document.addEventListener('animationstart', onAnimationStart);
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
    sessionStorage.setItem('torplex:crt-powered', '1');
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
  if (warmStart) {
    activated = true;
    if (boot) boot.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => {
      if (destroyed) return;
      body.classList.remove('crt-powering-on');
      body.classList.add('crt-powered-on');
      queueTargets(document.body);
      if (!muted) void startHum();
    }, reducedMotion ? 0 : 720);
  } else {
    boot?.addEventListener('click', activate);
    window.addEventListener('keydown', onBootKey, { once: true });
  }

  const unlockAudio = async () => {
    if (muted || audioContext?.state === 'running') return;
    const context = await ensureAudio();
    if (context && activated) void startHum();
  };
  const onUiActivate = (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('button, a, [role="button"]')) return;
    void playKeyClick();
  };
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('keydown', unlockAudio, { capture: true });
  document.addEventListener('click', onUiActivate);

  const toggleAudio = async () => {
    muted = !muted;
    localStorage.setItem('torplex:crt-muted', muted ? '1' : '0');
    body.classList.toggle('crt-audio-muted', muted);
    setAudioUi();
    if (muted) {
      stopHum();
      if (audioContext?.state === 'running') await audioContext.suspend().catch(() => {});
      audioUnlocked = false;
      setAudioUi();
    } else {
      await ensureAudio();
      void playKeyClick();
      if (activated) void startHum();
    }
  };
  audioToggle?.addEventListener('click', toggleAudio);

  const onVisibility = () => {
    if (!audioContext || muted) return;
    if (document.hidden) audioContext.suspend().then(setAudioUi).catch(() => {});
    else if (audioUnlocked) audioContext.resume().then(() => {
      setAudioUi();
      return startHum();
    }).catch(() => {});
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
    window.removeEventListener('torplex:terminal-key', onTerminalKey);
    document.removeEventListener('animationstart', onAnimationStart);
    document.removeEventListener('animationend', onAnimationEnd);
    document.removeEventListener('visibilitychange', onVisibility);
    if (typingTimer) clearTimeout(typingTimer);
    if (themeTimer) clearTimeout(themeTimer);
    if (themeSwapTimer) clearTimeout(themeSwapTimer);
    stopHum();
    audioContext?.removeEventListener('statechange', setAudioUi);
    audioContext?.close().catch(() => {});
  };
}
