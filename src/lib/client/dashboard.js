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
  speed: 0,
  batchProgress: 0,
  width: 0,
  height: 0,
  dpr: 1,
};
const swarmMap = {
  peers: [],
  displayPeers: [],
  labelNodes: new Map(),
  raf: 0,
  lastFrame: 0,
  origin: { lat: 39, lon: -98 },
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

function statusClassFor(status) {
  return String(status || 'pending').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
}

function rowIdFor(id) {
  return 'item-' + String(id).replace(/[^a-z0-9_-]/gi, '-');
}

function progressDetailFor(item) {
  if (item.status === 'completed') return fmt(item.totalBytes) + ' finished';
  if (item.progress.downloadedBytes) {
    return fmt(item.progress.downloadedBytes) + ' / ' + fmt(item.progress.totalBytes || item.totalBytes);
  }
  return 'queued';
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
  swarmMap.peers = peers;
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
  const layer = document.getElementById('worldMapLayer');
  if (layer) layer.style.transform = '';
  const image = document.querySelector('.world-map-image');
  if (image) image.style.transform = 'translate(' + mapView.x + 'px, ' + mapView.y + 'px) scale(' + mapView.scale + ')';
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

function mixColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function heatColor(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  const t = Math.max(0, Math.min(1, Math.log2(value / 32768 + 1) / 8));
  const stops = [
    [45, 126, 255],
    [0, 170, 0],
    [191, 255, 0],
    [255, 140, 0],
    [255, 46, 46],
  ];
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  return mixColor(stops[index], stops[index + 1], scaled - index).join(', ');
}

function syncDisplayPeers(peers) {
  const now = performance.now();
  const existing = new Map(swarmMap.displayPeers.map((peer) => [peer.peer ? peer.peer.ip + ':' + peer.peer.port : '', peer]));
  const next = [];
  peers.filter((peer) => Number.isFinite(peer.lat) && Number.isFinite(peer.lon)).slice(0, 32).forEach((peer, index) => {
    const key = peer.ip + ':' + peer.port;
    const current = existing.get(key) || { alpha: 0, x: 0, y: 0, phase: Math.random() * Math.PI * 2 };
    current.peer = peer;
    current.targetLat = Number(peer.lat);
    current.targetLon = Number(peer.lon);
    current.lastSeen = now;
    current.rank = index;
    current.fading = false;
    next.push(current);
  });
  existing.forEach((peer, ip) => {
    if (ip && !next.some((item) => item.peer && item.peer.ip + ':' + item.peer.port === ip)) {
      peer.fading = true;
      next.push(peer);
    }
  });
  swarmMap.displayPeers = next.slice(0, 40);
}

function renderMapPeerLabels(width, height) {
  const layer = document.getElementById('mapPeerLabels');
  if (!layer) return;
  const visible = swarmMap.displayPeers
    .filter((item) => item.peer?.active && item.rank < 16 && item.alpha > .05)
    .sort((a, b) => (Number(b.peer.receiveRateBps) || 0) - (Number(a.peer.receiveRateBps) || 0));
  const seen = new Set();
  const placed = [];
  const overlaps = (rect) => placed.some((other) =>
    rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top,
  );
  visible.forEach((item) => {
    const key = item.peer.ip + ':' + item.peer.port;
    seen.add(key);
    let node = swarmMap.labelNodes.get(key);
    if (!node) {
      node = document.createElement('div');
      node.className = 'map-peer-label';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      const text = document.createElement('span');
      text.className = 'map-peer-speed';
      const detail = document.createElement('span');
      detail.className = 'map-peer-detail';
      node.append(img, text, detail);
      layer.appendChild(node);
      swarmMap.labelNodes.set(key, node);
    }
    const text = formatPeerRate(item.peer.receiveRateBps);
    const country = item.peer.country || item.peer.countryCode || 'Unknown country';
    const detailText = country + ' - ' + item.peer.ip + ':' + item.peer.port;
    const flagUrl = flagUrlForCountry(item.peer.countryCode);
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
      span.style.color = 'rgb(' + heatColor(item.peer.receiveRateBps) + ')';
    }
    if (detail) detail.textContent = detailText;
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
    node.style.opacity = String(Math.min(.96, item.alpha));
  });
  swarmMap.labelNodes.forEach((node, key) => {
    if (!seen.has(key)) {
      node.remove();
      swarmMap.labelNodes.delete(key);
    }
  });
}

function drawWorldFrame(now) {
  swarmMap.raf = requestAnimationFrame(drawWorldFrame);
  const canvas = document.getElementById('worldCanvas');
  if (!canvas) return;
  syncDisplayPeers(swarmMap.peers);
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
  const vmPulse = pulseForSpeed(now, totalIngestBps);
  const vmColor = heatColor(totalIngestBps);
  const vmLabelColor = '191, 255, 0';
  const vmRadius = 4.5 * (1 + vmPulse.value);
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, vmRadius + 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(' + vmColor + ', ' + (.06 + vmPulse.value * .10) + ')';
  ctx.fill();
  ctx.fillStyle = 'rgb(' + vmColor + ')';
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, vmRadius, 0, Math.PI * 2);
  ctx.shadowColor = 'rgba(' + vmColor + ', .75)';
  ctx.shadowBlur = 16 + vmPulse.value * 14;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(' + vmLabelColor + ', .95)';
  ctx.textAlign = 'center';
  ctx.fillText('VM', origin.x, origin.y - vmRadius - 7);
  ctx.textAlign = 'start';

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
    const hue = 166 + (item.rank % 9) * 12;
    const peerPulse = pulseForSpeed(now, item.peer.receiveRateBps, item.phase + Math.PI);
    const activeColor = heatColor(item.peer.receiveRateBps);

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
      ctx.strokeStyle = 'rgba(' + activeColor + ', ' + (.62 * alpha) + ')';
      ctx.lineWidth = 2.2;
      ctx.shadowColor = 'rgba(' + activeColor + ', .36)';
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    const rateBps = Number(item.peer.receiveRateBps) || 0;
    if (item.peer.active && Math.round(rateBps) > 0) {
      const speedFactor = Math.max(.55, Math.min(4.5, Math.log2(rateBps / 32768 + 1)));
      const packetCount = Math.max(2, Math.min(8, Math.round(2 + speedFactor * 1.35)));
      for (let i = 0; i < packetCount; i += 1) {
        const travel = ((now / (1550 / speedFactor)) + i / packetCount + item.phase) % 1;
        const t = 1 - travel;
        const head = quadPoint(start, control, end, t);
        const tail = quadPoint(start, control, end, Math.min(1, t + .03 + speedFactor * .006));
        const packetAlpha = alpha * (.42 + .58 * Math.sin(travel * Math.PI));
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(head.x, head.y);
        ctx.strokeStyle = 'rgba(' + activeColor + ', ' + packetAlpha + ')';
        ctx.lineWidth = 3.2;
        ctx.shadowColor = 'rgba(' + activeColor + ', .88)';
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + activeColor + ', ' + packetAlpha + ')';
        ctx.fill();
      }
    }

    ctx.beginPath();
    const activePeerRadius = 2.25 + (1 - peerPulse.value) * 2.25;
    const outerRadius = item.peer.active ? activePeerRadius + 3 : item.peer.probing ? 5 : 4;
    ctx.arc(screen.x, screen.y, outerRadius, 0, Math.PI * 2);
    ctx.fillStyle = item.peer.active
      ? 'rgba(' + activeColor + ', ' + (.075 * alpha) + ')'
      : item.peer.probing
        ? 'rgba(247, 198, 95, ' + (.06 * alpha) + ')'
        : 'rgba(247, 198, 95, ' + (.05 * alpha) + ')';
    ctx.fill();
    ctx.beginPath();
    const innerRadius = item.peer.active ? activePeerRadius : item.peer.probing ? 3.1 : 2.6;
    ctx.arc(screen.x, screen.y, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = item.peer.active
      ? 'rgba(' + activeColor + ', ' + (.95 * alpha) + ')'
      : item.peer.probing
        ? 'rgba(247, 198, 95, ' + (.88 * alpha) + ')'
        : 'rgba(247, 198, 95, ' + (.78 * alpha) + ')';
    ctx.shadowColor = item.peer.active ? 'rgba(' + activeColor + ', ' + (.75 * alpha) + ')' : 'transparent';
    ctx.shadowBlur = item.peer.active ? 7 + (1 - peerPulse.value) * 7 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;
  });
  renderMapPeerLabels(width, height);
}

function renderItems(items) {
  const container = document.getElementById('items');
  const seen = new Set();
  const priority = { active: 0, organizing: 0, pending: 1, failed: 2, completed: 3 };
  const orderedItems = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (priority[a.item.status] ?? 1) - (priority[b.item.status] ?? 1) || a.index - b.index)
    .map((entry) => entry.item);
  orderedItems.forEach((item) => {
    const rowId = rowIdFor(item.id);
    seen.add(rowId);
    let row = document.getElementById(rowId);
    if (!row) {
      row = document.createElement('article');
      row.id = rowId;
      row.innerHTML =
        '<div class="title"><div data-role="title"></div><div class="mono" data-role="size"></div></div>' +
        '<div><span data-role="status" class="chip"></span></div>' +
        '<div><div data-role="progress-label"></div><div class="item-bar"><div data-role="fill" class="item-fill"></div></div><div class="mono" data-role="detail"></div></div>' +
        '<div><div class="label">Rate</div><div data-role="rate"></div></div>' +
        '<div><div class="label">ETA</div><div data-role="eta"></div></div>';
    }
    container.appendChild(row);

    const progress = item.status === 'completed' ? 100 : clamp(item.progress.percent);
    const statusClass = statusClassFor(item.status);
    row.className = 'item ' + statusClass;
    setText(row.querySelector('[data-role="title"]'), item.title);
    setText(row.querySelector('[data-role="size"]'), fmt(item.totalBytes));

    const chip = row.querySelector('[data-role="status"]');
    chip.className = 'chip ' + statusClass;
    setText(chip, item.status);

    tweenElementNumber(
      row.querySelector('[data-role="progress-label"]'),
      progress,
      (value) => value ? Math.round(value) + '%' : 'waiting',
      700,
    );
    row.querySelector('[data-role="fill"]').style.width = progress + '%';
    setText(row.querySelector('[data-role="detail"]'), progressDetailFor(item));
    setText(row.querySelector('[data-role="rate"]'), item.progress.rate || '-');
    setText(row.querySelector('[data-role="eta"]'), item.progress.eta || '-');
  });
  Array.from(container.children).forEach((row) => {
    if (!seen.has(row.id)) row.remove();
  });
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
  warp.dpr = Math.min(2, window.devicePixelRatio || 1);
  warp.width = window.innerWidth;
  warp.height = window.innerHeight;
  canvas.width = Math.floor(warp.width * warp.dpr);
  canvas.height = Math.floor(warp.height * warp.dpr);
}

function initWarp() {
  resizeWarp();
  if (!warp.stars.length) {
    for (let i = 0; i < 180; i += 1) {
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
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dt = warp.lastFrame ? Math.min(80, now - warp.lastFrame) : 16;
  warp.lastFrame = now;
  const targetSpeed = Math.min(1, speedChart.current / 75);
  warp.speed += (targetSpeed - warp.speed) * (1 - Math.exp(-dt / 520));
  const centerX = warp.width * (.50 + Math.sin(now / 6200) * .015);
  const centerY = warp.height * (.36 + Math.cos(now / 7400) * .018);
  const hue = 168 + warp.batchProgress * .95;
  const pace = (.00009 + warp.speed * .0011) * dt;
  const streak = 1.8 + warp.speed * 20;

  ctx.setTransform(warp.dpr, 0, 0, warp.dpr, 0, 0);
  ctx.clearRect(0, 0, warp.width, warp.height);
  ctx.globalCompositeOperation = 'lighter';

  const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(warp.width, warp.height) * .62);
  glow.addColorStop(0, 'hsla(' + hue + ', 80%, 58%, ' + (.08 + warp.speed * .08) + ')');
  glow.addColorStop(.42, 'hsla(' + (hue + 35) + ', 80%, 45%, .035)');
  glow.addColorStop(1, 'hsla(' + hue + ', 80%, 45%, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, warp.width, warp.height);

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

    const alpha = Math.min(.88, (.10 + (1 - star.z) * .52 + warp.speed * .24) * (.72 + Math.sin(now / 420 + star.twinkle) * .18));
    ctx.lineWidth = star.size * (.7 + warp.speed * .7);
    ctx.strokeStyle = 'hsla(' + hue + ', 92%, 72%, ' + alpha + ')';
    ctx.beginPath();
    ctx.moveTo(oldX, oldY);
    ctx.lineTo(x + (x - oldX) * streak, y + (y - oldY) * streak);
    ctx.stroke();
  });

  ctx.globalCompositeOperation = 'source-over';
}

function updateSpeedChart(value) {
  const now = performance.now();
  speedChart.target = Number.isFinite(value) ? value : 0;
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
  const preview = (meta.files || []).slice(0, 4).map((file) => file.path).join(' | ');
  const sourceKind = meta.source?.kind === 'magnet' ? 'Magnet' : meta.source?.kind === 'torrentUrl' ? 'Torrent URL' : meta.source?.kind === 'upload' ? 'Upload' : 'Source';
  const size = meta.totalBytes ? fmt(meta.totalBytes) : 'metadata pending';
  const fileCount = meta.fileCount ? meta.fileCount + ' file' + (meta.fileCount === 1 ? '' : 's') : 'file list pending';
  summary.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'summary-title';
  title.textContent = meta.payloadName || 'Ready to queue';
  const details = document.createElement('div');
  details.className = 'summary-details';
  details.textContent = sourceKind + ' - ' + size + ' - ' + fileCount + (preview ? ' - ' + preview : '');
  summary.append(title, details);
}

function initDialogControls() {
  const dialog = document.getElementById('intakeDialog');
  const open = document.getElementById('openIntake');
  const close = document.getElementById('closeIntake');
  open?.addEventListener('click', () => {
    if (!sessionState.configured) return;
    if (!sessionState.authenticated) {
      window.location.href = sessionState.loginUrl || '/auth/login';
      return;
    }
    if (typeof dialog?.showModal === 'function') {
      dialog.showModal();
      document.body.classList.add('dialog-open');
    }
  });
  close?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('close', () => document.body.classList.remove('dialog-open'));
}

function initIntakeControls() {
  const form = document.getElementById('intakeForm');
  const input = document.getElementById('torrentFile');
  const sourceInput = document.getElementById('sourceUrl');
  const inspect = document.getElementById('inspectTorrent');
  const submit = document.getElementById('addTorrent');
  if (!form || !input || !sourceInput || !inspect || !submit) return;
  let inspectTimer = 0;
  let inspectNonce = 0;
  const hasSource = () => Boolean(input.files?.[0] || sourceInput.value.trim());
  const updateInspectAvailability = () => {
    inspect.disabled = !sessionState.authenticated || !hasSource();
  };
  if (!sessionState.authenticated) {
    setIntakeStatus('Unlock first');
    setIntakeMode('locked');
    submit.disabled = true;
    inspect.disabled = true;
  }
  const inspectCurrentTorrent = async () => {
    window.clearTimeout(inspectTimer);
    const nonce = ++inspectNonce;
    const file = input.files?.[0];
    const sourceUrl = sourceInput.value.trim();
    submit.disabled = true;
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
    try {
      const data = new FormData();
      if (sourceUrl) data.set('sourceUrl', sourceUrl);
      else data.set('torrent', file);
      const res = await fetch('/api/torrent/inspect', { method: 'POST', body: data });
      const payload = await res.json();
      if (nonce !== inspectNonce) return;
      if (!res.ok) throw new Error(payload.error || 'Inspect failed');
      setIntakeFields(payload.suggested || {});
      renderTorrentSummary(payload);
      submit.disabled = false;
      setIntakeStatus('Auto-filled');
      setIntakeMode('ready');
    } catch (error) {
      if (nonce !== inspectNonce) return;
      setIntakeStatus(error instanceof Error ? error.message : String(error));
      setIntakeMode('error');
      updateInspectAvailability();
    }
  };
  const scheduleInspect = (delay = 450) => {
    window.clearTimeout(inspectTimer);
    submit.disabled = true;
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
      submit.disabled = true;
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

function render(data) {
  const active = activeItem(data);
  const activeCount = data.totals.activeItems || 0;
  const activePercent = activeCount ? data.totals.activePercent || 0 : data.totals.completedItems === data.totals.totalItems ? 100 : 0;
  const activeRateBytes = data.totals.activeRateBytesPerSecond || 0;
  const activeRateLabel = formatPeerRate(activeRateBytes);
  const activeTitle = activeCount > 1 ? activeCount + ' active downloads' : active ? active.title : 'Queue idle';
  const activeStreams = Array.isArray(data.swarm?.peers)
    ? data.swarm.peers.filter((peer) => peer.active && Number.isFinite(peer.lat) && Number.isFinite(peer.lon)).slice(0, 32).length
    : 0;
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
  renderSwarmMap(data.swarm);
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
initDialogControls();
initIntakeControls();
refreshSession();
window.addEventListener('resize', () => {
  resizeWarp();
  if (document.getElementById('speedCanvas')) updateSpeedChart(speedChart.target);
  applyMapTransform();
});
}
