import test from 'ava';
import { BlockPlacementQueue } from '../src/block-placement-queue.js';

test('enqueue preserves task order', async (t) => {
  const queue = new BlockPlacementQueue();
  const order: number[] = [];

  await Promise.all([
    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(1);
    }),
    queue.enqueue(async () => {
      order.push(2);
    }),
    queue.enqueue(async () => {
      order.push(3);
    })
  ]);

  t.deepEqual(order, [1, 2, 3]);
});

test('enqueueCommands runs every command sequentially', async (t) => {
  const queue = new BlockPlacementQueue();
  const seen: string[] = [];

  await queue.enqueueCommands(
    [
      '/setblock 0 64 0 minecraft:stone',
      '/setblock 1 64 0 minecraft:stone',
      '/setblock 2 64 0 minecraft:stone'
    ],
    async (command) => {
      seen.push(command);
    },
    0
  );

  t.deepEqual(seen, [
    '/setblock 0 64 0 minecraft:stone',
    '/setblock 1 64 0 minecraft:stone',
    '/setblock 2 64 0 minecraft:stone'
  ]);
});
