/**
 * Copies non-TypeScript runtime assets into dist/ after tsc.
 *
 * tsc emits only .js, so without this the deployed tree has no migrations
 * (`runMigrations` resolves them relative to import.meta.url) and no CSV fixture
 * — the service would build cleanly and then fail at boot.
 *
 * Plain .mjs so it runs on bare node during `npm run build`, with no tsx.
 */

import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['.sql', '.csv', '.json'];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) yield full;
  }
}

let copied = 0;
for await (const file of walk(join(root, 'src'))) {
  const target = join(root, 'dist', relative(join(root, 'src'), file));
  await mkdir(dirname(target), { recursive: true });
  await cp(file, target);
  copied += 1;
  console.log(`  ${relative(root, target)}`);
}

if (copied === 0) {
  console.error('No runtime assets found under src/ — expected at least the migrations.');
  process.exit(1);
}
console.log(`copied ${copied} runtime asset(s) into dist/`);
