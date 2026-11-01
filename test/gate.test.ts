import test from 'node:test';
import assert from 'node:assert/strict';

import { gateRequest } from '../lib/gate.js';

interface RequestOptions {
  remoteAddress?: string | null;
  encrypted?: boolean;
  host?: string;
  origin?: string;
}

/**
 * 构造与 IncomingMessage 相同形状的请求对象。
 */
function makeRequest(options: RequestOptions = {}) {
  const headers: { host?: string; origin?: string } = {};
  if (options.host !== undefined) {
    headers.host = options.host;
  }
  if (options.origin !== undefined) {
    headers.origin = options.origin;
  }

  return {
    socket: {
      remoteAddress: options.remoteAddress === undefined ? '127.0.0.1' : options.remoteAddress,
      encrypted: options.encrypted === true,
    },
    headers,
  };
}

test('gateRequest 放行 loopback 来源的 GET 请求', () => {
  assert.equal(gateRequest(makeRequest({ host: '127.0.0.1:3080' })), null);
  assert.equal(gateRequest(makeRequest({ host: 'localhost:3080' })), null);
  assert.equal(gateRequest(makeRequest({ host: 'localhost' })), null);
  assert.equal(gateRequest(makeRequest({ host: '[::1]:3080' })), null);
});

test('gateRequest 识别 IPv4 映射形式的 loopback 地址', () => {
  assert.equal(gateRequest(makeRequest({ remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:3080' })), null);
  assert.equal(gateRequest(makeRequest({ remoteAddress: '::FFFF:127.0.0.1', host: '127.0.0.1:3080' })), null);
  assert.equal(gateRequest(makeRequest({ remoteAddress: '::1', host: '[::1]:3080' })), null);
});

test('gateRequest 拒绝非 loopback 来源', () => {
  assert.equal(gateRequest(makeRequest({ remoteAddress: '192.168.1.10', host: '127.0.0.1:3080' })), 'bad-remote');
  assert.equal(gateRequest(makeRequest({ remoteAddress: '10.0.0.2', host: '127.0.0.1:3080' })), 'bad-remote');
  assert.equal(
    gateRequest(makeRequest({ remoteAddress: '::ffff:192.168.1.10', host: '127.0.0.1:3080' })),
    'bad-remote',
  );
  assert.equal(gateRequest(makeRequest({ remoteAddress: null, host: '127.0.0.1:3080' })), 'bad-remote');
});

test('gateRequest 拒绝非 loopback 的 Host', () => {
  assert.equal(gateRequest(makeRequest({})), 'bad-host');
  assert.equal(gateRequest(makeRequest({ host: 'example.com:3080' })), 'bad-host');
  assert.equal(gateRequest(makeRequest({ host: 'evil.local' })), 'bad-host');
});

test('gateRequest 校验同源 Origin', () => {
  assert.equal(
    gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })),
    null,
  );
  assert.equal(
    gateRequest(makeRequest({ host: '[::1]:3080', origin: 'http://[::1]:3080' })),
    null,
  );
  assert.equal(gateRequest(makeRequest({ host: '127.0.0.1', origin: 'http://127.0.0.1' })), null);
  assert.equal(
    gateRequest(makeRequest({ encrypted: true, host: '127.0.0.1', origin: 'https://127.0.0.1' })),
    null,
  );
  assert.equal(
    gateRequest(makeRequest({ encrypted: true, host: '127.0.0.1', origin: 'http://127.0.0.1' })),
    'cross-origin',
  );
});

test('gateRequest 放行桌面端 dsh-app://app', () => {
  assert.equal(gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'dsh-app://app' })), null);
});

test('gateRequest 拒绝跨源 Origin', () => {
  assert.equal(
    gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })),
    'cross-origin',
  );
  assert.equal(
    gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'https://evil.example' })),
    'cross-origin',
  );
  assert.equal(
    gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'http://localhost:3080' })),
    'cross-origin',
  );
  assert.equal(gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'ftp://127.0.0.1' })), 'cross-origin');
  assert.equal(gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'null' })), 'cross-origin');
});

test('gateRequest 用 allowedOrigins 放宽 Host 校验', () => {
  const allowed = ['https://dsh.example.com'];

  assert.equal(
    gateRequest(makeRequest({ host: 'dsh.example.com:8443', origin: 'https://dsh.example.com:8443' }), allowed),
    null,
  );
  assert.equal(gateRequest(makeRequest({ host: 'dsh.example.com:8443' })), 'bad-host');
});

test('gateRequest 允许 allowedOrigins 中显式列出的源', () => {
  const allowed = ['https://dsh.example.com'];

  assert.equal(gateRequest(makeRequest({ host: '127.0.0.1:3080', origin: 'https://dsh.example.com' }), allowed), null);
  assert.equal(
    gateRequest(makeRequest({ host: 'dsh.example.com', origin: 'https://other.example.com' }), allowed),
    'cross-origin',
  );
});
