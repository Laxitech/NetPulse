# NetPulse

**A live network path visualizer** — run a traceroute and watch your packets hop across the internet, hop by hop, in real time.

NetPulse is a lightweight, dependency-minimal tool that runs `traceroute` from your machine, streams each hop over a WebSocket, and renders the route as an interactive network graph **and** a geographic map. Private hops, CGNAT, packet loss, and timed-out routers are all handled gracefully; public hops are enriched with GeoIP, ASN, and ISP data from ipinfo.io.

![architecture](public/Images/bg-route-canvas.jpg)

---

## Features

- **Real-time traceroute** streamed hop-by-hop over WebSocket
- **Interactive Canvas graph** — zoom, pan, drag, and fit-to-view controls
- **Geographic map** (free OpenStreetMap tiles, no API key) with hop markers and route polyline
- **Live "traveler" marker** that glides along the route and auto-follows the camera like a ride-hailing app; drag the map to take control, hit re-center to resume following
- **GeoIP/ASN/ISP enrichment** (ipinfo.io, cached) per hop
- **Synchronized selection** across graph ↔ map ↔ details panel ↔ hop table
- **Statistics bar** — hop count, average/max latency, destination, trace duration
- **Live hop table** — latency, packet loss, status per hop
- **Progressive rendering** with probe and destination-pulse animations
- **Light/dark themes** (persisted), full-width background artwork
- **Stop / cancel** running traces anytime
- **Community-grade security** — input validation, no shell interpolation

---

## How It Works

```
Browser ←─ WebSocket ─→ Node.js server ←─ spawn() ─→ traceroute / tracepath
     │                                                      │
     └─ Canvas graph + Leaflet map ←─ ipinfo.io (cached) ──┘
```

1. You type a destination (hostname, IPv4, or IPv6). The server launches the system `traceroute`/`tracepath` via `child_process.spawn()` — never through a shell.
2. Each hop is parsed as it streams out, deduplicated, and pushed to the browser as a `hop` message, so the graph and map grow progressively.
3. For each responding public IP, the server lazily resolves GeoIP data (ipinfo.io) and delivers it as independent `hop_info` messages with coordinates (`info.loc`). The map places a marker and the traveler glides to it.
4. The trace ends with `trace_completed` (destination reached or TTL exhausted), `trace_stopped` (user cancelled), or `trace_error`.

### WebSocket protocol

| Message type | Direction | Payload |
| --- | --- | --- |
| `start_trace` | client → server | `{ destination }` |
| `stop_trace` | client → server | — |
| `trace_started` | server → client | `{ destination }` |
| `hop` | server → client | Raw hop `{ hop, ip, hostname, latency, latencies, packetLoss, timeout }` |
| `hop_info` | server → client | `{ ip, info }` where `info` is the ipinfo response (`loc`, `city`, `org`, …) |
| `trace_completed` | server → client | `{ destination }` |
| `trace_stopped` | server → client | — |
| `trace_error` | server → client | `{ message }` |

### REST API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Server + traceroute-command status |
| `GET /api/trace/status` | Whether a trace is in progress |
| `GET /api/ipinfo/:ip` | Cached ipinfo.io lookup for an IP |
| `GET /vendor/*` | Leaflet assets served locally (allowlist enforced) |

---

## Project Structure

```
netpulse/
├── server/
│   ├── server.js          # HTTP + WebSocket server, static/vendor routes, /api endpoints
│   ├── traceroute.js      # spawn-based traceroute runner with heartbeat
│   ├── parser.js          # detectCommand + traceroute line/output parsing
│   ├── parser.test.js     # 15 parser unit tests
│   └── model.test.js      # 9 model unit tests
├── public/
│   ├── index.html         # App shell
│   ├── style.css          # Themes, layout, map/marker/traveler styles
│   ├── app.js             # Orchestrator: WebSocket, routing, selection sync, controls
│   ├── js/
│   │   ├── model.js          # normalization, coordinate parsing, status derivation
│   │   ├── network-graph.js  # Canvas graph component
│   │   ├── traceroute-map.js # Leaflet map + traveler component
│   │   ├── hop-details.js    # details panel component
│   │   └── statistics.js     # stats bar component
│   └── Images/
│       └── bg-route-canvas.jpg  # background artwork
├── scripts/
│   └── smoke-test.mjs      # headless-browser E2E smoke test
└── package.json
```

---

## Requirements

- **Node.js 18+**
- A `traceroute` or `tracepath` binary on the system
- (Optional) internet access for ipinfo.io lookup and OSM map tiles

Install the traceroute binary:

| Distro | Command |
| --- | --- |
| Fedora | `sudo dnf install traceroute` |
| Debian / Ubuntu | `sudo apt install traceroute` |
| macOS | `brew install traceroute` |

---

## Getting Started

```bash
git clone <repository-url>
cd netpulse
npm install
npm start
```

Then open **http://localhost:3000**, type a destination such as `8.8.8.8`, and press **Trace** (or Enter).

### Command line

| Command | Purpose |
| --- | --- |
| `npm start` | Run the server on port 3000 |
| `npm run dev` | Run with auto-restart on file changes |
| `PORT=8080 npm start` | Run on a custom port |

---

## Testing

```bash
npm test
```

Runs both unit suites with Node's built-in test runner (24 tests, no network access required):

- `server/parser.test.js` — traceroute output parsing
- `server/model.test.js` — normalization, coordinate parsing, status derivation, timeout/destination edge cases

### E2E smoke test

Requires the server running (`npm start`) and Google Chrome installed:

```bash
node scripts/smoke-test.mjs                # traces 8.8.8.8
NETPULSE_DEST=example.com node scripts/smoke-test.mjs
```

Drives a real headless browser — starts a trace, verifies the canvas, map markers, live traveler marker, real tile loading, statistics, details panel, dark-theme toggle, and reports console errors.

---

## Security

- Traceroute is invoked via `spawn()` with argument arrays — **never** through a shell
- Destination input is validated: hostnames, IPv4, and IPv6 only
- Arguments starting with `-` and empty values are rejected
- `hop_info` data is escaped before insertion into popups (`escapeHtml`)
- Leaflet is vendored locally through an allowlist (`LEAFLET_ASSETS`) — no CDN, no path traversal
- ipinfo responses are cached in memory; no API token is stored in the client

---

## How Traceroute Works

Traceroute sends packets with incrementing **TTL** (Time To Live) values. Every router along the path decrements the TTL; when it reaches 0 the router replies with an ICMP *Time Exceeded* message. Recording which routers respond for each TTL maps the exact path from source to destination.

> **Note**: Traceroute reveals the path and round-trip characteristics of network hops. It does not measure how much traffic flows through those routers, and load balancers may cause routes to vary between runs.

---

## Limitations

- Some systems require root or raw-socket privileges for traceroute
- Not all routers respond to probes (shown as timeouts / `* * *`)
- Firewalls may block ICMP and cause partial or empty routes
- Results vary across runs due to load balancing — NetPulse shows one live route
- Unresolvable/private hops have no geographic coordinates, so the traveler pauses until the route reaches a public address

---

## Roadmap

- **Phase 2 — Packet Capture** — tshark integration, throughput metrics, protocol statistics
- **Phase 3 — Network Intelligence** ✅ — GeoIP, ASN, ISP per hop
- **Phase 4 — Historical Data** — trace history, latency/loss trend graphs
- **Phase 5 — Monitoring** — multi-target dashboards, continuous tracing, alerts and thresholds

---

## License

[MIT](LICENSE)