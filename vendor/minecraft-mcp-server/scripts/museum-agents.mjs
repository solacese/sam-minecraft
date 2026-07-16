import mineflayer from 'mineflayer';

const host = process.env.MC_HOST || 'localhost';
const port = Number(process.env.MC_PORT || 25565);
const CHATTER_LINES_PER_AGENT = 50;
const CHATTER_INTERVAL_MS = 6500;
const MOVEMENT_PAUSE_MS = 9000;
const PATROL_Y = Number(process.env.AGENT_PATROL_Y || 79);

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
    home: { x: 0, z: -210 },
    aliases: ['orchestrator', 'orch', 'guide', 'agent', 'sam'],
    topics: ['tour', 'help', 'agents', 'museum', 'where', 'alive', 'chat', 'dynamic', 'loop']
  },
  {
    username: 'DesignDora_l4s',
    label: 'Design Dora',
    role: 'site planner',
    home: { x: -16, z: -210 },
    aliases: ['dora', 'design', 'planner'],
    topics: ['site', 'path', 'plaza', 'layout', 'route', 'spawn']
  },
  {
    username: 'BuildBea_l33',
    label: 'Build Bea',
    role: 'structure specialist',
    home: { x: -8, z: -210 },
    aliases: ['bea', 'build', 'builder'],
    topics: ['structure', 'layers', 'tower', 'build', 'blocks', 'height', 'rebuild', 'unbuild', 'dissolve']
  },
  {
    username: 'MonumentMarc_m9',
    label: 'Monument Marc',
    role: 'landmark fidelity specialist',
    home: { x: 0, z: -210 },
    aliases: ['marc', 'monument'],
    topics: ['munich', 'eiffel', 'sydney', 'arc', 'triumph', 'basil', 'cathedral', 'chrysler', 'landmark', 'silhouette', 'model']
  },
  {
    username: 'SupplySid_l31',
    label: 'Supply Sid',
    role: 'materials and finishing specialist',
    home: { x: 8, z: -210 },
    aliases: ['sid', 'supply', 'materials'],
    topics: ['materials', 'palette', 'finish', 'glass', 'marker', 'beacon']
  },
  {
    username: 'ForestFinn_q32',
    label: 'Forest Finn',
    role: 'landscaping specialist',
    home: { x: 16, z: -210 },
    aliases: ['finn', 'forest', 'landscape'],
    topics: ['landscape', 'garden', 'trees', 'outside', 'terrain', 'ground']
  }
];

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
    return `${username}, look south from the glass overlook: Sydney, Arc de Triomphe, Munich, Eiffel, Saint Basil's, and Chrysler are arranged left to right in one close OTS model row.`;
  }
  if (text.includes('agents') || text.includes('help') || text.includes('team')) {
    return `${username}, we are six guide agents. We answer chat, patrol waypoints, and narrate the live build loop while a trusted builder edits the landmark blocks.`;
  }
  if (text.includes('alive') || text.includes('move') || text.includes('walking')) {
    return `${username}, each guide is cycling through exhibit waypoints while the six landmarks dissolve and rebuild in staggered phases.`;
  }
  if (text.includes('dynamic') || text.includes('loop') || text.includes('rebuild') || text.includes('unbuild') || text.includes('dissolve')) {
    return `${username}, the museum is kinetic now: two landmarks can animate at once, capped near 100 block edits per second, with unbuilds top-down and rebuilds bottom-up.`;
  }
  if (text.includes('munich')) {
    return `${username}, Munich is the large OTS flagship at the origin, centered in the visible row.`;
  }
  if (text.includes('eiffel')) {
    return `${username}, Eiffel is just right of Munich and uses the prebuilt GrabCraft Eiffel Tower model, with a yellow marker and full-height tower profile.`;
  }
  if (text.includes('sydney')) {
    return `${username}, Sydney is far left in the visible row, with a white marker and imported Opera House model.`;
  }
  if (text.includes('arc') || text.includes('triumph')) {
    return `${username}, Arc de Triomphe is left of Munich and uses a high-detail GrabCraft OTS conversion with an orange marker.`;
  }
  if (text.includes('basil') || text.includes('cathedral')) {
    return `${username}, Saint Basil's is right of Eiffel and uses the colorful GrabCraft cathedral model with a red marker.`;
  }
  if (text.includes('chrysler') || text.includes('skyscraper')) {
    return `${username}, the NY Chrysler Building is far right in the visible row, a tall converted GrabCraft skyline model with a light blue marker.`;
  }
  if (text.includes('pisa') || text.includes('colosseum') || text.includes('neuschwanstein')) {
    return `${username}, those draft placeholders were replaced. This museum row now uses six high-quality OTS-backed models only.`;
  }
  if (text.includes('build')) {
    return `${username}, public visitors can explore in creative mode; the landmark row is rebuilt block by block by a controlled worker while we coordinate the story in chat.`;
  }
  return `${username}, I am ${agent.label}, the ${agent.role}. Say a landmark name or ask for a tour and I will route you.`;
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
    await sleep(300);
    bot.chat(`${agent.label} online: ${agent.role}. I am patrolling the origin museum cluster.`);
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
