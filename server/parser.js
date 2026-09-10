const IP_REGEX = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
const IPV6_REGEX = /([0-9a-fA-F:]+)/;

function parseTracerouteLine(line) {
  if (!line || typeof line !== 'string') return null;

  const trimmed = line.trim();
  if (!trimmed) return null;

  // Match hop number at start: " 1  " or " 1."
  const hopMatch = trimmed.match(/^\s*(\d+)\s/);
  if (!hopMatch) return null;

  const hop = parseInt(hopMatch[1], 10);
  const rest = trimmed.slice(hopMatch[0].length);

  // Check for completely timeout: " 1  * * *"
  if (/^\*\s*\*\s*\*$/.test(rest.trim())) {
    return {
      hop,
      ip: null,
      hostname: null,
      latency: null,
      latencies: [],
      packetLoss: 100,
      timeout: true,
    };
  }

  // Try to extract hostname and IP
  let hostname = null;
  let ip = null;

  // Pattern: hostname (ip) — e.g. "router.local (192.168.1.1)"
  const hostnameIpMatch = rest.match(/([^\s(]+)\s*\(([^)]+)\)/);
  if (hostnameIpMatch) {
    hostname = hostnameIpMatch[1];
    ip = hostnameIpMatch[2];
  } else {
    // Pattern: just IP — e.g. "192.168.1.1"
    const ipMatch = rest.match(IP_REGEX);
    const ipv6Match = rest.match(IPV6_REGEX);
    if (ipMatch) {
      ip = ipMatch[1];
    } else if (ipv6Match) {
      ip = ipv6Match[1];
    }
  }

  // Extract all latency values (numbers followed by ms)
  const latencyMatches = rest.match(/([\d.]+)\s*ms/g);
  const latencies = [];
  if (latencyMatches) {
    for (const m of latencyMatches) {
      const val = parseFloat(m);
      if (!isNaN(val)) latencies.push(val);
    }
  }

  // Detect probe count from line content
  // Count individual * markers (each = 1 timeout probe)
  const stars = rest.match(/\*/g) || [];
  const responded = latencies.length;
  const timeouts = stars.length;
  const totalProbes = responded + timeouts;
  const lost = totalProbes > 0 ? totalProbes - responded : 0;
  const packetLoss = totalProbes > 0 ? Math.round((lost / totalProbes) * 100) : 0;

  const isTimeout = responded === 0;
  const avgLatency = latencies.length > 0
    ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10
    : null;

  return {
    hop,
    ip: ip || null,
    hostname: hostname || null,
    latency: avgLatency,
    latencies,
    packetLoss,
    timeout: isTimeout,
  };
}

function parseTracerouteOutput(output) {
  if (!output || typeof output !== 'string') return [];

  const lines = output.split('\n');
  const hops = [];

  for (const line of lines) {
    const hop = parseTracerouteLine(line);
    if (hop) hops.push(hop);
  }

  return hops;
}

function detectCommand() {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      function cmdExists(cmd) {
        return new Promise((res) => {
          const proc = spawn(cmd, [], { stdio: 'ignore' });
          let done = false;
          proc.on('error', (e) => { if (!done) { done = true; res(e.code !== 'ENOENT'); } });
          proc.on('close', () => { if (!done) { done = true; res(true); } });
          setTimeout(() => { if (!done) { done = true; proc.kill(); res(true); } }, 1000);
        });
      }

      cmdExists('traceroute').then((ok) => {
        if (ok) return resolve('traceroute');
        cmdExists('tracepath').then((ok2) => resolve(ok2 ? 'tracepath' : null));
      });
    });
  });
}

export { parseTracerouteLine, parseTracerouteOutput, detectCommand };
