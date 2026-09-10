import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTracerouteLine, parseTracerouteOutput } from './parser.js';

describe('parseTracerouteLine', () => {
  it('parses a normal hop with IP and latency', () => {
    const result = parseTracerouteLine(' 1  192.168.1.1  1.2 ms  1.4 ms  1.1 ms');
    assert.equal(result.hop, 1);
    assert.equal(result.ip, '192.168.1.1');
    assert.equal(result.hostname, null);
    assert.equal(result.latency, 1.2);
    assert.deepEqual(result.latencies, [1.2, 1.4, 1.1]);
    assert.equal(result.packetLoss, 0);
    assert.equal(result.timeout, false);
  });

  it('parses a hop with hostname and IP', () => {
    const result = parseTracerouteLine(' 3  router.example.com (10.0.0.1)  4.2 ms  3.8 ms  4.0 ms');
    assert.equal(result.hop, 3);
    assert.equal(result.ip, '10.0.0.1');
    assert.equal(result.hostname, 'router.example.com');
    assert.equal(result.latency, 4.0);
    assert.deepEqual(result.latencies, [4.2, 3.8, 4.0]);
    assert.equal(result.packetLoss, 0);
    assert.equal(result.timeout, false);
  });

  it('parses a timeout hop with * * *', () => {
    const result = parseTracerouteLine(' 5  * * *');
    assert.equal(result.hop, 5);
    assert.equal(result.ip, null);
    assert.equal(result.hostname, null);
    assert.equal(result.latency, null);
    assert.deepEqual(result.latencies, []);
    assert.equal(result.packetLoss, 100);
    assert.equal(result.timeout, true);
  });

  it('parses a hop with packet loss', () => {
    const result = parseTracerouteLine(' 4  203.0.113.10  18.4 ms  *  21.2 ms');
    assert.equal(result.hop, 4);
    assert.equal(result.ip, '203.0.113.10');
    assert.equal(result.hostname, null);
    assert.equal(result.latency, 19.8);
    assert.deepEqual(result.latencies, [18.4, 21.2]);
    assert.equal(result.packetLoss, 33);
    assert.equal(result.timeout, false);
  });

  it('parses a hop with single latency', () => {
    const result = parseTracerouteLine(' 2  10.0.0.1  8.4 ms');
    assert.equal(result.hop, 2);
    assert.equal(result.ip, '10.0.0.1');
    assert.equal(result.latency, 8.4);
    assert.deepEqual(result.latencies, [8.4]);
    assert.equal(result.packetLoss, 0);
    assert.equal(result.timeout, false);
  });

  it('parses IPv6 address', () => {
    const result = parseTracerouteLine(' 1  2001:db8::1  2.1 ms  2.3 ms  2.0 ms');
    assert.equal(result.hop, 1);
    assert.equal(result.ip, '2001:db8::1');
    assert.equal(result.latency, 2.1);
    assert.equal(result.packetLoss, 0);
  });

  it('parses a hop with all timeouts', () => {
    const result = parseTracerouteLine(' 7  * * *');
    assert.equal(result.hop, 7);
    assert.equal(result.timeout, true);
    assert.equal(result.packetLoss, 100);
  });

  it('returns null for empty input', () => {
    assert.equal(parseTracerouteLine(''), null);
    assert.equal(parseTracerouteLine(null), null);
    assert.equal(parseTracerouteLine(undefined), null);
  });

  it('returns null for header line', () => {
    assert.equal(parseTracerouteLine('traceroute to 8.8.8.8, 30 hops max, 60 byte packets'), null);
  });

  it('parses a hop with high latency', () => {
    const result = parseTracerouteLine(' 6  172.16.0.1  187.3 ms  192.1 ms  185.7 ms');
    assert.equal(result.hop, 6);
    assert.equal(result.ip, '172.16.0.1');
    assert.equal(result.latency, 188.4);
    assert.equal(result.packetLoss, 0);
    assert.equal(result.timeout, false);
  });

  it('handles malformed line gracefully', () => {
    const result = parseTracerouteLine('not a valid line');
    assert.equal(result, null);
  });
});

describe('parseTracerouteOutput', () => {
  it('parses multiple hops from full output', () => {
    const output = `traceroute to 8.8.8.8, 30 hops max, 60 byte packets
 1  192.168.1.1  1.2 ms  1.4 ms  1.1 ms
 2  10.0.0.1  4.2 ms  3.8 ms  4.0 ms
 3  203.0.113.10  18.4 ms  21.2 ms  19.8 ms
 4  8.8.8.8  31.2 ms  30.8 ms  31.0 ms`;

    const hops = parseTracerouteOutput(output);
    assert.equal(hops.length, 4);
    assert.equal(hops[0].hop, 1);
    assert.equal(hops[0].ip, '192.168.1.1');
    assert.equal(hops[3].hop, 4);
    assert.equal(hops[3].ip, '8.8.8.8');
  });

  it('handles output with timeouts', () => {
    const output = `traceroute to 8.8.8.8, 30 hops max, 60 byte packets
 1  192.168.1.1  1.2 ms  1.4 ms  1.1 ms
 2  * * *
 3  203.0.113.10  18.4 ms  21.2 ms  19.8 ms`;

    const hops = parseTracerouteOutput(output);
    assert.equal(hops.length, 3);
    assert.equal(hops[1].timeout, true);
    assert.equal(hops[1].packetLoss, 100);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseTracerouteOutput(''), []);
    assert.deepEqual(parseTracerouteOutput(null), []);
  });

  it('handles packet loss across hops', () => {
    const output = `traceroute to 8.8.8.8, 30 hops max, 60 byte packets
 1  192.168.1.1  1.2 ms  1.4 ms  1.1 ms
 2  10.0.0.1  4.2 ms  *  4.0 ms
 3  * * *`;

    const hops = parseTracerouteOutput(output);
    assert.equal(hops[0].packetLoss, 0);
    assert.equal(hops[1].packetLoss, 33);
    assert.equal(hops[2].packetLoss, 100);
  });
});
