import test from 'node:test';
import assert from 'node:assert/strict';
import { validCoords, deriveStatus, normalizeHop, applyInfo } from '../public/js/model.js';

test('validCoords rejects out-of-range and non-numeric', () => {
  assert.equal(validCoords(37.4, -122.1), true);
  assert.equal(validCoords(-90, 180), true);
  assert.equal(validCoords(91, 0), false);
  assert.equal(validCoords(0, 181), false);
  assert.equal(validCoords(NaN, 0), false);
  assert.equal(validCoords('37', 0), false);
  assert.equal(validCoords(37.4, undefined), false);
});

test('normalizeHop without info has no coordinates and reachable status', () => {
  const node = normalizeHop({ hop: 1, ip: '192.168.1.1', latency: 12.3, latencies: [12.3, 11.1] });
  assert.equal(node.hop, 1);
  assert.equal(node.ip, '192.168.1.1');
  assert.equal(node.latitude, null);
  assert.equal(node.longitude, null);
  assert.equal(node.status, 'reachable');
  assert.equal(node.isDestination, false);
  assert.equal(node.isLocal, true);
});

test('normalizeHop parses info.loc coordinates', () => {
  const node = normalizeHop({
    hop: 2,
    ip: '8.8.8.8',
    latency: 9,
    info: { loc: '37.4192,-122.0574', city: 'Mountain View', org: 'AS15169 Google LLC' },
  });
  assert.equal(node.latitude, 37.4192);
  assert.equal(node.longitude, -122.0574);
  assert.equal(node.city, 'Mountain View');
  assert.equal(node.org, 'AS15169 Google LLC');
});

test('normalizeHop rejects malformed loc strings', () => {
  const a = normalizeHop({ hop: 1, ip: '1.1.1.1', info: { loc: 'not-a-location' } });
  assert.equal(a.latitude, null);
  const b = normalizeHop({ hop: 1, ip: '1.1.1.1', info: { loc: '999,999' } });
  assert.equal(b.latitude, null);
});

test('timeout hop is not a destination and reports timeout status', () => {
  const node = normalizeHop({ hop: 13, timeout: true, latency: null }, 12, 13);
  assert.equal(node.timeout, true);
  assert.equal(node.status, 'timeout');
  assert.equal(node.isDestination, false);
  assert.equal(node.latency, null);
});

test('only the final non-timeout hop is the destination', () => {
  const hops = [1, 2, 3].map((hop, i) =>
    normalizeHop({ hop, ip: `10.0.0.${i}`, latency: 10 * i }, i, 3)
  );
  assert.equal(hops[0].isDestination, false);
  assert.equal(hops[1].isDestination, false);
  assert.equal(hops[2].isDestination, true);
  assert.equal(hops[0].isLocal, true);
  assert.equal(hops[2].isLocal, false);
});

test('a single-hop trace is not its own destination', () => {
  const node = normalizeHop({ hop: 1, ip: '192.168.0.1', latency: 1 }, 0, 1);
  assert.equal(node.isDestination, false);
});

test('deriveStatus buckets latency and loss', () => {
  assert.equal(deriveStatus({ latency: 10 }), 'reachable');
  assert.equal(deriveStatus({ latency: 100 }), 'slow');
  assert.equal(deriveStatus({ latency: 200 }), 'high');
  assert.equal(deriveStatus({ latency: null }), 'unreachable');
  assert.equal(deriveStatus({ latency: 5, packetLoss: 25 }), 'loss');
  assert.equal(deriveStatus({ timeout: true }), 'timeout');
});

test('applyInfo adds identity data and preserves destination/local flags', () => {
  const node = normalizeHop({ hop: 7, ip: '8.8.8.8', latency: 20 }, 6, 7);
  const next = applyInfo(node, {
    loc: '37.4192,-122.0574',
    city: 'Mountain View',
    org: 'AS15169 Google LLC',
  });
  assert.equal(next.latitude, 37.4192);
  assert.equal(next.city, 'Mountain View');
  assert.equal(next.isDestination, true); // preserved
  assert.equal(next.isLocal, false); // preserved
  assert.equal(next.latency, 20);
});