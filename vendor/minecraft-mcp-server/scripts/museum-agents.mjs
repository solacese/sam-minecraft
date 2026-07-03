import mineflayer from 'mineflayer';

const host = process.env.MC_HOST || 'localhost';
const port = Number(process.env.MC_PORT || 25565);

const agents = [
  {
    username: 'OrchGuide_o11',
    label: 'Orchestrator',
    role: 'museum guide and mission control',
    home: { x: 0, z: -102 },
    aliases: ['orchestrator', 'orch', 'guide', 'agent'],
    topics: ['tour', 'help', 'agents', 'museum']
  },
  {
    username: 'DesignDora_l4s',
    label: 'Design Dora',
    role: 'site planner',
    home: { x: -10, z: -96 },
    aliases: ['dora', 'design'],
    topics: ['site', 'path', 'plaza', 'layout']
  },
  {
    username: 'BuildBea_l33',
    label: 'Build Bea',
    role: 'structure specialist',
    home: { x: -5, z: -96 },
    aliases: ['bea', 'build'],
    topics: ['structure', 'layers', 'tower', 'build']
  },
  {
    username: 'MonumentMarc_m9',
    label: 'Monument Marc',
    role: 'landmark fidelity specialist',
    home: { x: 0, z: -96 },
    aliases: ['marc', 'monument'],
    topics: ['munich', 'eiffel', 'landmark', 'silhouette']
  },
  {
    username: 'SupplySid_l31',
    label: 'Supply Sid',
    role: 'materials and finishing specialist',
    home: { x: 5, z: -96 },
    aliases: ['sid', 'supply'],
    topics: ['materials', 'palette', 'finish', 'glass']
  },
  {
    username: 'ForestFinn_q32',
    label: 'Forest Finn',
    role: 'landscaping specialist',
    home: { x: 10, z: -96 },
    aliases: ['finn', 'forest'],
    topics: ['landscape', 'garden', 'trees', 'outside']
  }
];

const agentNames = new Set(agents.map((agent) => agent.username.toLowerCase()));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRespond(agent, message) {
  const text = message.toLowerCase();
  if (agent.username === 'OrchGuide_o11' && /\b(help|tour|agents|museum|where|what)\b/.test(text)) {
    return true;
  }
  return [...agent.aliases, ...agent.topics].some((token) => text.includes(token));
}

function responseFor(agent, username, message) {
  const text = message.toLowerCase();
  if (text.includes('tour') || text.includes('where')) {
    return `${username}, start at spawn: Munich is at the origin, Eiffel is just east, Sydney is west, Architecture Tower is southwest, Colosseum is south, and Neuschwanstein is southeast.`;
  }
  if (text.includes('agents') || text.includes('help')) {
    return `We are six museum agents: orchestration, site planning, structure, landmark fidelity, materials, and landscaping. Ask any of our names for details.`;
  }
  if (text.includes('munich')) {
    return `${username}, the Munich exhibit is the flagship OTS build at the museum center. It is staged for filming and agent coordination.`;
  }
  if (text.includes('eiffel')) {
    return `${username}, the Eiffel exhibit demonstrates staged foundations, platforms, tapering, and a spire from a curated landmark spec.`;
  }
  if (text.includes('build')) {
    return `${username}, public visitors can request builds on the museum page; trusted build jobs run through a controlled queue.`;
  }
  return `${username}, I am ${agent.label}, the ${agent.role}. I can explain my part of the museum build process.`;
}

function createAgent(agent, index) {
  let reconnectTimer = null;
  const bot = mineflayer.createBot({
    host,
    port,
    username: agent.username,
    version: '1.21.4',
    hideErrors: false
  });

  bot.once('spawn', async () => {
    await sleep(1000 + index * 700);
    const homeY = Math.ceil(bot.entity.position.y);
    bot.chat(`/tp ${agent.username} ${agent.home.x} ${homeY} ${agent.home.z}`);
    await sleep(300);
    bot.chat(`${agent.label} online: ${agent.role}. Say my name or ask for a tour.`);
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
