#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPlacementPlan } from '../src/grabcraft-place.ts';

function usage() {
  return [
    'Usage: tsx scripts/grabcraft-model-to-ots.mjs --input model.json --output model.ots_blocks',
    '',
    'Converts a GrabCraft model artifact JSON into the OTS_BLOCKS binary format.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--input' || key === '-i') {
      args.input = value;
      index += 1;
    } else if (key === '--output' || key === '-o') {
      args.output = value;
      index += 1;
    } else if (key === '--help' || key === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return args;
}

function writeUInt32LE(chunks, value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  chunks.push(buffer);
}

function writeInt32LE(chunks, value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  chunks.push(buffer);
}

function otsPayload(blocks) {
  const palette = new Map();
  const paletteEntries = [];
  for (const block of blocks) {
    if (!palette.has(block.blockState)) {
      palette.set(block.blockState, palette.size);
      paletteEntries.push(block.blockState);
    }
  }

  const chunks = [Buffer.from('OTS_BLOCKS'), Buffer.from([2])];
  writeUInt32LE(chunks, paletteEntries.length);
  for (const [id, state] of paletteEntries.entries()) {
    const stateBuffer = Buffer.from(state, 'utf8');
    writeUInt32LE(chunks, id);
    writeUInt32LE(chunks, stateBuffer.length);
    chunks.push(stateBuffer);
  }

  writeUInt32LE(chunks, blocks.length);
  for (const block of blocks) {
    writeInt32LE(chunks, block.x);
    writeInt32LE(chunks, block.y);
    writeInt32LE(chunks, block.z);
    writeInt32LE(chunks, palette.get(block.blockState));
  }

  return Buffer.concat(chunks);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.input || !args.output) {
    throw new Error(`${usage()}\n\nBoth --input and --output are required.`);
  }

  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const artifact = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  if (artifact.kind !== 'grabcraft-model') {
    throw new Error(`Expected a grabcraft-model artifact, got '${artifact.kind ?? 'unknown'}'.`);
  }

  const plan = buildPlacementPlan(artifact, 0, 0, 0);
  if (plan.translatedBlocks.length === 0) {
    throw new Error(`No supported blocks after translating ${artifact.source?.title ?? inputPath}.`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, otsPayload(plan.translatedBlocks));
  process.stdout.write(
    `Wrote ${outputPath}: ${plan.translatedBlocks.length}/${plan.sourceBlockCount} blocks, ` +
    `${plan.skippedPalette.length} skipped palette entries.\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
