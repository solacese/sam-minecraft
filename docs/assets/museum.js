const DATA_URL = 'data/museum.json';

const state = {
  config: null
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function youtubeIdFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace('/', '').trim();
    }
    if (parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v') || '';
    }
    const embedMatch = parsed.pathname.match(/\/embed\/([^/?]+)/);
    return embedMatch ? embedMatch[1] : '';
  } catch {
    return '';
  }
}

function recordingThumbnail(recording) {
  const id = youtubeIdFromUrl(recording.youtubeUrl);
  if (recording.thumbnailUrl) return recording.thumbnailUrl;
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : '';
}

function renderRecordings(recordings) {
  const grid = document.querySelector('#recording-grid');
  grid.innerHTML = recordings.map((recording, index) => {
    const thumbnail = recordingThumbnail(recording);
    const url = recording.youtubeUrl || '#request';
    const thumbHtml = thumbnail
      ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(recording.title)} thumbnail" loading="lazy">`
      : `<span>Recording ${index + 1}<br>Add YouTube URL</span>`;

    return `
      <article class="recording-card">
        <a class="recording-thumb" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
          ${thumbHtml}
        </a>
        <div class="recording-body">
          <h3>${escapeHtml(recording.title)}</h3>
          <p class="recording-meta">${escapeHtml(recording.city)} · ${escapeHtml(recording.duration || 'TBD')}</p>
          <p>${escapeHtml(recording.description)}</p>
        </div>
      </article>
    `;
  }).join('');
}

function renderLandmarks(landmarks) {
  const grid = document.querySelector('#landmark-grid');
  grid.innerHTML = landmarks.map((landmark) => `
    <article class="landmark-card">
      <h3>${escapeHtml(landmark.name)}</h3>
      <p class="landmark-meta">${escapeHtml(landmark.origin)} · ${escapeHtml(landmark.status)}</p>
      <p>${escapeHtml(landmark.description)}</p>
    </article>
  `).join('');
}

function renderAgents(agents) {
  const grid = document.querySelector('#agent-grid');
  grid.innerHTML = agents.map((agent) => `
    <article class="agent-card">
      <h3>${escapeHtml(agent.name)}</h3>
      <p class="agent-role">${escapeHtml(agent.role)}</p>
      <p>${escapeHtml(agent.activity)}</p>
    </article>
  `).join('');
}

function renderDynamic(dynamic) {
  const panel = document.querySelector('#dynamic-status');
  if (!panel || !dynamic) return;
  panel.innerHTML = `
    <strong>${escapeHtml(dynamic.status)}</strong>
    <span>${escapeHtml(dynamic.cadence)}</span>
    <span>${escapeHtml(dynamic.speed)}</span>
  `;
}

function renderAccess(config) {
  const serverAddress = `${config.minecraft.host}:${config.minecraft.port}`;
  const museumAddress = document.querySelector('#museum-address');
  const chatAddress = document.querySelector('#chat-address');
  const copyServer = document.querySelector('#copy-server');
  const inlineServer = document.querySelector('#server-address-inline');
  const note = document.querySelector('#server-note');

  museumAddress.href = config.urls.museum;
  museumAddress.textContent = config.urls.museumLabel || config.urls.museum;
  chatAddress.href = config.urls.chat;
  chatAddress.textContent = config.urls.chatLabel || config.urls.chat;
  copyServer.textContent = serverAddress;
  inlineServer.textContent = serverAddress;
  note.textContent = config.minecraft.note;

  copyServer.addEventListener('click', async () => {
    await navigator.clipboard.writeText(serverAddress);
    copyServer.textContent = 'Copied';
    window.setTimeout(() => {
      copyServer.textContent = serverAddress;
    }, 1400);
  });
}

function buildIssueUrl(config, payload) {
  const issueBase = config.request.githubIssueUrl;
  const title = `Museum request: ${payload.title}`;
  const body = [
    '## Requested model or landmark',
    payload.title,
    '',
    '## Requester',
    payload.requester || 'Anonymous visitor',
    '',
    '## Description',
    payload.description,
    '',
    '## Source',
    'Submitted from the SAM Minecraft Museum GitHub Pages site.'
  ].join('\n');

  const url = new URL(issueBase);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  if (config.request.issueLabels) {
    url.searchParams.set('labels', config.request.issueLabels);
  }
  return url.toString();
}

function setupRequestForm(config) {
  const form = document.querySelector('#request-form');
  const result = document.querySelector('#request-result');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
      requester: String(formData.get('requester') || '').trim(),
      title: String(formData.get('title') || '').trim(),
      description: String(formData.get('description') || '').trim(),
      submittedAt: new Date().toISOString()
    };

    if (!payload.title || !payload.description) {
      result.textContent = 'Add a title and description before submitting.';
      return;
    }

    if (config.request.apiEndpoint) {
      result.textContent = 'Submitting request...';
      const response = await fetch(config.request.apiEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`Request API returned ${response.status}`);
      }
      const body = await response.json();
      result.textContent = `Request submitted: ${body.requestId || 'queued'}`;
      form.reset();
      return;
    }

    window.open(buildIssueUrl(config, payload), '_blank', 'noopener,noreferrer');
    result.textContent = 'Opened a prefilled GitHub issue for this request.';
  });
}

async function main() {
  const response = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not load ${DATA_URL}`);
  }

  const config = await response.json();
  state.config = config;
  renderAccess(config);
  renderDynamic(config.dynamic);
  renderRecordings(config.recordings);
  renderLandmarks(config.landmarks);
  renderAgents(config.agents);
  setupRequestForm(config);
}

main().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div style="padding:12px 18px;background:#ffe9e0;color:#6a1f12">Museum data failed to load: ${escapeHtml(error.message)}</div>`
  );
});
