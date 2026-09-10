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

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === '/api/health' && req.method === 'GET') {
    const cmd = await ensureCommand();
    return sendJson(res, 200, {
      status: 'ok',
      command: cmd || 'none',
    });
  }

  // Start trace
  if (pathname === '/api/trace' && req.method === 'POST') {
    const body = await readBody(req);
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
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.set(ws, { proc: null, destination: null, tracing: false });

  ws.send(JSON.stringify({ type: 'connected' }));

  ws.on('message', async (raw) => {
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

      const cmd = await ensureCommand();
      if (!cmd) {
        ws.send(JSON.stringify({ type: 'trace_error', message: 'Traceroute command not found. Install traceroute or tracepath.' }));
        return;
      }

      state.tracing = true;
      state.destination = dest;

      ws.send(JSON.stringify({ type: 'trace_started', destination: dest }));

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
          state.tracing = false;
          state.proc = null;
          ws.send(JSON.stringify({ type: 'trace_completed', destination: dest }));
        },
        (err) => {
          state.tracing = false;
          state.proc = null;
          ws.send(JSON.stringify({ type: 'trace_error', message: err.message }));
        }
      );

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
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`NetPulse server running at http://localhost:${PORT}`);
});
