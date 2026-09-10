import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpsGet } from 'node:https';
import { WebSocketServer } from 'ws';
import { runTraceroute, validateDestination, ensureCommand } from './traceroute.js';
import { parseTracerouteLine } from './parser.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 9901;

const ipInfoCache = new Map();

let myIpCache = null;
let myIpFetching = null;

function fetchMyIp() {
  if (myIpCache) return Promise.resolve(myIpCache);
  if (myIpFetching) return myIpFetching;
  myIpFetching = new Promise((resolve) => {
    const req = httpsGet('https://ipinfo.io/ip', { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const ip = body.trim();
        if (ip && /^[0-9a-fA-F:.]+$/.test(ip)) {
          myIpCache = ip;
          setTimeout(() => { myIpCache = null; }, 6 * 60 * 60 * 1000);
          resolve(ip);
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
  return myIpFetching;
}

function fetchIpInfo(ip) {
  return new Promise((resolve) => {
    if (ipInfoCache.has(ip)) return resolve(ipInfoCache.get(ip));
    const req = httpsGet(`https://ipinfo.io/${ip}/json`, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.bogon) { resolve(null); return; }
          ipInfoCache.set(ip, data);
          resolve(data);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const LEAFLET_ASSETS = new Set([
  '/leaflet.css',
  '/leaflet.js',
  '/images/layers.png',
  '/images/layers-2x.png',
  '/images/marker-icon.png',
  '/images/marker-icon-2x.png',
  '/images/marker-shadow.png',
]);

const clients = new Map(); // ws -> { proc, destination, tracing }

// ─── Rate limiting / anti-DoS ─────────────────────────────

const RATE_LIMITS = {
  api: { window: 60_000, max: 60 },
  ws: { window: 60_000, max: 12 },
  static: { window: 60_000, max: 600 },
};
const MAX_CONCURRENT_TRACES = 3;
const MAX_CLIENTS = 40;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_INFLIGHT = 60;

let activeTraces = 0;
let inflight = 0;
const rateBuckets = new Map(); // ip -> { api: [], ws: [], static: [], wsCount: number }

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

// Bucket key — rate-limit by IP, but let the smoke test assert 429s against
// an isolated bucket so it never throttles real user traffic on the same host.
function getRateKey(req) {
  const ip = getClientIp(req);
  if (req.headers['x-ratelimit-test'] === '1') return `test:${ip}`;
  return ip;
}

function permit(ip, bucket) {
  const lim = RATE_LIMITS[bucket];
  const now = Date.now();
  let rec = rateBuckets.get(ip);
  if (!rec) {
    rec = { api: [], ws: [], static: [] };
    rateBuckets.set(ip, rec);
  }
  let arr = rec[bucket];
  arr = arr.filter((t) => now - t < lim.window);
  rec[bucket] = arr;
  if (arr.length >= lim.max) return false;
  arr.push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateBuckets) {
    for (const b of Object.keys(RATE_LIMITS)) {
      rec[b] = rec[b].filter((t) => now - t < RATE_LIMITS[b].window);
    }
    if (!rec.api.length && !rec.ws.length && !rec.static.length) rateBuckets.delete(ip);
  }
}, 60_000).unref();

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (body.length + chunk.length > MAX_BODY_BYTES) {
        tooBig = true;
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (tooBig) { resolve(null); return; }
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve(null));
  });
}

function cacheHeaders(pathname, url) {
  if (pathname === '/' || pathname.endsWith('.html')) {
    return { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
  }
  if (url.search) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  return { 'Cache-Control': 'public, max-age=3600' };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const rateKey = getRateKey(req);

  if (++inflight > MAX_INFLIGHT) {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: 'Server busy, try again shortly' }));
    inflight--;
    return;
  }
  const release = () => { inflight = Math.max(0, inflight - 1); };
  res.once('finish', release);
  res.once('close', release);

  if (pathname.startsWith('/api/')) {
    if (!permit(rateKey, 'api')) return sendJson(res, 429, { error: 'Too many requests. Slow down.' });
  } else if (!permit(rateKey, 'static')) {
    return sendJson(res, 429, { error: 'Too many requests. Slow down.' });
  }

  // Health check
  if (pathname === '/api/health' && req.method === 'GET') {
    const cmd = await ensureCommand();
    return sendJson(res, 200, {
      status: 'ok',
      command: cmd || 'none',
    });
  }

  // Public IP of this server / client
  if (pathname === '/api/myip' && req.method === 'GET') {
    const ip = await fetchMyIp();
    return sendJson(res, 200, { ip });
  }

  // Start trace
  if (pathname === '/api/trace' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) {
      return sendJson(res, 413, { error: 'Request body too large or malformed' });
    }
    const dest = (body.destination || '').trim();

    if (!validateDestination(dest)) {
      return sendJson(res, 400, { error: 'Invalid destination' });
    }

    const cmd = await ensureCommand();
    if (!cmd) {
      return sendJson(res, 500, { error: 'Traceroute command not found. Install traceroute or tracepath.' });
    }

    return sendJson(res, 200, { status: 'started', destination: dest });
  }

  // Stop trace
  if (pathname === '/api/trace/stop' && req.method === 'POST') {
    for (const [ws, state] of clients) {
      if (state.proc && !state.proc.killed) {
        state.proc.kill('SIGTERM');
        setTimeout(() => {
          if (state.proc && !state.proc.killed) state.proc.kill('SIGKILL');
        }, 2000);
        state.tracing = false;
        ws.send(JSON.stringify({ type: 'trace_stopped' }));
      }
    }
    return sendJson(res, 200, { status: 'stopped' });
  }

  // IP Info
  const ipInfoMatch = pathname.match(/^\/api\/ipinfo\/(.+)$/);
  if (ipInfoMatch && req.method === 'GET') {
    const ip = decodeURIComponent(ipInfoMatch[1]);
    if (!validateDestination(ip)) {
      return sendJson(res, 400, { error: 'Invalid IP' });
    }
    const info = await fetchIpInfo(ip);
    return sendJson(res, 200, info || { ip, error: 'No data' });
  }

  // Status
  if (pathname === '/api/trace/status' && req.method === 'GET') {
    let tracing = false;
    for (const [, state] of clients) {
      if (state.tracing) { tracing = true; break; }
    }
    return sendJson(res, 200, { tracing });
  }

  // Vendor assets (Leaflet)
  if (pathname.startsWith('/vendor/') && req.method === 'GET') {
    const rel = pathname.slice('/vendor'.length);
    if (!LEAFLET_ASSETS.has(rel)) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    let filePath = join(__dirname, '..', 'node_modules', 'leaflet', 'dist', rel.slice(1));
    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        ...cacheHeaders(pathname, url),
      });
      res.end(data);
      return;
    } catch {
      return sendJson(res, 404, { error: 'Not found' });
    }
  }

  // Serve static files
  let filePath = join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...cacheHeaders(pathname, url),
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, request) => {
  const rateKey = getRateKey(request);

  if (!permit(rateKey, 'ws')) {
    ws.close(1008, 'Rate limit exceeded. Slow down.');
    return;
  }
  if (wss.clients.size > MAX_CLIENTS) {
    ws.close(1013, 'Server busy. Try again shortly.');
    return;
  }

  clients.set(ws, { proc: null, destination: null, tracing: false, active: false });

  ws.send(JSON.stringify({ type: 'connected' }));

  let msgTimes = [];

  ws.on('message', async (raw) => {
    const now = Date.now();
    msgTimes = msgTimes.filter((t) => now - t < 10_000);
    if (msgTimes.length >= 30) {
      ws.close(1008, 'Message flood detected.');
      return;
    }
    msgTimes.push(now);

    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.type === 'start_trace') {
      const dest = (msg.destination || '').trim();
      if (!validateDestination(dest)) {
        ws.send(JSON.stringify({ type: 'trace_error', message: 'Invalid destination' }));
        return;
      }

      const state = clients.get(ws);
      if (state.tracing) {
        ws.send(JSON.stringify({ type: 'trace_error', message: 'Trace already in progress' }));
        return;
      }

      if (activeTraces >= MAX_CONCURRENT_TRACES) {
        ws.send(JSON.stringify({ type: 'trace_error', message: 'Too many concurrent traces. Try again in a moment.' }));
        return;
      }

      const cmd = await ensureCommand();
      if (!cmd) {
        ws.send(JSON.stringify({ type: 'trace_error', message: 'Traceroute command not found. Install traceroute or tracepath.' }));
        return;
      }

      state.tracing = true;
      state.active = true;
      state.destination = dest;
      activeTraces++;

      ws.send(JSON.stringify({ type: 'trace_started', destination: dest }));

      const done = () => {
        state.tracing = false;
        state.proc = null;
        if (state.active) {
          state.active = false;
          activeTraces = Math.max(0, activeTraces - 1);
        }
      };

      const proc = runTraceroute(
        dest,
        (line) => {
          const hop = parseTracerouteLine(line);
          if (hop) {
            ws.send(JSON.stringify({ type: 'hop', hop }));
            if (hop.ip && !hop.timeout) {
              fetchIpInfo(hop.ip).then((info) => {
                ws.send(JSON.stringify({ type: 'hop_info', ip: hop.ip, info }));
              });
            }
          }
        },
        (code) => {
          done();
          ws.send(JSON.stringify({ type: 'trace_completed', destination: dest }));
        },
        (err) => {
          done();
          ws.send(JSON.stringify({ type: 'trace_error', message: err.message }));
        }
      );

      if (!proc) {
        done();
        return;
      }
      state.proc = proc;
    }

    if (msg.type === 'stop_trace') {
      const state = clients.get(ws);
      if (state && state.proc && !state.proc.killed) {
        state.proc.kill('SIGTERM');
        setTimeout(() => {
          if (state.proc && !state.proc.killed) state.proc.kill('SIGKILL');
        }, 2000);
        state.tracing = false;
        ws.send(JSON.stringify({ type: 'trace_stopped' }));
      }
    }
  });

  ws.on('close', () => {
    const state = clients.get(ws);
    if (state && state.proc && !state.proc.killed) {
      state.proc.kill('SIGTERM');
    }
    if (state && state.active) {
      state.active = false;
      activeTraces = Math.max(0, activeTraces - 1);
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`NetPulse server running at http://localhost:${PORT}`);
});
