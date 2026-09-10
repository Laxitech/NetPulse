export function validCoords(lat, lng) {
  return (
    typeof lat === 'number' && isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && isFinite(lng) && lng >= -180 && lng <= 180
  );
}

function parseLoc(loc) {
  if (!loc || typeof loc !== 'string') return { latitude: null, longitude: null };
  const parts = loc.split(',');
  if (parts.length !== 2) return { latitude: null, longitude: null };
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  if (!validCoords(lat, lng)) return { latitude: null, longitude: null };
  return { latitude: lat, longitude: lng };
}

export function deriveStatus(rawHop) {
  if (rawHop.timeout) return 'timeout';
  if (rawHop.packetLoss > 0) return 'loss';
  if (rawHop.latency == null) return 'unreachable';
  if (rawHop.latency > 150) return 'high';
  if (rawHop.latency > 60) return 'slow';
  return 'reachable';
}

/**
 * Normalize a raw traceroute hop from the backend into the application model.
 * raw: { hop, ip, hostname, latency, latencies, packetLoss, timeout, info }
 * The backend delivers `info` lazily via a separate hop_info message, so info
 * may be null when first normalized.
 */
export function normalizeHop(rawHop, index = 0, total = 1) {
  const info = rawHop.info || {};
  const { latitude, longitude } = parseLoc(info.loc);
  const isValidDestination = total > 1 && index === total - 1 && !rawHop.timeout;

  return {
    hop: rawHop.hop,
    ip: rawHop.ip || null,
    hostname: rawHop.hostname || info.hostname || null,
    latency: typeof rawHop.latency === 'number' ? rawHop.latency : null,
    latencies: Array.isArray(rawHop.latencies) ? rawHop.latencies : [],
    packetLoss: typeof rawHop.packetLoss === 'number' ? rawHop.packetLoss : 0,
    timeout: Boolean(rawHop.timeout),
    status: deriveStatus(rawHop),
    isDestination: isValidDestination,
    isLocal: index === 0,
    latitude,
    longitude,
    city: info.city || null,
    region: info.region || null,
    country: info.country || null,
    org: info.org || null,
    timezone: info.timezone || null,
    postal: info.postal || null,
    hostnameIp: info.hostname || null,
  };
}

export function applyInfo(node, info) {
  const withInfo = { info, ...node };
  // Re-normalize the node now that identity data (coords, city, org) exists.
  const next = normalizeHop(
    {
      hop: node.hop,
      ip: node.ip,
      hostname: node.hostname,
      latency: node.latency,
      latencies: node.latencies,
      packetLoss: node.packetLoss,
      timeout: node.timeout,
      info,
    },
    0
  );
  // Preserve graph-derived flags that normalizeHop computes with total context.
  next.isDestination = node.isDestination;
  next.isLocal = node.isLocal;
  next._hopIndex = node._hopIndex;
  next._rawIndex = node._rawIndex;
  return next;
}