// OfferPk App Factory dashboard. Public GitHub API only, no token.
// Uses ETag conditional requests (304s don't count toward the 60/hr limit) + localStorage cache.
const OWNER = 'OfferPk';
const API = 'https://api.github.com';
const SELF = 'app-factory-dashboard';
const DETAIL_TTL = 10 * 60e3;
const REFRESH = 60e3;
const DETAIL_N = 12;
const MIN_LEFT = 6;

const LS = key => {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};
const SS = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};

let rate = { remaining: '?', reset: 0 };
let limited = false;
let loading = false;
let allRepos = [];
let allDetails = [];

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
    reset: +response.headers.get('x-ratelimit-reset') || rate.reset
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
    return null;
  }

  const data = await response.json();
  SS(key, { etag: response.headers.get('etag'), t: Date.now(), data });
  return data;
}

const fresh = path => {
  const cached = LS(`gh:${path}`);
  return cached && Date.now() - cached.t < DETAIL_TTL;
};

const pkt = value => value
  ? new Date(value).toLocaleString('en-GB', {
      timeZone: 'Asia/Karachi', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true
    }) + ' PKT'
  : '';

function ago(value) {
  if (!value) return 'time unavailable';
  const minutes = Math.round((Date.now() - new Date(value)) / 6e4);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const kind = run => run.status !== 'completed'
  ? 'running'
  : run.conclusion === 'success'
    ? 'success'
    : ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)
      ? 'failure'
      : 'none';

const label = name => /android|apk/i.test(name)
  ? 'Android build'
  : /page/i.test(name)
    ? 'Pages'
    : /ci|test|lint/i.test(name)
      ? 'CI'
      : name;

async function details(repo) {
  const path = `/repos/${OWNER}/${repo.name}`;
  const previous = LS(`d:${repo.name}`);
  const needRefresh = !previous
    || previous.pushed !== repo.pushed_at
    || !fresh(`${path}/actions/runs?per_page=30`)
    || previous.running;

  if (!needRefresh) return previous;
  if (limited || (rate.remaining !== '?' && +rate.remaining < MIN_LEFT)) {
    return previous || { wf: [], prs: 0, msg: '', ctime: repo.pushed_at };
  }

  const [commits, runs, pulls] = await Promise.all([
    gh(`${path}/commits?per_page=1`),
    gh(`${path}/actions/runs?per_page=30`),
    gh(`${path}/pulls?state=open&per_page=100`)
  ]);

  const latest = {};
  for (const run of (runs && runs.workflow_runs) || []) {
    if (!latest[run.name]) latest[run.name] = run;
  }
  const workflows = Object.values(latest).map(run => ({
    name: label(run.name),
    k: kind(run),
    url: run.html_url
  }));
  const apkRun = ((runs && runs.workflow_runs) || []).find(run =>
    /android|apk/i.test(run.name) && run.conclusion === 'success'
  );
  const commit = commits && commits[0];
  const data = {
    pushed: repo.pushed_at,
    msg: commit ? commit.commit.message.split('\n')[0] : '',
    ctime: commit ? commit.commit.committer.date : repo.pushed_at,
    curl: commit ? commit.html_url : '',
    wf: workflows,
    apk: apkRun ? apkRun.html_url : '',
    prs: pulls ? pulls.length : 0,
    running: workflows.some(workflow => workflow.k === 'running')
  };

  SS(`d:${repo.name}`, data);
  return data;
}

function buildState(data) {
  const checks = (data.wf || []).filter(workflow => workflow.name !== 'Pages');
  if (checks.some(workflow => workflow.k === 'running')) return { key: 'running', label: 'In progress' };
  if (checks.some(workflow => workflow.k === 'failure')) return { key: 'failure', label: 'Needs attention' };
  if (checks.some(workflow => workflow.k === 'success')) return { key: 'success', label: 'Passing' };
  return { key: 'none', label: 'No recent check' };
}

function workflowBadges(data) {
  if (!data.wf.length) return '<span class="workflow-chip is-none">No workflows</span>';
  return data.wf.map(workflow => {
    const mark = workflow.k === 'success'
      ? '✓'
      : workflow.k === 'failure'
        ? '!'
        : workflow.k === 'running'
          ? '<span class="mini-pulse" aria-hidden="true"></span>'
          : '–';
    return `<a class="workflow-chip is-${esc(workflow.k)}" href="${esc(workflow.url)}" target="_blank" rel="noopener noreferrer"><span class="workflow-mark" aria-hidden="true">${mark}</span>${esc(workflow.name)}</a>`;
  }).join('');
}

function card(repo, data, featured = false) {
  const state = buildState(data);
  const initial = esc((repo.name || '?').slice(0, 1).toUpperCase());
  const description = repo.description || 'No description added yet.';
  const commitLabel = data.msg || 'No commit message available';
  const liveDemo = repo.has_pages
    ? `<a class="resource-link" href="https://offerpk.github.io/${encodeURIComponent(repo.name)}/" target="_blank" rel="noopener noreferrer"><span class="resource-icon" aria-hidden="true">↗</span>Live demo</a>`
    : '<span class="resource-link is-disabled"><span class="resource-icon" aria-hidden="true">↗</span>No live demo</span>';
  const apkLink = data.apk
    ? `<a class="resource-link" href="${esc(data.apk)}" target="_blank" rel="noopener noreferrer"><span class="resource-icon" aria-hidden="true">↓</span>Android build</a>`
    : '<span class="resource-link is-disabled"><span class="resource-icon" aria-hidden="true">↓</span>No APK yet</span>';
  const prLabel = `${data.prs || 0} open PR${data.prs === 1 ? '' : 's'}`;

  return `<article class="repo-card${featured ? ' repo-card-featured' : ''}" data-repo="${esc(repo.name)}">
    <div class="repo-card-head">
      <span class="repo-avatar" aria-hidden="true">${initial}</span>
      <div class="repo-title-wrap">
        <span class="repo-owner">OFFERPK <span>/</span> PROJECT</span>
        <h3><a href="${esc(repo.html_url)}" target="_blank" rel="noopener noreferrer">${esc(repo.name)}</a></h3>
      </div>
      <span class="state-pill is-${state.key}"><span class="state-dot" aria-hidden="true"></span>${state.label}</span>
    </div>
    <p class="repo-description">${esc(description)}</p>
    <div class="commit-panel">
      <span class="panel-label">LATEST COMMIT</span>
      <a class="commit-message" href="${esc(data.curl || repo.html_url)}" target="_blank" rel="noopener noreferrer">${esc(commitLabel)}</a>
      <time class="commit-time" datetime="${esc(data.ctime || repo.pushed_at)}">${esc(pkt(data.ctime || repo.pushed_at))}<span aria-hidden="true"> · </span>${esc(ago(data.ctime || repo.pushed_at))}</time>
    </div>
    <div class="workflow-section">
      <span class="panel-label">BUILD CHECKS</span>
      <div class="workflow-list">${workflowBadges(data)}</div>
    </div>
    <div class="repo-card-footer">
      <div class="resource-links">${liveDemo}${apkLink}</div>
      <a class="pr-link" href="${esc(repo.html_url)}/pulls" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">↗</span>${esc(prLabel)}</a>
    </div>
  </article>`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setEmptyState(title, copy, canClear = false) {
  setText('empty-title', title);
  setText('empty-copy', copy);
  document.getElementById('empty').classList.remove('hidden');
  document.getElementById('clear-search').classList.toggle('hidden', !canClear);
}

function renderGrid() {
  const query = document.getElementById('search').value.trim().toLocaleLowerCase();
  const matches = allRepos.filter(repo =>
    `${repo.name} ${repo.description || ''}`.toLocaleLowerCase().includes(query)
  );
  const latestRepo = allRepos[0];
  const featuredMatches = Boolean(latestRepo && matches.includes(latestRepo));
  const spotlight = document.getElementById('now');

  if (latestRepo && (!query || featuredMatches)) {
    spotlight.innerHTML = `<div class="spotlight-heading"><span class="spotlight-live"><span class="live-dot" aria-hidden="true"></span> LATEST PUSH</span><span class="spotlight-caption">Most recently updated app</span></div>${card(latestRepo, allDetails[0] || { wf: [], prs: 0 }, true)}`;
    spotlight.classList.remove('hidden');
  } else {
    spotlight.classList.add('hidden');
  }

  const visibleRepos = matches.filter(repo => !(featuredMatches && repo === latestRepo));
  const grid = document.getElementById('grid');
  grid.innerHTML = visibleRepos.map(repo => {
    const index = allRepos.indexOf(repo);
    return card(repo, allDetails[index] || { wf: [], prs: 0 });
  }).join('');
  grid.setAttribute('aria-busy', 'false');

  const countLabel = `${matches.length} app${matches.length === 1 ? '' : 's'}`;
  setText('grid-count', query ? `${countLabel} found` : countLabel);
  document.getElementById('empty').classList.add('hidden');

  if (!allRepos.length) {
    setEmptyState('App data is not available yet', 'Try refreshing in a moment. The dashboard needs the public GitHub API to load the portfolio.');
  } else if (!matches.length) {
    setEmptyState('No matching apps', 'Try another name or search term.', true);
  } else if (!visibleRepos.length && !featuredMatches) {
    setEmptyState('No apps to show', 'There are no additional apps in this view.');
  }
}

async function load() {
  if (loading) return;
  loading = true;
  limited = false;

  const refreshButton = document.getElementById('refresh');
  const grid = document.getElementById('grid');
  const notice = document.getElementById('notice');
  refreshButton.disabled = true;
  refreshButton.classList.add('is-loading');
  grid.setAttribute('aria-busy', 'true');

  let requestFailed = false;
  try {
    let repos = await gh(`/users/${OWNER}/repos?per_page=100&sort=pushed`);
    if (!repos) throw new Error('No repository data was returned.');

    repos = repos
      .filter(repo => !repo.fork && repo.name !== SELF)
      .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

    const repoDetails = [];
    for (const [index, repo] of repos.entries()) {
      if (index >= DETAIL_N) {
        repoDetails.push(LS(`d:${repo.name}`) || {
          wf: [], prs: 0, msg: '', ctime: repo.pushed_at
        });
      } else {
        repoDetails.push(await details(repo).catch(() =>
          LS(`d:${repo.name}`) || { wf: [], prs: 0, msg: '', ctime: repo.pushed_at }
        ));
      }
    }

    allRepos = repos;
    allDetails = repoDetails;

    let passing = 0;
    let failing = 0;
    let running = 0;
    let openPrs = 0;
    repoDetails.forEach(data => {
      openPrs += data.prs || 0;
      const checks = (data.wf || []).filter(workflow => workflow.name !== 'Pages');
      if (checks.some(workflow => workflow.k === 'running')) running++;
      else if (checks.some(workflow => workflow.k === 'failure')) failing++;
      else if (checks.some(workflow => workflow.k === 'success')) passing++;
    });

    setText('s-apps', repos.length);
    setText('s-pass', passing);
    setText('s-fail', failing);
    setText('s-run', running);
    setText('s-pr', openPrs);
    setText('updated', `Updated ${pkt(new Date().toISOString())}`);
    renderGrid();
  } catch (error) {
    console.error(error);
    requestFailed = true;
    if (allRepos.length) renderGrid();
    else renderGrid();
  } finally {
    loading = false;
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-loading');
    grid.setAttribute('aria-busy', 'false');
  }

  if (limited || (rate.remaining !== '?' && +rate.remaining < 5)) {
    notice.textContent = `GitHub API limit reached. Showing cached data where available; live updates resume at ${pkt(new Date(rate.reset * 1000).toISOString())}.`;
    notice.classList.remove('hidden');
  } else if (requestFailed) {
    notice.textContent = allRepos.length
      ? 'Could not refresh live data. The last available app information is still shown.'
      : 'Could not connect to GitHub. Check your connection and try again.';
    notice.classList.remove('hidden');
  } else {
    notice.classList.add('hidden');
  }

  setText('rate', rate.remaining === '?'
    ? 'Public GitHub API'
    : `${rate.remaining} API calls left this hour`
  );
}

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('search').addEventListener('input', renderGrid);
document.getElementById('clear-search').addEventListener('click', () => {
  const search = document.getElementById('search');
  search.value = '';
  renderGrid();
  search.focus();
});

load();
setInterval(load, REFRESH);
