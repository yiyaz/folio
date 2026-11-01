// k6 load test: concurrent document saves and full-text search.
//
//   k6 run -e BASE_URL=http://localhost:3000 loadtest/folio.js
//   docker run --rm -i --network host -e BASE_URL=http://localhost:3000 grafana/k6 run - < loadtest/folio.js
//
// Each virtual user signs up (sign-up must be open), creates its own document, then loops:
// save the document (optimistic concurrency), read it, and search.
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const saveLatency = new Trend('folio_save_latency', true);
const searchLatency = new Trend('folio_search_latency', true);
const conflicts = new Rate('folio_save_conflicts');

export const options = {
  noCookiesReset: true, // keep each VU's session cookie across iterations
  scenarios: {
    editors: { executor: 'ramping-vus', startVUs: 1, stages: [{ duration: '20s', target: 20 }, { duration: '40s', target: 20 }, { duration: '10s', target: 0 }] },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    folio_save_latency: ['p(95)<300'],
    folio_search_latency: ['p(95)<300'],
    folio_save_conflicts: ['rate<0.01'],
  },
};

const HEADERS = { headers: { 'content-type': 'application/json', 'x-requested-with': 'folio' } };
const send = (method, url, body) => http.request(method, url, JSON.stringify(body), HEADERS);
const WORDS = ['latency', 'pipeline', 'feature', 'store', 'kubernetes', 'gradient', 'boosting', 'rollout', 'incident', 'schema', 'embedding', 'cache'];
const sentence = () => Array.from({ length: 12 }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ');

export function setup() {
  return { run: Date.now().toString(36) };
}

export default function (data) {
  // per-VU state survives iterations
  if (!globalThis.state) {
    const name = `load${data.run}${__VU}`;
    const r = send('POST', `${BASE}/api/auth/signup`, { email: `${name}@load.test`, username: name, displayName: name, password: 'load-test-password' });
    check(r, { 'signed up': (x) => x.status === 201 });
    const ws = http.get(`${BASE}/api/workspaces`).json()[0].id;
    const doc = send('POST', `${BASE}/api/documents`, { workspaceId: ws, name: `Load doc ${__VU}`, content: '# Load test\n' }).json();
    globalThis.state = { ws, docId: doc.id, version: doc.version, content: '# Load test\n' };
  }
  const s = globalThis.state;

  group('edit', () => {
    s.content += `\n${sentence()} [[Welcome to Folio]] #load`;
    const r = send('PUT', `${BASE}/api/documents/${s.docId}/content`, { content: s.content, baseVersion: s.version });
    saveLatency.add(r.timings.duration);
    conflicts.add(r.status === 409);
    if (check(r, { 'saved': (x) => x.status === 200 })) s.version = r.json().version;
  });

  group('read', () => {
    const r = http.get(`${BASE}/api/documents/${s.docId}`);
    check(r, { 'read ok': (x) => x.status === 200 });
  });

  group('search', () => {
    const r = http.get(`${BASE}/api/search?q=${WORDS[Math.floor(Math.random() * WORDS.length)]}`);
    searchLatency.add(r.timings.duration);
    check(r, { 'search ok': (x) => x.status === 200 });
  });

  sleep(1);
}
