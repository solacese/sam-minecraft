import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const SERVER_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');

const EXHIBITS = [
  {
    id: 'sydney',
    title: 'Sydney Opera House',
    centerX: -200,
    centerZ: 0,
    file: 'vendor/minecraft-mcp-server/local_structures/sydney_opera_house_cadnav.ots_blocks'
  },
  {
    id: 'arc',
    title: 'Arc de Triomphe',
    centerX: -100,
    centerZ: 0,
    file: 'vendor/minecraft-mcp-server/local_structures/arc_de_triomphe.ots_blocks'
  },
  {
    id: 'munich',
    title: 'Munich Famous Building',
    centerX: 0,
    centerZ: 0,
    file: 'vendor/minecraft-mcp-server/local_structures/munich_famous_building.ots_blocks'
  },
  {
    id: 'eiffel',
    title: 'Eiffel Tower',
    centerX: 95,
    centerZ: 0,
    file: 'vendor/minecraft-mcp-server/local_structures/eiffel_tower_paris.ots_blocks'
  },
  {
    id: 'saint_basil',
    title: "Saint Basil's Cathedral",
    centerX: 175,
    centerZ: 0,
    file: 'vendor/minecraft-mcp-server/local_structures/saint_basils_cathedral_moscow.ots_blocks'
  },
  {
    id: 'chrysler',
    title: 'NY Chrysler Building',
    centerX: 255,
    centerZ: 0,
    file: 'vendor/minecraft-mcp-server/local_structures/ny_chrysler_building.ots_blocks'
  }
];

const GRAVITY_REPLACEMENTS = new Map([
  ['minecraft:white_concrete_powder', 'minecraft:white_concrete'],
  ['minecraft:orange_concrete_powder', 'minecraft:orange_concrete'],
  ['minecraft:magenta_concrete_powder', 'minecraft:magenta_concrete'],
  ['minecraft:light_blue_concrete_powder', 'minecraft:light_blue_concrete'],
  ['minecraft:yellow_concrete_powder', 'minecraft:yellow_concrete'],
  ['minecraft:lime_concrete_powder', 'minecraft:lime_concrete'],
  ['minecraft:pink_concrete_powder', 'minecraft:pink_concrete'],
  ['minecraft:gray_concrete_powder', 'minecraft:gray_concrete'],
  ['minecraft:light_gray_concrete_powder', 'minecraft:light_gray_concrete'],
  ['minecraft:cyan_concrete_powder', 'minecraft:cyan_concrete'],
  ['minecraft:purple_concrete_powder', 'minecraft:purple_concrete'],
  ['minecraft:blue_concrete_powder', 'minecraft:blue_concrete'],
  ['minecraft:brown_concrete_powder', 'minecraft:brown_concrete'],
  ['minecraft:green_concrete_powder', 'minecraft:green_concrete'],
  ['minecraft:red_concrete_powder', 'minecraft:red_concrete'],
  ['minecraft:black_concrete_powder', 'minecraft:black_concrete'],
  ['minecraft:sand', 'minecraft:sandstone'],
  ['minecraft:red_sand', 'minecraft:red_sandstone'],
  ['minecraft:gravel', 'minecraft:stone']
]);

const CLEAN_REPLACEMENTS = new Map([
  ['minecraft:tnt', 'minecraft:smooth_quartz'],
  ['minecraft:coal_ore', 'minecraft:stone'],
  ['minecraft:deepslate_coal_ore', 'minecraft:deepslate'],
  ['minecraft:copper_ore', 'minecraft:stone'],
  ['minecraft:deepslate_copper_ore', 'minecraft:deepslate'],
  ['minecraft:iron_ore', 'minecraft:stone'],
  ['minecraft:deepslate_iron_ore', 'minecraft:deepslate'],
  ['minecraft:gold_ore', 'minecraft:stone'],
  ['minecraft:deepslate_gold_ore', 'minecraft:deepslate'],
  ['minecraft:redstone_ore', 'minecraft:stone'],
  ['minecraft:deepslate_redstone_ore', 'minecraft:deepslate'],
  ['minecraft:emerald_ore', 'minecraft:stone'],
  ['minecraft:deepslate_emerald_ore', 'minecraft:deepslate'],
  ['minecraft:lapis_ore', 'minecraft:stone'],
  ['minecraft:deepslate_lapis_ore', 'minecraft:deepslate'],
  ['minecraft:diamond_ore', 'minecraft:stone'],
  ['minecraft:deepslate_diamond_ore', 'minecraft:deepslate'],
  ['minecraft:nether_gold_ore', 'minecraft:netherrack'],
  ['minecraft:nether_quartz_ore', 'minecraft:netherrack'],
  ['minecraft:ancient_debris', 'minecraft:polished_blackstone'],
  ['minecraft:observer', 'minecraft:light_gray_concrete'],
  ['minecraft:dispenser', 'minecraft:smooth_stone'],
  ['minecraft:dropper', 'minecraft:smooth_stone'],
  ['minecraft:piston', 'minecraft:smooth_stone'],
  ['minecraft:sticky_piston', 'minecraft:smooth_stone'],
  ['minecraft:hopper', 'minecraft:iron_block'],
  ['minecraft:redstone_block', 'minecraft:red_concrete'],
  ['minecraft:redstone_lamp', 'minecraft:sea_lantern'],
  ['minecraft:command_block', 'minecraft:smooth_quartz'],
  ['minecraft:chain_command_block', 'minecraft:smooth_quartz'],
  ['minecraft:repeating_command_block', 'minecraft:smooth_quartz'],
  ['minecraft:structure_block', 'minecraft:smooth_quartz'],
  ['minecraft:jigsaw', 'minecraft:smooth_quartz'],
  ['minecraft:barrier', 'minecraft:smooth_stone'],
  ['minecraft:bedrock', 'minecraft:stone'],
  ['minecraft:lava', 'minecraft:smooth_stone'],
  ['minecraft:fire', 'minecraft:smooth_stone'],
  ['minecraft:soul_fire', 'minecraft:smooth_stone']
]);

const config = {
  mode: argValue('--mode') || process.env.MUSEUM_BUILDER_MODE || 'loop',
  dryRun: hasArg('--dry-run') || process.env.MUSEUM_DRY_RUN === '1',
  host: process.env.MC_RCON_HOST || process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_RCON_PORT || 25575),
  password: process.env.MC_RCON_PASSWORD || process.env.RCON_PASSWORD || 'sam-museum-change-me',
  baseY: optionalNumber(argValue('--base-y') || process.env.MUSEUM_BASE_Y),
  blocksPerSecond: positiveNumber(process.env.MUSEUM_BLOCKS_PER_SECOND, 60),
  activeJobs: positiveInteger(process.env.MUSEUM_ACTIVE_JOBS, 1),
  batchSize: positiveInteger(process.env.MUSEUM_BATCH_SIZE, 25),
  builtHoldMs: positiveInteger(process.env.MUSEUM_BUILT_HOLD_MS, 15000),
  emptyHoldMs: positiveInteger(process.env.MUSEUM_EMPTY_HOLD_MS, 10000),
  phaseSpacingMs: positiveInteger(process.env.MUSEUM_PHASE_SPACING_MS, 0),
  rconTimeoutMs: positiveInteger(process.env.MUSEUM_RCON_TIMEOUT_MS, 30000),
  streamInterval: positiveInteger(process.env.MUSEUM_STREAM_INTERVAL, 500),
  showCountdownSeconds: positiveInteger(process.env.MUSEUM_SHOW_COUNTDOWN_SECONDS, 20),
  saveAfterRestore: process.env.MUSEUM_SAVE_AFTER_RESTORE !== '0'
};

const GUIDE_AGENT_COUNT = 6;
const REQUEST_BOARD = {
  x1: -26,
  y1: 78,
  z1: -224,
  x2: -9,
  y2: 84,
  z2: -224,
  facing: 'south'
};

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return process.argv[index + 1] || '';
}

function hasArg(name) {
  return process.argv.includes(name);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric value, got '${value}'`);
  }
  return parsed;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value || fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readInt32LE(buffer, offset) {
  return buffer.readInt32LE(offset);
}

async function loadOtsBlocks(filePath) {
  const raw = await fs.readFile(filePath);
  if (raw.length < 15 || raw.subarray(0, 10).toString('utf8') !== 'OTS_BLOCKS') {
    throw new Error(`${filePath} is not an OTS_BLOCKS file`);
  }
  if (raw[10] !== 2) {
    throw new Error(`${filePath} uses unsupported OTS_BLOCKS version ${raw[10]}`);
  }

  let offset = 11;
  const paletteCount = readUInt32LE(raw, offset);
  offset += 4;
  const palette = new Map();
  for (let index = 0; index < paletteCount; index += 1) {
    const blockId = readUInt32LE(raw, offset);
    offset += 4;
    const stateLength = readUInt32LE(raw, offset);
    offset += 4;
    const rawState = raw.subarray(offset, offset + stateLength).toString('utf8');
    offset += stateLength;
    palette.set(blockId, cleanState(GRAVITY_REPLACEMENTS.get(rawState) || rawState));
  }

  const recordCount = readUInt32LE(raw, offset);
  offset += 4;
  const blocks = [];
  for (let index = 0; index < recordCount; index += 1) {
    const x = readInt32LE(raw, offset);
    const y = readInt32LE(raw, offset + 4);
    const z = readInt32LE(raw, offset + 8);
    const blockId = readUInt32LE(raw, offset + 12);
    offset += 16;
    const state = palette.get(blockId);
    if (state && state !== 'minecraft:air') {
      blocks.push({ x, y, z, state });
    }
  }
  return blocks;
}

function cleanState(rawState) {
  const blockName = rawState.split('[', 1)[0];
  if (CLEAN_REPLACEMENTS.has(blockName)) {
    return CLEAN_REPLACEMENTS.get(blockName);
  }
  if (/^minecraft:.*_(button|pressure_plate|trapdoor|door|fence_gate)(\[.*)?$/.test(rawState)) {
    return 'minecraft:smooth_stone';
  }
  if (/^minecraft:(redstone_wire|repeater|comparator|lever|tripwire|tripwire_hook)(\[.*)?$/.test(rawState)) {
    return 'minecraft:smooth_stone';
  }
  return rawState;
}

function translateBlocks(exhibit, blocks, baseY) {
  const minX = Math.min(...blocks.map((block) => block.x));
  const maxX = Math.max(...blocks.map((block) => block.x));
  const minY = Math.min(...blocks.map((block) => block.y));
  const minZ = Math.min(...blocks.map((block) => block.z));
  const maxZ = Math.max(...blocks.map((block) => block.z));
  const width = maxX - minX + 1;
  const depth = maxZ - minZ + 1;
  const originX = exhibit.centerX - Math.floor(width / 2);
  const originZ = exhibit.centerZ - Math.floor(depth / 2);

  const worldBlocks = blocks.map((block) => ({
    x: originX + block.x - minX,
    y: baseY + block.y - minY,
    z: originZ + block.z - minZ,
    state: block.state
  }));

  return {
    ...exhibit,
    originX,
    originZ,
    blockCount: worldBlocks.length,
    bounds: {
      minX: Math.min(...worldBlocks.map((block) => block.x)),
      maxX: Math.max(...worldBlocks.map((block) => block.x)),
      minY: Math.min(...worldBlocks.map((block) => block.y)),
      maxY: Math.max(...worldBlocks.map((block) => block.y)),
      minZ: Math.min(...worldBlocks.map((block) => block.z)),
      maxZ: Math.max(...worldBlocks.map((block) => block.z))
    },
    buildBlocks: [...worldBlocks].sort(blockBuildOrder),
    unbuildBlocks: [...worldBlocks].sort(blockUnbuildOrder)
  };
}

function blockBuildOrder(left, right) {
  return left.y - right.y || left.z - right.z || left.x - right.x || left.state.localeCompare(right.state);
}

function blockUnbuildOrder(left, right) {
  return right.y - left.y || right.z - left.z || right.x - left.x || left.state.localeCompare(right.state);
}

function setblockCommand(block, state = block.state) {
  return `setblock ${block.x} ${block.y} ${block.z} ${state}`;
}

function forceloadCommand(exhibit, action) {
  const { minX, minZ, maxX, maxZ } = exhibit.bounds;
  return `forceload ${action} ${minX} ${minZ} ${maxX} ${maxZ}`;
}

function tellraw(text, color = 'gold') {
  return `tellraw @a ${JSON.stringify({ text, color })}`;
}

function titleCommand(kind, text, color = 'gold') {
  return `title @a ${kind} ${JSON.stringify({ text, color })}`;
}

function scoreHolder(text) {
  return text
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_:#/%.-]/g, '')
    .slice(0, 40);
}

function shortTitle(exhibitOrTitle) {
  const title = typeof exhibitOrTitle === 'string' ? exhibitOrTitle : exhibitOrTitle.title;
  return title
    .replace('Sydney Opera House', 'Sydney')
    .replace('Arc de Triomphe', 'Arc')
    .replace('Munich Famous Building', 'Munich')
    .replace('Eiffel Tower', 'Eiffel')
    .replace("Saint Basil's Cathedral", 'Saint Basil')
    .replace('NY Chrysler Building', 'Chrysler');
}

function formatCount(value) {
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}k`;
  }
  return String(value);
}

function streamMessage(exhibit, modeLabel, placed, total) {
  const sign = modeLabel === 'build' || modeLabel === 'restore' ? '+' : '-';
  const action = modeLabel === 'build'
    ? 'building'
    : modeLabel === 'restore'
      ? 'restoring'
      : 'dissolving';
  const color = sign === '+' ? 'green' : 'red';
  return tellraw(`[SAM Museum] ${sign} ${exhibit.title}: ${action} ${placed}/${total}`, color);
}

class RconClient {
  constructor({ host, port, password }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.requestId = 10;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.commandChain = Promise.resolve();
  }

  async connect() {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    const response = await this.sendPacket(3, this.password);
    if (response.requestId === -1) {
      throw new Error('RCON authentication failed');
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < length + 4) return;
      const packet = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      const requestId = packet.readInt32LE(0);
      const type = packet.readInt32LE(4);
      const body = packet.subarray(8, packet.length - 2).toString('utf8');
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        pending.resolve({ requestId, type, body });
      }
    }
  }

  send(command) {
    const run = () => this.sendPacket(2, command);
    const next = this.commandChain.then(run, run);
    this.commandChain = next.catch(() => {});
    return next;
  }

  sendPacket(type, body) {
    if (!this.socket) {
      throw new Error('RCON socket is not connected');
    }
    const requestId = this.requestId;
    this.requestId += 1;
    const bodyBuffer = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(4 + 4 + bodyBuffer.length + 2);
    packet.writeInt32LE(requestId, 0);
    packet.writeInt32LE(type, 4);
    bodyBuffer.copy(packet, 8);
    packet.writeUInt8(0, 8 + bodyBuffer.length);
    packet.writeUInt8(0, 9 + bodyBuffer.length);
    const frame = Buffer.alloc(4 + packet.length);
    frame.writeInt32LE(packet.length, 0);
    packet.copy(frame, 4);

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RCON command timed out: ${body.slice(0, 120)}`));
      }, config.rconTimeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
    this.socket.write(frame);
    return promise;
  }
}

class RateLimiter {
  constructor(commandsPerSecond) {
    this.intervalMs = Math.max(1, 1000 / commandsPerSecond);
    this.nextAt = Date.now();
    this.chain = Promise.resolve();
  }

  async wait() {
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAt - now);
      this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
}

async function setupSidebar(rcon) {
  await rcon.send('scoreboard objectives remove sam_museum');
  await rcon.send('scoreboard objectives add sam_museum dummy "SAM Museum"');
  await rcon.send('scoreboard objectives setdisplay sidebar sam_museum');
}

async function updateSidebar(rcon, {
  exhibit = null,
  phase = 'Idle',
  placed = 0,
  total = 0,
  nextTitle = 'loading',
  cycleCount = 0
} = {}) {
  const now = exhibit ? shortTitle(exhibit) : 'loading';
  const pct = total > 0 ? `${Math.floor((placed / total) * 100)}%` : '0%';
  const lines = [
    ['SAM Museum', 90],
    [`Now: ${now}`, 80],
    [`Phase: ${phase}`, 70],
    [`Progress: ${pct} ${formatCount(placed)}/${formatCount(total)}`, 60],
    [`Next: ${shortTitle(nextTitle)}`, 50],
    [`Agents: ${GUIDE_AGENT_COUNT} guides`, 40],
    [`Show #: ${cycleCount}`, 30],
    ['Type: tour', 20],
    ['Request board: spawn', 10]
  ];
  await rcon.send('scoreboard players reset * sam_museum');
  for (const [label, score] of lines) {
    await rcon.send(`scoreboard players set ${scoreHolder(label)} sam_museum ${score}`);
  }
}

function signMessages(lines) {
  const padded = [...lines, '', '', '', ''].slice(0, 4);
  return padded.map((line) => JSON.stringify(JSON.stringify({ text: line }))).join(',');
}

async function setupRequestBoard(rcon) {
  const { x1, y1, z1, x2, y2, z2, facing } = REQUEST_BOARD;
  await rcon.send(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:dark_oak_planks`);
  await rcon.send(`fill ${x1 + 1} ${y1 + 1} ${z1 + 1} ${x2 - 1} ${y1 + 1} ${z1 + 5} minecraft:smooth_quartz`);
  await rcon.send('kill @e[type=minecraft:text_display,tag=sam_request_board]');

  const signs = [
    { x: -24, y: 82, lines: ['SAM Museum', 'Request Board', 'Vote for the', 'next landmark'] },
    { x: -20, y: 82, lines: ['Type request', 'in chat or use', 'the visit page', 'from the site'] },
    { x: -16, y: 82, lines: ['Shows run', 'one landmark', 'at a time', 'block by block'] },
    { x: -12, y: 82, lines: ['Try: tour', 'Ask agents', 'Watch sidebar', 'Explore freely'] }
  ];

  for (const sign of signs) {
    await rcon.send(`setblock ${sign.x} ${sign.y} ${z1 + 1} minecraft:oak_wall_sign[facing=${facing}]`);
    await rcon.send(
      `data merge block ${sign.x} ${sign.y} ${z1 + 1} ` +
      `{front_text:{messages:[${signMessages(sign.lines)}]}}`
    );
  }

  await rcon.send(
    `summon minecraft:text_display -18 84 ${z1 + 2} ` +
    `{Tags:["sam_request_board"],text:'${JSON.stringify({ text: 'Suggest the next landmark: use the museum page or type request in chat.', color: 'aqua' })}',` +
    'billboard:"center",background:0,see_through:1b}'
  );
}

async function setupVisitorFeatures(rcon, exhibits) {
  await rcon.send('gamerule sendCommandFeedback false');
  await rcon.send('gamerule logAdminCommands false');
  await setupSidebar(rcon);
  await updateSidebar(rcon, {
    exhibit: exhibits[0],
    phase: 'Booting',
    placed: 0,
    total: exhibits[0]?.blockCount ?? 0,
    nextTitle: exhibits[1]?.title ?? 'Sydney'
  });
  await setupRequestBoard(rcon);
  await rcon.send(tellraw('[SAM Museum] Visitor features online: sidebar status, guided tour command, request board, and scheduled shows.', 'gold'));
}

class SlotLimiter {
  constructor(maxActive) {
    this.maxActive = maxActive;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.maxActive) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

async function resolveBaseY(rcon) {
  if (config.baseY !== null) {
    return config.baseY;
  }
  for (let y = 319; y >= -64; y -= 1) {
    const response = await rcon.send(`execute if block 0 ${y} -48 minecraft:sea_lantern`);
    if (/Test passed|passed/i.test(response.body)) {
      return y - 23;
    }
  }
  console.warn('Could not infer base Y from Munich marker; falling back to 68.');
  return 68;
}

async function loadExhibits(baseY) {
  const loaded = [];
  for (const exhibit of EXHIBITS) {
    const filePath = path.resolve(REPO_ROOT, exhibit.file);
    const blocks = await loadOtsBlocks(filePath);
    loaded.push(translateBlocks(exhibit, blocks, baseY));
  }
  return loaded;
}

async function sendBlockBatch(rcon, limiter, commands) {
  for (const command of commands) {
    await limiter.wait();
    await rcon.send(command);
  }
}

async function applyBlocks(rcon, limiter, exhibit, blocks, modeLabel, stateOverride = null, context = {}) {
  let placed = 0;
  for (let index = 0; index < blocks.length; index += config.batchSize) {
    const batch = blocks.slice(index, index + config.batchSize)
      .map((block) => setblockCommand(block, stateOverride || block.state));
    await sendBlockBatch(rcon, limiter, batch);
    placed += batch.length;
    if (placed % 1000 < config.batchSize) {
      console.log(`${modeLabel} ${exhibit.id}: ${placed}/${blocks.length}`);
    }
    if (placed % config.streamInterval < config.batchSize || placed === blocks.length) {
      await rcon.send(streamMessage(exhibit, modeLabel, placed, blocks.length));
      await updateSidebar(rcon, {
        exhibit,
        phase: context.phase ?? modeLabel,
        placed,
        total: blocks.length,
        nextTitle: context.nextTitle ?? 'pending',
        cycleCount: context.cycleCount ?? 0
      });
    }
  }
}

async function restoreOnce(rcon, exhibits) {
  const limiter = new RateLimiter(config.blocksPerSecond);
  await setupVisitorFeatures(rcon, exhibits);
  await rcon.send(tellraw('[SAM Museum] Restoring all landmark models to their complete static state.', 'gold'));
  for (const exhibit of exhibits) {
    console.log(`Restoring ${exhibit.title}: ${exhibit.blockCount} blocks`);
    await rcon.send(forceloadCommand(exhibit, 'add'));
    await applyBlocks(rcon, limiter, exhibit, exhibit.buildBlocks, 'restore', null, {
      phase: 'Restoring',
      nextTitle: 'complete',
      cycleCount: 0
    });
    await rcon.send(forceloadCommand(exhibit, 'remove'));
  }
  if (config.saveAfterRestore) {
    await rcon.send('save-all flush');
  }
  await rcon.send(tellraw('[SAM Museum] Static landmark restore complete.', 'green'));
}

async function announceShowCountdown(rcon, exhibit, nextTitle, cycleCount) {
  if (config.showCountdownSeconds <= 0) {
    return;
  }
  await updateSidebar(rcon, {
    exhibit,
    phase: `Show in ${config.showCountdownSeconds}s`,
    placed: 0,
    total: exhibit.blockCount,
    nextTitle,
    cycleCount
  });
  await rcon.send(tellraw(`[SAM Museum] Scheduled show ${cycleCount}: ${exhibit.title} starts in ${config.showCountdownSeconds} seconds. Type "tour" for a guided route.`, 'gold'));
  await rcon.send(titleCommand('title', 'Next SAM Museum Show', 'gold'));
  await rcon.send(titleCommand('subtitle', `${exhibit.title} starts soon`, 'yellow'));
  if (config.showCountdownSeconds > 10) {
    await sleep((config.showCountdownSeconds - 10) * 1000);
    await rcon.send(tellraw(`[SAM Museum] ${exhibit.title} starts in 10 seconds.`, 'yellow'));
    await updateSidebar(rcon, {
      exhibit,
      phase: 'Show in 10s',
      placed: 0,
      total: exhibit.blockCount,
      nextTitle,
      cycleCount
    });
    await sleep(5000);
    await rcon.send(tellraw(`[SAM Museum] ${exhibit.title} starts in 5 seconds.`, 'red'));
    await updateSidebar(rcon, {
      exhibit,
      phase: 'Show in 5s',
      placed: 0,
      total: exhibit.blockCount,
      nextTitle,
      cycleCount
    });
    await sleep(5000);
  } else {
    await sleep(config.showCountdownSeconds * 1000);
  }
}

async function runExhibitCycle(rcon, limiter, exhibit, nextTitle, cycleCount) {
  try {
    console.log(`Starting animation cycle for ${exhibit.title}`);
    await announceShowCountdown(rcon, exhibit, nextTitle, cycleCount);
    await rcon.send(forceloadCommand(exhibit, 'add'));
    await updateSidebar(rcon, {
      exhibit,
      phase: 'Dissolving',
      placed: 0,
      total: exhibit.blockCount,
      nextTitle,
      cycleCount
    });
    await rcon.send(tellraw(`[SAM Museum] ${exhibit.title} is dissolving block by block.`, 'yellow'));
    await applyBlocks(rcon, limiter, exhibit, exhibit.unbuildBlocks, 'unbuild', 'minecraft:air', {
      phase: 'Dissolving',
      nextTitle,
      cycleCount
    });
    await updateSidebar(rcon, {
      exhibit,
      phase: 'Empty hold',
      placed: exhibit.blockCount,
      total: exhibit.blockCount,
      nextTitle,
      cycleCount
    });
    await rcon.send(tellraw(`[SAM Museum] ${exhibit.title} is cleared. Rebuild starts shortly.`, 'gray'));
    await sleep(config.emptyHoldMs);
    await updateSidebar(rcon, {
      exhibit,
      phase: 'Rebuilding',
      placed: 0,
      total: exhibit.blockCount,
      nextTitle,
      cycleCount
    });
    await rcon.send(tellraw(`[SAM Museum] ${exhibit.title} is rebuilding from lower layers upward.`, 'aqua'));
    await applyBlocks(rcon, limiter, exhibit, exhibit.buildBlocks, 'build', null, {
      phase: 'Rebuilding',
      nextTitle,
      cycleCount
    });
    await updateSidebar(rcon, {
      exhibit,
      phase: 'Complete',
      placed: exhibit.blockCount,
      total: exhibit.blockCount,
      nextTitle,
      cycleCount
    });
    await rcon.send(tellraw(`[SAM Museum] ${exhibit.title} is complete again.`, 'green'));
    await rcon.send(forceloadCommand(exhibit, 'remove'));
    await sleep(config.builtHoldMs);
  } catch (error) {
    console.error(`Animation cycle failed for ${exhibit.title}:`, error);
    try {
      await rcon.send(forceloadCommand(exhibit, 'remove'));
    } catch (forceloadError) {
      console.error(`Failed to remove forceload for ${exhibit.title}:`, forceloadError);
    }
    await sleep(15000);
  }
}

async function loop(rcon, exhibits) {
  await setupVisitorFeatures(rcon, exhibits);
  await rcon.send(tellraw('[SAM Museum] Sequential build loop online: one landmark dissolves and rebuilds at a time.', 'gold'));
  const limiter = new RateLimiter(config.blocksPerSecond);
  let cycleCount = 1;
  while (true) {
    for (let index = 0; index < exhibits.length; index += 1) {
      const exhibit = exhibits[index];
      const next = exhibits[(index + 1) % exhibits.length];
      await runExhibitCycle(rcon, limiter, exhibit, next.title, cycleCount);
      cycleCount += 1;
    }
  }
}

function printDryRun(exhibits, baseY) {
  const summary = exhibits.map((exhibit) => ({
    id: exhibit.id,
    title: exhibit.title,
    blocks: exhibit.blockCount,
    origin: { x: exhibit.originX, y: baseY, z: exhibit.originZ },
    bounds: exhibit.bounds,
    firstBuildCommand: setblockCommand(exhibit.buildBlocks[0]),
    firstUnbuildCommand: setblockCommand(exhibit.unbuildBlocks[0], 'minecraft:air')
  }));
  const totalBlocks = exhibits.reduce((sum, exhibit) => sum + exhibit.blockCount, 0);
  console.log(JSON.stringify({
    mode: config.mode,
    dryRun: true,
    baseY,
    totalBlocks,
    totalLoopEdits: totalBlocks * 2,
    blocksPerSecond: config.blocksPerSecond,
    activeJobs: config.activeJobs,
    batchSize: config.batchSize,
    exhibits: summary
  }, null, 2));
}

async function main() {
  let rcon = null;
  let baseY = config.baseY ?? 68;
  if (!config.dryRun && config.baseY === null) {
    rcon = new RconClient(config);
    await rcon.connect();
    baseY = await resolveBaseY(rcon);
  }
  const exhibits = await loadExhibits(baseY);
  if (config.dryRun) {
    printDryRun(exhibits, baseY);
    return;
  }
  if (!rcon) {
    rcon = new RconClient(config);
    await rcon.connect();
  }
  console.log(
    `Museum dynamic builder connected to ${config.host}:${config.port}; ` +
    `mode=${config.mode} baseY=${baseY} blocksPerSecond=${config.blocksPerSecond}`
  );
  if (config.mode === 'restore-once') {
    await restoreOnce(rcon, exhibits);
    rcon.disconnect();
    return;
  }
  if (config.mode !== 'loop') {
    throw new Error(`Unsupported MUSEUM_BUILDER_MODE '${config.mode}'. Use loop or restore-once.`);
  }
  await loop(rcon, exhibits);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
