import mineflayer from 'mineflayer';

const host = process.env.MC_HOST || 'localhost';
const port = Number(process.env.MC_PORT || 25565);
const CHATTER_LINES_PER_AGENT = Number(process.env.AGENT_CHATTER_LINES || 10);
const CHATTER_INTERVAL_MS = Number(process.env.AGENT_CHATTER_INTERVAL_MS || 30000);
const MOVEMENT_PAUSE_MS = 9000;
const PATROL_Y = Number(process.env.AGENT_PATROL_Y || 79);
const TOUR_STOP_PAUSE_MS = 9000;
const MUSEUM_PAGE_URL = 'https://raphael-solace.github.io/sam-minecraft-museum/#visit';

const waypoints = [
  { label: 'spawn overlook', x: 0, z: -210 },
  { label: 'Sydney Opera House west display', x: -200, z: -52 },
  { label: 'Arc de Triomphe west-center display', x: -100, z: -52 },
  { label: 'Munich origin display', x: 8, z: -52 },
  { label: 'Eiffel Tower east-center display', x: 95, z: -52 },
  { label: "Saint Basil's Cathedral east display", x: 175, z: -52 },
  { label: 'NY Chrysler Building far-east display', x: 255, z: -52 }
];

const agents = [
  {
    username: 'OrchGuide_o11',
    label: 'Orchestrator',
    role: 'museum guide and live build mission control',
    model: 'Claude 4.5 Sonnet',
    badge: 'ORCH',
    team: 'sam_orch',
    teamColor: 'gold',
    armor: {
      head: 'minecraft:golden_helmet',
      chest: 'minecraft:golden_chestplate'
    },
    home: { x: 0, z: -210 },
    aliases: ['orchestrator', 'orch', 'guide', 'agent', 'sam'],
    topics: ['tour', 'help', 'agents', 'museum', 'where', 'alive', 'chat', 'dynamic', 'loop', 'request', 'vote']
  },
  {
    username: 'DesignDora_l4s',
    label: 'Design Dora',
    role: 'site planner',
    model: 'Claude 4.5 Haiku',
    badge: 'SITE',
    team: 'sam_design',
    teamColor: 'light_purple',
    armor: {
      head: 'minecraft:chainmail_helmet',
      chest: 'minecraft:chainmail_chestplate'
    },
    home: { x: -16, z: -210 },
    aliases: ['dora', 'design', 'planner'],
    topics: ['site', 'path', 'plaza', 'layout', 'route', 'spawn']
  },
  {
    username: 'BuildBea_l33',
    label: 'Build Bea',
    role: 'structure specialist',
    model: 'Claude 4.5 Sonnet',
    badge: 'BUILD',
    team: 'sam_build',
    teamColor: 'blue',
    armor: {
      head: 'minecraft:diamond_helmet',
      chest: 'minecraft:diamond_chestplate'
    },
    home: { x: -8, z: -210 },
    aliases: ['bea', 'build', 'builder'],
    topics: ['structure', 'layers', 'tower', 'build', 'blocks', 'height', 'rebuild', 'unbuild', 'dissolve']
  },
  {
    username: 'MonumentMarc_m9',
    label: 'Monument Marc',
    role: 'landmark fidelity specialist',
    model: 'Claude 4.5 Sonnet',
    badge: 'FIDEL',
    team: 'sam_fidelity',
    teamColor: 'gray',
    armor: {
      head: 'minecraft:iron_helmet',
      chest: 'minecraft:iron_chestplate'
    },
    home: { x: 0, z: -210 },
    aliases: ['marc', 'monument'],
    topics: ['munich', 'eiffel', 'sydney', 'arc', 'triumph', 'basil', 'cathedral', 'chrysler', 'landmark', 'silhouette', 'model']
  },
  {
    username: 'SupplySid_l31',
    label: 'Supply Sid',
    role: 'materials and finishing specialist',
    model: 'Claude 4.5 Sonnet',
    badge: 'MAT',
    team: 'sam_supply',
    teamColor: 'yellow',
    armor: {
      head: 'minecraft:golden_helmet',
      chest: 'minecraft:chainmail_chestplate'
    },
    home: { x: 8, z: -210 },
    aliases: ['sid', 'supply', 'materials'],
    topics: ['materials', 'palette', 'finish', 'glass', 'marker', 'beacon']
  },
  {
    username: 'ForestFinn_q32',
    label: 'Forest Finn',
    role: 'landscaping specialist',
    model: 'Claude 4.5 Haiku',
    badge: 'LAND',
    team: 'sam_forest',
    teamColor: 'green',
    armor: {
      head: 'minecraft:turtle_helmet',
      chest: 'minecraft:leather_chestplate'
    },
    home: { x: 16, z: -210 },
    aliases: ['finn', 'forest', 'landscape'],
    topics: ['landscape', 'garden', 'trees', 'outside', 'terrain', 'ground']
  }
];

const tourStops = [
  {
    label: 'Spawn overlook',
    x: 0,
    z: -210,
    line: 'This is the live control balcony: watch the sidebar for the active show and the chat for the event stream.'
  },
  {
    label: 'Sydney Opera House',
    x: -200,
    z: -52,
    line: 'Sydney anchors the west end with a white marker and curved OTS profile.'
  },
  {
    label: 'Arc de Triomphe',
    x: -100,
    z: -52,
    line: 'The Arc shows the top-down dissolve and bottom-up rebuild pattern clearly.'
  },
  {
    label: 'Munich Famous Building',
    x: 8,
    z: -52,
    line: 'Munich is the central origin exhibit and the easiest reference point for the row.'
  },
  {
    label: 'Eiffel Tower',
    x: 95,
    z: -52,
    line: 'Eiffel is a tall model, so the layer-by-layer rebuild is visible from far away.'
  },
  {
    label: "Saint Basil's and Chrysler",
    x: 215,
    z: -52,
    line: 'The east end contrasts colorful domes with the tallest skyline model.'
  },
  {
    label: 'Request board',
    x: -18,
    z: -219,
    line: `Use the request board near spawn or visit ${MUSEUM_PAGE_URL} to suggest the next exhibit.`
  }
];

const activeTours = new Set();

const agentNames = new Set(agents.map((agent) => agent.username.toLowerCase()));
const chatterTemplates = [
  'checking sightlines around {place}',
  'marking visitor flow from {place}',
  'confirming the colored beacon at {place}',
  'reviewing whether {place} reads clearly from spawn',
  'logging a museum activity beat near {place}',
  'cross-checking structure scale at {place}',
  'watching visitor movement past {place}',
  'calling out the next tour stop: {place}',
  'checking that {place} is not hidden behind Munich',
  'keeping the origin-cluster route alive near {place}',
  'tracking the live dissolve phase at {place}',
  'checking the rebuild rhythm around {place}',
  'confirming Build Bea has the lower layers queued at {place}',
  'asking Monument Marc to verify the silhouette at {place}',
  'asking Supply Sid to watch palette consistency at {place}',
  'keeping visitors clear while the trusted builder edits {place}',
  'confirming only OTS model blocks are being touched at {place}',
  'timing the next staggered animation slot for {place}',
  'watching the top layers unbuild cleanly at {place}',
  'checking that paths and markers remain untouched near {place}'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(message) {
  return message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

function addressedTo(agent, text) {
  const labelTokens = agent.label.toLowerCase().split(/\s+/);
  return [...agent.aliases, ...labelTokens, agent.username.toLowerCase()]
    .some((token) => text.includes(token));
}

function addressedAgents(text) {
  return agents.filter((agent) => addressedTo(agent, text));
}

function shouldRespond(agent, message) {
  const text = normalize(message);
  const addressed = addressedAgents(text);
  if (addressed.length > 0) {
    return addressed.some((target) => target.username === agent.username);
  }
  if (/\b(all|everyone|team|agents|guides)\b/.test(text)) {
    return true;
  }
  if ([...agent.topics].some((topic) => text.includes(topic))) {
    return true;
  }
  return agent.username === 'OrchGuide_o11' && text.trim().length > 0;
}

function responseFor(agent, username, message) {
  const text = normalize(message);
  if (text.includes('tour') || text.includes('where')) {
    return `${username}, say "tour" and I will move you through the museum stops. From the overlook, the row is Sydney, Arc, Munich, Eiffel, Saint Basil's, then Chrysler.`;
  }
  if (text.includes('agents') || text.includes('help') || text.includes('team')) {
    return `${username}, six guide agents are online: Orchestrator, Design Dora, Build Bea, Monument Marc, Supply Sid, and Forest Finn. Ask any of us for a tour or a landmark detail.`;
  }
  if (text.includes('alive') || text.includes('move') || text.includes('walking')) {
    return `${username}, each guide is cycling through exhibit waypoints while the six landmarks dissolve and rebuild in staggered phases.`;
  }
  if (text.includes('dynamic') || text.includes('loop') || text.includes('rebuild') || text.includes('unbuild') || text.includes('dissolve')) {
    return `${username}, the museum is kinetic now: one landmark runs as a scheduled show at a time, capped at a stable edit rate, with unbuilds top-down and rebuilds bottom-up.`;
  }
  if (text.includes('request') || text.includes('vote') || text.includes('next landmark')) {
    return `${username}, the request board is beside spawn. You can also use ${MUSEUM_PAGE_URL} to suggest the next landmark for the museum.`;
  }
  if (text.includes('munich')) {
    return `${username}, Munich is the large OTS flagship at the origin, centered in the visible row.`;
  }
  if (text.includes('eiffel')) {
    return `${username}, Eiffel is just right of Munich and uses a prebuilt OTS Eiffel Tower model, with a yellow marker and full-height tower profile.`;
  }
  if (text.includes('sydney')) {
    return `${username}, Sydney is far left in the visible row, with a white marker and imported Opera House model.`;
  }
  if (text.includes('arc') || text.includes('triumph')) {
    return `${username}, Arc de Triomphe is left of Munich and uses a high-detail OTS model with an orange marker.`;
  }
  if (text.includes('basil') || text.includes('cathedral')) {
    return `${username}, Saint Basil's is right of Eiffel and uses the colorful OTS cathedral model with a red marker.`;
  }
  if (text.includes('chrysler') || text.includes('skyscraper')) {
    return `${username}, the NY Chrysler Building is far right in the visible row, a tall imported OTS skyline model with a light blue marker.`;
  }
  if (text.includes('pisa') || text.includes('colosseum') || text.includes('neuschwanstein')) {
    return `${username}, those draft placeholders were replaced. This museum row now uses six high-quality OTS-backed models only.`;
  }
  if (text.includes('build')) {
    return `${username}, public visitors can explore in creative mode; the landmark row is rebuilt block by block by a controlled worker while we coordinate the story in chat.`;
  }
  return `${username}, I am ${agent.label}, the ${agent.role}, running on ${agent.model}. Say a landmark name, "tour", or "request".`;
}

function chatterLine(agent, lineNumber, agentIndex) {
  const otherAgents = agents.filter((_, index) => index !== agentIndex);
  const target = otherAgents[lineNumber % otherAgents.length];
  const waypoint = waypoints[(agentIndex + lineNumber) % waypoints.length];
  const template = chatterTemplates[lineNumber % chatterTemplates.length];
  const phrase = template.replace('{place}', waypoint.label);
  return `${agent.label} -> ${target.label} [${lineNumber + 1}/${CHATTER_LINES_PER_AGENT}]: ${phrase}.`;
}

function startChatter(bot, agent, index, isActive) {
  let lineNumber = 0;
  const sendNext = () => {
    if (!isActive() || lineNumber >= CHATTER_LINES_PER_AGENT) {
      return;
    }
    bot.chat(chatterLine(agent, lineNumber, index));
    lineNumber += 1;
    setTimeout(sendNext, CHATTER_INTERVAL_MS);
  };
  setTimeout(sendNext, 3500 + index * 1100);
}

async function startMovement(bot, agent, index, isActive) {
  await sleep(5000 + index * 700);
  let waypointIndex = index % waypoints.length;
  while (isActive()) {
    const waypoint = waypoints[waypointIndex % waypoints.length];
    bot.chat(`/tp ${agent.username} ${waypoint.x} ${PATROL_Y} ${waypoint.z}`);
    waypointIndex += 2;
    await sleep(MOVEMENT_PAUSE_MS + index * 500);
  }
}

function chatComponent(text, color) {
  return JSON.stringify({ text, color });
}

function isSafePlayerName(username) {
  return /^[A-Za-z0-9_]{1,16}$/.test(username);
}

async function styleAgent(bot, agent) {
  bot.chat(`/team add ${agent.team}`);
  await sleep(70);
  bot.chat(`/team modify ${agent.team} color ${agent.teamColor}`);
  await sleep(70);
  bot.chat(`/team modify ${agent.team} prefix ${chatComponent(`[${agent.badge}] `, agent.teamColor)}`);
  await sleep(70);
  bot.chat(`/team join ${agent.team} ${agent.username}`);
  await sleep(100);
  bot.chat(`/item replace entity ${agent.username} armor.head with ${agent.armor.head}`);
  await sleep(100);
  bot.chat(`/item replace entity ${agent.username} armor.chest with ${agent.armor.chest}`);
}

async function runTour(bot, username) {
  if (!isSafePlayerName(username)) {
    bot.chat(`${username}, I can only start the guided tour for standard Minecraft usernames.`);
    return;
  }
  if (activeTours.has(username)) {
    bot.chat(`${username}, your tour is already running. Watch the action bar for each stop.`);
    return;
  }
  activeTours.add(username);
  try {
    bot.chat(`${username}, starting a quick museum tour. I will move you through ${tourStops.length} stops; the sidebar shows the live build status.`);
    for (let index = 0; index < tourStops.length; index += 1) {
      const stop = tourStops[index];
      bot.chat(`/tp ${username} ${stop.x} ${PATROL_Y} ${stop.z}`);
      await sleep(300);
      bot.chat(`/title ${username} actionbar ${JSON.stringify({ text: `Tour ${index + 1}/${tourStops.length}: ${stop.label}`, color: 'gold' })}`);
      bot.chat(`${username}, ${stop.label}: ${stop.line}`);
      await sleep(TOUR_STOP_PAUSE_MS);
    }
    bot.chat(`${username}, tour complete. Type a landmark name for details or "request" for the request board.`);
  } finally {
    activeTours.delete(username);
  }
}

function shouldStartTour(message) {
  const text = normalize(message);
  return /\b(tour|start tour|guide me|museum tour)\b/.test(text);
}

function createAgent(agent, index) {
  let reconnectTimer = null;
  let active = true;
  const bot = mineflayer.createBot({
    host,
    port,
    username: agent.username,
    version: '1.21.4',
    hideErrors: false
  });

  bot.once('spawn', async () => {
    await sleep(1000 + index * 700);
    bot.chat(`/tp ${agent.username} ${agent.home.x} ${PATROL_Y} ${agent.home.z}`);
    bot.chat(`/effect give ${agent.username} minecraft:glowing 999999 0 true`);
    await styleAgent(bot, agent);
    await sleep(300);
    bot.chat(`${agent.label} online: ${agent.role}, model=${agent.model}. I am patrolling the origin museum cluster.`);
    startChatter(bot, agent, index, () => active);
    startMovement(bot, agent, index, () => active).catch((error) => {
      console.error(`${agent.username} movement loop`, error.message);
    });
  });

  bot.on('chat', async (username, message) => {
    if (!username || agentNames.has(username.toLowerCase())) {
      return;
    }
    if (!shouldRespond(agent, message)) {
      return;
    }
    await sleep(250 + index * 150);
    if (agent.username === 'OrchGuide_o11' && shouldStartTour(message)) {
      runTour(bot, username).catch((error) => {
        console.error(`${agent.username} tour loop`, error.message);
      });
      return;
    }
    bot.chat(responseFor(agent, username, message));
  });

  const reconnect = () => {
    active = false;
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      createAgent(agent, index);
    }, 5000);
  };

  bot.on('kicked', (reason) => {
    console.error(`${agent.username} kicked`, reason);
    reconnect();
  });
  bot.on('end', reconnect);
  bot.on('error', (error) => {
    console.error(`${agent.username} error`, error.message);
  });
}

agents.forEach((agent, index) => {
  setTimeout(() => createAgent(agent, index), index * 1200);
});
