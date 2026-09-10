export class Statistics {
  constructor(rootEl) {
    this.root = rootEl;
    this.meta = { destStatus: 'IDLE', durationMs: 0, startedAt: null, finishedAt: null, hops: [] };
  }

  reset() {
    this.meta = { destStatus: 'IDLE', durationMs: 0, startedAt: null, finishedAt: null, hops: [] };
    this.render();
  }

  setStartedAt(now) { this.meta.startedAt = now; }

  setFinished(stopwatch) {
    this.meta.finishedAt = stopwatch || performance.now();
    this.render();
  }

  update(hops, status) {
    this.meta.hops = hops;
    this.meta.destStatus = status || this.meta.destStatus;
    this.render();
  }

  render() {
    const hops = this.meta.hops || [];
    const latencies = hops.filter((h) => typeof h.latency === 'number' && !h.timeout).map((h) => h.latency);
    const avg = latencies.length ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10 : null;
    const max = latencies.length ? Math.max(...latencies) : null;
    const durationMs = this.meta.startedAt
      ? (this.meta.finishedAt || performance.now()) - this.meta.startedAt
      : 0;
    const dur = durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : '—';

    this.root.innerHTML = `
      <div class="stat stat-hops">
        <span class="stat-label">HOPS</span>
        <span class="stat-value" id="stat-hops">${hops.length}</span>
      </div>
      <div class="stat stat-avg">
        <span class="stat-label">AVG LATENCY</span>
        <span class="stat-value" id="stat-avg">${avg != null ? `${avg} ms` : '—'}</span>
      </div>
      <div class="stat stat-max">
        <span class="stat-label">MAX LATENCY</span>
        <span class="stat-value" id="stat-max">${max != null ? `${max} ms` : '—'}</span>
      </div>
      <div class="stat stat-dest">
        <span class="stat-label">DESTINATION</span>
        <span class="stat-value stat-status ${this._destClass()}" id="stat-dest">${this.meta.destStatus}</span>
      </div>
      <div class="stat stat-dur">
        <span class="stat-label">DURATION</span>
        <span class="stat-value" id="stat-dur">${dur}</span>
      </div>`;
  }

  _destClass() {
    const s = this.meta.destStatus;
    if (s === 'REACHED') return 'status-ok';
    if (s === 'TRACING') return 'status-warning';
    if (s === 'TIMED OUT' || s === 'FAILED' || s === 'STOPPED') return 'status-loss';
    if (s === 'TIMEOUT') return 'status-timeout';
    return 'status-ok';
  }
}