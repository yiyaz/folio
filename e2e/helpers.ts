import { expect, type Page, type Browser } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const MAIL_DIR = path.resolve(import.meta.dirname, '../.mail/e2e');
export const PASSWORD = 'e2e-password-123';

export function latestMail(to: string): { subject: string; text: string } {
  if (!existsSync(MAIL_DIR)) throw new Error('no mail yet');
  const mails = readdirSync(MAIL_DIR)
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(MAIL_DIR, f), 'utf8')))
    .filter((m) => m.to === to);
  if (!mails.length) throw new Error(`no mail for ${to}`);
  return mails[mails.length - 1];
}

export async function signupAndVerify(page: Page, name: string, opts: { first?: boolean } = {}) {
  await page.goto('/signup');
  await page.fill('input[name=displayName]', name[0].toUpperCase() + name.slice(1));
  await page.fill('input[name=username]', name);
  await page.fill('input[name=email]', `${name}@example.com`);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button[type=submit]');
  if (opts.first) {
    // the first account is the admin and is verified automatically
    await expect(page).toHaveURL('/');
    return;
  }
  await expect(page.getByText('Check your inbox')).toBeVisible();
  let link = '';
  await expect.poll(() => {
    try {
      link = /http:\/\/\S+\/verify\?token=\S+/.exec(latestMail(`${name}@example.com`).text)![0];
      return true;
    } catch {
      return false;
    }
  }).toBe(true);
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page).toHaveURL('/');
}

export async function login(page: Page, name: string) {
  await page.goto('/login');
  await page.fill('input[name=login]', name);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
}

export async function newContext(browser: Browser, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, name);
  return { ctx, page };
}

/** Type into the CodeMirror editor at the end of the document. */
export async function typeAtEnd(page: Page, text: string) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 10_000 });
}

export async function createDoc(page: Page, name: string) {
  await page.getByTestId('new-doc').click();
  await page.getByTestId('prompt-input').fill(name);
  await page.getByTestId('prompt-ok').click();
  await expect(page.getByTestId('doc-name')).toHaveValue(name);
  await expect(page.locator('.cm-content')).toBeVisible();
}

export function treeDoc(page: Page, name: string) {
  return page.locator('.tree').getByRole('link', { name, exact: true });
}

/** Wait until the autocomplete list has settled with `label` selected, then accept it. */
export async function acceptCompletion(page: Page, label: string) {
  const selected = page.locator('.cm-tooltip-autocomplete li[aria-selected="true"]');
  await expect(selected).toContainText(label);
  await page.waitForTimeout(150);
  await expect(selected).toContainText(label);
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
}
