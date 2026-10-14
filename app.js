// OfferPk App Factory dashboard. Public GitHub API only, no token.
// ETag conditional requests and localStorage cache keep visitor API usage modest.
const OWNER = 'OfferPk';
const API = 'https://api.github.com';
const SELF = 'app-factory-dashboard';
const DETAIL_TTL = 10 * 60e3;
const REFRESH = 60e3;
const DETAIL_N = 12;
const MIN_LEFT = 6;

const LS = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const SS = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const state = { repos: [], details: [], filter: 'all', query: '', loading: false };
let rate = { remaining: '?', reset: 0 };
let limited = false;

async function gh(path) {
  const key = `gh:${path}`;
  const cached = LS(key);
  if (limited && cached) return cached.data;
  const headers = { Accept: 'application/vnd.github+json' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  let response;
  try {
    response = await fetch(API + path, { headers });
  } catch (error) {
    if (cached) return cached.data;
    throw error;
  }
  rate = {
    remaining: response.headers.get('x-ratelimit-remaining') ?? rate.remaining,
    reset: Number(response.headers.get('x-ratelimit-reset')) || rate.reset
  };
  if (response.status === 304 && cached) {
    cached.t = Date.now();
    SS(key, cached);
    return cached.data;
  }
  if (response.status === 403 || response.status === 429) {
    limited = true;
    if (cached) return cached.data;
    throw new Error('rate');
  }
  if (!response.ok) {
    if (cached) return cached.data;
    throw new Error(`GitHub returned ${response.status}`);
  }
  const data = await response.json();
  SS(key, { etag: response.headers.get('etag'), t: Date.now(), data });
  return data;
}

const fresh = path => {
  const cached = LS(`gh:${path}`);
  return Boolean(cached && Date.now() - cached.t < DETAIL_TTL);
};
const pkt = value => value ? new Date(value).toLocaleString('en-GB', {
  timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
}) + ' PKT' : 'Time unavailable';
function ago(value) {
  if (!value) return 'time unavailable';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 6e4));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const kind = run => run.status !== 'completed' ? 'running'
  : run.conclusion === 'success' ? 'success'
  : ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion) ? 'failure' : 'none';
const label = name => /android|apk/i.test(name) ? 'Android build'
  : /page/i.test(name) ? 'Pages'
  : /ci|test|lint/i.test(name) ? 'CI' : name;

async function details(repo) {
  const path = `/repos/${OWNER}/${repo.name}`;
  const previous = LS(`d:${repo.name}`);
  const needsRefresh = !previous || previous.pushed !== repo.pushed_at
    || !fresh(`${path}/actions/runs?per_page=30`) || previous.running;
  if (!needsRefresh) return previous;
  if (limited || (rate.remaining !== '?' && Number(rate.remaining) < MIN_LEFT)) {
    return previous || { wf: [], prs: 0, msg: '', ctime: repo.pushed_at };
  }

  const [commits, runs, pulls] = await Promise.all([
    gh(`${path}/commits?per_page=1`),
    gh(`${path}/actions/runs?per_page=30`),
    gh(`${path}/pulls?state=open&per_page=100`)
  ]);
  const latest = {};
  for (const run of (runs?.workflow_runs || [])) if (!latest[run.name]) latest[run.name] = run;
  const workflows = Object.values(latest).map(run => ({ name: label(run.name), k: kind(run), url: run.html_url }));
  const apk = (runs?.workflow_runs || []).find(run => /android|apk/i.test(run.name) && run.conclusion === 'success');
  const commit = commits?.[0];
  const result = {
    pushed: repo.pushed_at,
    msg: commit ? commit.commit.message.split('\n')[0] : '',
    ctime: commit ? commit.commit.committer.date : repo.pushed_at,
    curl: commit?.html_url || '',
    wf: workflows,
    apk: apk?.html_url || '',
    prs: pulls ? pulls.length : 0,
    running: workflows.some(workflow => workflow.k === 'running')
  };
  SS(`d:${repo.name}`, result);
  return result;
}

function buildState(data) {
  const builds = (data?.wf || []).filter(workflow => workflow.name !== 'Pages');
  if (builds.some(workflow => workflow.k === 'running')) return 'running';
  if (builds.some(workflow => workflow.k === 'failure')) return 'failure';
  if (builds.some(workflow => workflow.k === 'success')) return 'success';
  return 'none';
}
const stateLabel = status => ({ success: 'Build passing', failure: 'Build failing', running: 'Build in progress', none: 'No build checks' }[status] || 'No build checks');
const stateIcon = status => status === 'success'
  ? '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.2 6.2 2.4 2.4 5.2-5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  : status === 'failure'
    ? '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 3 6 6m0-6L3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    : status === 'running'
      ? '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.1" stroke="currentColor" stroke-width="1.4"/><path d="M6 3.6V6l1.6 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function workflowBadges(data) {
  if (!data.wf?.length) return '<span class="workflow-badge none">No workflows reported</span>';
  return data.wf.map(workflow => {
    const icon = stateIcon(workflow.k);
    const name = esc(workflow.name);
    return workflow.url
      ? `<a class="workflow-badge ${esc(workflow.k)}" href="${esc(workflow.url)}" target="_blank" rel="noopener noreferrer">${icon}<span>${name}</span></a>`
      : `<span class="workflow-badge ${esc(workflow.k)}">${icon}<span>${name}</span></span>`;
  }).join('');
}

function repoCard(repo, data, index) {
  const status = buildState(data);
  const demo = repo.has_pages
    ? `<a class="repo-link" href="https://offerpk.github.io/${encodeURIComponent(repo.name)}/" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.1 3.2H3.8c-.7 0-1.3.6-1.3 1.3v7.7c0 .7.6 1.3 1.3 1.3h7.7c.7 0 1.3-.6 1.3-1.3V10M8.6 2.5h4.9v4.9M13.2 2.8 7.5 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Live demo</a>`
    : '<span class="repo-link disabled">No live demo</span>';
  const apk = data.apk
    ? `<a class="repo-link" href="${esc(data.apk)}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.3v7.2m0 0 2.6-2.6M8 9.5 5.4 6.9M3 10.5v2.2c0 .6.5 1.1 1.1 1.1h7.8c.6 0 1.1-.5 1.1-1.1v-2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>APK</a>`
    : '<span class="repo-link disabled">No APK yet</span>';
  const commitMessage = data.curl
    ? `<a class="commit-message" href="${esc(data.curl)}" target="_blank" rel="noopener noreferrer" title="${esc(data.msg || 'Latest commit')}">${esc(data.msg || 'Latest commit')}</a>`
    : `<span class="commit-message" title="${esc(data.msg || 'Commit details not available')}">${esc(data.msg || 'Commit details not available')}</span>`;
  const latestLabel = index === 0 ? '<span class="latest-label">Latest update</span>' : '';
  const timestamp = data.ctime || repo.pushed_at;
  const prs = Number(data.prs) || 0;
  return `<article class="repo-card status-${status}${index === 0 ? ' is-latest' : ''}" data-status="${status}" data-name="${esc(repo.name.toLowerCase())}" data-description="${esc((repo.description || '').toLowerCase())}">
    <div class="repo-head">
      <span class="repo-avatar" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="m3 9.4 7-6.5 7 6.5v6.8a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8V9.4Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M7.2 17v-5.7h5.6V17M6 7.8h.01M10 6.5h.01M14 7.8h.01" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg></span>
      <div class="repo-heading">
        <div class="repo-title-row"><h3><a href="${esc(repo.html_url)}" target="_blank" rel="noopener noreferrer">${esc(repo.name)}</a></h3>${latestLabel}</div>
        <p class="repo-description">${esc(repo.description || 'No description added yet.')}</p>
      </div>
      <a class="external-link" href="${esc(repo.html_url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(repo.name)} on GitHub"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.1 2.5h4.4v4.4M13.2 2.8 7.6 8.4M12.5 9.5v2.7c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V4.8c0-.7.6-1.3 1.3-1.3h2.7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
    </div>
    <div class="repo-meta"><span class="status-chip status-${status}">${stateIcon(status)}${stateLabel(status)}</span><span class="updated-ago" title="${esc(pkt(timestamp))}">Updated ${esc(ago(timestamp))}</span></div>
    <div class="commit-box"><svg class="commit-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.3"/><path d="M1.8 8h4.1m4.2 0h4.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><div class="commit-copy">${commitMessage}<time class="commit-time" datetime="${esc(timestamp || '')}">${esc(pkt(timestamp))}</time></div></div>
    <div class="workflow-row" aria-label="Workflow statuses">${workflowBadges(data)}</div>
    <div class="repo-links">${demo}${apk}<a class="repo-link" href="${esc(repo.html_url)}/pulls" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="4" cy="12.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 5v6m8 0V7.8a3.2 3.2 0 0 0-3.2-3.2H6.3m0 0 1.8 1.8M6.3 4.6l1.8-1.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>${prs} open PR${prs === 1 ? '' : 's'}</a></div>
  </article>`;
}

function updateFilters() {
  const query = state.query.trim().toLowerCase();
  const cards = [...document.querySelectorAll('.repo-card')];
  let visible = 0;
  for (const card of cards) {
    const matchesQuery = !query || card.dataset.name.includes(query) || card.dataset.description.includes(query);
    const matchesStatus = state.filter === 'all' || card.dataset.status === state.filter;
    const show = matchesQuery && matchesStatus;
    card.classList.toggle('hidden', !show);
    if (show) visible++;
  }
  const empty = document.getElementById('empty');
  empty.classList.toggle('hidden', visible !== 0);
  document.getElementById('grid').classList.toggle('hidden', visible === 0);
  document.getElementById('directory-count').textContent = `${visible} ${visible === 1 ? 'app' : 'apps'}`;
  document.getElementById('directory-description').textContent = query || state.filter !== 'all'
    ? `Showing ${visible} matching ${visible === 1 ? 'project' : 'projects'}.`
    : 'The latest projects, with their build status at a glance.';
  document.getElementById('empty-message').textContent = query || state.filter !== 'all'
    ? 'Try another search or filter.' : 'No projects are available right now.';
}

function updateCounts() {
  const totals = { all: state.repos.length, success: 0, failure: 0, running: 0, none: 0 };
  for (const data of state.details) totals[buildState(data)]++;
  for (const [key, total] of Object.entries(totals)) {
    const element = document.getElementById(`count-${key}`);
    if (element) element.textContent = total;
  }
}

function setNotice(message, type = 'warning') {
  const notice = document.getElementById('notice');
  notice.textContent = message;
  notice.classList.toggle('is-error', type === 'error');
  notice.classList.toggle('hidden', !message);
}

function setRateStatus() {
  const rateLabel = rate.remaining === '?' ? 'API quota status unavailable' : `${rate.remaining} GitHub API calls left this hour`;
  document.getElementById('rate').textContent = rateLabel;
}

function render() {
  const builds = { success: 0, failure: 0, running: 0, prs: 0 };
  state.details.forEach(data => {
    builds.prs += Number(data.prs) || 0;
    const checks = (data.wf || []).filter(workflow => workflow.name !== 'Pages');
    if (checks.some(workflow => workflow.k === 'running')) builds.running++;
    else if (checks.some(workflow => workflow.k === 'failure')) builds.failure++;
    else if (checks.some(workflow => workflow.k === 'success')) builds.success++;
  });
  document.getElementById('s-apps').textContent = state.repos.length;
  document.getElementById('s-pass').textContent = builds.success;
  document.getElementById('s-fail').textContent = builds.failure;
  document.getElementById('s-run').textContent = builds.running;
  document.getElementById('s-pr').textContent = builds.prs;
  updateCounts();
  document.getElementById('grid').innerHTML = state.repos.map((repo, index) => repoCard(repo, state.details[index] || { wf: [], prs: 0 }, index)).join('');
  document.getElementById('grid').setAttribute('aria-busy', 'false');
  updateFilters();
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  limited = false;
  const refresh = document.getElementById('refresh');
  refresh.disabled = true;
  refresh.classList.add('is-refreshing');
  refresh.setAttribute('aria-busy', 'true');
  document.getElementById('grid').setAttribute('aria-busy', 'true');
  try {
    let repos = await gh(`/users/${OWNER}/repos?per_page=100&sort=pushed`);
    if (!Array.isArray(repos)) throw new Error('No repository data was returned.');
    repos = repos.filter(repo => !repo.fork && repo.name !== SELF)
      .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
    const repositoryDetails = [];
    for (const [index, repo] of repos.entries()) {
      if (index >= DETAIL_N) {
        repositoryDetails.push(LS(`d:${repo.name}`) || { wf: [], prs: 0, msg: '(Details shown for the 12 most recently updated apps.)', ctime: repo.pushed_at });
      } else {
        const cached = LS(`d:${repo.name}`) || { wf: [], prs: 0 };
        repositoryDetails.push(await details(repo).catch(() => cached));
      }
    }
    state.repos = repos;
    state.details = repositoryDetails;
    render();
    document.getElementById('updated').textContent = `Updated ${pkt(new Date().toISOString())}`;
    setNotice('');
  } catch (error) {
    console.error(error);
    const usingCached = state.repos.length > 0;
    setNotice(usingCached
      ? 'Could not reach GitHub just now. Showing the most recently loaded dashboard data.'
      : 'Could not load the dashboard from GitHub. Check your connection and try refreshing.', usingCached ? 'warning' : 'error');
    if (usingCached) document.getElementById('grid').setAttribute('aria-busy', 'false');
  }

  if (limited || (rate.remaining !== '?' && Number(rate.remaining) < 5)) {
    const resumeTime = rate.reset ? pkt(new Date(rate.reset * 1000).toISOString()) : 'after the hourly reset';
    setNotice(`GitHub API rate limit reached. Showing cached data; live updates should resume at ${resumeTime}.`);
  }
  setRateStatus();
  state.loading = false;
  refresh.disabled = false;
  refresh.classList.remove('is-refreshing');
  refresh.removeAttribute('aria-busy');
  document.getElementById('grid').setAttribute('aria-busy', 'false');
}

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('search').addEventListener('input', event => {
  state.query = event.target.value;
  updateFilters();
});
document.querySelector('.filter-group').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll('.filter-button').forEach(item => {
    const active = item === button;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  updateFilters();
});
document.getElementById('clear-filters').addEventListener('click', () => {
  state.filter = 'all';
  state.query = '';
  document.getElementById('search').value = '';
  document.querySelectorAll('.filter-button').forEach(button => {
    const active = button.dataset.filter === 'all';
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  updateFilters();
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    document.getElementById('search').focus();
  }
  if (event.key === 'Escape' && document.activeElement === document.getElementById('search')) {
    document.getElementById('search').value = '';
    state.query = '';
    updateFilters();
  }
});

load();
setInterval(load, REFRESH);
