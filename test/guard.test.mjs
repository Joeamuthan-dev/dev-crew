import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest } from '../lib/guard.mjs';

const port = 4610;
const req = (over = {}) => ({
  method: 'POST',
  pathname: '/api/tasks',
  port,
  headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-dev-crew': '1', 'content-type': 'application/json', 'content-length': '10' },
  ...over,
});
const withHeaders = h => req({ headers: { ...req().headers, ...h } });

test('allows a dashboard POST', () => {
  assert.equal(checkRequest(req()), null);
});

test('allows same-origin GETs without the header', () => {
  assert.equal(checkRequest({ method: 'GET', pathname: '/api/state', port, headers: { host: `127.0.0.1:${port}` } }), null);
});

test('allows static files', () => {
  assert.equal(checkRequest({ method: 'GET', pathname: '/app.js', port, headers: { host: `localhost:${port}` } }), null);
});

test('rejects another site', () => {
  assert.equal(checkRequest(withHeaders({ origin: 'https://evil.example' })).code, 403);
});

test('rejects the opaque null origin', () => {
  assert.equal(checkRequest(withHeaders({ origin: 'null' })).code, 403);
});

test('rejects a foreign Host (DNS rebinding), even for GETs', () => {
  assert.equal(checkRequest({ method: 'GET', pathname: '/api/state', port, headers: { host: 'evil.example:4610' } }).code, 403);
  assert.equal(checkRequest({ method: 'GET', pathname: '/api/state', port, headers: { host: 'localhost:9999' } }).code, 403);
});

test('rejects a state change without the X-Dev-Crew header', () => {
  const h = { ...req().headers };
  delete h['x-dev-crew'];
  assert.equal(checkRequest(req({ headers: h })).code, 403);
});

test('rejects a text/plain body dressed up as JSON', () => {
  assert.equal(checkRequest(withHeaders({ 'content-type': 'text/plain' })).code, 415);
});

test('allows a POST with no body and no content type', () => {
  const h = { ...req().headers };
  delete h['content-type'];
  h['content-length'] = '0';
  assert.equal(checkRequest(req({ headers: h })), null);
});

test('applies to DELETE as well', () => {
  const h = { ...req().headers };
  delete h['x-dev-crew'];
  assert.equal(checkRequest(req({ method: 'DELETE', pathname: '/api/tasks/t1', headers: h })).code, 403);
});
