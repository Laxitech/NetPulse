const TILE_PROVIDERS = {
  light: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  dark: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};

const HOP_COLORS = {
  local: '#059669',
  hop: '#2563eb',
  slow: '#d97706',
  high: '#dc2626',
  loss: '#ef4444',
  timeout: '#9ca3af',
  destination: '#e11d48',
};

const HOP_COLORS_DARK = {
  local: '#00d4aa',
  hop: '#4fc3f7',
  slow: '#ffb347',
  high: '#ff6b6b',
  loss: '#ff6b6b',
  timeout: '#777777',
  destination: '#ff6b9d',
};

export class TracerouteMap {
  constructor(container, { theme = 'light' } = {}) {
    this.container = container;
    this.theme = theme;
    this.hops = []; // normalized nodes that have valid coords, indexed to raw
    this.markers = new Map(); // rawIndex -> marker layer
    this.line = null;
    this.selectedIndex = -1;
    this.activeIndex = -1;
    this.userInteracted = false;
    this.following = true; // "rider mode": camera follows the live traveler
    this._traveling = false;
    this._traveled = false;
    this._furthestIdx = -1;
    this._travelerTimer = null;

    this.map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    this.map.setView([20, 0], 2);
    this._attachTiles(this.theme);
    this._createTraveler();

    this.map.on('dragstart zoomstart', () => { this.userInteracted = true; });
    this.map.on('moveend', () => this._invalidate());

    this.onSelect = null; // fn(rawIndex, node)
  }

  _createTraveler() {
    const icon = L.divIcon({
      className: 'traveler-marker',
      html: '<div class="traveler"><div class="traveler-ring"></div><div class="traveler-dot"></div></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    this._traveler = L.marker([0, 0], { icon, interactive: false, zIndexOffset: 900 }).addTo(this.map);
    this._traveler.setOpacity(0);
  }

  setTheme(theme) {
    this.theme = theme;
    this._attachTiles(theme);
    this._refreshMarkerStyles();
  }

  _attachTiles(theme) {
    if (this._tileLayer) this._tileLayer.remove();
    const provider = TILE_PROVIDERS[theme] || TILE_PROVIDERS.dark;
    this._tileLayer = L.tileLayer(provider.url, {
      maxZoom: 19,
      attribution: provider.attribution,
    }).addTo(this.map);
  }

  _refreshMarkerStyles() {
    for (const [rawIndex, marker] of this.markers) {
      const hop = this.hops[rawIndex];
      if (!hop || !hop.node) continue;
      const node = hop.node;
      const color = this._color(node);
      if (marker.setStyle) {
        marker.setStyle({ fillColor: color });
      }
      if (marker.getPopup && marker.getPopup()) {
        marker.setPopupContent(this._popupHTML(this._markerData(node)));
      }
    }
  }

  _color(node) {
    const palette = this.theme === 'dark' ? HOP_COLORS_DARK : HOP_COLORS;
    if (node.isDestination) return palette.destination;
    if (node.isLocal) return palette.local;
    if (node.timeout) return palette.timeout;
    switch (node.status) {
      case 'slow': return palette.slow;
      case 'high': return palette.high;
      case 'loss': return palette.loss;
      default: return palette.hop;
    }
  }

  begin() {
    for (const marker of this.markers.values()) {
      marker.remove();
    }
    this.markers.clear();
    this.hops = [];
    if (this.line) { this.line.remove(); this.line = null; }
    this.selectedIndex = -1;
    this.activeIndex = -1;
    this.userInteracted = false;
    this.following = true;
    this._traveling = false;
    this._traveled = false;
    this._furthestIdx = -1;
    if (this._travelerTimer) clearInterval(this._travelerTimer);
    if (this._traveler) { this._traveler.setOpacity(0); this._traveler.setLatLng([0, 0]); }
  }

  _markerData(node) {
    return {
      label: node.isLocal ? 'Local Machine' : node.isDestination ? 'Destination' : `Hop ${node.hop}`,
      ip: node.ip || '—',
      latency: node.latency != null ? `${node.latency} ms` : node.timeout ? 'timeout' : '—',
      loss: node.packetLoss > 0 ? `${node.packetLoss}%` : '0%',
      status: node.timeout ? 'Timeout' : node.packetLoss > 0 ? 'Packet loss' : node.isDestination ? 'Reached' : 'Reachable',
      loc: node.latitude != null ? `${node.latitude.toFixed(4)}, ${node.longitude.toFixed(4)}` : '—',
      city: node.city ? [node.city, node.region, node.country].filter(Boolean).join(', ') : '—',
      org: node.org || '—',
    };
  }

  addHop(rawIndex, node) {
    if (node.latitude == null || node.longitude == null) {
      // No coordinates: register the hop as existing without a marker so
      // `_rebuildLine` can connect the nearest available points.
      this.hops[rawIndex] = { node, latlng: null };
      this._markersChanged();
      return;
    }
    const latlng = [node.latitude, node.longitude];
    this.hops[rawIndex] = { node, latlng };

    const color = this._color(node);

    let marker;
    if (node.isDestination) {
      const icon = L.divIcon({
        className: 'dest-marker',
        html: '<div class="dest-star">&#9733;</div>',
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });
      marker = L.marker(latlng, { icon, zIndexOffset: 1000 });
    } else {
      marker = L.circleMarker(latlng, {
        radius: node.isLocal ? 9 : 7,
        color: '#ffffff',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.95,
        className: 'hop-marker',
      });
    }

    const data = this._markerData(node);
    marker.bindPopup(this._popupHTML(data), { autoClose: false, closeButton: true, className: 'netpulse-popup' });

    marker.on('click', () => {
      if (this.onSelect) this.onSelect(rawIndex, node);
      marker.openPopup();
    });

    marker.addTo(this.map);
    this.markers.set(rawIndex, marker);
    if (rawIndex > this._furthestIdx) {
      this._furthestIdx = rawIndex;
      this.moveTraveler(latlng);
    }
    this._markersChanged();
  }

  /**
   * Animate the live "traveler" marker toward a newly discovered hop and keep
   * the camera following it (rider-app style) until the user interacts.
   */
  moveTraveler(latlng) {
    if (this._travelerTimer) clearInterval(this._travelerTimer);
    this._traveler.setOpacity(1);
    this._traveling = true;
    const end = L.latLng(latlng);
    const follow = this.following && !this.userInteracted;

    // First positioned hop: jump straight there and zoom the camera in.
    if (!this._traveled) {
      this._traveled = true;
      this._traveling = false;
      if (follow) this.map.setView(end, 9, { animate: true });
      return;
    }

    const start = this._traveler.getLatLng();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const steps = 22;
    let step = 0;

    this._travelerTimer = setInterval(() => {
      step++;
      const t = ease(step / steps);
      const pt = L.latLng(
        start.lat + (end.lat - start.lat) * t,
        start.lng + (end.lng - start.lng) * t
      );
      this._traveler.setLatLng(pt);
      if (follow) this.map.panTo(pt, { animate: false });

      if (step >= steps) {
        clearInterval(this._travelerTimer);
        this._traveler.setLatLng(end);
        this._traveling = false;
        if (follow) this.map.setView(end, Math.max(this.map.getZoom(), 9), { animate: true });
      }
    }, 28);
  }

  updateHop(rawIndex, node) {
    const existing = this.markers.get(rawIndex);
    const wasDestination = this.hops[rawIndex] && this.hops[rawIndex].node
      ? this.hops[rawIndex].node.isDestination
      : node.isDestination;

    if (existing && wasDestination !== node.isDestination) {
      // Destination flag changed (a later hop became the new destination):
      // rebuild this marker with the correct visual.
      existing.remove();
      this.markers.delete(rawIndex);
      this.addHop(rawIndex, node);
      return;
    }

    if (node.latitude == null || node.longitude == null) {
      if (existing) {
        existing.remove();
        this.markers.delete(rawIndex);
      }
      this.hops[rawIndex] = { node, latlng: null };
      this._markersChanged();
      return;
    }
    const latlng = [node.latitude, node.longitude];
    this.hops[rawIndex] = { node, latlng };
    if (existing) {
      existing.setLatLng(latlng);
      existing.setPopupContent(this._popupHTML(this._markerData(node)));
      const color = this._color(node);
      if (existing.setStyle) existing.setStyle({ fillColor: color });
    } else {
      this.addHop(rawIndex, node);
      return;
    }
    this._markersChanged();
  }

  _markersChanged() {
    this._rebuildLine();
    this._autoFit();
  }

  _rebuildLine() {
    if (this.line) { this.line.remove(); this.line = null; }
    const points = [];
    for (const hop of this.hops) {
      if (hop && hop.latlng) points.push(hop.latlng);
    }
    if (points.length < 2) return;
    this.line = L.polyline(points, {
      color: this.theme === 'dark' ? '#00d4aa' : '#059669',
      weight: 3,
      opacity: 0.85,
      dashArray: '6 6',
      lineCap: 'round',
    }).addTo(this.map);
  }

  _autoFit() {
    if (this.userInteracted || this._traveling) return;
    const points = [];
    for (const hop of this.hops) {
      if (hop && hop.latlng) points.push(hop.latlng);
    }
    if (points.length === 0) return;
    if (points.length === 1) {
      this.map.setView(points[0], 9, { animate: true });
    } else if (!this.following) {
      this.map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 15 });
    }
  }

  fit() {
    // "Re-follow": recenter on the whole route and resume rider-follow mode.
    this.following = true;
    this.userInteracted = false;
    const points = [];
    for (const hop of this.hops) {
      if (hop && hop.latlng) points.push(hop.latlng);
    }
    if (points.length === 0) return;
    if (points.length === 1) {
      this.map.setView(points[0], 9, { animate: true });
    } else {
      this.map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 15 });
    }
  }

  highlightHop(rawIndex) {
    this.activeIndex = rawIndex;
    for (const [idx, marker] of this.markers) {
      const isActive = idx === rawIndex;
      const isSelected = idx === this.selectedIndex;
      if (marker.setStyle) {
        marker.setStyle({ radius: isActive ? 11 : idx === this.selectedIndex ? 9 : 7 });
      }
      marker.getElement && (() => {
        const el = marker.getElement();
        if (el) {
          el.classList.toggle('marker-active', isActive);
          el.classList.toggle('marker-selected', isSelected);
        }
      })();
    }
  }

  selectHop(rawIndex, node) {
    this.selectedIndex = rawIndex;
    const marker = this.markers.get(rawIndex);
    if (marker) {
      this.highlightHop(rawIndex);
      const latlng = marker.getLatLng ? marker.getLatLng() : null;
      if (latlng) {
        this.map.setView(latlng, Math.max(this.map.getZoom(), 8), { animate: true });
      }
      marker.openPopup();
    } else {
      this.highlightHop(rawIndex);
    }
  }

  _popupHTML(d) {
    return `
      <div class="popup-inner">
        <div class="popup-title">${d.label}</div>
        <div class="popup-grid">
          ${d.city !== '—' ? `<span>Location</span><b>${d.city}</b>` : ''}
          <span>IP</span><b>${d.ip}</b>
          <span>Latency</span><b>${d.latency}</b>
          <span>Loss</span><b>${d.loss}</b>
          <span>Status</span><b>${d.status}</b>
          <span>Coords</span><b>${d.loc}</b>
          ${d.org !== '—' ? `<span>Org</span><b>${escapeHtml(d.org)}</b>` : ''}
        </div>
      </div>`;
  }

  _invalidate() {
    if (this.map) {
      clearTimeout(this._invT);
      this._invT = setTimeout(() => { try { this.map.invalidateSize(); } catch {} }, 200);
    }
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

export { HOP_COLORS, HOP_COLORS_DARK };