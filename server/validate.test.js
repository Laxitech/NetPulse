import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidIPv4,
  isValidIPv6,
  isValidHostname,
  isValidDestination,
} from '../public/js/validate.js';

describe('isValidIPv4', () => {
  it('accepts valid IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '192.168.2.254', '0.0.0.0', '255.255.255.255', '10.0.0.1', '7.255.0.1']) {
      assert.equal(isValidIPv4(ip), true, ip);
    }
  });

  it('rejects invalid IPv4 addresses', () => {
    for (const ip of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.4e', '1..2.3.4', '', null, 42]) {
      assert.equal(isValidIPv4(ip), false, String(ip));
    }
  });
});

describe('isValidIPv6', () => {
  it('accepts valid IPv6 addresses', () => {
    for (const ip of [
      '2001:db8::1',
      '::1',
      '::',
      '2606:4700:4700::1111',
      'fe80::1%eth0',
      '[2001:db8::1]',
      '::ffff:192.168.0.1',
      '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    ]) {
      assert.equal(isValidIPv6(ip), true, ip);
    }
  });

  it('rejects invalid IPv6 addresses', () => {
    for (const ip of ['12345::', '2001:::db8', 'gggg::', '1:2:3:4:5:6:7:8:9', '8.8.8.8', '', null]) {
      assert.equal(isValidIPv6(ip), false, String(ip));
    }
  });
});

describe('isValidHostname', () => {
  it('accepts valid hostnames', () => {
    for (const h of ['google.com', 'www.google.com', 'localhost', 'a', 'sub-domain.example.co.uk', 'xn--bcher-kva.example', 'my_host.local', '8.8.8.8.']) {
      assert.equal(isValidHostname(h), true, h);
    }
  });

  it('rejects invalid hostnames', () => {
    for (const h of ['-bad.example', 'bad-.example', '.example', 'exa mple.com', 'a..b', '', 'a'.repeat(254), `${'a'.repeat(64)}.com`, 'exa@mple.com', 'exa/mple.com']) {
      assert.equal(isValidHostname(h), false, String(h));
    }
  });
});

describe('isValidDestination', () => {
  it('accepts IPs and hostnames', () => {
    for (const d of ['8.8.8.8', '192.168.1.1', '2606:4700:4700::1111', '::1', 'google.com', 'sub.example.com', 'localhost']) {
      assert.equal(isValidDestination(d), true, d);
    }
  });

  it('rejects unsafe or malformed input', () => {
    for (const d of ['', '  ', '--help', '-n', '8.8.8.8; rm -rf /', 'google.com --flag', '$(id)', '`reboot`', 'http://google.com', 'google.com/path', '1.300.1.1', 'a b', null, 1234]) {
      assert.equal(isValidDestination(d), false, String(d));
    }
  });
});