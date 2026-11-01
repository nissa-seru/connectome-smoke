import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localImports = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf-8').matchAll(/^import [^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) localImports(resolve(dirname(file), spec), seen);
  return seen;
};

test('the self-check runs on a change to any file the test module loads, which the host loads into itself', () => {
  const loaded = [...localImports(join(ROOT, 'test/whole-host/lib/strategies/module.mjs'))].map((f) => relative(ROOT, f)).sort();
  const workflow = readFileSync(join(ROOT, '.github/workflows/whole-host-self-check.yml'), 'utf-8');
  const paths = [...workflow.matchAll(/^\s+- (test\/whole-host\/\S+)$/gm)].map((m) => m[1]);
  assert.ok(loaded.includes('test/whole-host/lib/strategies/prose.mjs'), 'the module reaches prose.mjs through the recorder and the stand-in');
  assert.deepEqual(loaded.filter((f) => !paths.includes(f)), [], 'each loaded file is a path that schedules the check');
});
