// Stage a Microsoft Store submission draft through the Partner Center UI.
//
// The Partner Center APIs want Entra ID credentials this account does not
// have, so the automation drives the browser the owner already signs into.
// Playwright is already this repo's browser dependency; nothing new is added.
//
// No password is ever handled here. The sign-in happens once, by hand, in a
// dedicated browser profile that lives outside the repo (see PROFILE below).
// That profile holds a live Microsoft session: treat it like a credential.
//
//   node scripts/store-draft.mjs setup              # sign in once, record the page URLs
//   node scripts/store-draft.mjs probe              # dump those pages for selector work
//   node scripts/store-draft.mjs stage --msix <path> [--version x.y.z] [--dry]
//
// `stage` uploads the package and writes the three "what's new" texts, then
// stops. Submit for certification stays a human click.
//
// Partner Center is a moving UI: every step fails loudly with a screenshot and
// an element dump rather than guessing, so a broken run is diagnosable from
// the artifacts instead of a rerun.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { configuredVersion, readWhatsNew, repoRoot } from './store-notes.mjs';

const STATE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'state'),
  'funkot-store-draft',
);
const PROFILE = path.join(STATE, 'profile');
const CONFIG = path.join(STATE, 'config.json');
const DASHBOARD = 'https://partner.microsoft.com/dashboard/apps-and-games/overview';
const LANGUAGES = ['ja', 'en', 'id'];

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(String(data).trim());
    });
  });
}

async function readConfig() {
  if (!existsSync(CONFIG)) {
    throw new Error(`no ${CONFIG} — run: node scripts/store-draft.mjs setup`);
  }
  return JSON.parse(await readFile(CONFIG, 'utf8'));
}

async function open({ headless = false } = {}) {
  // Loaded here rather than at the top so --dry and the notes checks work in
  // a checkout that has not run npm ci.
  const { chromium } = await import('@playwright/test');
  await mkdir(PROFILE, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// What the page offers right now: enough to write a locator against, and the
// first thing to look at when a step stops matching.
async function describe(page) {
  return page.evaluate(() => {
    const label = (el) =>
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el.labels && el.labels[0]?.innerText) ||
      el.getAttribute('name') ||
      el.id ||
      (el.innerText || '').trim().slice(0, 60);
    const pick = (selector, kind) =>
      [...document.querySelectorAll(selector)].map((el) => ({
        kind,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        label: label(el),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      }));
    return {
      url: location.href,
      title: document.title,
      elements: [
        ...pick('input[type="file"]', 'file'),
        ...pick('textarea', 'textarea'),
        ...pick('input:not([type="file"])', 'input'),
        ...pick('button, [role="button"]', 'button'),
      ].filter((el) => el.visible),
    };
  });
}

async function dump(page, dir, name) {
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  await writeFile(
    path.join(dir, `${name}.json`),
    `${JSON.stringify(await describe(page), null, 2)}\n`,
    'utf8',
  );
  return dir;
}

async function fail(page, step, message) {
  const dir = path.join(STATE, `failed-${step}-${Date.now()}`);
  await dump(page, dir, step);
  throw new Error(`${message}\nwhat the page looked like: ${dir}`);
}

// --- setup ------------------------------------------------------------------

// The URLs are recorded rather than constructed: Partner Center's paths carry
// ids this script has no other way to learn, and a recorded URL cannot be
// wrong about a product the owner is looking at.
async function setup() {
  const { context, page } = await open();
  try {
    await page.goto(DASHBOARD);
    console.log('Sign in if asked. This profile keeps the session, so this is a one-time step.');
    await ask('\nSigned in? Press Enter... ');

    const config = { listings: {} };
    await ask('Open the product\'s Packages page for a submission, then press Enter... ');
    config.packagesUrl = page.url();

    for (const lang of LANGUAGES) {
      await ask(`Open the Store listing page for "${lang}", then press Enter... `);
      config.listings[lang] = page.url();
    }

    await mkdir(STATE, { recursive: true });
    await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    console.log(`\nOK: recorded ${CONFIG}`);
    for (const [key, value] of Object.entries({ packages: config.packagesUrl, ...config.listings })) {
      console.log(`  ${key}: ${value}`);
    }
  } finally {
    await context.close();
  }
}

// --- probe ------------------------------------------------------------------

async function probe() {
  const config = await readConfig();
  const dir = path.join(STATE, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const { context, page } = await open();
  try {
    for (const [name, url] of Object.entries({ packages: config.packagesUrl, ...config.listings })) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000); // Partner Center fills the page after load
      await dump(page, dir, name);
      console.log(`probed ${name}`);
    }
  } finally {
    await context.close();
  }
  console.log(`\nOK: ${dir}`);
}

// --- stage ------------------------------------------------------------------

async function stage({ msix, version, dry }) {
  version ??= await configuredVersion();
  const notes = await readWhatsNew(version);

  if (!existsSync(msix)) throw new Error(`no package at ${msix}`);
  if (!path.basename(msix).includes(`_${version}.0_`)) {
    throw new Error(`${path.basename(msix)} does not look like ${version} — pass --version to override`);
  }

  console.log(`package  ${msix}`);
  console.log(`version  ${version}`);
  for (const lang of LANGUAGES) console.log(`\nwhat's new [${lang}]:\n${notes[lang]}`);

  if (dry) {
    console.log(
      existsSync(CONFIG)
        ? `\nrecorded pages: ${CONFIG}`
        : `\nnot set up yet: no ${CONFIG} — run: node scripts/store-draft.mjs setup`,
    );
    console.log('OK: dry run — the browser was not opened');
    return;
  }

  const config = await readConfig();
  const { context, page } = await open();
  try {
    await page.goto(config.packagesUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    const upload = page.locator('input[type="file"]').first();
    if (!(await upload.count())) {
      await fail(page, 'packages', 'no file input on the Packages page');
    }
    await upload.setInputFiles(msix);
    await page.waitForTimeout(2000);
    const name = path.basename(msix);
    try {
      await page.getByText(name, { exact: false }).first().waitFor({ timeout: 300_000 });
    } catch {
      await fail(page, 'upload', `the page never showed ${name} after the upload`);
    }
    await save(page, 'packages');

    for (const lang of LANGUAGES) {
      await page.goto(config.listings[lang], { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      const field = page
        .getByRole('textbox', { name: /what.s new|このバージョンの新機能|新機能/i })
        .first();
      if (!(await field.count())) {
        await fail(page, `listing-${lang}`, `no "what's new" field on the ${lang} listing page`);
      }
      await field.fill(notes[lang]);
      await save(page, `listing-${lang}`);
      console.log(`release notes [${lang}] written`);
    }

    const dir = await dump(page, path.join(STATE, `staged-${version}`), 'final');
    console.log('\nOK: draft is staged and NOT submitted.');
    console.log(`evidence: ${dir}`);
    console.log('Review it in Partner Center, then press Submit for certification yourself.');
  } finally {
    await context.close();
  }
}

async function save(page, step) {
  const button = page.getByRole('button', { name: /^(save|save draft|保存)$/i }).first();
  if (!(await button.count())) await fail(page, step, `no Save button on the ${step} page`);
  await button.click();
  await page.waitForTimeout(3000);
}

// --- entry ------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(`--${name}`);
  return at === -1 ? undefined : rest[at + 1];
};

try {
  if (command === 'setup') await setup();
  else if (command === 'probe') await probe();
  else if (command === 'stage') {
    const msix = flag('msix');
    if (!msix) throw new Error('stage needs --msix <path>');
    await stage({ msix: path.resolve(msix), version: flag('version'), dry: rest.includes('--dry') });
  } else {
    console.error(`usage: node scripts/store-draft.mjs setup|probe|stage [--msix <path>] [--version x.y.z] [--dry]`);
    console.error(`repo: ${repoRoot}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
