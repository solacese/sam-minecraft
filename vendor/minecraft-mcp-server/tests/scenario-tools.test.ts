import test from 'ava';
import {
  latestZonePhase,
  planVillageLayout,
  zoneHasPhase
} from '../src/scenario-tools.js';

test('planVillageLayout creates buffered slots with deterministic assignments', (t) => {
  const plan = planVillageLayout({
    centerX: 0,
    centerZ: 0,
    rows: 2,
    cols: 3,
    houseCount: 5,
    houseWidth: 7,
    houseDepth: 7,
    bufferBlocks: 2,
    builders: ['A', 'B'],
    styles: ['oak', 'spruce']
  });

  t.is(plan.slots.length, 5);
  t.is(plan.meta.generatedHouses, 5);
  t.is(plan.meta.bufferBlocks, 2);
  t.deepEqual(
    plan.slots.slice(0, 4).map((slot) => ({ id: slot.houseId, builder: slot.builder, style: slot.style })),
    [
      { id: 'house_01', builder: 'A', style: 'oak' },
      { id: 'house_02', builder: 'B', style: 'spruce' },
      { id: 'house_03', builder: 'A', style: 'oak' },
      { id: 'house_04', builder: 'B', style: 'spruce' }
    ]
  );

  const first = plan.slots[0];
  const second = plan.slots[1];
  const xGap = second.x1 - first.x2 - 1;
  t.is(xGap, 2);
});

test('latestZonePhase returns newest event for zone', (t) => {
  const events = [
    { zoneId: 'house_01', phase: 'claimed', timestamp: 10 },
    { zoneId: 'house_02', phase: 'claimed', timestamp: 11 },
    { zoneId: 'house_01', phase: 'building', timestamp: 12 }
  ];

  const latest = latestZonePhase(events, 'house_01');
  t.truthy(latest);
  t.is(latest?.phase, 'building');
});

test('zoneHasPhase performs case-insensitive phase matching', (t) => {
  const events = [
    { zoneId: 'house_01', phase: 'Claimed', timestamp: 10 },
    { zoneId: 'house_01', phase: 'handoff:BuildBeaAgent', timestamp: 12 }
  ];

  t.true(zoneHasPhase(events, 'house_01', 'claimed'));
  t.true(zoneHasPhase(events, 'house_01', 'HANDOFF:BUILDBEAAGENT'));
  t.false(zoneHasPhase(events, 'house_02', 'claimed'));
});
