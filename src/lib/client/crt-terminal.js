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

const CRT_THEMES = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta', 'gruvbox']);
const CRT_THEME_STORAGE_KEY = 'torplex:crt-theme';
const CRT_WARP_SCALE = 96;
const CRT_WARP_CURVE = .28;
const CRT_GLITCH_STATIC_CHANCE = .125;
const normalizeTheme = (theme) => theme === 'purple' ? 'magenta' : theme;

const hasReadableText = (node) => Boolean(node?.textContent?.trim());

function installCrtBarrelMap() {
  const mapImage = document.getElementById('crtBarrelMap');
  if (!mapImage) return;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return;
  const pixels = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    const ny = y / (size - 1) * 2 - 1;
    for (let x = 0; x < size; x += 1) {
      const nx = x / (size - 1) * 2 - 1;
      const radiusSquared = nx * nx + ny * ny;
      const offset = (y * size + x) * 4;
      pixels.data[offset] = 128 + Math.max(-.49, Math.min(.49, nx * radiusSquared * CRT_WARP_CURVE)) * 255;
      pixels.data[offset + 1] = 128 + Math.max(-.49, Math.min(.49, ny * radiusSquared * CRT_WARP_CURVE)) * 255;
      pixels.data[offset + 2] = 128;
      pixels.data[offset + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  mapImage.setAttribute('href', canvas.toDataURL('image/png'));
  document.body.classList.add('crt-barrel-ready');
}

function installCrtPointerCompensation() {
  const picture = document.getElementById('crtPicture');
  if (!picture) return () => {};
  const interactiveSelector = 'a[href], button, input, select, textarea, label, summary, [role="button"]';
  let hoverPath = [];
  let lastPointer = null;
  const sourcePoint = (clientX, clientY) => {
    const rect = picture.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: clientX, y: clientY };
    const nx = (clientX - rect.left) / rect.width * 2 - 1;
    const ny = (clientY - rect.top) / rect.height * 2 - 1;
    const radiusSquared = nx * nx + ny * ny;
    return {
      x: clientX + CRT_WARP_SCALE * Math.max(-.49, Math.min(.49, nx * radiusSquared * CRT_WARP_CURVE)),
      y: clientY + CRT_WARP_SCALE * Math.max(-.49, Math.min(.49, ny * radiusSquared * CRT_WARP_CURVE)),
    };
  };
  const onClick = (event) => {
    if (!event.isTrusted || event.defaultPrevented || document.body.classList.contains('map-fullscreen-open')) return;
    if (!(event.target instanceof Element) || !picture.contains(event.target)) return;
    const mapped = sourcePoint(event.clientX, event.clientY);
    const mappedElement = document.elementFromPoint(mapped.x, mapped.y);
    const intended = mappedElement?.closest?.(interactiveSelector);
    const received = event.target.closest(interactiveSelector);
    if (!(intended instanceof HTMLElement) || !picture.contains(intended) || intended === received) return;
    if ('disabled' in intended && intended.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (typeof intended.focus === 'function') intended.focus({ preventScroll: true });
    if (intended instanceof HTMLSelectElement && typeof intended.showPicker === 'function') {
      try {
        intended.showPicker();
        return;
      } catch {}
    }
    intended.click();
  };
  const clearHover = () => {
    hoverPath.forEach((element) => element.classList.remove('crt-warp-hover'));
    hoverPath = [];
    document.body.classList.remove('crt-warp-cursor-active');
    document.body.style.removeProperty('--crt-warp-cursor');
  };
  const updateHover = (clientX, clientY) => {
    if (document.body.classList.contains('map-fullscreen-open')) {
      clearHover();
      return;
    }
    const mapped = sourcePoint(clientX, clientY);
    const mappedElement = document.elementFromPoint(mapped.x, mapped.y);
    if (!(mappedElement instanceof Element) || !picture.contains(mappedElement)) {
      clearHover();
      return;
    }
    const nextPath = [];
    for (let element = mappedElement; element && element !== picture; element = element.parentElement) nextPath.push(element);
    hoverPath.forEach((element) => {
      if (!nextPath.includes(element)) element.classList.remove('crt-warp-hover');
    });
    nextPath.forEach((element) => element.classList.add('crt-warp-hover'));
    hoverPath = nextPath;
    document.body.classList.remove('crt-warp-cursor-active');
    document.body.style.removeProperty('--crt-warp-cursor');
    document.body.style.setProperty('--crt-warp-cursor', getComputedStyle(mappedElement).cursor || 'auto');
    document.body.classList.add('crt-warp-cursor-active');
  };
  const onPointerMove = (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    updateHover(event.clientX, event.clientY);
  };
  const onViewportMove = () => {
    if (lastPointer) requestAnimationFrame(() => updateHover(lastPointer.x, lastPointer.y));
  };
  document.addEventListener('click', onClick, { capture: true });
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerleave', clearHover);
  window.addEventListener('blur', clearHover);
  window.addEventListener('resize', onViewportMove, { passive: true });
  window.addEventListener('scroll', onViewportMove, { capture: true, passive: true });
  picture.addEventListener('scroll', onViewportMove, { passive: true });
  document.body.dataset.warpInput = 'compensated';
  return () => {
    clearHover();
    document.removeEventListener('click', onClick, { capture: true });
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    document.removeEventListener('pointerleave', clearHover);
    window.removeEventListener('blur', clearHover);
    window.removeEventListener('resize', onViewportMove);
    window.removeEventListener('scroll', onViewportMove, { capture: true });
    picture.removeEventListener('scroll', onViewportMove);
  };
}

export function bitcrushTerminalSamples(samples, sourceSampleRate, bitDepth = 8, targetSampleRate = 16000) {
  const levels = 2 ** (Math.max(4, Math.min(16, Math.round(bitDepth))) - 1);
  const phaseStep = Math.min(1, Math.max(4000, Math.min(sourceSampleRate, targetSampleRate)) / sourceSampleRate);
  const processed = new Float32Array(samples.length);
  let phase = 1;
  let held = 0;
  for (let index = 0; index < samples.length; index += 1) {
    phase += phaseStep;
    if (phase >= 1) {
      phase -= 1;
      held = Math.round((samples[index] || 0) * levels) / levels;
    }
    processed[index] = held;
  }
  return processed;
}

function createWavUrl(durationSeconds, sampleAt, { bitcrush = true, sampleRate = 22050 } = {}) {
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
  const rawSamples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    rawSamples[index] = Math.max(-1, Math.min(1, Number(sampleAt(index / sampleRate, index, sampleCount)) || 0));
  }
  const samples = bitcrush ? bitcrushTerminalSamples(rawSamples, sampleRate) : rawSamples;
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(44 + index * 2, Math.round((samples[index] || 0) * 32767), true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function createTerminalMediaBank() {
  const tau = Math.PI * 2;
  let transitionNoiseState = 0x51f15e;
  const transitionNoise = () => {
    transitionNoiseState = Math.imul(transitionNoiseState ^ (transitionNoiseState >>> 15), 1 | transitionNoiseState);
    transitionNoiseState ^= transitionNoiseState + Math.imul(transitionNoiseState ^ (transitionNoiseState >>> 7), 61 | transitionNoiseState);
    return (((transitionNoiseState ^ (transitionNoiseState >>> 14)) >>> 0) / 4_294_967_296) * 2 - 1;
  };
  const urls = {
    enabled: createWavUrl(.38, (time, index, count) => {
      const progress = index / count;
      const frequency = progress < .48 ? 220 : 330;
      const envelope = Math.sin(Math.PI * progress) ** .45;
      return Math.sin(tau * frequency * time) * envelope * .38;
    }, { bitcrush: false }),
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
    ambientPing: createWavUrl(.46, (time, index, count) => {
      const progress = index / count;
      const step = Math.min(2, Math.floor(progress * 3));
      const localProgress = (progress * 3) % 1;
      const frequency = [210, 280, 235][step];
      return Math.sin(tau * frequency * time) * Math.sin(Math.PI * localProgress) ** 1.35 * .19;
    }),
    ambientSweep: createWavUrl(.68, (time, index, count) => {
      const progress = index / count;
      const frequency = 115 + progress * 105;
      return Math.sin(tau * frequency * time) * Math.sin(Math.PI * progress) ** 1.6 * .2;
    }),
    ambientBloop: createWavUrl(.38, (time, index, count) => {
      const progress = index / count;
      const frequency = 255 - progress * 120;
      return Math.sin(tau * frequency * time) * Math.sin(Math.PI * progress) ** 1.15 * .2;
    }),
    diskTickLight: createWavUrl(.052, (time, index, count) => {
      const progress = index / count;
      const noise = ((Math.sin(index * 91.733 + 4.17) * 43758.5453) % 1) * 2 - 1;
      const envelope = (1 - Math.exp(-progress * 110)) * Math.exp(-progress * 15);
      const frequency = 34 - progress * 10;
      const mechanism = Math.sin(tau * frequency * time) + Math.sin(tau * frequency * 2 * time) * .2;
      return (mechanism * .88 + noise * .12) * envelope * .22;
    }, { bitcrush: false }),
    diskTickSeek: createWavUrl(.082, (time, index, count) => {
      const progress = index / count;
      const noise = ((Math.sin(index * 73.913 + 8.61) * 24634.6345) % 1) * 2 - 1;
      const first = (1 - Math.exp(-progress * 130)) * Math.exp(-progress * 18);
      const secondProgress = Math.max(0, progress - .42);
      const second = secondProgress > 0
        ? (1 - Math.exp(-secondProgress * 180)) * Math.exp(-secondProgress * 23) * .58
        : 0;
      const frequency = 31 - progress * 9;
      const mechanism = Math.sin(tau * frequency * time) + Math.sin(tau * frequency * 2 * time) * .18;
      return (mechanism * .9 + noise * .1) * (first + second) * .23;
    }, { bitcrush: false }),
    diskTickClack: createWavUrl(.11, (time, index, count) => {
      const progress = index / count;
      const noise = ((Math.sin(index * 61.317 + 2.03) * 31547.2371) % 1) * 2 - 1;
      const impact = (1 - Math.exp(-progress * 150)) * Math.exp(-progress * 20);
      const returnProgress = Math.max(0, progress - .3);
      const returnImpact = returnProgress > 0
        ? (1 - Math.exp(-returnProgress * 140)) * Math.exp(-returnProgress * 17) * .7
        : 0;
      const lowMechanism = Math.sin(tau * 24 * time) + Math.sin(tau * 48 * time) * .22;
      return (lowMechanism * .92 + noise * .08) * (impact + returnImpact) * .22;
    }, { bitcrush: false }),
    power: createWavUrl(.72, (time, index, count) => {
      const progress = index / count;
      const noise = ((Math.sin(index * 78.233) * 43758.5453) % 1) * 2 - 1;
      const sweep = Math.sin(tau * (58 + progress * 520) * time);
      return (noise * .46 + sweep * .54) * Math.sin(Math.PI * progress) ** .8 * .5;
    }, { bitcrush: false }),
    transitionStatic: createWavUrl(.34, (time, index, count) => {
      const progress = index / Math.max(1, count - 1);
      const noise = transitionNoise();
      const electricalGate = Math.sin(tau * (38 + 22 * progress) * time) > .35 ? 1 : .22;
      const envelope = Math.min(1, time / .012) * Math.max(0, 1 - progress) ** .78;
      const crackle = noise * (.045 + electricalGate * .16);
      return Math.tanh(crackle * envelope * 1.35) * .78;
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
    ambient: ['ambientPing', 'ambientSweep', 'ambientBloop'].map((name) => audio(urls[name], .24)),
    transitionStatic: Array.from({ length: 4 }, () => audio(urls.transitionStatic, .014)),
    disk: Array.from({ length: 12 }, (_, index) => {
      const timbres = [urls.diskTickLight, urls.diskTickSeek, urls.diskTickLight, urls.diskTickClack];
      return audio(timbres[index % timbres.length], .05);
    }),
  };
}

export function startCrtTerminal() {
  const body = document.body;
  const boot = document.getElementById('crtBootTrigger');
  const audioToggle = document.getElementById('crtAudioToggle');
  const themeButtons = Array.from(document.querySelectorAll('.crt-theme-dot'));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  installCrtBarrelMap();
  const removePointerCompensation = installCrtPointerCompensation();
  const revealed = new WeakSet();
  const pendingTargets = new Set();
  const media = createTerminalMediaBank();
  let mediaUnlocked = false;
  let audioError = '';
  const controlVoices = new Map();
  let themeTimer = 0;
  let themeSwapTimer = 0;
  let ambientTimer = 0;
  let ambientIndex = 0;
  let diskActivityTimer = 0;
  let diskBurstRemaining = 0;
  let diskBurstSize = 0;
  let diskEventCount = 0;
  let transitionStaticVoice = 0;
  let lastTransitionStaticAt = 0;
  let transferRateBytes = 0;
  let activeTransferCount = 0;
  let activeAiCount = 0;
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

  const allMedia = () => [media.enabled, media.power, media.hum, ...Object.values(media.controls).flat(), ...media.ambient, ...media.transitionStatic, ...media.disk];

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

  const scheduleAmbient = (delay = 7000 + Math.random() * 9000) => {
    if (ambientTimer || destroyed || muted || !mediaUnlocked || document.hidden) return;
    ambientTimer = window.setTimeout(() => {
      ambientTimer = 0;
      if (destroyed || muted || !mediaUnlocked || document.hidden) return;
      const sound = media.ambient[ambientIndex % media.ambient.length];
      ambientIndex += 1;
      void playElement(sound);
      scheduleAmbient();
    }, delay);
  };

  const diskDensity = () => {
    let transferDensity = 0;
    if (transferRateBytes > 0 && activeTransferCount > 0) {
      const maxRate = 100 * 1024 * 1024;
      const throughput = Math.min(1, Math.log1p(transferRateBytes / 128) / Math.log1p(maxRate / 128));
      const concurrency = Math.min(1, activeTransferCount / 8);
      transferDensity = Math.min(1, throughput * .82 + concurrency * .18);
    }
    const aiDensity = activeAiCount > 0
      ? Math.min(1, .78 + Math.log2(activeAiCount + 1) * .09)
      : 0;
    return 1 - (1 - transferDensity) * (1 - aiDensity);
  };

  const randomGeometric = (probability, cap) => {
    let count = 1;
    while (count < cap && Math.random() > probability) count += 1;
    return count;
  };

  const chooseDiskBurstSize = (density) => {
    const isolatedChance = .72 - density * .48;
    if (Math.random() < isolatedChance) return 1;
    const cap = Math.round(4 + density * 46);
    let count = randomGeometric(.7 - density * .48, cap);
    if (density > .45 && Math.random() < density * .13) {
      count += 8 + Math.floor(Math.pow(Math.random(), .72) * density * 48);
    }
    return Math.min(cap, count);
  };

  const diskBurstDelay = (density) => {
    if (Math.random() < .78) {
      return Math.max(48, (82 + Math.pow(Math.random(), 1.55) * (145 - density * 45)) * (1 - density * .32));
    }
    return Math.max(105, (150 + Math.random() * 170) * (1 - density * .28));
  };

  const diskRestDelay = (density) => {
    const scale = 175 + (1 - density) ** 2 * 1200;
    let delay = 140 + -Math.log(Math.max(.015, Math.random())) * scale;
    if (Math.random() < .1) delay *= 1.8 + Math.random() * 1.8;
    return Math.min(4200, delay);
  };

  const resetDiskBurst = () => {
    diskBurstRemaining = 0;
    diskBurstSize = 0;
    body.dataset.diskPattern = 'rest';
    body.dataset.diskBurstRemaining = '0';
  };

  const scheduleDiskActivity = (delayOverride) => {
    if (diskActivityTimer || destroyed || muted || !mediaUnlocked || document.hidden) return;
    const density = diskDensity();
    if (density <= 0) return;
    if (diskBurstRemaining <= 0) {
      diskBurstSize = chooseDiskBurstSize(density);
      diskBurstRemaining = diskBurstSize;
      body.dataset.diskPattern = 'rest';
    }
    const delay = Number.isFinite(delayOverride) ? delayOverride : diskRestDelay(density);
    diskActivityTimer = window.setTimeout(() => {
      diskActivityTimer = 0;
      const currentDensity = diskDensity();
      if (destroyed || muted || !mediaUnlocked || document.hidden || currentDensity <= 0) return;
      const availableVoices = media.disk.filter((candidate) => candidate.paused || candidate.ended);
      const voicePool = availableVoices.length ? availableVoices : media.disk;
      const voice = voicePool[Math.floor(Math.random() * voicePool.length)];
      const burstProgress = diskBurstSize > 1
        ? 1 - diskBurstRemaining / diskBurstSize
        : 0;
      const accent = Math.random() < .11 ? 1.2 : .78 + Math.random() * .3;
      voice.volume = Math.min(.18, (.1 + currentDensity * .07) * accent);
      voice.playbackRate = .88 + Math.random() * .14 + Math.sin(burstProgress * Math.PI) * .018;
      void playElement(voice);
      diskEventCount += 1;
      body.dataset.diskEventCount = String(diskEventCount);
      diskBurstRemaining -= 1;
      body.dataset.diskPattern = diskBurstRemaining > 0 ? 'seek' : 'rest';
      body.dataset.diskBurstRemaining = String(Math.max(0, diskBurstRemaining));
      if (diskBurstRemaining > 0) scheduleDiskActivity(diskBurstDelay(currentDensity));
      else scheduleDiskActivity();
    }, delay);
  };

  const syncDiskActivity = (immediate = false) => {
    const density = diskDensity();
    body.dataset.diskActivity = density > 0 ? 'active' : 'idle';
    body.dataset.diskDensity = density.toFixed(3);
    body.dataset.aiActivity = String(activeAiCount);
    if (density > 0) {
      if (immediate && diskActivityTimer) {
        clearTimeout(diskActivityTimer);
        diskActivityTimer = 0;
        resetDiskBurst();
      }
      scheduleDiskActivity(immediate ? 25 + Math.random() * 45 : undefined);
    }
    else if (diskActivityTimer) {
      clearTimeout(diskActivityTimer);
      diskActivityTimer = 0;
      resetDiskBurst();
    } else {
      resetDiskBurst();
    }
  };
  const onTransferActivity = (event) => {
    transferRateBytes = Math.max(0, Number(event.detail?.bytesPerSecond) || 0);
    activeTransferCount = Math.max(0, Number(event.detail?.activeCount) || 0);
    syncDiskActivity();
  };
  const onCrtActivity = (event) => {
    const previousAiCount = activeAiCount;
    activeAiCount = Math.max(0, Number(event.detail?.counts?.ai) || 0);
    syncDiskActivity(activeAiCount > previousAiCount);
  };
  window.addEventListener('torplex:transfer-activity', onTransferActivity);
  window.addEventListener('torplex:crt-activity', onCrtActivity);

  const playPowerOn = () => {
    if (!mediaUnlocked) return;
    void playElement(media.power);
    playTransitionStatic(true);
  };

  const playTransitionStatic = (force = false) => {
    if (muted || !mediaUnlocked || document.hidden) return;
    const now = performance.now();
    if (!force && now - lastTransitionStaticAt < 260) return;
    lastTransitionStaticAt = now;
    const voice = media.transitionStatic[transitionStaticVoice % media.transitionStatic.length];
    transitionStaticVoice += 1;
    voice.volume = .014;
    voice.playbackRate = .85;
    void playElement(voice);
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
      if (activated) {
        if (body.classList.contains('crt-powering-on')) playPowerOn();
        startHum();
        scheduleAmbient(3500 + Math.random() * 3500);
        scheduleDiskActivity();
      }
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
        playTransitionStatic(true);
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

  const glitchPhases = new Map([
    ['crtSignalJitter', [.62, .85]],
    ['crtTearA', [.35, .77]],
    ['crtTearB', [.48, .92]],
    ['crtTearC', [.71]],
    ['crtBlockA', [.39]],
    ['crtBlockB', [.65]],
  ]);
  const glitchSoundTimers = new Set();
  const onGlitchAnimationCycle = (event) => {
    const phases = glitchPhases.get(event.animationName);
    if (!phases || reducedMotion) return;
    const duration = Number.parseFloat(getComputedStyle(event.target).animationDuration) * 1_000;
    if (!Number.isFinite(duration) || duration <= 0) return;
    phases.forEach((phase) => {
      const timer = window.setTimeout(() => {
        glitchSoundTimers.delete(timer);
        if (activated && body.classList.contains('crt-powered-on') && Math.random() < CRT_GLITCH_STATIC_CHANCE) {
          playTransitionStatic();
        }
      }, duration * phase);
      glitchSoundTimers.add(timer);
    });
  };
  document.addEventListener('animationstart', onGlitchAnimationCycle);
  document.addEventListener('animationiteration', onGlitchAnimationCycle);

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
      if (!muted) {
        void startHum();
        scheduleAmbient(3500 + Math.random() * 3500);
        scheduleDiskActivity();
      }
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
    if (ambientTimer) clearTimeout(ambientTimer);
    ambientTimer = 0;
    if (diskActivityTimer) clearTimeout(diskActivityTimer);
    diskActivityTimer = 0;
    resetDiskBurst();
    stopHum();
    setAudioUi();
  };
  audioToggle?.addEventListener('click', toggleAudio);

  const onVisibility = () => {
    if (muted || !mediaUnlocked) return;
    if (document.hidden) {
      media.hum.pause();
      if (ambientTimer) clearTimeout(ambientTimer);
      ambientTimer = 0;
      if (diskActivityTimer) clearTimeout(diskActivityTimer);
      diskActivityTimer = 0;
      resetDiskBurst();
    } else {
      startHum();
      scheduleAmbient(2500 + Math.random() * 2500);
      scheduleDiskActivity();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    destroyed = true;
    observer.disconnect();
    removePointerCompensation();
    boot?.removeEventListener('click', activate);
    window.removeEventListener('keydown', onBootKey);
    audioToggle?.removeEventListener('click', toggleAudio);
    document.removeEventListener('pointerdown', unlockAudio, { capture: true });
    document.removeEventListener('keydown', unlockAudio, { capture: true });
    document.removeEventListener('click', onUiActivate);
    themeButtons.forEach((button) => button.removeEventListener('click', onThemeClick));
    window.removeEventListener('storage', onThemeStorage);
    document.removeEventListener('animationend', onAnimationEnd);
    document.removeEventListener('animationstart', onGlitchAnimationCycle);
    document.removeEventListener('animationiteration', onGlitchAnimationCycle);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('torplex:transfer-activity', onTransferActivity);
    window.removeEventListener('torplex:crt-activity', onCrtActivity);
    if (themeTimer) clearTimeout(themeTimer);
    if (themeSwapTimer) clearTimeout(themeSwapTimer);
    if (ambientTimer) clearTimeout(ambientTimer);
    if (diskActivityTimer) clearTimeout(diskActivityTimer);
    glitchSoundTimers.forEach((timer) => clearTimeout(timer));
    glitchSoundTimers.clear();
    stopHum();
    allMedia().forEach((element) => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    });
    Object.values(media.urls).forEach((url) => URL.revokeObjectURL(url));
  };
}
