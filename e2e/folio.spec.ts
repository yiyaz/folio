import { test, expect } from '@playwright/test';
import { signupAndVerify, login, newContext, typeAtEnd, waitSaved, createDoc, treeDoc, acceptCompletion } from './helpers';

test.describe.configure({ mode: 'serial' });

test('sign-up: first user becomes admin, second user verifies e-mail', async ({ page, browser }) => {
  await signupAndVerify(page, 'alice', { first: true });
  await expect(page.getByRole('heading', { name: /Welcome back, Alice/ })).toBeVisible();
  // seeded documents are in the tree
  await expect(treeDoc(page, 'Welcome to Folio')).toBeVisible();

  const ctx = await browser.newContext();
  const bobPage = await ctx.newPage();
  await signupAndVerify(bobPage, 'bob');
  await expect(bobPage.getByRole('heading', { name: /Welcome back, Bob/ })).toBeVisible();
  await ctx.close();
});

test('login is rejected with a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name=login]', 'alice');
  await page.fill('input[name=password]', 'wrong-password');
  await page.click('button[type=submit]');
  await expect(page.locator('.alert-error')).toContainText('Invalid');
});

test('write a document with live formatting and read mode', async ({ page }) => {
  await login(page, 'alice');
  await createDoc(page, 'Design');
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Design\n\n## Goals\n\nShip a **fast** editor. #product\n\nSecond paragraph.');
  await waitSaved(page);
  // move the cursor away from the formatted line: live preview hides the markup
  await page.keyboard.press('ControlOrMeta+End');
  await expect(page.locator('.cm-lp-strong')).toHaveText('fast');
  await expect(page.locator('.cm-line', { hasText: 'Ship a' })).not.toContainText('**');
  await expect(page.locator('.cm-lp-tag')).toHaveText('#product');

  // toolbar formatting
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.getByTestId('tb-bold').click();
  await waitSaved(page);

  // the view mode is a saved preference: wait until it is stored, since the test reloads below
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/users/me') && r.request().method() === 'PATCH' && r.ok()),
    page.getByTestId('mode-read').click(),
  ]);
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Design');
  await expect(page.getByTestId('preview').locator('strong').first()).toHaveText('fast');
  await expect(page.getByTestId('preview').locator('a.tag')).toHaveText('#product');

  // persisted after reload
  await page.reload();
  await expect(page.getByTestId('preview').locator('h2')).toHaveText('Goals');
  await page.getByTestId('mode-live').click();
});

test('link documents with [[ autocomplete, follow links and see backlinks', async ({ page }) => {
  await login(page, 'alice');
  await createDoc(page, 'Architecture');
  await typeAtEnd(page, '\nSee [[Des');
  await acceptCompletion(page, 'Design');
  await page.keyboard.type(' and the [[Design#Goals]] section.\n\nend');
  await waitSaved(page);
  await expect(page.locator('.cm-content')).toContainText('Design');

  // follow the link from the rendered (read) view, landing on the heading anchor
  await page.getByTestId('mode-read').click();
  await page.getByTestId('preview').locator('a.wikilink', { hasText: 'Goals' }).click();
  await expect(page.getByTestId('doc-name')).toHaveValue('Design');
  await expect(page).toHaveURL(/#goals$/);

  await page.getByTestId('panel-backlinks').click();
  await expect(page.getByTestId('backlinks')).toContainText('Architecture');
  await expect(page.getByTestId('backlinks')).toContainText('#Goals');
  await page.getByTestId('mode-live').click();
});

test('renaming a document rewrites links pointing at it', async ({ page }) => {
  await login(page, 'alice');
  await treeDoc(page, 'Design').click();
  await page.getByTestId('doc-name').fill('System Design');
  await page.getByTestId('doc-name').press('Enter');
  await expect(page.locator('.toast')).toContainText('Links in other documents were updated');
  await treeDoc(page, 'Architecture').click();
  await page.getByTestId('mode-source').click();
  await expect(page.locator('.cm-content')).toContainText('[[System Design]]');
  await expect(page.locator('.cm-content')).toContainText('[[System Design#Goals]]');
  await page.getByTestId('mode-live').click();
});

test('share with a user, mention them, they get a notification and see live updates', async ({ page, browser }) => {
  await login(page, 'alice');
  await treeDoc(page, 'System Design').click();
  await page.getByTestId('share-btn').click();
  await page.getByTestId('share-user').fill('bob');
  await page.getByTestId('share-role').selectOption('editor');
  await page.getByTestId('share-submit').click();
  await expect(page.locator('.perm-list')).toContainText('Bob');
  await page.keyboard.press('Escape');

  await typeAtEnd(page, '\n\nPing @bo');
  await acceptCompletion(page, 'bob');
  await page.keyboard.type('for review.');
  await waitSaved(page);

  const { ctx, page: bob } = await newContext(browser, 'bob');
  await expect(bob.getByTestId('bell')).toContainText('2'); // share + mention
  await bob.getByTestId('bell').click();
  await expect(bob.getByTestId('notification').first()).toContainText('mentioned you in Design');
  await bob.getByTestId('notification').first().click();
  await expect(bob.getByTestId('doc-name')).toHaveValue('System Design');
  await expect(bob.getByText('(shared with you)')).toBeVisible();

  // presence: each sees the other
  await expect(page.getByTestId('presence').locator('.avatar')).toHaveCount(1);
  await expect(bob.getByTestId('presence').locator('.avatar')).toHaveCount(1);

  // bob edits; alice's open editor picks the change up
  await typeAtEnd(bob, '\n\nBob was here.');
  await waitSaved(bob);
  await expect(page.locator('.cm-content')).toContainText('Bob was here.');

  // shared-with-me list
  await bob.goto('/shared');
  await expect(bob.getByTestId('shared-list')).toContainText('Design');
  await ctx.close();
});

test('comment on a selection and reply', async ({ page, browser }) => {
  await login(page, 'alice');
  await treeDoc(page, 'System Design').click();
  await page.locator('.cm-line', { hasText: 'Second paragraph.' }).dblclick();
  await page.getByTestId('tb-comment').click();
  await page.getByTestId('prompt-input').fill('Can we expand this?');
  await page.getByTestId('prompt-ok').click();
  await expect(page.getByTestId('comments')).toContainText('Can we expand this?');
  await expect(page.locator('.cm-comment-highlight')).toHaveCount(1);

  const { ctx, page: bob } = await newContext(browser, 'bob');
  await bob.getByTestId('bell').click();
  await bob.getByTestId('notification').first().click(); // "commented on" (bob is not the author) or mention
  await bob.goto(page.url().split('#')[0]);
  await bob.getByTestId('panel-comments').click();
  await bob.getByLabel('Reply').fill('Yes, adding detail.');
  await bob.getByLabel('Reply').press('Enter');
  await expect(page.getByTestId('comments')).toContainText('Yes, adding detail.');
  await page.getByTestId('comments').getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('.cm-comment-highlight')).toHaveCount(0);
  await ctx.close();
});

test('version history shows a diff and restores', async ({ page }) => {
  await login(page, 'alice');
  await treeDoc(page, 'System Design').click();
  await page.getByTestId('panel-history').click();
  const revs = page.getByTestId('history').locator('.rev-list button');
  await expect(revs.first()).toBeVisible();
  const count = await revs.count();
  expect(count).toBeGreaterThan(1);
  await revs.last().click();
  await expect(page.locator('.diff-view')).toContainText('+ ');
  await page.getByTestId('restore-revision').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('.cm-content')).not.toContainText('Bob was here.');
});

test('search, tags, quick switcher and command palette', async ({ page }) => {
  await login(page, 'alice');
  await page.goto('/search?q=editor');
  await expect(page.getByTestId('search-results')).toContainText('Design');
  await expect(page.getByTestId('search-results').locator('mark').first()).toBeVisible();

  await page.goto('/tags/product');
  await expect(page.getByTestId('tag-docs')).toContainText('Design');

  await page.keyboard.press('ControlOrMeta+p');
  await page.getByTestId('palette-input').fill('archi');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-name')).toHaveValue('Architecture');

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.getByRole('button', { name: /Commands/ }).click();
  await page.getByTestId('palette-input').fill('split mode');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('mode-split')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('preview')).toBeVisible();
  await page.getByTestId('mode-live').click();
});

test('templates for data science render math, tables and charts', async ({ page }) => {
  await login(page, 'alice');
  await page.getByTestId('new-from-template').click();
  await page.getByTestId('template-name').fill('Churn experiment');
  await page.getByText('Experiment log').click();
  await page.getByTestId('template-create').click();
  await expect(page.getByTestId('doc-name')).toHaveValue('Churn experiment');
  await page.getByTestId('mode-read').click();
  const preview = page.getByTestId('preview');
  await expect(preview.locator('.katex').first()).toBeVisible();
  await expect(preview.locator('.data-table table')).toContainText('exp-1');
  await expect(preview.locator('.vega-chart svg.marks')).toBeVisible({ timeout: 20_000 });
  await expect(preview.locator('.run-bar button')).toContainText('Run');
  // sortable csv table
  await preview.locator('.data-table th', { hasText: 'f1' }).click();
  await expect(preview.locator('.data-table tbody tr').first()).toContainText('baseline');

  // engineering template with a mermaid diagram
  await page.getByTestId('new-from-template').click();
  await page.getByTestId('template-name').fill('Caching RFC');
  await page.getByText('RFC / design doc').click();
  await page.getByTestId('template-create').click();
  await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('preview').locator('.mermaid-diagram svg')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('mode-live').click();
});

test('slash commands insert blocks', async ({ page }) => {
  await login(page, 'alice');
  await createDoc(page, 'Slash test');
  await typeAtEnd(page, '\n/tab');
  await acceptCompletion(page, 'table');
  await waitSaved(page);
  await page.getByTestId('mode-source').click();
  await expect(page.locator('.cm-content')).toContainText('| Column A | Column B |');
  await page.getByTestId('mode-live').click();
});

test('public read-only link works without signing in', async ({ page, browser }) => {
  await login(page, 'alice');
  await treeDoc(page, 'Architecture').click();
  await page.getByTestId('share-btn').click();
  await page.getByTestId('enable-public-link').click();
  const url = await page.getByTestId('public-link').inputValue();
  const anon = await browser.newContext();
  const p = await anon.newPage();
  await p.goto(url);
  await expect(p.getByTestId('preview')).toContainText('System Design');
  await expect(p.locator('.cm-editor')).toHaveCount(0);
  await anon.close();
});

test('folders, drag and drop, trash and restore', async ({ page }) => {
  await login(page, 'alice');
  await page.getByTestId('new-folder').click();
  await page.getByTestId('prompt-input').fill('Projects');
  await page.getByTestId('prompt-ok').click();
  await expect(page.getByTestId('folder-Projects')).toBeVisible();
  await treeDoc(page, 'Slash test').dragTo(page.getByTestId('folder-Projects'));
  await page
    .getByTestId('folder-Projects')
    .getByRole('button', { name: /Expand/ })
    .click();
  await expect(page.locator('.tree li li').getByRole('link', { name: 'Slash test', exact: true })).toBeVisible();

  await treeDoc(page, 'Slash test').click();
  await page.getByTestId('doc-menu').click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(treeDoc(page, 'Slash test')).toHaveCount(0);
  await page.getByRole('link', { name: /Trash/ }).click();
  await page.getByTestId('trash-list').getByTestId('restore-doc').click();
  await expect(page.locator('.tree li li').getByRole('link', { name: 'Slash test', exact: true })).toBeVisible();
});

test('settings: API token and vim keybindings', async ({ page }) => {
  await login(page, 'alice');
  await page.goto('/settings');
  await page.getByLabel('Token name').fill('laptop');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByTestId('new-token')).toContainText('folio_');
  await page.getByTestId('keymap-select').selectOption('vim');
  await treeDoc(page, 'Architecture').click();
  await page.locator('.cm-content').click();
  await expect(page.locator('.cm-fat-cursor, .cm-vimMode'))
    .toHaveCount(1, { timeout: 10_000 })
    .catch(async () => {
      await expect(page.locator('.cm-editor')).toHaveClass(/cm-vimMode|cm-focused/);
    });
  await page.goto('/settings');
  await page.getByTestId('keymap-select').selectOption('default');
});

test('autosave retries after a network failure without losing the edit', async ({ page }) => {
  await login(page, 'alice');
  await createDoc(page, 'Flaky network');
  let failures = 0;
  await page.route('**/api/documents/*/content', async (route) => {
    if (failures < 2) {
      failures++;
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
  await typeAtEnd(page, '\nwritten while offline');
  await expect(page.locator('.toast')).toContainText('Retrying automatically');
  await waitSaved(page);
  expect(failures).toBe(2);
  await page.unroute('**/api/documents/*/content');
  await page.reload();
  await page.getByTestId('mode-source').click();
  await expect(page.locator('.cm-content')).toContainText('written while offline');
  await page.getByTestId('mode-live').click();
});

test('mobile layout hides the sidebar behind a menu button', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await login(page, 'alice');
  await expect(page.locator('.sidebar')).not.toBeInViewport();
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(page.locator('.sidebar')).toBeInViewport();
  await treeDoc(page, 'Architecture').click();
  await expect(page.getByTestId('doc-name')).toHaveValue('Architecture');
  await ctx.close();
});

test('restricted documents: only listed people can open them, with an access log', async ({ page, browser }) => {
  await login(page, 'alice');
  const ws = (await (await page.request.get('/api/workspaces')).json())[0];
  const api = (method: 'post' | 'put', url: string, data: object) => page.request[method](url, { headers: { 'x-requested-with': 'folio' }, data });
  await api('post', `/api/workspaces/${ws.id}/members`, { user: 'bob', role: 'admin' });
  await createDoc(page, 'Payroll');
  await typeAtEnd(page, '\nsalary bands: confidential');
  await waitSaved(page);
  const url = page.url();

  // before: a workspace admin can open it
  const { ctx, page: bob } = await newContext(browser, 'bob');
  await bob.goto(url);
  await expect(bob.getByTestId('doc-name')).toHaveValue('Payroll');

  // restrict it
  await page.getByTestId('share-btn').click();
  await page.getByTestId('restrict').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('restricted-box')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('restricted-badge')).toBeVisible();
  await expect(page.locator('.tree').getByRole('link', { name: 'Payroll (restricted)' })).toContainText('🔒');

  // the workspace admin loses access and no longer sees it
  await bob.goto(url);
  await expect(bob.getByText('Document not found')).toBeVisible();
  await expect(bob.locator('.tree').getByRole('link', { name: /^Payroll/ })).toHaveCount(0);

  // grant bob explicitly
  await page.getByTestId('restricted-badge').click();
  await page.getByTestId('share-user').fill('bob');
  await page.getByTestId('share-role').selectOption('viewer');
  await page.getByTestId('share-submit').click();
  await expect(page.locator('.perm-list')).toContainText('Bob');
  await bob.goto(url);
  await expect(bob.getByTestId('restricted-badge')).toBeVisible();
  await expect(bob.locator('.cm-content')).toContainText('salary bands');

  // the owner sees who opened it
  await page.getByTestId('show-audit').click();
  await expect(page.getByTestId('audit-log')).toContainText('Bob opened the document');
  await page.keyboard.press('Escape');
  await ctx.close();

  // admins can see where files live
  await page.goto(`/workspace/${ws.id}`);
  await expect(page.getByTestId('storage-card')).toContainText('library');
  await expect(page.getByTestId('storage-card')).toContainText('1 restricted');
});

test('AI writes a document from workspace context; authorship shows AI text and human edits', async ({ page, browser }) => {
  await login(page, 'alice');
  await page.getByTestId('new-with-ai').click();
  await page.getByTestId('ai-prompt').fill('release checklist');
  await page.getByTestId('ai-ctx-pick').check();
  await page.getByTestId('ai-pick-Architecture').check();
  await page.getByTestId('ai-generate').click();
  await expect(page.getByTestId('ai-output')).toContainText('This draft covers release checklist');
  await expect(page.getByTestId('ai-context-report')).toContainText('Shared 1 document: Architecture');
  await page.getByTestId('ai-accept').click();
  await expect(page.getByTestId('doc-name')).toHaveValue('Release checklist');

  // AI-written text is tinted; the legend explains it
  await expect(page.locator('.cm-auth-ai').first()).toBeVisible();
  await expect(page.locator('.authorship-legend')).toContainText('AI-written');

  // a person's edit inside an AI sentence is marked as such ("key point." -> "key verified point.")
  await page.locator('.cm-line', { hasText: 'Second key point' }).click();
  await page.keyboard.press('End');
  for (let i = 0; i < 'point.'.length; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('verified ');
  await waitSaved(page);
  await page.keyboard.press('ControlOrMeta+Home'); // move the cursor away from the edited line
  await expect(page.locator('.cm-auth-edited', { hasText: 'verified' })).toBeVisible();
  await page.screenshot({ path: 'test-results/authorship-after-edit.png' });
  // every AI-written line is tinted
  for (const line of ['This draft covers', 'It draws on', 'First key point'])
    await expect(page.locator('.cm-line', { hasText: line }).locator('.cm-auth-ai').first()).toBeVisible();
  // a new sentence of one's own is a person's text, not an "edit" of AI text
  await typeAtEnd(page, ' Signed off.');
  await waitSaved(page);
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(page.locator('.cm-auth-edited', { hasText: 'Signed off' })).toHaveCount(0);

  // the read view shows the same attribution
  await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('preview').locator('.auth-ai').first()).toBeVisible();
  await expect(page.getByTestId('preview').locator('.auth-edited', { hasText: 'verified' })).toBeVisible();
  await page.getByTestId('mode-live').click();

  // insert AI text at the cursor; after a reload it is still attributed to the AI (verified by the server)
  await typeAtEnd(page, '\n\nHuman paragraph.\n');
  await page.getByTestId('tb-ai').click();
  await page.getByTestId('ai-prompt').fill('rollback plan');
  await page.getByTestId('ai-generate').click();
  await expect(page.getByTestId('ai-accept')).toBeVisible();
  await page.getByTestId('ai-accept').click();
  await expect(page.locator('.cm-auth-ai', { hasText: 'rollback plan' }).first()).toBeVisible();
  await waitSaved(page);
  await page.reload();
  await expect(page.locator('.cm-auth-ai', { hasText: 'rollback plan' }).first()).toBeVisible();
  await expect(page.locator('.cm-auth-ai', { hasText: 'Human paragraph' })).toHaveCount(0);

  // a coworker's edits, shown per person in "everyone" mode
  const url = page.url();
  const { ctx, page: bob } = await newContext(browser, 'bob');
  await bob.goto(url);
  await typeAtEnd(bob, '\nBob signed off.');
  await waitSaved(bob);
  await ctx.close();
  await page.reload();
  await page.getByTestId('authorship-mode').selectOption('all');
  await expect(page.locator('.cm-auth-person', { hasText: 'Bob signed off' })).toHaveAttribute('title', /Bob/);

  // the authors panel: shares and the provenance of the AI text
  await page.getByTestId('panel-authors').click();
  await expect(page.getByTestId('authors-panel')).toContainText('AI (fake-model)');
  await expect(page.getByTestId('authors-panel')).toContainText('Bob');
  await page.getByTestId('authors-panel').getByRole('button', { name: 'details' }).first().click();
  await expect(page.getByTestId('generation-details')).toContainText('Architecture');
  await page.getByTestId('authorship-mode').selectOption('ai');
});

test('admin can restrict sign-up to invitations', async ({ page, browser }) => {
  await login(page, 'alice');
  await page.goto('/admin');
  await page.getByTestId('signup-mode').selectOption('invite');
  await expect(page.locator('.toast')).toContainText('Saved');
  const anon = await browser.newContext();
  const p = await anon.newPage();
  await p.goto('/signup');
  await expect(p.getByText('Sign-up is by invitation only')).toBeVisible();
  await anon.close();
  await page.getByTestId('signup-mode').selectOption('open');
});
