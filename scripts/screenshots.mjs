// Regenerates the README screenshots in docs/screenshots.
//
//   pnpm build && node scripts/screenshots.mjs
//
// Starts a fresh Folio instance (DATABASE_URL defaults to a local folio_shots database, which is
// dropped and recreated), seeds demo users and documents through the API, and captures screens
// with Playwright.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHOTS_PORT ?? 3300);
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(root, 'docs/screenshots');

// ---------- server ----------
const server = spawn('node', ['e2e/start-server.mjs'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://folio:folio@localhost:5432/folio_shots',
    WEB_DIST: 'apps/web/dist',
    STORAGE_FS_ROOT: '.data/shots-storage',
    MAIL_TRANSPORT: 'log',
    LOG_LEVEL: 'warn',
    REQUIRE_EMAIL_VERIFICATION: 'false',
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    PUBLIC_URL: BASE,
    APP_SECRET: 'screenshots-secret-screenshots-secret',
  },
});
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/readyz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// ---------- API helpers ----------
class Api {
  cookie = '';
  async req(method, url, body, form) {
    const headers = { 'x-requested-with': 'folio', cookie: this.cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const set = res.headers.get('set-cookie');
    if (set?.startsWith('folio_session=')) this.cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
}
const PASSWORD = 'screenshot-password';
async function user(username, displayName) {
  const a = new Api();
  a.user = (await a.req('POST', '/api/auth/signup', { email: `${username}@acme.dev`, username, displayName, password: PASSWORD })).user;
  return a;
}

// ---------- seed ----------
const alice = await user('alice', 'Alice Chen');
const bob = await user('bob', 'Bob Martinez');
await user('priya', 'Priya Natarajan');
const ws = (await alice.req('POST', '/api/workspaces', { name: 'ML Platform' })).id;
await alice.req('POST', `/api/workspaces/${ws}/members`, { user: 'priya', role: 'editor' });
const folder = async (name, parentId = null) => (await alice.req('POST', '/api/folders', { workspaceId: ws, name, parentId })).id;
const doc = async (name, content, folderId = null) => (await alice.req('POST', '/api/documents', { workspaceId: ws, folderId, name, content })).id;

const design = await folder('Design docs');
const experiments = await folder('Experiments');
const runbooks = await folder('Runbooks');

const featureStore = await doc(
  'Feature Store',
  `---
tags: [design, platform]
status: in review
---
# Feature Store

A shared store for **ML features** so training and serving read *exactly* the same values. Owner: @alice · Reviewers: @bob @priya #platform

## Goals
- [x] Point-in-time correct training sets
- [x] Online serving under **10 ms p99**
- [ ] Backfills without downtime
- [ ] Self-serve feature registration

## Architecture

\`\`\`mermaid
flowchart LR
  E[Event stream] --> T[Transform jobs]
  B[(Warehouse)] --> T
  T --> O[(Online store)]
  T --> F[(Offline store)]
  O --> S[Model serving]
  F --> TR[Training pipelines]
\`\`\`

## Online serving
Reads go through a gRPC gateway backed by Redis. Hot keys are cached in-process for 1 s. ^online-latency

| Tier | p50 | p99 | Notes |
|---|---|---|---|
| Redis | 1.2 ms | 6.8 ms | 3 shards |
| Gateway | 2.1 ms | 9.4 ms | includes auth |

## Open questions
See the latency results in [[Churn model v3#Results]] and the on-call steps in [[Feature backfill runbook]].
`,
  design,
);

const churn = await doc(
  'Churn model v3',
  `---
tags: [experiment, churn]
owner: alice
status: done
---
# Churn model v3

Gradient-boosted trees with features from the [[Feature Store]]. Hypothesis: adding *recency* features lifts recall at a fixed precision.

## Setup
- **Dataset:** 2.4M accounts, 90-day window, 8.1% positive rate
- **Model:** LightGBM, 600 trees, early stopping on log loss
- **Metric:** $F_1 = 2 \\cdot \\frac{P \\cdot R}{P + R}$, reported at the threshold that keeps precision $\\geq 0.80$

## Results

\`\`\`vega-lite
{
  "width": "container", "height": 220,
  "data": {"values": [
    {"run": "baseline", "metric": "precision", "value": 0.80}, {"run": "baseline", "metric": "recall", "value": 0.61},
    {"run": "+ recency", "metric": "precision", "value": 0.80}, {"run": "+ recency", "metric": "recall", "value": 0.68},
    {"run": "+ recency + usage", "metric": "precision", "value": 0.81}, {"run": "+ recency + usage", "metric": "recall", "value": 0.72}
  ]},
  "mark": {"type": "bar", "cornerRadiusEnd": 3},
  "encoding": {
    "x": {"field": "run", "type": "nominal", "sort": null, "title": null, "axis": {"labelAngle": 0}},
    "xOffset": {"field": "metric"},
    "y": {"field": "value", "type": "quantitative", "scale": {"domain": [0, 1]}},
    "color": {"field": "metric", "type": "nominal", "scale": {"range": ["#3b5bdb", "#20c997"]}}
  }
}
\`\`\`

\`\`\`csv
run,features,precision,recall,f1,auc
baseline,42,0.80,0.61,0.692,0.871
+ recency,51,0.80,0.68,0.735,0.889
+ recency + usage,63,0.81,0.72,0.762,0.902
\`\`\`

## Analysis

\`\`\`python run
lift = (0.72 - 0.61) / 0.61
print(f"Recall lift at fixed precision: {lift:.1%}")
\`\`\`

Recency features close most of the gap; usage features add a smaller second step. Decision recorded in [[ADR-012 Adopt feature store]]. #experiment
`,
  experiments,
);

await doc(
  'Feature backfill runbook',
  `# Feature backfill runbook\n\n1. Pause the transform job for the affected [[Feature Store]] view.\n2. Run the backfill with \`--point-in-time\`.\n3. Compare row counts against the warehouse snapshot.\n\nLatency guidance: [[Feature Store#^online-latency]] #runbook\n`,
  runbooks,
);
await doc(
  'ADR-012 Adopt feature store',
  `---\ntags: [adr]\nstatus: accepted\n---\n# ADR-012 Adopt feature store\n\n## Decision\nAdopt the [[Feature Store]] for all new models. Evidence: [[Churn model v3]].\n`,
  design,
);
await doc(
  'Q3 planning notes',
  `# Q3 planning notes\n\n- Ship [[Feature Store]] GA\n- Retrain churn model monthly @priya\n- Evaluate vector search for #embeddings\n`,
);

await alice.req('POST', `/api/documents/${featureStore}/permissions`, { user: 'bob', role: 'editor' });
const fsDoc = await alice.req('GET', `/api/documents/${featureStore}`);
const anchor = 'Hot keys are cached in-process for 1 s.';
const at = fsDoc.content.indexOf(anchor);
const c = await bob.req('POST', `/api/documents/${featureStore}/comments`, {
  body: 'Is 1 s safe for features that change per request? Maybe make the TTL configurable per feature view.',
  anchorText: anchor,
  anchorStart: at,
  anchorEnd: at + anchor.length,
});
await alice.req('POST', `/api/documents/${featureStore}/comments`, { body: 'Good call — added to open questions. @priya can you own this?', parentId: c.id });

// a notebook attachment embedded in the experiment
const nb = {
  metadata: { language_info: { name: 'python' } },
  cells: [
    { cell_type: 'markdown', source: ['### Feature importance (top 5)'] },
    {
      cell_type: 'code',
      execution_count: 7,
      source: ['imp = model.feature_importance(importance_type="gain")\n', 'top5(imp, names)'],
      outputs: [
        {
          output_type: 'execute_result',
          data: {
            'text/plain': [
              'days_since_last_login   0.214\n',
              'sessions_7d             0.163\n',
              'plan_tier               0.118\n',
              'support_tickets_30d     0.094\n',
              'seats_used_ratio        0.081',
            ],
          },
        },
      ],
    },
  ],
};
const form = new FormData();
form.append('workspaceId', ws);
form.append('documentId', churn);
form.append('file', new Blob([JSON.stringify(nb)], { type: 'application/json' }), 'importance.ipynb');
const att = await alice.req('POST', '/api/attachments', undefined, form);
const churnDoc = await alice.req('GET', `/api/documents/${churn}`);
await alice.req('PUT', `/api/documents/${churn}/content`, {
  content: churnDoc.content.replace('## Analysis\n', `## Analysis\n\n\`\`\`notebook\nsrc: ${att.url}\n\`\`\`\n`),
  baseVersion: churnDoc.version,
});

// a restricted document, shared with one person, opened by them
const people = await folder('People');
const comp = await doc('Compensation bands 2027', '# Compensation bands 2027\n\n| Level | Band |\n|---|---|\n| L4 | … |\n', people);
await alice.req('PUT', `/api/documents/${comp}/classification`, { classification: 'restricted' });
await alice.req('POST', `/api/documents/${comp}/permissions`, { user: 'priya', role: 'viewer' });
const priya = new Api();
await priya.req('POST', '/api/auth/login', { login: 'priya', password: PASSWORD });
await priya.req('GET', `/api/documents/${comp}`);

// ---------- screenshots ----------
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
async function session(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...opts });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=login]', 'alice');
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`);
  await page.evaluate((id) => localStorage.setItem('folio.workspace', id), ws);
  await page.evaluate((ids) => localStorage.setItem('folio.tree.expanded', JSON.stringify(ids)), [design, experiments, runbooks]);
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const open = async (page, id, mode) => {
  await page.goto(`${BASE}/d/${id}`);
  await page.waitForSelector('.cm-editor', { state: 'attached' });
  if (mode) await page.getByTestId(`mode-${mode}`).click();
  await page.waitForTimeout(600);
};

const { ctx, page } = await session();

// 1. live editor with comments
await open(page, featureStore, 'live');
await page.getByTestId('panel-comments').click();
await page.waitForTimeout(500);
await shot(page, 'editor-live');

// 2. split mode with a rendered mermaid diagram
await open(page, featureStore, 'split');
await page.locator('.pane-preview').evaluate((el) => el.querySelector('.mermaid-diagram')?.scrollIntoView({ block: 'center' }));
await page.locator('.pane-editor .cm-scroller').evaluate((el) => (el.scrollTop = 260));
await page.waitForSelector('.mermaid-diagram svg');
await page.waitForTimeout(500);
await shot(page, 'split-view');

// 3. data science: math, chart, table
await open(page, churn, 'read');
await page.waitForSelector('.vega-chart svg.marks', { timeout: 20000 });
await page.locator('.pane-preview').evaluate((el) => (el.scrollTop = 260));
await page.waitForTimeout(600);
await shot(page, 'data-science');

// 4. notebook embed and runnable python
await page.locator('.notebook-embed').scrollIntoViewIfNeeded();
await page.locator('.pane-preview').evaluate((el) => {
  const nb = el.querySelector('.data-table');
  if (nb) el.scrollTop = nb.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 20;
});
await page.waitForTimeout(400);
await shot(page, 'notebook');

// 5. backlinks and outline
await open(page, featureStore, 'read');
await page.getByTestId('panel-backlinks').click();
await page.waitForSelector('[data-testid=backlinks] li');
await page.waitForTimeout(400);
await shot(page, 'backlinks');

// 6. sharing
await open(page, featureStore, 'live');
await page.getByTestId('share-btn').click();
await page.waitForSelector('.perm-list li');
await page.waitForTimeout(300);
await shot(page, 'share');
await page.keyboard.press('Escape');

// 7. command palette and search
await page.getByRole('button', { name: /Commands/ }).click();
await page.getByTestId('palette-input').fill('mode');
await page.waitForTimeout(300);
await shot(page, 'command-palette');
await page.keyboard.press('Escape');
await page.goto(`${BASE}/search?q=feature%20latency`);
await page.waitForSelector('[data-testid=search-results] li');
await shot(page, 'search');

// 8. templates
await page.getByTestId('new-from-template').click();
await page.waitForTimeout(400);
await shot(page, 'templates');
await page.keyboard.press('Escape');
await ctx.close();

// 8b. restricted document: share dialog with the access log
const r = await session();
await r.page.evaluate((ids) => localStorage.setItem('folio.tree.expanded', JSON.stringify(ids)), [design, experiments, runbooks, people]);
await open(r.page, comp, 'read');
await r.page.getByTestId('restricted-badge').click();
await r.page.getByTestId('show-audit').click();
await r.page.waitForSelector('[data-testid=audit-log] li');
await r.page.waitForTimeout(300);
await shot(r.page, 'restricted');
await r.page.keyboard.press('Escape');

// 8c. where the files are stored
await r.page.goto(`${BASE}/workspace/${ws}`);
await r.page.getByTestId('storage-card').scrollIntoViewIfNeeded();
await r.page.waitForTimeout(300);
await r.page.getByTestId('storage-card').screenshot({ path: path.join(OUT, 'storage.png') });
await r.ctx.close();

// 9. dark mode
const dark = await session({ colorScheme: 'dark' });
await open(dark.page, churn, 'split');
await dark.page.waitForSelector('.vega-chart svg.marks', { timeout: 20000 });
await dark.page.waitForTimeout(800);
await shot(dark.page, 'dark-mode');
await dark.ctx.close();

// 10. mobile
const mobile = await session({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await open(mobile.page, featureStore, 'read');
await shot(mobile.page, 'mobile');
await mobile.ctx.close();

await browser.close();
console.log(`screenshots written to ${OUT}`);
stop();
process.exit(0);
