export function startDashboard() {
function fmt(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
const speedChart = {
  samples: [],
  target: 0,
  current: 0,
  max: 10,
  raf: 0,
  lastFrame: 0,
  lastSampleAt: 0,
  windowMs: 45000,
};
const warp = {
  stars: [],
  raf: 0,
  lastFrame: 0,
  scrollingUntil: 0,
  speed: 0,
  batchProgress: 0,
  width: 0,
  height: 0,
  pixelRatio: 1,
};
const swarmMap = {
  peers: [],
  displayPeers: [],
  labelNodes: new Map(),
  raf: 0,
  lastFrame: 0,
  updatedAt: '',
  labelsDirty: true,
  origin: { label: 'SERVER', lat: 39, lon: -98 },
};
const mapView = {
  scale: 1,
  x: 0,
  y: 0,
  dragging: false,
  startX: 0,
  startY: 0,
  baseX: 0,
  baseY: 0,
};
const mapRaster = {
  image: null,
  ready: false,
  raf: 0,
};
let fullscreenBusy = false;
const completedSeen = new Set();
const tweens = new Map();
const elementTweens = new WeakMap();
let renderedOnce = false;
const sessionState = {
  configured: false,
  authenticated: false,
  user: null,
  loginUrl: '/auth/login',
  logoutUrl: '/auth/logout',
};
const colorPalette = [
  '#57e0c2',
  '#8ab4ff',
  '#ffcf5a',
  '#f47086',
  '#c084fc',
  '#22d3ee',
  '#fb923c',
  '#a3e635',
  '#f9a8d4',
  '#facc15',
  '#38bdf8',
  '#f87171',
];
const nodeLimeRgb = '191, 255, 0';
let latestItems = [];
let queueDragId = '';
let queueOrderSaving = false;
const queueReflowAnimations = new WeakMap();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function setRing(id, percent) {
  const value = clamp(percent);
  document.getElementById(id).style.setProperty('--p', value);
}

function easeOut(value) {
  return 1 - Math.pow(1 - value, 3);
}

function tweenNumber(id, target, formatter, duration) {
  const el = document.getElementById(id);
  if (!el) return;
  const previous = tweens.get(id);
  if (previous?.raf) cancelAnimationFrame(previous.raf);
  const start = previous ? previous.value : target;
  const state = { value: start, raf: 0 };
  tweens.set(id, state);
  if (!Number.isFinite(target) || Math.abs(start - target) < 0.01) {
    state.value = target;
    el.textContent = formatter(target);
    return;
  }
  const startedAt = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / duration);
    state.value = start + (target - start) * easeOut(t);
    el.textContent = formatter(state.value);
    if (t < 1) state.raf = requestAnimationFrame(step);
    else {
      state.value = target;
      el.textContent = formatter(target);
    }
  };
  state.raf = requestAnimationFrame(step);
}

function tweenElementNumber(el, target, formatter, duration) {
  if (!el) return;
  const previous = elementTweens.get(el);
  if (previous?.raf) cancelAnimationFrame(previous.raf);
  const start = previous ? previous.value : target;
  const state = { value: start, raf: 0 };
  elementTweens.set(el, state);
  if (!Number.isFinite(target) || Math.abs(start - target) < 0.01) {
    state.value = target;
    el.textContent = formatter(target);
    return;
  }
  const startedAt = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / duration);
    state.value = start + (target - start) * easeOut(t);
    el.textContent = formatter(state.value);
    if (t < 1) state.raf = requestAnimationFrame(step);
    else {
      state.value = target;
      el.textContent = formatter(target);
    }
  };
  state.raf = requestAnimationFrame(step);
}

function setText(el, value) {
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}

function moveQueueRow(container, dragged, insertionPoint) {
  if (dragged.nextElementSibling === insertionPoint || (!insertionPoint && dragged === container.lastElementChild)) return;
  const rows = Array.from(container.querySelectorAll('.item'));
  const before = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
  rows.forEach((row) => {
    const animation = queueReflowAnimations.get(row);
    if (animation) animation.cancel();
  });
  container.insertBefore(dragged, insertionPoint);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  rows.forEach((row) => {
    if (row === dragged || !row.isConnected) return;
    const previous = before.get(row);
    const current = row.getBoundingClientRect();
    const deltaY = previous ? previous.top - current.top : 0;
    if (Math.abs(deltaY) < .5) return;
    const animation = row.animate(
      [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
      { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    queueReflowAnimations.set(row, animation);
    animation.finished.finally(() => {
      if (queueReflowAnimations.get(row) === animation) queueReflowAnimations.delete(row);
    }).catch(() => {});
  });
}

function statusClassFor(status) {
  return String(status || 'pending').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
}

function rowIdFor(id) {
  return 'item-' + String(id).replace(/[^a-z0-9_-]/gi, '-');
}

function progressDetailFor(item) {
  const aiState = {
    researching: 'AI researching',
    applying: 'AI applying fixes',
    passed: 'AI checked',
    fixed: 'AI corrected metadata',
    warning: 'AI review warning',
    skipped: 'AI review skipped',
  }[item.aiMetadataStatus] || '';
  const aiSuffix = aiState ? ' · ' + aiState : '';
  if (item.status === 'completed') return fmt(item.totalBytes) + ' finished' + aiSuffix;
  const verification = item.progress.phase === 'verifying'
    ? ' · checking local data ' + Math.round(item.progress.verificationPercent || 0) + '%'
    : '';
  if (item.progress.downloadedBytes) {
    return fmt(item.progress.downloadedBytes) + ' / ' + fmt(item.progress.totalBytes || item.totalBytes) + verification + aiSuffix;
  }
  return (verification ? verification.slice(3) : 'queued') + aiSuffix;
}

function shortTitle(title) {
  const cleaned = String(title || '').replace(/\\([^)]*\\)/g, '').replace(/[:]/g, ' ').trim();
  return cleaned
    .split(/\\s+/)
    .filter((word) => !['the', 'and', 'of'].includes(word.toLowerCase()))
    .slice(0, 3)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 3) || '...';
}

function flagUrlForCountry(countryCode) {
  const code = String(countryCode || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return '';
  return 'https://flagcdn.com/w40/' + code + '.png';
}

function renderSwarmMap(swarm) {
  const routeStatus = document.getElementById('routeStatus');
  const peers = Array.isArray(swarm?.peers) ? swarm.peers : [];
  const mapped = peers.filter((peer) => Number.isFinite(peer.lat) && Number.isFinite(peer.lon));
  const updatedAt = String(swarm?.updatedAt || '');
  if (swarmMap.updatedAt !== updatedAt) {
    swarmMap.updatedAt = updatedAt;
    swarmMap.peers = peers;
    syncDisplayPeers(peers);
    swarmMap.labelsDirty = true;
  }
  if (Number.isFinite(swarm?.origin?.lat) && Number.isFinite(swarm?.origin?.lon)) {
    swarmMap.origin = {
      label: String(swarm.origin.label || 'SERVER'),
      lat: Number(swarm.origin.lat),
      lon: Number(swarm.origin.lon),
    };
  }
  routeStatus.textContent = peers.length
    ? 'aria2 SD:' + (swarm.aria2Seeders ?? 0) + ' CN:' + (swarm.aria2Connections ?? 0) +
      ' - active ' + (swarm.activeCount ?? 0) +
      ', probing ' + (swarm.probingCount ?? 0) +
      ', inactive ' + (swarm.inactiveCount ?? 0) +
      ' - ' + mapped.length + '/' + peers.length + ' mapped'
    : 'No connected aria2c peers visible yet';
  if (!swarmMap.raf) swarmMap.raf = requestAnimationFrame(drawWorldFrame);
}

function clampMapView() {
  const viewport = document.getElementById('worldMapViewport');
  if (!viewport) return;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  mapView.scale = Math.max(1, Math.min(6, mapView.scale));
  if (mapView.scale === 1) {
    mapView.x = 0;
    mapView.y = 0;
    return;
  }
  mapView.x = Math.min(0, Math.max(width - width * mapView.scale, mapView.x));
  mapView.y = Math.min(0, Math.max(height - height * mapView.scale, mapView.y));
}

function applyMapTransform() {
  clampMapView();
  swarmMap.labelsDirty = true;
  const layer = document.getElementById('worldMapLayer');
  if (layer) layer.style.transform = '';
  scheduleMapRaster();
}

function drawMapRaster() {
  mapRaster.raf = 0;
  const canvas = document.getElementById('worldMapRaster');
  const viewport = document.getElementById('worldMapViewport');
  const image = mapRaster.image;
  if (!canvas || !viewport || !image || !mapRaster.ready) return;
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.floor(width * dpr));
  const pixelHeight = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const sourceWidth = image.naturalWidth / mapView.scale;
  const sourceHeight = image.naturalHeight / mapView.scale;
  const sourceX = Math.max(0, Math.min(image.naturalWidth - sourceWidth, -mapView.x / (width * mapView.scale) * image.naturalWidth));
  const sourceY = Math.max(0, Math.min(image.naturalHeight - sourceHeight, -mapView.y / (height * mapView.scale) * image.naturalHeight));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = 'invert(1) hue-rotate(145deg) saturate(.7) brightness(1.08) contrast(1.08)';
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  ctx.filter = 'none';
}

function scheduleMapRaster() {
  if (!mapRaster.raf) mapRaster.raf = requestAnimationFrame(drawMapRaster);
}

function initMapRaster() {
  const image = new Image();
  image.decoding = 'async';
  image.addEventListener('load', () => {
    mapRaster.ready = true;
    scheduleMapRaster();
  });
  image.src = '/assets/natural-earth-ii-10800.webp';
  mapRaster.image = image;
}

function cameraPoint(point) {
  return {
    x: point.x * mapView.scale + mapView.x,
    y: point.y * mapView.scale + mapView.y,
  };
}

function projectWorldScreen(lat, lon, width, height) {
  return cameraPoint(projectWorld(lat, lon, width, height));
}

function initMapControls() {
  const frame = document.querySelector('.world-map-frame');
  const fullscreenButton = document.getElementById('fullscreenMap');
  if (!frame) return;
  initMapRaster();
  frame.addEventListener('wheel', (event) => {
    event.preventDefault();
    const viewport = document.getElementById('worldMapViewport');
    const rect = (viewport ?? frame).getBoundingClientRect();
    const oldScale = mapView.scale;
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextScale = Math.max(1, Math.min(6, oldScale * (direction > 0 ? 1.18 : 1 / 1.18)));
    const px = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const py = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const mapX = (px - mapView.x) / oldScale;
    const mapY = (py - mapView.y) / oldScale;
    mapView.scale = nextScale;
    mapView.x = px - mapX * nextScale;
    mapView.y = py - mapY * nextScale;
    applyMapTransform();
  }, { passive: false });
  frame.addEventListener('pointerdown', (event) => {
    if (event.target?.closest?.('#fullscreenMap, .map-peer-label')) return;
    if (mapView.scale <= 1) return;
    mapView.dragging = true;
    mapView.startX = event.clientX;
    mapView.startY = event.clientY;
    mapView.baseX = mapView.x;
    mapView.baseY = mapView.y;
    frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', (event) => {
    if (!mapView.dragging) return;
    mapView.x = mapView.baseX + event.clientX - mapView.startX;
    mapView.y = mapView.baseY + event.clientY - mapView.startY;
    applyMapTransform();
  });
  frame.addEventListener('pointerup', (event) => {
    mapView.dragging = false;
    try { frame.releasePointerCapture(event.pointerId); } catch {}
  });
  frame.addEventListener('pointercancel', () => {
    mapView.dragging = false;
  });
  frame.addEventListener('dblclick', () => {
    mapView.scale = 1;
    mapView.x = 0;
    mapView.y = 0;
    applyMapTransform();
  });
  fullscreenButton?.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  fullscreenButton?.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (fullscreenBusy) return;
    fullscreenBusy = true;
    fullscreenButton.disabled = true;
    try {
      if (document.fullscreenElement === frame) {
        await document.exitFullscreen();
      } else {
        await frame.requestFullscreen();
      }
    } catch (error) {
      console.warn('Fullscreen toggle failed', error);
    } finally {
      fullscreenBusy = false;
      fullscreenButton.disabled = false;
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = document.fullscreenElement === frame;
    if (fullscreenButton) {
      fullscreenButton.title = isFullscreen ? 'Exit fullscreen map' : 'Fullscreen map';
      fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
    }
    applyMapTransform();
  });
}

function projectWorld(lat, lon, width, height) {
  return {
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  };
}

function quadPoint(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
}

function pulseForSpeed(now, bytesPerSecond, phase = 0) {
  const speed = Math.max(.45, Math.min(4.6, Math.log2((Number(bytesPerSecond) || 0) / 65536 + 1)));
  return {
    speed,
    value: .5 + Math.sin(now / (900 / speed) + phase) * .5,
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < String(value).length; i += 1) {
    hash ^= String(value).charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length !== 6) return '87, 224, 194';
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ].join(', ');
}

function itemVisual(itemId) {
  const id = String(itemId || 'unknown');
  const activeIds = latestItems
    .filter((item) => item.status === 'active' || item.status === 'organizing')
    .map((item) => String(item.id));
  const activeIndex = activeIds.indexOf(id);
  if (activeIndex >= 0) {
    const color = colorPalette[activeIndex % colorPalette.length];
    return {
      color,
      rgb: hexToRgb(color),
    };
  }
  const hash = hashString(id);
  const color = colorPalette[hash % colorPalette.length];
  return {
    color,
    rgb: hexToRgb(color),
  };
}

function drawPacketDot(ctx, start, control, end, t, rgb, alpha) {
  const head = quadPoint(start, control, end, t);
  const tail = quadPoint(start, control, end, Math.min(1, t + .045));
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(head.x, head.y);
  ctx.strokeStyle = 'rgba(' + rgb + ', ' + (.18 * alpha) + ')';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = 'rgba(' + rgb + ', ' + (.62 * alpha) + ')';
  ctx.lineWidth = 4.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(head.x, head.y, 4.8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(' + rgb + ', ' + alpha + ')';
  ctx.fill();
}

function drawServerNode(ctx, origin, nodeRadius, nodePulse, nodeColor, nodeLabel) {
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, nodeRadius + 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(' + nodeColor + ', ' + (.10 + nodePulse.value * .14) + ')';
  ctx.fill();
  ctx.fillStyle = 'rgb(' + nodeColor + ')';
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, nodeRadius, 0, Math.PI * 2);
  ctx.shadowColor = 'rgba(' + nodeColor + ', .82)';
  ctx.shadowBlur = 18 + nodePulse.value * 16;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(' + nodeLimeRgb + ', .95)';
  ctx.textAlign = 'center';
  ctx.fillText(nodeLabel, origin.x, origin.y - nodeRadius - 7);
  ctx.textAlign = 'start';
}

function streamSpeedFactor(bytesPerSecond) {
  const targetFastBps = 100 * 1024 * 1024;
  const t = Math.max(0, Math.min(1, (Number(bytesPerSecond) || 0) / targetFastBps));
  return .45 + Math.pow(t, .3) * 3.3;
}

function syncDisplayPeers(peers) {
  const now = performance.now();
  const existing = new Map(swarmMap.displayPeers
    .map((item) => [item.peerKey || item.peer?.peerKey || '', item])
    .filter(([key]) => key));
  const next = [];
  const nextKeys = new Set();
  peers.filter((peer) => Number.isFinite(peer.lat) && Number.isFinite(peer.lon)).forEach((peer, index) => {
    peer.peerKey = (peer.itemId || peer.pid || 'unknown') + ':' + peer.ip + ':' + peer.port;
    const key = peer.peerKey;
    nextKeys.add(key);
    const current = existing.get(key) || { alpha: 0, x: 0, y: 0, phase: Math.random() * Math.PI * 2 };
    current.peerKey = key;
    current.peer = peer;
    current.targetLat = Number(peer.lat);
    current.targetLon = Number(peer.lon);
    current.lastSeen = now;
    current.rank = index;
    current.fading = false;
    next.push(current);
  });
  existing.forEach((peer, key) => {
    if (key && !nextKeys.has(key)) {
      peer.fading = true;
      next.push(peer);
    }
  });
  swarmMap.displayPeers = next;
}

function renderMapPeerLabels(width, height) {
  const layer = document.getElementById('mapPeerLabels');
  if (!layer) return;
  const visible = swarmMap.displayPeers
    .filter((item) => item.peer?.active && !item.fading)
    .sort((a, b) =>
      Number(Boolean(b.peer.infrastructure)) - Number(Boolean(a.peer.infrastructure)) ||
      (Number(b.peer.receiveRateBps) || 0) - (Number(a.peer.receiveRateBps) || 0) ||
      (Number(a.rank) || 0) - (Number(b.rank) || 0),
    );
  const seen = new Set();
  const placed = [];
  const overlaps = (rect) => placed.some((other) =>
    rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top,
  );
  visible.forEach((item) => {
    const key = item.peer.peerKey || item.peer.ip + ':' + item.peer.port;
    seen.add(key);
    let node = swarmMap.labelNodes.get(key);
    if (!node) {
      node = document.createElement('div');
      node.className = 'map-peer-label';
      const img = document.createElement('img');
      img.loading = 'eager';
      img.decoding = 'async';
      const text = document.createElement('span');
      text.className = 'map-peer-speed';
      const detail = document.createElement('span');
      detail.className = 'map-peer-detail';
      node.append(img, text, detail);
      layer.appendChild(node);
      swarmMap.labelNodes.set(key, node);
    }
    const rateText = formatPeerRate(item.peer.receiveRateBps);
    const text = item.peer.label ? item.peer.label + ' ' + rateText : rateText;
    const country = item.peer.country || item.peer.countryCode || 'Unknown country';
    const detailText = (item.peer.label ? item.peer.label + ' - ' : '') + country + ' - ' + item.peer.ip + ':' + item.peer.port;
    const flagUrl = flagUrlForCountry(item.peer.countryCode);
    const visual = itemVisual(item.peer.itemId || item.peer.pid || item.peer.ip);
    const img = node.querySelector('img');
    const span = node.querySelector('.map-peer-speed');
    const detail = node.querySelector('.map-peer-detail');
    if (img) {
      img.hidden = !flagUrl;
      if (flagUrl && img.src !== flagUrl) {
        img.src = flagUrl;
        img.alt = item.peer.countryCode || '';
      }
    }
    if (span) {
      span.textContent = text;
      span.style.color = visual.color;
    }
    if (detail) {
      detail.textContent = detailText;
      detail.style.color = visual.color;
    }
    const collapsedWidth = Math.min(150, Math.max(76, 18 + (flagUrl ? 28 : 0) + text.length * 7.2));
    const labelHeight = 24;
    const point = cameraPoint({ x: item.x, y: item.y });
    if (point.x < -24 || point.x > width + 24 || point.y < -24 || point.y > height + 24) {
      node.style.opacity = '0';
      return;
    }
    const candidates = [
      { x: point.x + 6, y: point.y + 6, right: false, bottom: false },
      { x: point.x + 6, y: point.y - labelHeight - 6, right: false, bottom: true },
      { x: point.x - collapsedWidth - 6, y: point.y + 6, right: true, bottom: false },
      { x: point.x - collapsedWidth - 6, y: point.y - labelHeight - 6, right: true, bottom: true },
      { x: point.x + 12, y: point.y - labelHeight / 2, right: false, bottom: false },
      { x: point.x - collapsedWidth - 12, y: point.y - labelHeight / 2, right: true, bottom: false },
    ].map((candidate) => ({
      ...candidate,
      x: Math.min(width - collapsedWidth - 4, Math.max(4, candidate.x)),
      y: Math.min(height - labelHeight - 4, Math.max(4, candidate.y)),
    }));
    const choice = candidates.find((candidate) => !overlaps({
      left: candidate.x - 3,
      right: candidate.x + collapsedWidth + 3,
      top: candidate.y - 3,
      bottom: candidate.y + labelHeight + 3,
    }));
    if (!choice) {
      node.style.opacity = '0';
      return;
    }
    placed.push({
      left: choice.x - 3,
      right: choice.x + collapsedWidth + 3,
      top: choice.y - 3,
      bottom: choice.y + labelHeight + 3,
    });
    node.classList.toggle('edge-right', choice.right);
    node.classList.toggle('edge-bottom', choice.bottom);
    node.style.left = choice.x.toFixed(1) + 'px';
    node.style.top = choice.y.toFixed(1) + 'px';
    node.style.opacity = '.96';
  });
  swarmMap.labelNodes.forEach((node, key) => {
    if (!seen.has(key)) {
      node.remove();
      swarmMap.labelNodes.delete(key);
    }
  });
  swarmMap.labelsDirty = false;
}

function drawWorldFrame(now) {
  swarmMap.raf = requestAnimationFrame(drawWorldFrame);
  const canvas = document.getElementById('worldCanvas');
  if (!canvas) return;
  const frameInterval = 1000 / 30;
  if (swarmMap.lastFrame && now - swarmMap.lastFrame < frameInterval) return;
  const viewport = document.getElementById('worldMapViewport');
  const rect = { width: viewport?.clientWidth || canvas.clientWidth, height: viewport?.clientHeight || canvas.clientHeight };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.floor(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  const dt = swarmMap.lastFrame ? Math.min(80, now - swarmMap.lastFrame) : 16;
  swarmMap.lastFrame = now;
  const width = rect.width;
  const height = rect.height;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const vignette = ctx.createRadialGradient(width / 2, height / 2, height * .1, width / 2, height / 2, width * .62);
  vignette.addColorStop(0, 'rgba(87, 224, 194, .10)');
  vignette.addColorStop(.55, 'rgba(7, 12, 19, 0)');
  vignette.addColorStop(1, 'rgba(7, 12, 19, .40)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(150, 167, 190, .13)';
  ctx.lineWidth = 1;
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = projectWorldScreen(0, lon, width, height).x;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = projectWorldScreen(lat, 0, width, height).y;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const totalIngestBps = swarmMap.displayPeers.reduce(
    (sum, item) => sum + (item.peer?.active ? Number(item.peer.receiveRateBps) || 0 : 0),
    0,
  );
  const originWorld = projectWorld(swarmMap.origin.lat, swarmMap.origin.lon, width, height);
  const origin = cameraPoint(originWorld);
  const nodePulse = pulseForSpeed(now, totalIngestBps);
  const nodeColor = nodeLimeRgb;
  const nodeRadius = 4.5 * (1 + nodePulse.value);

  swarmMap.displayPeers = swarmMap.displayPeers.filter((item) => item.alpha > .02 || !item.fading);
  swarmMap.displayPeers.forEach((item) => {
    const target = projectWorld(item.targetLat, item.targetLon, width, height);
    if (!item.x && !item.y) {
      item.x = target.x;
      item.y = target.y;
    }
    item.x = target.x;
    item.y = target.y;
    item.alpha += ((item.fading ? 0 : 1) - item.alpha) * (1 - Math.exp(-dt / 360));
    const targetAlpha = item.peer.active ? 1 : item.peer.probing ? .72 : .38;
    const alpha = Math.max(0, Math.min(targetAlpha, item.alpha * targetAlpha));
    const peerPulse = pulseForSpeed(now, item.peer.receiveRateBps, item.phase + Math.PI);
    const visual = itemVisual(item.peer.itemId || item.peer.pid || item.peer.ip);
    const activeColor = visual.rgb;

    const start = { x: origin.x, y: origin.y };
    const screen = cameraPoint({ x: item.x, y: item.y });
    const end = { x: screen.x, y: screen.y };
    const midX = (origin.x + screen.x) / 2;
    const midY = (origin.y + screen.y) / 2 - Math.min(80, Math.abs(origin.x - screen.x) * .12);
    const control = { x: midX, y: midY };
    if (item.peer.active) {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
      ctx.strokeStyle = 'rgba(' + activeColor + ', ' + (.17 * alpha) + ')';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(' + activeColor + ', ' + (.88 * alpha) + ')';
      ctx.lineWidth = 2.7;
      ctx.stroke();
    }

    const rateBps = Number(item.peer.receiveRateBps) || 0;
    if (item.peer.active && Math.round(rateBps) > 0) {
      const speedFactor = streamSpeedFactor(rateBps);
      const packetCount = Math.max(2, Math.min(14, Math.round(2 + speedFactor * 3.1)));
      for (let i = 0; i < packetCount; i += 1) {
        const travel = ((now / (2600 / speedFactor)) + i / packetCount + item.phase) % 1;
        const t = 1 - travel;
        const packetAlpha = alpha * (.42 + .58 * Math.sin(travel * Math.PI));
        drawPacketDot(ctx, start, control, end, t, activeColor, packetAlpha);
      }
    }

    ctx.beginPath();
    const activePeerRadius = 2.25 + (1 - peerPulse.value) * 2.25;
    const outerRadius = item.peer.active ? activePeerRadius + 3 : item.peer.probing ? 5 : 4;
    ctx.arc(screen.x, screen.y, outerRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(' + activeColor + ', ' + ((item.peer.active ? .17 : .07) * alpha) + ')';
    ctx.fill();
    ctx.beginPath();
    const innerRadius = item.peer.active ? activePeerRadius : item.peer.probing ? 3.1 : 2.6;
    ctx.arc(screen.x, screen.y, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(' + activeColor + ', ' + ((item.peer.active ? 1 : .68) * alpha) + ')';
    ctx.fill();
    if (item.peer.infrastructure) {
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, outerRadius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + nodeLimeRgb + ', ' + (.9 * alpha) + ')';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  });
  drawServerNode(ctx, origin, nodeRadius, nodePulse, nodeColor, swarmMap.origin.label);
  if (swarmMap.labelsDirty) renderMapPeerLabels(width, height);
}

function renderItems(items) {
  const container = document.getElementById('items');
  latestItems = Array.isArray(items) ? items : [];
  const seen = new Set();
  const priority = { active: 0, organizing: 0, pending: 1, failed: 2, completed: 3 };
  const rowMarkup =
    '<button data-role="drag-handle" class="drag-handle" type="button" aria-label="Drag to reprioritize" title="Drag to reprioritize"><span aria-hidden="true"></span></button>' +
    '<div class="title item-title"><span data-role="torrent-marker" class="torrent-marker"></span><div class="title-copy"><span data-role="title"></span><span class="mono" data-role="size"></span></div></div>' +
    '<div class="item-status"><span data-role="status" class="chip"></span></div>' +
    '<div class="item-progress"><div data-role="progress-label"></div><div class="item-bar"><div data-role="fill" class="item-fill"></div></div><div class="mono" data-role="detail"></div></div>' +
    '<div class="item-stat item-rate"><div class="label">Rate</div><div data-role="rate"></div></div>' +
    '<div class="item-stat item-eta"><div class="label">ETA</div><div data-role="eta"></div></div>' +
    '<div class="item-actions"><button data-role="remove" class="danger-button" type="button">Remove</button></div>';
  const orderedItems = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const priorityDelta = (priority[a.item.status] ?? 1) - (priority[b.item.status] ?? 1);
      if (priorityDelta) return priorityDelta;
      if (a.item.status === 'completed' && b.item.status === 'completed') {
        return (Date.parse(b.item.completedAt || '') || 0) - (Date.parse(a.item.completedAt || '') || 0) || a.index - b.index;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.item);
  orderedItems.forEach((item) => {
    const rowId = rowIdFor(item.id);
    seen.add(rowId);
    let row = document.getElementById(rowId);
    if (!row) {
      row = document.createElement('article');
      row.id = rowId;
      row.innerHTML = rowMarkup;
    } else if (item.status !== 'completed' && !row.querySelector('[data-role="torrent-marker"]')) {
      row.innerHTML = rowMarkup;
    }
    if ((!queueDragId && !queueOrderSaving) || !row.isConnected) container.appendChild(row);

    const progress = item.status === 'completed' ? 100 : clamp(item.progress.percent);
    const statusClass = statusClassFor(item.status);
    row.className = 'item ' + statusClass + (item.status === 'pending' ? ' reorderable' : '') + (queueDragId === item.id ? ' is-dragging' : '');
    row.dataset.itemId = item.id;
    setText(row.querySelector('[data-role="title"]'), item.title);
    setText(row.querySelector('[data-role="size"]'), fmt(item.totalBytes));
    const visual = itemVisual(item.id);
    const marker = row.querySelector('[data-role="torrent-marker"]');
    if (marker) {
      if (item.status === 'completed') {
        marker.remove();
      } else {
        marker.className = 'torrent-marker';
        marker.style.setProperty('--torrent-color', visual.color);
      }
    }

    const chip = row.querySelector('[data-role="status"]');
    chip.className = 'chip ' + statusClass;
    const visibleStatus = item.aiMetadataStatus === 'researching'
      ? 'AI review'
      : item.aiMetadataStatus === 'applying'
        ? 'AI fixing'
        : item.status === 'active' && item.progress.phase === 'verifying'
          ? 'verifying'
          : item.status;
    setText(chip, visibleStatus);

    tweenElementNumber(
      row.querySelector('[data-role="progress-label"]'),
      progress,
      (value) => value ? Math.round(value) + '%' : 'waiting',
      700,
    );
    row.querySelector('[data-role="fill"]').style.width = progress + '%';
    const detail = row.querySelector('[data-role="detail"]');
    setText(detail, progressDetailFor(item));
    if (detail) detail.title = item.aiMetadataSummary || '';
    setText(row.querySelector('[data-role="rate"]'), item.progress.phase === 'verifying' ? '-' : item.progress.rate || '-');
    setText(row.querySelector('[data-role="eta"]'), item.progress.eta || '-');
    const remove = row.querySelector('[data-role="remove"]');
    if (remove) {
      remove.disabled = !sessionState.authenticated;
      remove.textContent = item.status === 'completed' ? 'Clear' : 'Remove';
      remove.onclick = () => removeTorrentItem(item);
    }
    const dragHandle = row.querySelector('[data-role="drag-handle"]');
    if (dragHandle) {
      const canReorder = item.status === 'pending' && sessionState.authenticated && !queueOrderSaving;
      dragHandle.hidden = item.status !== 'pending';
      dragHandle.disabled = !canReorder;
      dragHandle.draggable = canReorder;
      dragHandle.ondragstart = (event) => {
        if (!canReorder || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        queueDragId = item.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
        event.dataTransfer.setDragImage(row, 22, Math.min(40, row.offsetHeight / 2));
        row.classList.add('is-dragging');
        container.classList.add('is-reordering');
      };
      dragHandle.ondragend = () => {
        if (!queueOrderSaving) {
          queueDragId = '';
          container.classList.remove('is-reordering');
          renderItems(latestItems);
        }
      };
    }
  });
  Array.from(container.children).forEach((row) => {
    if (!seen.has(row.id)) row.remove();
  });
  renderQueueControls();
}

function renderQueueControls() {
  const clear = document.getElementById('clearCompleted');
  if (!clear) return;
  const completedCount = latestItems.filter((item) => item.status === 'completed').length;
  clear.disabled = !sessionState.authenticated || completedCount === 0;
  clear.textContent = completedCount ? 'Clear Completed (' + completedCount + ')' : 'Clear Completed';
}

function itemCleanupDescription(item) {
  if (item.status === 'completed') return 'This removes the completed row from Torplex. Plex media stays in place.';
  if (item.status === 'active' || item.status === 'organizing') return 'This stops the active download and deletes its partial data.';
  return 'This removes the queued item and deletes any partial data.';
}

async function removeTorrentItem(item) {
  if (!sessionState.authenticated || !item?.id) return;
  const message = 'Remove "' + item.title + '"?\n\n' + itemCleanupDescription(item);
  if (!window.confirm(message)) return;
  const row = document.getElementById(rowIdFor(item.id));
  const button = row?.querySelector('[data-role="remove"]');
  if (button) button.disabled = true;
  try {
    const res = await fetch('/api/torrents/' + encodeURIComponent(item.id), { method: 'DELETE' });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Remove failed');
    await refreshFallback();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
    if (button) button.disabled = !sessionState.authenticated;
  }
}

async function clearCompletedItems() {
  if (!sessionState.authenticated) return;
  const completedCount = latestItems.filter((item) => item.status === 'completed').length;
  if (!completedCount) return;
  if (!window.confirm('Clear ' + completedCount + ' completed queue row' + (completedCount === 1 ? '' : 's') + '?\n\nPlex media stays in place.')) return;
  const clear = document.getElementById('clearCompleted');
  if (clear) clear.disabled = true;
  try {
    const res = await fetch('/api/torrents/clear-completed', { method: 'POST' });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Clear completed failed');
    await refreshFallback();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
    renderQueueControls();
  }
}

async function persistQueueOrder() {
  if (!queueDragId || queueOrderSaving) return;
  const container = document.getElementById('items');
  const ids = Array.from(container.querySelectorAll('.item.active[data-item-id], .item.organizing[data-item-id], .item.pending[data-item-id]'))
    .map((row) => row.dataset.itemId);
  queueOrderSaving = true;
  queueDragId = '';
  container.classList.remove('is-reordering');
  container.querySelectorAll('.is-dragging').forEach((row) => row.classList.remove('is-dragging'));
  try {
    const res = await fetch('/api/torrents/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Reorder failed');
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  } finally {
    queueOrderSaving = false;
    await refreshFallback();
  }
}

function activeItem(data) {
  return data.items.find((item) => item.status === 'active' || item.status === 'organizing') ?? null;
}

function parseSpeed(rate) {
  const match = String(rate || '').match(/^([0-9.]+)(B|KiB|MiB|GiB|TiB)$/);
  if (!match) return 0;
  const value = Number(match[1]);
  const multipliers = { B: 1 / 1024 / 1024, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1024 * 1024 };
  return value * multipliers[match[2]];
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) return '0 MiB/s';
  if (value >= 1024) return (value / 1024).toFixed(2) + ' GiB/s';
  return value.toFixed(value >= 10 ? 0 : 1) + ' MiB/s';
}

function formatPeerRate(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value >= 1024 * 1024 * 1024) return (value / 1024 / 1024 / 1024).toFixed(2) + ' GiB/s';
  if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1) + ' MiB/s';
  if (value >= 1024) return (value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1) + ' KiB/s';
  return Math.round(value) + ' B/s';
}

function resetWarpStar(star, fresh) {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.pow(Math.random(), .65) * 1.7;
  star.x = Math.cos(angle) * radius;
  star.y = Math.sin(angle) * radius;
  star.z = fresh ? Math.random() * .95 + .08 : .98;
  star.size = Math.random() * 1.35 + .45;
  star.twinkle = Math.random() * Math.PI * 2;
}

function resizeWarp() {
  const canvas = document.getElementById('warpCanvas');
  if (!canvas) return;
  warp.pixelRatio = Math.min(.75, window.devicePixelRatio || 1);
  warp.width = window.innerWidth;
  warp.height = window.innerHeight;
  canvas.width = Math.floor(warp.width * warp.pixelRatio);
  canvas.height = Math.floor(warp.height * warp.pixelRatio);
  warp.lastFrame = 0;
}

function initWarp() {
  resizeWarp();
  if (!warp.stars.length) {
    for (let i = 0; i < 90; i += 1) {
      const star = {};
      resetWarpStar(star, true);
      warp.stars.push(star);
    }
  }
  if (!warp.raf) warp.raf = requestAnimationFrame(drawWarpFrame);
}

function drawWarpFrame(now) {
  warp.raf = requestAnimationFrame(drawWarpFrame);
  const canvas = document.getElementById('warpCanvas');
  if (!canvas || document.hidden || now < warp.scrollingUntil) return;
  const frameInterval = window.scrollY > warp.height * .65 ? 1000 / 12 : 1000 / 20;
  if (warp.lastFrame && now - warp.lastFrame < frameInterval) return;
  const ctx = canvas.getContext('2d');
  const dt = warp.lastFrame ? Math.min(80, now - warp.lastFrame) : 16;
  warp.lastFrame = now;
  const targetSpeed = Math.min(1, speedChart.target / 75);
  warp.speed += (targetSpeed - warp.speed) * (1 - Math.exp(-dt / 520));
  const centerX = warp.width * (.50 + Math.sin(now / 6200) * .015);
  const centerY = warp.height * (.36 + Math.cos(now / 7400) * .018);
  const hue = 168 + warp.batchProgress * .95;
  const pace = (.00009 + warp.speed * .0011) * dt;
  const streak = 1.8 + warp.speed * 20;

  ctx.setTransform(warp.pixelRatio, 0, 0, warp.pixelRatio, 0, 0);
  ctx.clearRect(0, 0, warp.width, warp.height);
  const paths = [new Path2D(), new Path2D(), new Path2D()];

  warp.stars.forEach((star) => {
    const oldZ = star.z;
    star.z -= pace * (.65 + star.size * .28);
    if (star.z <= .035) resetWarpStar(star, false);

    const scale = Math.min(warp.width, warp.height) * .23;
    const x = centerX + star.x / star.z * scale;
    const y = centerY + star.y / star.z * scale;
    const oldX = centerX + star.x / oldZ * scale;
    const oldY = centerY + star.y / oldZ * scale;

    if (x < -80 || x > warp.width + 80 || y < -80 || y > warp.height + 80) {
      resetWarpStar(star, false);
      return;
    }

    const bucket = Math.max(0, Math.min(2, Math.floor((star.size - .45) / .46)));
    paths[bucket].moveTo(oldX, oldY);
    paths[bucket].lineTo(x + (x - oldX) * streak, y + (y - oldY) * streak);
  });
  paths.forEach((path, index) => {
    ctx.lineWidth = (.75 + index * .46) * (.72 + warp.speed * .62);
    ctx.strokeStyle = 'hsla(' + hue + ', 92%, 72%, ' + (.28 + index * .16 + warp.speed * .12) + ')';
    ctx.stroke(path);
  });
}

function updateSpeedChart(value) {
  const now = performance.now();
  speedChart.target = Number.isFinite(value) ? value : 0;
  if (!document.getElementById('speedCanvas')) return;
  if (!speedChart.samples.length || now - speedChart.lastSampleAt >= 450) {
    speedChart.samples.push({ time: now, value: speedChart.target });
    speedChart.lastSampleAt = now;
  } else {
    speedChart.samples[speedChart.samples.length - 1].value = speedChart.target;
  }
  const oldest = now - speedChart.windowMs - 1000;
  while (speedChart.samples.length > 2 && speedChart.samples[0].time < oldest) {
    speedChart.samples.shift();
  }
  if (!speedChart.raf) speedChart.raf = requestAnimationFrame(drawSpeedFrame);
}

function drawSpeedFrame(now) {
  speedChart.raf = requestAnimationFrame(drawSpeedFrame);
  const canvas = document.getElementById('speedCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.floor(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext('2d');
  const dt = speedChart.lastFrame ? Math.min(120, now - speedChart.lastFrame) : 16;
  speedChart.lastFrame = now;
  const alpha = 1 - Math.exp(-dt / 420);
  speedChart.current += (speedChart.target - speedChart.current) * alpha;
  const windowStart = now - speedChart.windowMs;
  while (speedChart.samples.length > 2 && speedChart.samples[0].time < windowStart - 1000) {
    speedChart.samples.shift();
  }

  const points = speedChart.samples
    .filter((point) => point.time >= windowStart)
    .concat({ time: now, value: speedChart.current });
  const targetMax = Math.max(10, ...points.map((point) => point.value)) * 1.18;
  speedChart.max += (targetMax - speedChart.max) * Math.min(1, dt / 900);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const pad = 14;
  const width = rect.width - pad * 2;
  const height = rect.height - pad * 2;
  const max = Math.max(10, speedChart.max);

  ctx.strokeStyle = 'rgba(150, 167, 190, .24)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad + (height / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(rect.width - pad, y);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, pad, 0, rect.height - pad);
  gradient.addColorStop(0, 'rgba(87, 224, 194, .40)');
  gradient.addColorStop(1, 'rgba(87, 224, 194, 0)');

  const toX = (time) => pad + ((time - windowStart) / speedChart.windowMs) * width;
  const toY = (value) => pad + height - (value / max) * height;

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = toX(point.time);
    const y = toY(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(rect.width - pad, rect.height - pad);
  ctx.lineTo(pad, rect.height - pad);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = toX(point.time);
    const y = toY(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#57e0c2';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(87, 224, 194, .55)';
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const head = points.at(-1);
  if (head) {
    ctx.beginPath();
    ctx.arc(toX(head.time), toY(head.value), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#d9fff6';
    ctx.shadowColor = 'rgba(87, 224, 194, .85)';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function celebrate() {
  for (let i = 0; i < 26; i += 1) {
    const particle = document.createElement('span');
    particle.className = 'burst';
    particle.style.left = '50vw';
    particle.style.top = '84px';
    particle.style.background = ['#57e0c2', '#f7c65f', '#f47086', '#78a6ff', '#7ee787'][i % 5];
    particle.style.setProperty('--x', (Math.cos(i / 26 * Math.PI * 2) * (90 + Math.random() * 110)) + 'px');
    particle.style.setProperty('--y', (Math.sin(i / 26 * Math.PI * 2) * (50 + Math.random() * 90)) + 'px');
    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 950);
  }
}

function setIntakeStatus(message) {
  const el = document.getElementById('intakeStatus');
  if (el) el.textContent = message;
}

function setIntakeMode(mode) {
  const el = document.getElementById('intakeStatus');
  if (!el) return;
  el.dataset.mode = mode;
}

function setAuthStatus(message) {
  const el = document.getElementById('authStatus');
  if (el) el.textContent = message;
}

function renderSessionControls() {
  const open = document.getElementById('openIntake');
  const logout = document.getElementById('logoutButton');
  if (!open) return;

  open.disabled = false;
  if (!sessionState.configured) {
    open.textContent = 'Password not configured';
    open.disabled = true;
    setAuthStatus('Upload locked');
  } else if (!sessionState.authenticated) {
    open.textContent = 'Unlock';
    setAuthStatus('Upload locked');
  } else {
    open.textContent = 'Add Torrent';
    setAuthStatus('Unlocked');
  }

  if (logout) logout.hidden = !sessionState.authenticated;
  renderQueueControls();
}

async function refreshSession() {
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    const payload = await res.json();
    Object.assign(sessionState, payload);
  } catch {
    sessionState.configured = false;
    sessionState.authenticated = false;
    sessionState.user = null;
  }
  renderSessionControls();
}

function setIntakeFields(suggested) {
  document.getElementById('torrentTitle').value = suggested.title || '';
  document.getElementById('torrentId').value = suggested.id || '';
  document.getElementById('mediaType').value = suggested.mediaType || 'show';
  document.getElementById('destinationPath').value = suggested.destinationPath || '';
  document.getElementById('organizeStrategy').value = suggested.organizeStrategy || 'mergeRoot';
  document.getElementById('targetSubdir').value = suggested.targetSubdir || '';
}

function renderTorrentSummary(meta) {
  const summary = document.getElementById('torrentSummary');
  if (!summary) return;
  const sourceKind = meta.source?.kind === 'magnet' ? 'Magnet' : meta.source?.kind === 'torrentUrl' ? 'Torrent URL' : meta.source?.kind === 'upload' ? 'Upload' : 'Source';
  const size = meta.totalBytes ? fmt(meta.totalBytes) : 'metadata pending';
  const fileCount = meta.fileCount ? meta.fileCount + ' file' + (meta.fileCount === 1 ? '' : 's') : 'file list pending';
  summary.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'summary-title';
  title.textContent = meta.payloadName || 'Ready to queue';
  const details = document.createElement('div');
  details.className = 'summary-details';
  details.textContent = sourceKind + ' - ' + size + ' - ' + fileCount;
  summary.append(title, details);
}

const mediaAndCaptionPattern = /\.(?:mkv|mp4|m4v|avi|mov|webm|ts|m2ts|srt|ass|ssa|vtt|sub|idx|sup)$/i;
const riskyTorrentFilePattern = /\.(?:exe|dll|com|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|reg|lnk|desktop|appimage|apk|jar|dmg|pkg|deb|rpm|sh|bash|zsh|fish|py|pl|rb)$/i;

function torrentTree(files) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.path || '').split('/').filter(Boolean);
    const name = parts.pop() || `File ${file.index}`;
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ ...file, name });
  }
  return root;
}

function collectTreeFiles(node) {
  const files = [...node.files];
  for (const child of node.folders.values()) files.push(...collectTreeFiles(child));
  return files;
}

function renderTorrentFileTree(files, selectedFiles, filter = '') {
  const container = document.getElementById('torrentFileTree');
  const visibleCount = document.getElementById('visibleFileCount');
  if (!container) return;
  const query = filter.trim().toLowerCase();
  const visibleFiles = query ? files.filter((file) => String(file.path).toLowerCase().includes(query)) : files;
  if (visibleCount) visibleCount.textContent = query ? `${visibleFiles.length} of ${files.length} shown` : `${files.length} files`;
  container.replaceChildren();
  if (!visibleFiles.length) {
    const empty = document.createElement('div');
    empty.className = 'file-tree-empty';
    empty.textContent = files.length ? 'No torrent files match that filter.' : 'The file list will be available after magnet metadata is retrieved.';
    container.append(empty);
    return;
  }

  const makeCheckbox = (indexes, label) => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.fileIndexes = indexes.join(',');
    checkbox.setAttribute('aria-label', label);
    const selectedCount = indexes.filter((index) => selectedFiles.has(index)).length;
    checkbox.checked = selectedCount === indexes.length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < indexes.length;
    return checkbox;
  };

  const renderNode = (node, depth) => {
    const fragment = document.createDocumentFragment();
    for (const [name, child] of [...node.folders.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))) {
      const childFiles = collectTreeFiles(child);
      const details = document.createElement('details');
      details.className = 'file-folder';
      details.open = depth === 0 || Boolean(query);
      const summary = document.createElement('summary');
      const checkbox = makeCheckbox(childFiles.map((file) => file.index), `Select folder ${name}`);
      checkbox.dataset.role = 'folder-selection';
      const folderName = document.createElement('span');
      folderName.className = 'file-folder-name';
      folderName.textContent = name;
      folderName.title = name;
      const meta = document.createElement('span');
      meta.className = 'file-folder-meta';
      meta.textContent = `${childFiles.length} files - ${fmt(childFiles.reduce((sum, file) => sum + file.length, 0))}`;
      summary.append(checkbox, folderName, meta);
      const children = document.createElement('div');
      children.className = 'file-children';
      children.append(renderNode(child, depth + 1));
      details.append(summary, children);
      fragment.append(details);
    }
    for (const file of [...node.files].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))) {
      const row = document.createElement('label');
      row.className = 'torrent-file-row';
      if (riskyTorrentFilePattern.test(file.path)) {
        row.classList.add('risky-file');
        row.title = 'Executable or script file. Torplex will not queue this payload.';
      }
      const checkbox = makeCheckbox([file.index], `Select ${file.name}`);
      checkbox.dataset.role = 'file-selection';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name;
      name.title = file.path;
      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = fmt(file.length);
      row.append(checkbox, name, size);
      fragment.append(row);
    }
    return fragment;
  };

  container.append(renderNode(torrentTree(visibleFiles), 0));
}

function initIntakeNavigation() {
  const open = document.getElementById('openIntake');
  open?.addEventListener('click', () => {
    if (!sessionState.configured) return;
    if (!sessionState.authenticated) {
      window.location.href = sessionState.loginUrl || '/auth/login';
      return;
    }
    window.location.href = '/add';
  });
}

function initIntakeControls() {
  const form = document.getElementById('intakeForm');
  const input = document.getElementById('torrentFile');
  const sourceInput = document.getElementById('sourceUrl');
  const inspect = document.getElementById('inspectTorrent');
  const submit = document.getElementById('addTorrent');
  const contentSelection = document.getElementById('contentSelection');
  const plexSetup = document.getElementById('plexSetup');
  const selectedInput = document.getElementById('selectedFiles');
  const selectionSummary = document.getElementById('selectionSummary');
  const queueReadiness = document.getElementById('queueReadiness');
  const rightsConfirmed = document.getElementById('rightsConfirmed');
  const fileFilter = document.getElementById('fileFilter');
  const fileTree = document.getElementById('torrentFileTree');
  const smartSetupPanel = document.getElementById('smartSetupPanel');
  const smartSetupButton = document.getElementById('runSmartSetup');
  const smartSetupStatus = document.getElementById('smartSetupStatus');
  const smartProgress = document.getElementById('smartProgress');
  const smartPlanReview = document.getElementById('smartPlanReview');
  const additionalInstructions = document.getElementById('additionalInstructions');
  const organizeStrategy = document.getElementById('organizeStrategy');
  const routeEditor = document.getElementById('routeEditor');
  const routeRows = document.getElementById('routeRows');
  const organizationRoutes = document.getElementById('organizationRoutes');
  const postDownloadSetup = document.getElementById('postDownloadSetup');
  if (!form || !input || !sourceInput || !inspect || !submit || !selectedInput || !rightsConfirmed) return;
  let inspectTimer = 0;
  let inspectProgressTimer = 0;
  let inspectNonce = 0;
  let inspectedTorrent = null;
  let selectedFiles = new Set();
  let inspectedSourceKey = '';
  let smartSetupAvailable = false;
  let smartSetupModel = '';
  let smartSetupRunning = false;
  let smartSetupAutoSourceKey = '';
  let smartSetupAbortController = null;
  const appendSmartProgress = (message) => {
    if (!smartProgress) return;
    const active = smartProgress.querySelector('.smart-progress-line:not(.done)');
    active?.classList.add('done');
    const line = document.createElement('div');
    line.className = 'smart-progress-line';
    line.textContent = message;
    smartProgress.append(line);
    smartProgress.hidden = false;
    smartProgress.scrollTop = smartProgress.scrollHeight;
  };
  const currentRoutes = () => Array.from(routeRows?.querySelectorAll('.route-row') || []).map((row) => ({
    sourcePath: row.querySelector('[data-route-source]')?.value.trim() || '',
    destinationPath: row.querySelector('[data-route-destination]')?.value.trim() || '',
  }));
  const syncRoutes = () => {
    if (organizationRoutes) organizationRoutes.value = JSON.stringify(currentRoutes().filter((route) => route.sourcePath || route.destinationPath));
  };
  const renderRoutes = (routes = []) => {
    if (!routeRows) return;
    routeRows.replaceChildren();
    for (const route of routes) {
      const row = document.createElement('div');
      row.className = 'route-row';
      const sourceField = document.createElement('div');
      sourceField.className = 'intake-field';
      const sourceLabel = document.createElement('label');
      sourceLabel.textContent = 'Torrent source folder';
      const source = document.createElement('input');
      source.dataset.routeSource = 'true';
      source.value = route.sourcePath || '';
      source.placeholder = 'Folder path inside torrent';
      sourceField.append(sourceLabel, source);
      const destinationField = document.createElement('div');
      destinationField.className = 'intake-field';
      const destinationLabel = document.createElement('label');
      destinationLabel.textContent = 'Plex destination';
      const destination = document.createElement('input');
      destination.dataset.routeDestination = 'true';
      destination.value = route.destinationPath || '';
      destination.placeholder = '/media/plex/TV Shows/Title (Year)/Season 01';
      destinationField.append(destinationLabel, destination);
      const remove = document.createElement('button');
      remove.className = 'danger-button route-remove';
      remove.type = 'button';
      remove.textContent = 'x';
      remove.title = 'Remove route';
      remove.setAttribute('aria-label', 'Remove route');
      remove.addEventListener('click', () => {
        row.remove();
        syncRoutes();
      });
      row.append(sourceField, destinationField, remove);
      routeRows.append(row);
    }
    syncRoutes();
  };
  const updateRouteEditor = () => {
    const routed = organizeStrategy?.value === 'routeDirectories';
    if (routeEditor) routeEditor.hidden = !routed;
    if (routed && !currentRoutes().length) renderRoutes([{ sourcePath: '', destinationPath: '' }]);
    syncRoutes();
  };
  const renderSmartPlan = (plan) => {
    if (!smartPlanReview) return;
    smartPlanReview.replaceChildren();
    const summary = document.createElement('div');
    const confidence = document.createElement('strong');
    confidence.textContent = `${String(plan.confidence || 'unknown').toUpperCase()} confidence: `;
    summary.append(confidence, document.createTextNode(plan.summary || 'Plan applied.'));
    smartPlanReview.append(summary);
    for (const decision of plan.decisions || []) {
      const line = document.createElement('div');
      line.textContent = `- ${decision}`;
      smartPlanReview.append(line);
    }
    for (const warning of plan.warnings || []) {
      const line = document.createElement('div');
      line.className = 'smart-plan-warning';
      line.textContent = `Warning: ${warning}`;
      smartPlanReview.append(line);
    }
    smartPlanReview.hidden = false;
  };
  const hasSource = () => Boolean(input.files?.[0] || sourceInput.value.trim());
  const hasSelectableFiles = () => Boolean(inspectedTorrent?.files?.length);
  const updateSelection = () => {
    const files = inspectedTorrent?.files || [];
    const selected = files.filter((file) => selectedFiles.has(file.index));
    const selectedBytes = selected.reduce((sum, file) => sum + file.length, 0);
    selectedInput.value = hasSelectableFiles() ? JSON.stringify(selected.map((file) => file.index)) : '';
    if (selectionSummary) {
      selectionSummary.textContent = hasSelectableFiles()
        ? `${selected.length} of ${files.length} files selected - ${fmt(selectedBytes)}`
        : 'File selection becomes available after magnet metadata is retrieved.';
    }
    for (const checkbox of fileTree?.querySelectorAll('input[data-file-indexes]') || []) {
      const indexes = checkbox.dataset.fileIndexes.split(',').map(Number).filter(Boolean);
      const count = indexes.filter((index) => selectedFiles.has(index)).length;
      checkbox.checked = count === indexes.length;
      checkbox.indeterminate = count > 0 && count < indexes.length;
    }
  };
  const updateSubmitAvailability = () => {
    const hasSelection = Boolean(inspectedTorrent) && (!hasSelectableFiles() || selectedFiles.size > 0);
    const blockedSelectionCount = (inspectedTorrent?.files || []).filter(
      (file) => selectedFiles.has(file.index) && riskyTorrentFilePattern.test(file.path),
    ).length;
    const selectionReady = hasSelection && blockedSelectionCount === 0;
    const rightsReady = rightsConfirmed.checked;
    submit.disabled = smartSetupRunning || !sessionState.authenticated || !selectionReady || !rightsReady;
    if (smartSetupButton) {
      smartSetupButton.disabled = smartSetupRunning || !smartSetupAvailable || !inspectedTorrent;
    }
    if (queueReadiness) {
      queueReadiness.textContent = !inspectedTorrent
        ? 'Inspect a source to continue.'
        : !hasSelection
          ? 'Select at least one file.'
          : blockedSelectionCount > 0
            ? `Remove ${blockedSelectionCount} blocked executable or script file${blockedSelectionCount === 1 ? '' : 's'} from the selection.`
          : !rightsReady
            ? 'Confirm the rights statement to add this torrent.'
            : 'Ready to add the selected content.';
    }
  };
  const resetInspection = () => {
    window.clearInterval(inspectProgressTimer);
    inspectProgressTimer = 0;
    smartSetupAbortController?.abort();
    smartSetupAbortController = null;
    smartSetupRunning = false;
    inspectedTorrent = null;
    inspectedSourceKey = '';
    selectedFiles = new Set();
    selectedInput.value = '';
    if (contentSelection) contentSelection.hidden = true;
    if (plexSetup) plexSetup.hidden = true;
    if (postDownloadSetup) postDownloadSetup.hidden = true;
    if (smartSetupPanel) smartSetupPanel.hidden = true;
    if (smartPlanReview) {
      smartPlanReview.hidden = true;
      smartPlanReview.replaceChildren();
    }
    if (smartProgress) {
      smartProgress.hidden = true;
      smartProgress.replaceChildren();
    }
    smartSetupAvailable = false;
    smartSetupModel = '';
    if (!hasSource()) smartSetupAutoSourceKey = '';
    if (smartSetupButton) smartSetupButton.textContent = 'Run Smart Setup';
    renderRoutes([]);
    if (organizationRoutes) organizationRoutes.value = '';
    if (fileTree) fileTree.replaceChildren();
    if (fileFilter) fileFilter.value = '';
    updateSubmitAvailability();
  };
  const updateInspectAvailability = () => {
    inspect.disabled = !sessionState.authenticated || !hasSource();
  };
  if (!sessionState.authenticated) {
    setIntakeStatus('Unlock first');
    setIntakeMode('locked');
    submit.disabled = true;
    inspect.disabled = true;
  }
  const runSmartSetup = async () => {
    const file = input.files?.[0];
    const sourceUrl = sourceInput.value.trim();
    if (
      (!file && !sourceUrl)
      || !inspectedTorrent
      || !smartSetupAvailable
      || smartSetupRunning
    ) return;
    const planNonce = inspectNonce;
    const controller = new AbortController();
    smartSetupAbortController = controller;
    smartSetupRunning = true;
    if (smartSetupButton) smartSetupButton.textContent = 'Planning...';
    updateSubmitAvailability();
    if (smartSetupStatus) smartSetupStatus.textContent = `${smartSetupModel} is building a plan...`;
    setIntakeStatus('Planning');
    setIntakeMode('busy');
    if (smartProgress) {
      smartProgress.replaceChildren();
      smartProgress.hidden = false;
    }
    appendSmartProgress('Starting Smart Setup');
    try {
      const data = new FormData();
      if (sourceUrl) data.set('sourceUrl', sourceUrl);
      else data.set('torrent', file);
      data.set('additionalInstructions', additionalInstructions?.value.trim() || '');
      const res = await fetch('/api/torrent/plan', { method: 'POST', body: data, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error('Smart Setup could not start');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let payload = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'progress') {
            appendSmartProgress(event.message);
            if (smartSetupStatus) smartSetupStatus.textContent = event.message;
          } else if (event.type === 'result') {
            payload = event;
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Smart Setup failed');
          }
        }
      }
      if (planNonce !== inspectNonce) return;
      if (!payload) throw new Error('Smart Setup ended without a plan');
      const plan = payload.plan;
      selectedFiles = new Set(plan.selectedFiles || []);
      setIntakeFields(plan);
      if (organizeStrategy) organizeStrategy.value = plan.organizeStrategy || 'mergeRoot';
      renderRoutes(plan.routes || []);
      updateRouteEditor();
      for (const [id, key] of [
        ['verifyStreams', 'verifyStreams'],
        ['ensureEnglishSubtitles', 'ensureEnglishSubtitles'],
        ['verifyCanonicalMetadata', 'verifyCanonicalMetadata'],
        ['verifyArtwork', 'verifyArtwork'],
        ['validateMetadataWithAi', 'validateMetadataWithAi'],
        ['refreshPlex', 'refreshPlex'],
      ]) {
        const control = document.getElementById(id);
        if (control instanceof HTMLInputElement) control.checked = Boolean(plan.postDownloadChecks?.[key]);
      }
      renderTorrentFileTree(inspectedTorrent.files || [], selectedFiles, fileFilter?.value || '');
      updateSelection();
      renderSmartPlan(plan);
      const activeProgress = smartProgress?.querySelector('.smart-progress-line:not(.done)');
      activeProgress?.classList.add('done');
      if (smartSetupStatus) smartSetupStatus.textContent = `${payload.model} plan applied`;
      if (smartSetupButton) smartSetupButton.textContent = 'Run Smart Setup again';
      setIntakeStatus('Plan ready');
      setIntakeMode('ready');
    } catch (error) {
      if (controller.signal.aborted || planNonce !== inspectNonce) return;
      if (smartSetupStatus) smartSetupStatus.textContent = error instanceof Error ? error.message : String(error);
      if (smartSetupButton) smartSetupButton.textContent = 'Retry Smart Setup';
      setIntakeStatus('Planning failed');
      setIntakeMode('error');
    } finally {
      if (smartSetupAbortController === controller) smartSetupAbortController = null;
      if (planNonce === inspectNonce) {
        smartSetupRunning = false;
        updateSubmitAvailability();
      }
    }
  };
  const currentSourceKey = () => {
    const file = input.files?.[0];
    if (file) return `file:${file.name}:${file.size}:${file.lastModified}`;
    return sourceInput.value.trim() ? `url:${sourceInput.value.trim()}` : '';
  };
  const maybeRunSmartSetup = () => {
    const sourceKey = currentSourceKey();
    if (
      !sourceKey
      || smartSetupAutoSourceKey === sourceKey
      || smartSetupRunning
      || !smartSetupAvailable
      || !inspectedTorrent
    ) return;
    smartSetupAutoSourceKey = sourceKey;
    runSmartSetup().catch(() => {});
  };
  const inspectCurrentTorrent = async () => {
    window.clearTimeout(inspectTimer);
    const sourceKey = currentSourceKey();
    if (sourceKey && sourceKey === inspectedSourceKey && inspectedTorrent) return;
    const nonce = ++inspectNonce;
    const file = input.files?.[0];
    const sourceUrl = sourceInput.value.trim();
    resetInspection();
    updateInspectAvailability();
    if (!file && !sourceUrl) {
      document.getElementById('torrentSummary').textContent = 'Waiting for a source.';
      setIntakeStatus('Ready');
      setIntakeMode('idle');
      return;
    }
    if (!sessionState.authenticated) {
      setIntakeStatus('Unlock first');
      setIntakeMode('locked');
      return;
    }
    setIntakeStatus('Inspecting');
    setIntakeMode('busy');
    inspect.disabled = true;
    const summary = document.getElementById('torrentSummary');
    const retrievingMagnet = sourceUrl.toLowerCase().startsWith('magnet:');
    const inspectStartedAt = Date.now();
    if (summary) {
      summary.textContent = retrievingMagnet
        ? 'Retrieving the torrent file list from trackers and peers...'
        : 'Reading torrent metadata...';
    }
    if (retrievingMagnet) {
      setIntakeStatus('Fetching metadata - 0s');
      inspectProgressTimer = window.setInterval(() => {
        if (nonce !== inspectNonce) return;
        const elapsed = Math.floor((Date.now() - inspectStartedAt) / 1000);
        setIntakeStatus(`Fetching metadata - ${elapsed}s`);
        if (summary) {
          summary.textContent = elapsed < 30
            ? 'Contacting trackers and peers for the torrent file list...'
            : `Still waiting for a peer to provide metadata. No media is being downloaded. (${elapsed}s)`;
        }
      }, 1000);
    }
    try {
      const data = new FormData();
      if (sourceUrl) data.set('sourceUrl', sourceUrl);
      else data.set('torrent', file);
      const res = await fetch('/api/torrent/inspect', { method: 'POST', body: data });
      const payload = await res.json();
      if (nonce !== inspectNonce) return;
      if (!res.ok) throw new Error(payload.error || 'Inspect failed');
      inspectedTorrent = payload;
      inspectedSourceKey = sourceKey;
      selectedFiles = new Set((payload.files || []).map((file) => file.index));
      setIntakeFields(payload.suggested || {});
      renderTorrentSummary(payload);
      if (contentSelection) contentSelection.hidden = !(payload.files || []).length;
      if (plexSetup) plexSetup.hidden = false;
      if (postDownloadSetup) postDownloadSetup.hidden = false;
      smartSetupAvailable = Boolean(payload.smartSetup?.available && (payload.files || []).length);
      smartSetupModel = payload.smartSetup?.model || '';
      if (smartSetupPanel) smartSetupPanel.hidden = !(payload.files || []).length;
      if (smartSetupStatus) {
        smartSetupStatus.textContent = smartSetupAvailable
          ? `${smartSetupModel} starting automatically...`
          : 'Set OPENAI_API_KEY to enable';
      }
      renderTorrentFileTree(payload.files || [], selectedFiles, '');
      updateSelection();
      updateSubmitAvailability();
      setIntakeStatus('Ready to review');
      setIntakeMode('ready');
      maybeRunSmartSetup();
    } catch (error) {
      if (nonce !== inspectNonce) return;
      const message = error instanceof Error ? error.message : String(error);
      setIntakeStatus(message);
      if (summary) summary.textContent = message;
      setIntakeMode('error');
      updateInspectAvailability();
    } finally {
      if (nonce === inspectNonce) {
        window.clearInterval(inspectProgressTimer);
        inspectProgressTimer = 0;
      }
    }
  };
  const scheduleInspect = (delay = 450) => {
    window.clearTimeout(inspectTimer);
    inspectNonce += 1;
    resetInspection();
    updateInspectAvailability();
    if (!hasSource()) {
      document.getElementById('torrentSummary').textContent = 'Waiting for a source.';
      setIntakeStatus('Ready');
      setIntakeMode('idle');
      return;
    }
    setIntakeStatus('Ready to inspect');
    setIntakeMode('idle');
    inspectTimer = window.setTimeout(() => {
      inspectCurrentTorrent().catch(() => {});
    }, delay);
  };
  input.addEventListener('change', async () => {
    if (input.files?.[0]) sourceInput.value = '';
    scheduleInspect(80);
  });
  sourceInput.addEventListener('input', () => {
    if (sourceInput.value.trim()) input.value = '';
    scheduleInspect();
  });
  sourceInput.addEventListener('paste', () => window.setTimeout(() => scheduleInspect(120), 0));
  sourceInput.addEventListener('change', inspectCurrentTorrent);
  inspect.addEventListener('click', inspectCurrentTorrent);
  rightsConfirmed.addEventListener('change', () => {
    updateSubmitAvailability();
  });
  organizeStrategy?.addEventListener('change', updateRouteEditor);
  routeRows?.addEventListener('input', syncRoutes);
  document.getElementById('addRoute')?.addEventListener('click', () => {
    renderRoutes([...currentRoutes(), { sourcePath: '', destinationPath: '' }]);
  });
  fileFilter?.addEventListener('input', () => {
    renderTorrentFileTree(inspectedTorrent?.files || [], selectedFiles, fileFilter.value);
    updateSelection();
  });
  fileTree?.addEventListener('click', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.dataset.fileIndexes) event.stopPropagation();
  });
  fileTree?.addEventListener('change', (event) => {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement) || !checkbox.dataset.fileIndexes) return;
    const indexes = checkbox.dataset.fileIndexes.split(',').map(Number).filter(Boolean);
    for (const index of indexes) {
      if (checkbox.checked) selectedFiles.add(index);
      else selectedFiles.delete(index);
    }
    updateSelection();
    updateSubmitAvailability();
  });
  document.getElementById('selectAllFiles')?.addEventListener('click', () => {
    selectedFiles = new Set((inspectedTorrent?.files || []).map((file) => file.index));
    updateSelection();
    updateSubmitAvailability();
  });
  document.getElementById('selectMedia')?.addEventListener('click', () => {
    selectedFiles = new Set((inspectedTorrent?.files || []).filter((file) => mediaAndCaptionPattern.test(file.path)).map((file) => file.index));
    updateSelection();
    updateSubmitAvailability();
  });
  document.getElementById('clearFileSelection')?.addEventListener('click', () => {
    selectedFiles.clear();
    updateSelection();
    updateSubmitAvailability();
  });
  smartSetupButton?.addEventListener('click', () => runSmartSetup().catch(() => {}));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    window.clearTimeout(inspectTimer);
    const file = input.files?.[0];
    const sourceUrl = sourceInput.value.trim();
    if ((!file && !sourceUrl) || !sessionState.authenticated) return;
    submit.disabled = true;
    inspect.disabled = true;
    setIntakeStatus('Adding');
    setIntakeMode('busy');
    try {
      const data = new FormData(form);
      if (sourceUrl) data.set('sourceUrl', sourceUrl);
      else data.set('torrent', file);
      const res = await fetch('/api/torrents', { method: 'POST', body: data });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Add failed');
      setIntakeStatus(payload.restartMessage || 'Added');
      setIntakeMode('ready');
      document.getElementById('torrentSummary').textContent = 'Queued ' + payload.item.title + ' - ' + fmt(payload.item.totalBytes);
      form.reset();
      resetInspection();
      updateInspectAvailability();
      document.getElementById('intakeDialog')?.close();
      refreshFallback().catch(() => {});
    } catch (error) {
      setIntakeStatus(error instanceof Error ? error.message : String(error));
      setIntakeMode('error');
      submit.disabled = false;
      updateInspectAvailability();
    }
  });
}

function initQueueControls() {
  document.getElementById('clearCompleted')?.addEventListener('click', clearCompletedItems);
  const container = document.getElementById('items');
  container?.addEventListener('dragover', (event) => {
    if (!queueDragId || queueOrderSaving) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const dragged = container.querySelector(`.item[data-item-id="${CSS.escape(queueDragId)}"]`);
    if (!dragged) return;
    const queueRows = Array.from(container.querySelectorAll('.item.active, .item.organizing, .item.pending'))
      .filter((row) => row !== dragged);
    const beforeRow = queueRows.find((row) => {
      const bounds = row.getBoundingClientRect();
      return event.clientY < bounds.top + bounds.height / 2;
    });
    const queueBoundary = container.querySelector('.item.failed, .item.completed');
    moveQueueRow(container, dragged, beforeRow || queueBoundary);
  });
  container?.addEventListener('drop', (event) => {
    if (!queueDragId || queueOrderSaving) return;
    event.preventDefault();
    persistQueueOrder().catch(() => {});
  });
}

function render(data) {
  const active = activeItem(data);
  const activeCount = data.totals.activeItems || 0;
  const activePercent = activeCount ? data.totals.activePercent || 0 : data.totals.completedItems === data.totals.totalItems ? 100 : 0;
  const activeRateBytes = data.totals.activeRateBytesPerSecond || 0;
  const activeRateLabel = formatPeerRate(activeRateBytes);
  const activeTitle = activeCount > 1 ? activeCount + ' active downloads' : active ? active.title : 'Queue idle';
  const streamPeers = Array.isArray(data.swarm?.peers) ? data.swarm.peers : swarmMap.peers;
  const activeStreams = streamPeers
    .filter((peer) => peer.active && Number.isFinite(peer.lat) && Number.isFinite(peer.lon)).length;
  const diskUse = Number(String(data.disk.usePercent || '0').replace('%', '')) || 0;
  const diskFree = clamp(100 - diskUse);
  const speed = activeRateBytes / 1024 / 1024;
  warp.batchProgress = data.totals.percent;

  document.getElementById('connection').textContent = 'Live';
  document.getElementById('subtitle').textContent = activeTitle;
  tweenNumber('batchPercent', data.totals.percent, (value) => value.toFixed(1) + '%', 800);
  document.getElementById('batchText').textContent = data.totals.completedItems + ' of ' + data.totals.totalItems + ' complete';
  tweenNumber('activePercent', activePercent, (value) => Math.round(value) + '%', 800);
  document.getElementById('activeText').textContent = activeCount ? (data.totals.activeEta ? 'ETA ' + data.totals.activeEta : activeCount + ' running') : 'No active item';
  tweenNumber('diskPercent', diskFree, (value) => Math.round(value) + '%', 800);
  document.getElementById('diskText').textContent = data.disk.available + ' free of ' + data.disk.size;
  setRing('batchRing', data.totals.percent);
  setRing('activeRing', activePercent);
  setRing('diskRing', diskFree);
  const totalFill = document.getElementById('totalFill');
  if (totalFill) totalFill.style.width = clamp(data.totals.percent) + '%';
  tweenNumber('downloaded', data.totals.doneBytes, (value) => fmt(value) + ' / ' + fmt(data.totals.totalBytes), 700);
  const updated = document.getElementById('updated');
  if (updated) updated.textContent = new Date(data.generatedAt).toLocaleTimeString();
  tweenNumber('speedNow', speed, formatSpeed, 450);
  if (activeCount) tweenNumber('currentMini', activePercent, (value) => Math.round(value) + '% @ ' + activeRateLabel, 700);
  else document.getElementById('currentMini').textContent = '-';
  document.getElementById('etaMini').textContent = data.totals.activeEta || '-';
  document.getElementById('mapTorrentTitle').textContent = activeTitle;
  document.getElementById('mapTorrentProgress').textContent = activeCount ? Math.round(activePercent) + '%' : '-';
  document.getElementById('mapTorrentRate').textContent = activeCount ? activeRateLabel : '-';
  document.getElementById('mapTorrentEta').textContent = data.totals.activeEta || '-';
  document.getElementById('mapTorrentSeeds').textContent = 'Streams ' + activeStreams;
  document.getElementById('mapTorrentFill').style.width = clamp(activePercent) + '%';
  tweenNumber('remainingMini', Math.max(0, data.totals.totalBytes - data.totals.doneBytes), fmt, 700);
  updateSpeedChart(speed);

  data.items.forEach((item) => {
    if (item.status === 'completed' && !completedSeen.has(item.id)) {
      completedSeen.add(item.id);
      if (renderedOnce) celebrate();
    }
  });
  renderedOnce = true;

  renderItems(data.items);
  if (data.swarm) renderSwarmMap(data.swarm);
  const log = document.getElementById('log');
  if (log) log.textContent = data.batchLogTail || '';
}
async function refreshFallback() {
  const res = await fetch('/api/status', { cache: 'no-store' });
  render(await res.json());
}
if ('EventSource' in window) {
  const events = new EventSource('/api/events');
  events.addEventListener('status', (event) => render(JSON.parse(event.data)));
  events.addEventListener('error', () => {
    document.getElementById('connection').textContent = 'Reconnecting';
  });
} else {
  document.getElementById('connection').textContent = 'Fallback';
  refreshFallback();
  setInterval(refreshFallback, 1000);
}
initWarp();
initMapControls();
initIntakeNavigation();
initQueueControls();
refreshSession();
window.addEventListener('torplex:refresh', () => refreshFallback().catch(() => {}));
window.addEventListener('scroll', () => {
  warp.scrollingUntil = performance.now() + 140;
}, { passive: true });
window.addEventListener('resize', () => {
  resizeWarp();
  if (document.getElementById('speedCanvas')) updateSpeedChart(speedChart.target);
  applyMapTransform();
});
}
