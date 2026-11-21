import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePatchAddedLines,
  parseUnifiedDiff,
  rangeTouchesAddedLines,
} from '../src/diff.ts';

test('parsePatchAddedLines extracts added line numbers accurately', () => {
  const patch = [
    '@@ -10,3 +10,5 @@ export function foo() {',
    '   const a = 1;',
    '-  return a;',
    '+  const b = a + 1;',
    '+  const c = b + 1;',
    '+  return c;',
    ' }',
  ].join('\n');

  const added = parsePatchAddedLines(patch);
  assert.deepEqual([...added], [11, 12, 13]);
});

test('parseUnifiedDiff handles multiple files and skips deleted files', () => {
  const diff = [
    'diff --git a/src/old.ts b/src/old.ts',
    'deleted file mode 100644',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-const dead = true;',
    'diff --git a/src/routes/orders.ts b/src/routes/orders.ts',
    'index 111..222 100644',
    '--- a/src/routes/orders.ts',
    '+++ b/src/routes/orders.ts',
    '@@ -15,0 +16,3 @@ router.get("/health", () => "ok");',
    '+router.post("/orders", async (req, res) => {',
    '+  res.json({ ok: true });',
    '+});',
  ].join('\n');

  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.filePath, 'src/routes/orders.ts');
  assert.deepEqual([...(files[0]?.addedLines ?? [])], [16, 17, 18]);
});

test('rangeTouchesAddedLines checks inclusive overlap', () => {
  const added = new Set([10, 25]);
  assert.equal(rangeTouchesAddedLines(5, 10, added), true);
  assert.equal(rangeTouchesAddedLines(11, 24, added), false);
  assert.equal(rangeTouchesAddedLines(25, 30, added), true);
});
