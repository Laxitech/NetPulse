// Shared destination validation for NetPulse.
// Pure ESM with no DOM/Node dependencies so both the browser (public/js)
// and the server (server/traceroute.js) can use the exact same logic.

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

// RFC 3986 / RFC 4291 IPv6 including :: compression, IPv4-mapped forms,
// and optional zone identifiers.
const IPV6_REGEX = /^((?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?:(?::[0-9A-Fa-f]{1,4}){1,6})|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:)|fe80:(?::[0-9A-Fa-f]{0,4}){0,4}%[0-9a-zA-Z]+|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])|(?:[0-9A-Fa-f]{1,4}:){1,4}:(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9]))$/;

// RFC 1123 hostname: labels of up to 63 chars, alphanumeric with interior
// hyphens/underscores, optional single trailing dot for FQDNs.
const HOSTNAME_REGEX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)*\.?$/;

// A dotted-numeric-quad that is not valid IPv4 is almost certainly a mistyped
// IP (e.g. 1.300.1.1) rather than a deliberate numeric hostname.
const DOTTED_QUAD_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isValidIPv4(input) {
  return typeof input === 'string' && IPV4_REGEX.test(input.trim());
}

export function isValidIPv6(input) {
  if (typeof input !== 'string') return false;
  let value = input.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  return IPV6_REGEX.test(value);
}

export function isValidHostname(input) {
  if (typeof input !== 'string') return false;
  const value = input.trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith('-') || value.startsWith('.')) return false;
  return HOSTNAME_REGEX.test(value);
}

export function isValidDestination(input) {
  if (typeof input !== 'string') return false;
  const value = input.trim();
  if (!value) return false;
  if (value.startsWith('-')) return false;
  if (!/^[a-zA-Z0-9._:\-\[\]%]+$/.test(value)) return false;
  if (DOTTED_QUAD_REGEX.test(value)) return isValidIPv4(value);
  return isValidIPv6(value) || isValidHostname(value);
}