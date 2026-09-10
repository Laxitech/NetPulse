const MIN_SCALE = 0.3;
const MAX_SCALE = 6;
const NODE_RADIUS = 26;
const NODE_GAP = 165;
const LAYOUT_PAD_X = 80;
const LAYOUT_Y = 120;

const PALETTES = {
  light: {
    bgClear: true,
    local: '#059669',
    hop: '#2563eb',
    slow: '#d97706',
    high: '#dc2626',
    loss: '#ef4444',
    timeout: '#9ca3af',
    destination: '#e11d48',
    line: '#c7d2e0',
    text: '#1a1d23',
    muted: '#64748b',
    labelBg: 'rgba(255,255,255,0.92)',
  },
  dark: {
    local: '#00d4aa',
    hop: '#4fc3f7',
    slow: '#ffb347',
    high: '#ff6b6b',
    loss: '#ff6b6b',
    timeout: '#555555',
    destination: '#ff6b9d',
    line: '#334252',
    text: '#e6edf3',
    muted: '#8b98a7',
    labelBg: 'rgba(16,22,31,0.92)',
  },
};

export class NetworkGraph {
  constructor(canvas, { theme = 'light', fitOnEmpty = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.theme = theme;
    this.palette = PALETTES[theme] || PALETTES.dark;

    this.nodes = [];
    this.view = { scale: 1, ox: 0, oy: 0 };
    this.selectedIndex = -1;
    this.hoveredIndex = -1;
    this.probes = [];
    this.pulse = null; // { index, t0 }
    this.dpr = 1;

    this.autoFitPending = true;
    this.userInteracted = false;
    this.hitRadius = 8;

    this.onSelect = null; // fn(index, node)
    this.onHover = null;  // fn(index, node | null)

    this._container = canvas.parentElement;
    this._tooltip = null;
    this._raf = null;

    this._bindEvents();
    this._initTooltip();

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this._container);
    this.resize();
  }

  setTheme(theme) {
    this.theme = theme;
    this.palette = PALETTES[theme] || PALETTES.dark;
    this.render();
  }

  // ─── Sizing / DPR ────────────────────────────────────────────────

  resize() {
    const rect = this._container.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (this.autoFitPending && this.nodes.length) this.fitView();
    this.render();
  }

  // ─── Data ────────────────────────────────────────────────────────

  begin() {
    this.nodes = [];
    this.probes = [];
    this.pulse = null;
    this.selectedIndex = -1;
    this.hoveredIndex = -1;
    this.autoFitPending = true;
    this.userInteracted = false;
    if (this._tooltip) this._showTooltip(null);
    this.render();
  }

  appendHop(node) {
    const index = this.nodes.length;
    node._hopIndex = index;
    node._rawIndex = index;
    // Previous hop is no longer the destination once a new one arrives.
    if (index > 0) {
      this.nodes[index - 1].isDestination = false;
    }
    node.x = LAYOUT_PAD_X + index * NODE_GAP;
    node.y = LAYOUT_Y;
    this.nodes.push(node);

    if (index > 0) {
      const from = this.nodes[index - 1];
      this.probes.push({ from, to: node, t0: performance.now(), dur: 650 });
    }
    this.pulse = { index, t0: performance.now() };

    if (this.autoFitPending && !this.userInteracted) this.fitView();
    this.requestFrame();
  }

  updateNode(index, node) {
    if (!this.nodes[index]) return;
    const prev = this.nodes[index];
    node.x = prev.x;
    node.y = prev.y;
    node._hopIndex = index;
    node._rawIndex = prev._rawIndex;
    this.nodes[index] = node;
    this.render();
  }

  setActive(index) {
    if (index >= 0 && index < this.nodes.length) {
      this.pulse = { index, t0: performance.now() };
      this.render();
    }
  }

  clearSelection() {
    if (this.selectedIndex !== -1) {
      this.selectedIndex = -1;
      this.render();
    }
  }

  selectByIndex(index) {
    this.selectedIndex = index;
    if (this.hoveredIndex !== index) this.hoveredIndex = -1;
    this.render();
    if (this.onSelect) this.onSelect(index, this.nodes[index]);
  }

  _notifyHover(index, node) {
    if (this.onHover) this.onHover(index, node);
  }

  // ─── Zoom / Pan / Fit ────────────────────────────────────────────

  worldToScreen(wx, wy) {
    return { x: wx * this.view.scale + this.view.ox, y: wy * this.view.scale + this.view.oy };
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.view.ox) / this.view.scale, y: (sy - this.view.oy) / this.view.scale };
  }

  zoomIn() { this._zoomStep(1.35); }
  zoomOut() { this._zoomStep(1 / 1.35); }

  _zoomStep(factor) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    this._zoomAt(cx, cy, factor);
  }

  _zoomAt(sx, sy, factor) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * factor));
    // Keep the world point under the cursor fixed.
    const wx = (sx - this.view.ox) / this.view.scale;
    const wy = (sy - this.view.oy) / this.view.scale;
    this.view.scale = scale;
    this.view.ox = sx - wx * scale;
    this.view.oy = sy - wy * scale;
    this.userInteracted = true;
    this.render();
  }

  fitView() {
    if (this.nodes.length === 0) {
      this.view.scale = 1;
      this.view.ox = this.width / 2;
      this.view.oy = this.height / 2;
      this.render();
      return;
    }
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - NODE_RADIUS);
      maxX = Math.max(maxX, n.x + NODE_RADIUS);
      minY = Math.min(minY, n.y - NODE_RADIUS);
      maxY = Math.max(maxY, n.y + NODE_RADIUS);
    }
    const pad = 48;
    const bw = Math.max(maxX - minX, 80);
    const bh = Math.max(maxY - minY, 80);
    let scale = Math.min((this.width - pad * 2) / bw, (this.height - pad * 2) / bh);
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const ox = (this.width - bw * scale) / 2 - minX * scale;
    const oy = (this.height - bh * scale) / 2 - minY * scale;
    this.view.scale = scale;
    this.view.ox = ox;
    this.view.oy = oy;
    this.autoFitPending = false;
    this.render();
  }

  // ─── Interaction ─────────────────────────────────────────────────

  _bindEvents() {
    const el = this.canvas;

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0012);
      this._zoomAt(sx, sy, factor);
    }, { passive: false });

    el.addEventListener('dblclick', (e) => {
      const rect = el.getBoundingClientRect();
      this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.8);
    });

    let panStart = null;
    let startView = null;
    let dragMoved = false;

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      panStart = { x: e.clientX, y: e.clientY };
      startView = { ...this.view };
      dragMoved = false;
    });

    el.addEventListener('pointermove', (e) => {
      if (panStart) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true;
        this.view.ox = startView.ox + dx;
        this.view.oy = startView.oy + dy;
        this.userInteracted = true;
        this.render();
        return;
      }
      // Hover detection
      const rect = el.getBoundingClientRect();
      const idx = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
      const changed = idx !== this.hoveredIndex;
      this.hoveredIndex = idx;
      if (changed) {
        el.style.cursor = idx >= 0 ? 'pointer' : 'grab';
        if (idx >= 0) {
          const n = this.nodes[idx];
          this._showTooltip(e, idx, n);
          el.style.cursor = 'pointer';
        } else {
          this._showTooltip(null);
          el.style.cursor = 'grab';
        }
        this.render();
      } else if (idx >= 0) {
        this._moveTooltip(e);
      }
    });

    const endPan = (e) => {
      if (panStart) {
        panStart = null;
        if (!dragMoved) {
          const rect = el.getBoundingClientRect();
          const idx = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
          if (idx >= 0) this.selectByIndex(idx);
        }
      }
    };
    el.addEventListener('pointerup', endPan);
    el.addEventListener('pointerleave', () => {
      if (!panStart) {
        this.hoveredIndex = -1;
        this._showTooltip(null);
        el.style.cursor = 'grab';
        this.render();
      }
    });
  }

  _hitTest(sx, sy) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const p = this.worldToScreen(n.x, n.y);
      const r = NODE_RADIUS * this.view.scale;
      const dx = sx - p.x;
      const dy = sy - p.y;
      if (dx * dx + dy * dy <= (r + this.hitRadius) ** 2) return i;
    }
    return -1;
  }

  // ─── Tooltip ─────────────────────────────────────────────────────

  _initTooltip() {
    this._tooltip = document.createElement('div');
    this._tooltip.className = 'graph-tooltip';
    this._tooltip.hidden = true;
    this._container.appendChild(this._tooltip);
  }

  _tooltipContent(node) {
    const lines = [];
    lines.push(`Hop #${node.hop}`);
    if (node.ip) lines.push(node.ip);
    lines.push(`Latency: ${node.latency != null ? node.latency + ' ms' : (node.timeout ? 'timeout' : '—')}`);
    if (node.packetLoss > 0) lines.push(`Loss: ${node.packetLoss}%`);
    if (node.city) lines.push(`Location: ${[node.city, node.country].filter(Boolean).join(', ')}`);
    if (node.latitude != null) lines.push(`Coords: ${node.latitude.toFixed(4)}, ${node.longitude.toFixed(4)}`);
    return lines.join('<br>');
  }

  _showTooltip(e, idx, node) {
    if (!this._tooltip) return;
    if (!node) {
      this._tooltip.hidden = true;
      return;
    }
    this._tooltip.innerHTML = this._tooltipContent(node);
    this._tooltip.hidden = false;
    this._moveTooltip(e);
  }

  _moveTooltip(e) {
    if (!this._tooltip || this._tooltip.hidden) return;
    const rect = this._container.getBoundingClientRect();
    let left = e.clientX - rect.left + 14;
    let top = e.clientY - rect.top + 14;
    const tw = this._tooltip.offsetWidth;
    const th = this._tooltip.offsetHeight;
    if (left + tw > rect.width - 4) left = e.clientX - rect.left - tw - 10;
    if (top + th > rect.height - 4) top = e.clientY - rect.top - th - 10;
    this._tooltip.style.left = `${Math.max(4, left)}px`;
    this._tooltip.style.top = `${Math.max(4, top)}px`;
  }

  // ─── Rendering ───────────────────────────────────────────────────

  requestFrame() {
    if (!this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        this.render();
        const now = performance.now();
        const hasProbes = this.probes.some((p) => now - p.t0 < p.dur);
        const hasPulse = this.pulse && now - this.pulse.t0 < 1600;
        if (hasProbes || hasPulse) this.requestFrame();
      });
    }
  }

  render() {
    const ctx = this.ctx;
    const { width, height, dpr, palette } = this;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (this.nodes.length === 0) return;

    // Connections
    for (let i = 0; i < this.nodes.length - 1; i++) {
      const from = this.nodes[i];
      const to = this.nodes[i + 1];
      const a = this.worldToScreen(from.x, from.y);
      const b = this.worldToScreen(to.x, to.y);
      const color = this._edgeColor(to);
      const active = to._hopIndex === this.nodes.length - 1;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 2.4 : 1.4;
      ctx.globalAlpha = active ? 0.95 : 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Latency marker at midpoint
      if (to.latency != null && !to.timeout) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2 - 10;
        const label = `${to.latency.toFixed(1)}ms`;
        ctx.font = '10px "SF Mono","Consolas",monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = palette.labelBg;
        const ly = my - 8;
        ctx.fillRect(mx - tw / 2 - 4, ly, tw + 8, 13);
        ctx.fillStyle = palette.muted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, mx, ly + 7);
      }
    }

    // Nodes
    for (let i = 0; i < this.nodes.length; i++) {
      this._drawNode(ctx, i);
    }

    // Probe animations
    const now = performance.now();
    this.probes = this.probes.filter((p) => now - p.t0 < p.dur);
    for (const p of this.probes) {
      const t = Math.min((now - p.t0) / p.dur, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const a = this.worldToScreen(p.from.x, p.from.y);
      const b = this.worldToScreen(p.to.x, p.to.y);
      const x = a.x + (b.x - a.x) * ease;
      const y = a.y + (b.y - a.y) * ease;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = palette.destination;
      ctx.shadowColor = palette.destination;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Destination / active pulse
    if (this.pulse) {
      const el = (now - this.pulse.t0) / 1600;
      if (el < 1) {
        const n = this.nodes[this.pulse.index];
        if (n) {
          const p = this.worldToScreen(n.x, n.y);
          const r = NODE_RADIUS * this.view.scale * (1 + el * 1.6);
          const col = n.isDestination ? palette.destination : this._statusColor(n);
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.7 * (1 - el);
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        this.requestFrame();
      } else {
        this.pulse = null;
      }
    }
  }

  _statusColor(n) {
    if (n.isDestination) return this.palette.destination;
    if (n.isLocal) return this.palette.local;
    if (n.timeout) return this.palette.timeout;
    switch (n.status) {
      case 'slow': return this.palette.slow;
      case 'high': return this.palette.high;
      case 'loss': return this.palette.loss;
      default: return this.palette.hop;
    }
  }

  _edgeColor(n) {
    if (n.timeout) return this.palette.timeout;
    if (n.status === 'loss') return this.palette.loss;
    if (n.status === 'high' || n.status === 'slow') return this.palette.slow;
    return this.palette.hop;
  }

  _drawNode(ctx, i) {
    const n = this.nodes[i];
    const p = this.worldToScreen(n.x, n.y);
    const r = NODE_RADIUS * this.view.scale;
    if (r < 3) return;
    const palette = this.palette;
    const color = this._statusColor(n);
    const isSelected = i === this.selectedIndex;
    const isHovered = i === this.hoveredIndex;

    // Selection ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 8 * this.view.scale + 2, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Node body
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = this._alpha(color, 0.16);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = isHovered || isSelected ? 3 : 2;
    ctx.stroke();

    // Center glyph
    ctx.fillStyle = color;
    ctx.font = `${Math.max(14, r * 0.72)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (n.timeout) {
      this._drawTimeoutGlyph(ctx, p.x, p.y, r);
    } else if (n.isDestination) {
      this._drawStar(ctx, p.x, p.y, r * 0.55, color);
    } else if (n.isLocal) {
      this._drawSquare(ctx, p.x, p.y, r * 0.5, color);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Labels
    const labelAbove = n.isLocal ? 'LOCAL' : n.isDestination ? 'DEST' : `HOP ${n.hop}`;
    ctx.font = `600 ${Math.max(9, Math.min(12, r * 0.42))}px "SF Mono","Consolas",monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = n.isDestination ? palette.destination : palette.text;
    ctx.textBaseline = 'bottom';
    ctx.fillText(labelAbove, p.x, p.y - r - 6);

    let ipLabel = n.ip ? (n.ip.length > 18 ? n.ip.slice(0, 18) + '…' : n.ip) : (n.timeout ? '* * *' : '—');
    ctx.font = `${Math.max(8, Math.min(11, r * 0.36))}px "SF Mono","Consolas",monospace`;
    ctx.fillStyle = palette.muted;
    ctx.textBaseline = 'top';
    ctx.fillText(ipLabel, p.x, p.y + r + 6);

    if (n.city && n.latitude != null) {
      ctx.font = `8px "SF Mono","Consolas",monospace`;
      ctx.fillStyle = palette.muted;
      ctx.fillText(`${n.city}, ${n.country || ''}`, p.x, p.y + r + 20);
    }
  }

  _alpha(hex, a) {
    if (hex.startsWith('#')) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    return hex;
  }

  _drawSquare(ctx, x, y, half, color) {
    const s = half * 0.8;
    ctx.fillStyle = color;
    ctx.fillRect(x - s, y - s, s * 2, s * 2);
    ctx.strokeStyle = this._alpha(color, 1);
    ctx.lineWidth = 1;
    ctx.strokeRect(x - s, y - s, s * 2, s * 2);
  }

  _drawTimeoutGlyph(ctx, x, y, r) {
    const s = r * 0.36;
    ctx.strokeStyle = this.palette.timeout;
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
  }

  _drawStar(ctx, x, y, r, color) {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const radius = k % 2 === 0 ? r : r * 0.45;
      const angle = (Math.PI / 5) * k - Math.PI / 2;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  destroy() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._tooltip) this._tooltip.remove();
    this.canvas = null;
  }
}