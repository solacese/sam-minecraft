import test from 'ava';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  resolveLocalStructureReference,
  selectLocalStructureRegistryEntry,
  type LocalStructureRegistryEntry
} from '../src/local-structure-import.js';

test('selectLocalStructureRegistryEntry matches the natural Pisa prompt to the registered local tower', (t) => {
  const entries: LocalStructureRegistryEntry[] = [
    {
      id: 'leaning_tower_of_pisa_local',
      title: 'Leaning Tower of Pisa',
      aliases: ['local Leaning Tower of Pisa', 'Tower of Pisa'],
      filePath: '/tmp/pisa.zip',
      sourceVersion: '1.13.2'
    },
    {
      id: 'roman_villa_local',
      title: 'Roman Villa',
      aliases: ['local Roman Villa'],
      filePath: '/tmp/villa.zip',
      sourceVersion: '1.13.2'
    }
  ];

  const match = selectLocalStructureRegistryEntry(
    'Build the local Leaning Tower of Pisa. Use multiple workers in parallel until it is complete.',
    entries
  );

  t.truthy(match);
  t.is(match?.entry.id, 'leaning_tower_of_pisa_local');
});

test('resolveLocalStructureReference preserves explicit file paths', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sam-minecraft-local-structure-test-'));
  const archivePath = path.join(tempDir, 'structure.zip');
  await fs.writeFile(archivePath, 'not-a-real-zip');

  t.teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const resolved = await resolveLocalStructureReference({
    filePath: archivePath,
    title: 'Ad Hoc Structure',
    sourceVersion: '1.20.1'
  });

  t.is(resolved.resolvedVia, 'filePath');
  t.is(resolved.filePath, archivePath);
  t.is(resolved.title, 'Ad Hoc Structure');
  t.is(resolved.sourceVersion, '1.20.1');
});
