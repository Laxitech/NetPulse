export class HopDetails {
  constructor(cardEl) {
    this.card = cardEl;
  }

  show(node, index, total) {
    if (!node) { this.clear(); return; }
    this.card.innerHTML = this._render(node, index, total);
  }

  showEmpty(message = 'Select a hop or map marker to inspect') {
    this.card.innerHTML = `<div class="info-empty">${message}</div>`;
  }

  clear() {
    this.showEmpty();
  }

  _render(node, index, total) {
    if (node.timeout) {
      return `
        <div class="info-hop-badge badge-timeout">HOP ${node.hop}</div>
        <div class="info-ip">—</div>
        <div class="info-hostname">No response received</div>
        <hr class="info-divider">
        <div class="info-row"><span class="info-label">Status</span><span class="info-value status-timeout">TIMEOUT</span></div>
        <div class="info-row"><span class="info-label">Loss</span><span class="info-value">${node.packetLoss}%</span></div>
        <div class="info-row"><span class="info-label">Coordinates</span><span class="info-value">—</span></div>`;
    }

    const typeName = node.isLocal ? 'LOCAL MACHINE' : node.isDestination ? 'DESTINATION' : `HOP ${node.hop}`;
    const loc = [node.city, node.region, node.country].filter(Boolean).join(', ');
    const coords = node.latitude != null
      ? `${node.latitude.toFixed(4)}, ${node.longitude.toFixed(4)}`
      : '—';
    const statusLabel = node.isDestination ? 'REACHED'
      : node.packetLoss > 0 ? 'PACKET LOSS'
      : node.latency > 150 ? 'HIGH LATENCY'
      : node.latency > 60 ? 'SLOW'
      : 'REACHABLE';

    const rows = [
      ['Status', statusLabel, this._statusClass(node)],
      ['IP Address', node.ip || '—'],
      ['Hostname', node.hostname || '—'],
      ['Latency', node.latency != null ? `${node.latency} ms` : '—'],
      ['Response Time', node.latencies.length ? `${node.latencies.map(String).join(', ')} ms` : '—'],
      ['Packet Loss', `${node.packetLoss}%`],
      ['Coordinates', coords],
    ];
    if (node.org) rows.push(['Provider / ASN', node.org]);
    if (loc) rows.push(['Location', loc]);
    if (node.timezone) rows.push(['Timezone', node.timezone]);

    return `
      <div class="info-hop-badge ${this._badgeClass(node)}">${typeName}</div>
      <div class="info-ip">${node.ip || '—'}</div>
      <div class="info-hostname">${node.hostname || ''}</div>
      <hr class="info-divider">
      ${rows.map(([label, value, cls]) => `
        <div class="info-row">
          <span class="info-label">${label}</span>
          <span class="info-value ${cls || ''}">${value}</span>
        </div>`).join('')}
      ${loc ? `<div class="info-location"><span class="info-location-icon">&#8982;</span><span class="info-location-text">${loc}</span></div>` : ''}
      ${node.latitude != null ? `
        <a class="info-map-link" href="https://www.google.com/maps?q=${node.latitude},${node.longitude}" target="_blank" rel="noopener">Open in Maps &#8599;</a>` : ''}`;
  }

  _badgeClass(node) {
    if (node.isDestination) return 'badge-destination';
    if (node.isLocal) return 'badge-local';
    if (node.status === 'slow' || node.status === 'high') return 'badge-warning';
    if (node.status === 'loss') return 'badge-loss';
    return 'badge-hop';
  }

  _statusClass(node) {
    if (node.isDestination) return 'status-destination';
    if (node.packetLoss > 0) return 'status-loss';
    if (node.latency > 150) return 'status-warning';
    return 'status-ok';
  }
}