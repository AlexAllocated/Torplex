const AUDIO_STORAGE_KEY = 'torplex:lcars-audio-muted';

const AUDIO_PROFILES = {
  galaxy: {
    ambient: '/audio/lcars/bridge-ambient.mp3',
    ambientVolume: .09,
    keys: ['/audio/lcars/key-01.mp3', '/audio/lcars/key-02.mp3'],
    keyVolumes: [.34, .31],
  },
  intrepid: {
    ambient: '/audio/lcars/intrepid-bridge.mp3',
    ambientVolume: .072,
    keys: ['/audio/lcars/intrepid-key.mp3', '/audio/lcars/key-02.mp3'],
    keyVolumes: [.25, .27],
  },
};

function makeVoice(path, volume) {
  const element = new Audio(path);
  element.preload = 'auto';
  element.volume = volume;
  return element;
}

export function startLcarsAudio() {
  const toggle = document.getElementById('lcarsAudioToggle');
  const body = document.body;
  const voices = {
    confirm: [makeVoice('/audio/lcars/confirm.mp3', .3)],
    denied: [makeVoice('/audio/lcars/denied.mp3', .28)],
    search: [makeVoice('/audio/lcars/search.mp3', .2)],
  };
  const profileVoices = new Map();
  const ambientVoices = new Map();
  let activeTheme = '';
  let ambient = null;
  let keys = [];
  let muted = localStorage.getItem(AUDIO_STORAGE_KEY) === '1';
  let unlocked = false;
  let keyIndex = 0;
  let lastPlayedAt = 0;
  let aiActivity = 0;

  const setAudioTheme = (value) => {
    const theme = AUDIO_PROFILES[value] ? value : 'galaxy';
    if (theme === activeTheme) return;
    ambient?.pause();
    activeTheme = theme;
    const profile = AUDIO_PROFILES[theme];
    if (!ambientVoices.has(theme)) {
      const nextAmbient = makeVoice(profile.ambient, profile.ambientVolume);
      nextAmbient.loop = true;
      ambientVoices.set(theme, nextAmbient);
    }
    if (!profileVoices.has(theme)) {
      profileVoices.set(theme, profile.keys.map((path, index) => makeVoice(path, profile.keyVolumes[index])));
    }
    ambient = ambientVoices.get(theme);
    keys = profileVoices.get(theme);
    syncAmbient();
  };

  const syncAmbient = () => {
    if (!ambient) return;
    if (muted || !unlocked || document.hidden) {
      ambient?.pause();
      return;
    }
    void ambient.play().catch(() => {});
  };

  const updateUi = () => {
    body.dataset.lcarsAudio = muted ? 'muted' : unlocked ? 'online' : 'armed';
    if (!toggle) return;
    const label = muted ? 'Enable LCARS audio' : 'Mute LCARS audio';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    toggle.setAttribute('aria-pressed', String(!muted));
  };

  const play = (kind) => {
    if (muted || !unlocked || document.hidden) return;
    const now = performance.now();
    if (now - lastPlayedAt < 38) return;
    lastPlayedAt = now;
    const bank = kind === 'key' ? keys : voices[kind] || keys;
    if (!bank.length) return;
    const index = kind === 'key' ? keyIndex++ : 0;
    const voice = bank[index % bank.length];
    try { voice.currentTime = 0; } catch {}
    void voice.play().catch(() => {});
  };

  const unlock = () => {
    if (unlocked || muted) return;
    unlocked = true;
    updateUi();
    syncAmbient();
  };

  const onPointerDown = () => unlock();
  const onControlClick = (event) => {
    unlock();
    const control = event.target instanceof Element
      ? event.target.closest('button, a, summary, input[type="checkbox"], input[type="radio"], select')
      : null;
    if (!control || control === toggle) return;
    if (control.matches('.danger-button, [data-sound="denied"]')) play('denied');
    else if (control.matches('.primary-button, [type="submit"], [data-sound="confirm"]')) play('confirm');
    else play('key');
  };
  const onAiActivity = (event) => {
    const next = Math.max(0, Number(event.detail?.counts?.ai) || 0);
    if (next > aiActivity) play('search');
    aiActivity = next;
  };
  const onInterfaceTheme = (event) => setAudioTheme(event.detail?.theme);
  const onToggle = () => {
    muted = !muted;
    localStorage.setItem(AUDIO_STORAGE_KEY, muted ? '1' : '0');
    if (!muted) {
      unlocked = true;
      updateUi();
      play('confirm');
      syncAmbient();
      return;
    }
    ambient?.pause();
    for (const voice of ambientVoices.values()) voice.pause();
    Object.values(voices).flat().forEach((voice) => voice.pause());
    for (const bank of profileVoices.values()) bank.forEach((voice) => voice.pause());
    updateUi();
  };
  const onVisibilityChange = () => syncAmbient();

  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  document.addEventListener('click', onControlClick);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('torplex:crt-activity', onAiActivity);
  window.addEventListener('torplex:interface-theme', onInterfaceTheme);
  toggle?.addEventListener('click', onToggle);
  setAudioTheme(document.documentElement.dataset.interfaceTheme);
  updateUi();

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    document.removeEventListener('click', onControlClick);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('torplex:crt-activity', onAiActivity);
    window.removeEventListener('torplex:interface-theme', onInterfaceTheme);
    toggle?.removeEventListener('click', onToggle);
    for (const voice of ambientVoices.values()) voice.pause();
    Object.values(voices).flat().forEach((voice) => voice.pause());
    for (const bank of profileVoices.values()) bank.forEach((voice) => voice.pause());
  };
}
