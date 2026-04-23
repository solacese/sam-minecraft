import test from 'ava';
import { normalizeBounds } from '../src/build-coordination.js';
import { buildFillBatches } from '../src/fill-batching.js';

test('buildFillBatches covers the full region in layered patches', (t) => {
  const bounds = normalizeBounds(0, 63, 0, 7, 64, 7);
  const batches = buildFillBatches(bounds, 'minecraft:smooth_sandstone', 4);

  t.is(batches.length, 8);
  t.is(
    batches.reduce((sum, batch) => sum + batch.blockCount, 0),
    128
  );
  t.is(
    batches[0]?.command,
    '/fill 0 63 0 3 63 3 minecraft:smooth_sandstone'
  );
  t.is(
    batches.at(-1)?.command,
    '/fill 4 64 4 7 64 7 minecraft:smooth_sandstone'
  );
});

test('buildFillBatches handles edge tiles smaller than the span', (t) => {
  const bounds = normalizeBounds(-2, 70, -1, 4, 70, 5);
  const batches = buildFillBatches(bounds, 'minecraft:stone', 6);

  t.is(batches.length, 4);
  t.deepEqual(
    batches.map((batch) => batch.blockCount),
    [36, 6, 6, 1]
  );
});
