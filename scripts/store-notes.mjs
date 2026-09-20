// Read the three Store "what's new" paste blocks out of docs/store-submission.md.
//
// One parser, two callers: scripts/store-draft.mjs drives the Partner Center
// browser, scripts/store-publish.ps1 drives msstore. The text itself lives
// only in the document, which scripts/check-doc-claims.sh already guards, so
// neither caller carries a copy that can go stale.
//
//   node scripts/store-notes.mjs          # version from src-tauri/tauri.conf.json
//   node scripts/store-notes.mjs 0.8.0
//
// Prints {"version":"0.8.0","notes":{"ja":"...","en":"...","id":"..."}} and
// exits non-zero when a heading names a different version, so a stale block
// cannot be shipped with a new package.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Heading -> Store listing language, with the version in the heading captured.
const HEADINGS = {
  ja: /このバージョンの新機能（([0-9][^）]*)）/,
  en: /What's new in this version \(([0-9][^)]*)\)/,
  id: /Yang baru di versi ini \(([0-9][^)]*)\)/,
};

const FENCE = '`'.repeat(3);

export async function configuredVersion() {
  const conf = JSON.parse(await readFile(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  return conf.version;
}

export async function readWhatsNew(version) {
  const docPath = path.join(repoRoot, 'docs', 'store-submission.md');
  const lines = (await readFile(docPath, 'utf8')).split(/\r?\n/);
  const notes = {};

  for (let i = 0; i < lines.length; i++) {
    for (const [lang, heading] of Object.entries(HEADINGS)) {
      const found = lines[i].match(heading);
      if (!found) continue;
      if (notes[lang] !== undefined) throw new Error(`two ${lang} what's-new blocks in ${docPath}`);
      if (found[1] !== version) {
        throw new Error(`the ${lang} what's-new heading says ${found[1]}, expected ${version} — update ${docPath}`);
      }

      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith(FENCE)) j++;
      if (j >= lines.length) throw new Error(`no fenced block after the ${lang} heading in ${docPath}`);

      const body = [];
      for (j++; j < lines.length && !lines[j].startsWith(FENCE); j++) body.push(lines[j]);
      if (j >= lines.length) throw new Error(`unterminated ${lang} fenced block in ${docPath}`);

      const text = body.join('\n').trim();
      if (!text) throw new Error(`the ${lang} what's-new block is empty in ${docPath}`);
      notes[lang] = text;
      i = j;
    }
  }

  for (const lang of Object.keys(HEADINGS)) {
    if (notes[lang] === undefined) throw new Error(`no ${lang} what's-new block in ${docPath}`);
  }
  return notes;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('store-notes.mjs')) {
  const version = process.argv[2] ?? (await configuredVersion());
  try {
    const notes = await readWhatsNew(version);
    process.stdout.write(`${JSON.stringify({ version, notes }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
