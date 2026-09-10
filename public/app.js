import { NetworkGraph } from './js/network-graph.js';
import { TracerouteMap } from './js/traceroute-map.js';
import { HopDetails } from './js/hop-details.js';
import { Statistics } from './js/statistics.js';
import { normalizeHop, applyInfo } from './js/model.js';
import { isValidDestination } from './js/validate.js';
import { startSplash } from './js/splash.js';

(() => {
  const destInput = document.getElementById('destination');
  const traceBtn = document.getElementById('traceBtn');
  const stopBtn = document.getElementById('stopBtn');
  const wsStatusEl = document.getElementById('wsStatus');
  const traceStatusEl = document.getElementById('traceStatus');
  const themeToggle = document.getElementById('themeToggle');
  const graphEmpty = document.getElementById('graphEmpty');
  const hopTableBody = document.getElementById('hopTableBody');
  const myIpEl = document.getElementById('myIp');
  const myIpValueEl = document.getElementById('myIpValue');
  const traceIpBtn = document.getElementById('traceIpBtn');

  const canvas = document.getElementById('networkGraph');
  const infoCard = document.getElementById('infoCard');

  const graph = new NetworkGraph(canvas, { theme: getTheme() });
  const mapContainer = document.getElementById('tracerouteMap');
  const map = new TracerouteMap(mapContainer, { theme: getTheme() });
  const details = new HopDetails(infoCard);
  const stats = new Statistics(document.getElementById('statsBar'));

  let ws = null;
  let tracing = false;
  let rawHops = [];
  let myIp = null;

  // ─── Theme ──────────────────────────────────────────────

  function getTheme() {
    return localStorage.getItem('netpulse-theme') || 'dark';
  }

  function applyTheme(theme, { init = false } = {}) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('netpulse-theme', theme);
    graph.setTheme(theme);
    map.setTheme(theme);
    if (!init) setTimeout(() => { graph.render(); map._invalidate(); }, 60);
  }

  themeToggle.addEventListener('click', () => {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
  });

  // ─── WebSocket ──────────────────────────────────────────

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      wsStatusEl.textContent = '\u25CF Connected';
      wsStatusEl.className = 'status-badge status-connected';
    };

    ws.onclose = () => {
      wsStatusEl.textContent = '\u25CF Disconnected';
      wsStatusEl.className = 'status-badge status-disconnected';
      setTimeout(connectWs, 2000);
    };

    ws.onerror = () => ws.close();
    ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  }

  // ─── Message handling ───────────────────────────────────

  function handleMessage(msg) {
    switch (msg.type) {
      case 'trace_started':
        onTraceStarted(msg.destination);
        break;
      case 'hop':
        onHop(msg.hop);
        break;
      case 'hop_info':
        onHopInfo(msg.ip, msg.info);
        break;
      case 'trace_completed':
        onTraceEnded('REACHED');
        break;
      case 'trace_stopped':
        onTraceEnded('STOPPED');
        break;
      case 'trace_error':
        onTraceEnded('FAILED', msg.message || 'Trace failed');
        break;
    }
  }

  function onTraceStarted(_dest) {
    tracing = true;
    rawHops = [];
    updateControls();
    setTraceStatus('TRACING...', 'active');
    begin(false);
    stats.setStartedAt(performance.now());
    stats.update([], 'TRACING');
  }

  function onHop(raw) {
    const index = rawHops.length;

    // Destination is always the current last reachable hop; demote the
    // previous destination both in data and on the map.
    if (index > 0) {
      const prevRaw = rawHops[index - 1];
      const prevNode = graph.nodes[index - 1];
      if (prevRaw._isDestination && prevNode) {
        // Snapshot the pre-demotion state so the map sees the flag change
        // (the map stores a reference to the same node object).
        map.updateHop(index - 1, { ...prevNode, isDestination: false });
        prevRaw._isDestination = false;
        prevNode.isDestination = false;
      }
    }
    rawHops.push(raw);
    raw._isDestination = !raw.timeout;

    const node = normalizeHop(raw, index, rawHops.length);
    node._rawIndex = index;
    node.isDestination = raw._isDestination;
    node.isLocal = index === 0;

    graph.appendHop(node);
    graph.setActive(index);
    map.addHop(index, node);
    stats.update(rawHops, 'TRACING');
    renderTable();

    if (graphEmpty && !graphEmpty.style.display) dealGraphEmpty();
  }

  function onHopInfo(ip, info) {
    const idx = rawHops.findIndex((h) => h.ip === ip && !h.info);
    if (idx === -1) return;
    rawHops[idx].info = info;

    const node = normalizeHop(rawHops[idx], idx, rawHops.length);
    node._rawIndex = rawHops[idx]._rawIndex != null ? rawHops[idx]._rawIndex : idx;
    node.isDestination = rawHops[idx]._isDestination;
    node.isLocal = idx === 0;

    graph.updateNode(idx, node);
    map.updateHop(idx, node);
    if (selectedIndex === idx) details.show(node, idx, rawHops.length);
    stats.update(rawHops, undefined);
  }

  function onTraceEnded(destStatus, message) {
    tracing = false;
    updateControls();

    const last = rawHops[rawHops.length - 1];
    let status = destStatus;
    if (destStatus === 'STOPPED') {
      status = 'STOPPED';
    } else if (destStatus === 'FAILED') {
      status = 'FAILED';
    } else if (last && last.timeout) {
      status = 'TIMED OUT';
    } else if (last && last.ip) {
      status = 'REACHED';
    }

    const label = status === 'REACHED' ? 'TRACE COMPLETE'
      : status === 'TIMED OUT' ? 'DESTINATION UNREACHABLE — TIMED OUT'
      : status === 'STOPPED' ? 'TRACE STOPPED'
      : message ? `TRACE FAILED — ${message}`
      : 'TRACE FAILED';
    setTraceStatus(label, status === 'REACHED' ? 'done' : status === 'STOPPED' ? '' : 'error');

    graph.setActive(Math.max(0, rawHops.length - 1));
    stats.setFinished();
    stats.update(rawHops, status);
    if (graph.nodes.length === 0) {
      graph.fitView();
    } else if (map.hops.length > 0) {
      map.fit();
    }
  }

  // ─── Details / sync helpers ─────────────────────────────

  let selectedIndex = -1;

  function selectHopIndex(index) {
    if (index < 0 || index >= graph.nodes.length) return;
    selectedIndex = index;
    const node = graph.nodes[index];

    graph.selectedIndex = index;
    graph.render();
    map.selectHop(index, node);
    details.show(node, index, graph.nodes.length);
    renderTableSelection(index);
  }

  graph.onSelect = (index) => selectHopIndex(index);
  map.onSelect = (index) => {
    // Keep graph in sync, avoid re-triggering map popup recursively.
    if (index !== selectedIndex) selectHopIndex(index);
    else {
      details.show(graph.nodes[index], index, graph.nodes.length);
      renderTableSelection(index);
    }
  };

  // ─── Controls ───────────────────────────────────────────

  document.getElementById('zoomIn').addEventListener('click', () => graph.zoomIn());
  document.getElementById('zoomOut').addEventListener('click', () => graph.zoomOut());
  document.getElementById('zoomFit').addEventListener('click', () => graph.fitView());
  document.getElementById('mapFit').addEventListener('click', () => map.fit());
  traceBtn.addEventListener('click', startTrace);
  stopBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'stop_trace' })));
  destInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startTrace(); });
  destInput.addEventListener('input', clearInputError);

  function startTrace() {
    const dest = destInput.value.trim();
    if (!dest) {
      showInputError('Enter a destination');
      return;
    }
    if (!isValidDestination(dest)) {
      showInputError('Invalid IP address or hostname');
      return;
    }
    clearInputError();
    if (tracing) return;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'start_trace', destination: dest }));
    }
  }

  function showInputError(message) {
    destInput.classList.add('invalid');
    setTraceStatus(message, 'error');
  }

  function clearInputError() {
    destInput.classList.remove('invalid');
  }

  function updateControls() {
    traceBtn.disabled = tracing;
    stopBtn.disabled = !tracing;
    destInput.disabled = tracing;
    traceIpBtn.disabled = tracing || !myIp;
  }

  function setMyIp(ip) {
    myIp = ip || null;
    if (myIp) {
      myIpValueEl.textContent = myIp;
      if (myIpEl) myIpEl.title = `Your public IP \u2014 ${myIp}`;
    } else {
      myIpValueEl.textContent = '\u2014';
      myIpEl.title = 'Could not determine public IP';
    }
    updateControls();
  }

  traceIpBtn.addEventListener('click', () => {
    if (!myIp || tracing) return;
    destInput.value = myIp;
    destInput.focus();
    startTrace();
  });

  function setTraceStatus(text, cls) {
    traceStatusEl.textContent = text;
    traceStatusEl.className = `trace-status ${cls || ''}`;
  }

  // ─── Rendering helpers ──────────────────────────────────

  function begin(showEmptyHint = true) {
    graph.begin();
    map.begin();
    details.clear();
    selectedIndex = -1;
    renderTable();
    if (graphEmpty) graphEmpty.style.display = showEmptyHint ? 'flex' : 'none';
  }

  function dealGraphEmpty() {
    if (graphEmpty) graphEmpty.style.display = 'none';
  }

  function renderTable() {
    hopTableBody.innerHTML = '';
    for (let i = 0; i < rawHops.length; i++) {
      const raw = rawHops[i];
      const node = graph.nodes[i] || normalizeHop(raw, i, rawHops.length);
      const tr = document.createElement('tr');
      if (i === selectedIndex) tr.classList.add('selected');

      const hopNum = document.createElement('td');
      hopNum.textContent = node.hop;

      const ip = document.createElement('td');
      ip.textContent = node.ip || '\u2014';

      const hostname = document.createElement('td');
      hostname.textContent = node.hostname || '\u2014';

      const latency = document.createElement('td');
      latency.textContent = node.timeout ? '\u2014' : node.latency != null ? `${node.latency} ms` : '\u2014';

      const loss = document.createElement('td');
      loss.textContent = `${node.packetLoss}%`;

      const status = document.createElement('td');
      status.textContent = statusLabel(node);
      status.className = statusClass(node);

      tr.addEventListener('click', () => selectHopIndex(i));
      tr.append(hopNum, ip, hostname, latency, loss, status);
      hopTableBody.appendChild(tr);
    }
  }

  function renderTableSelection(index) {
    for (let i = 0; i < hopTableBody.children.length; i++) {
      hopTableBody.children[i].classList.toggle('selected', i === index);
    }
  }

  function statusLabel(node) {
    if (node.timeout) return 'TIMEOUT';
    if (node.isDestination) return node.timeout ? 'UNREACHABLE' : 'REACHED';
    if (node.packetLoss > 0) return 'PACKET LOSS';
    if (node.latency > 150) return 'HIGH LATENCY';
    if (node.latency > 60) return 'SLOW';
    return 'OK';
  }

  function statusClass(node) {
    if (node.timeout) return 'status-timeout';
    if (node.isDestination) return 'status-destination';
    if (node.packetLoss > 0) return 'status-loss';
    if (node.latency > 150) return 'status-warning';
    return 'status-ok';
  }

  // ─── Init ───────────────────────────────────────────────

  begin(true);
  stats.update([], 'IDLE');
  applyTheme(getTheme(), { init: true });
  connectWs();
  startSplash({ onEnter: () => {
    destInput.focus({ preventScroll: true });
    if (map.map) setTimeout(() => { try { map.map.invalidateSize(); } catch {} }, 120);
  } });

  fetch('/api/myip')
    .then((r) => r.ok ? r.json() : null)
    .then((data) => setMyIp(data && data.ip ? data.ip : null))
    .catch(() => setMyIp(null));

  if (map.map) setTimeout(() => { try { map.map.invalidateSize(); } catch {} }, 300);

  window.addEventListener('resize', () => {
    if (graph) graph.resize();
    if (map && map.map) { try { map.map.invalidateSize(); } catch {} }
  });
})();