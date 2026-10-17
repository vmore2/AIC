// AIC — CEO dashboard. Plain JavaScript, no build step, no CDN (customer installs work offline).
// Every change goes through the API → ledger commands; this file only renders and asks.
'use strict';

/* ================================================================== basics */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toFixed(Number(n) < 1 && Number(n) > 0 ? 3 : 2)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const initials = (name) => String(name || '?').replace(/\s+\d+$/, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const firstName = (name) => String(name || '').split(/\s+/)[0] || 'there';
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let TOKEN = '';
try {
  TOKEN = (location.hash.match(/token=([^&]+)/) || [])[1] || sessionStorage.getItem('aic-token') || '';
  if (TOKEN) { sessionStorage.setItem('aic-token', TOKEN); if (/token=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/home'); }
} catch {}

async function api(path, opts = {}) {
  const auth = TOKEN ? { 'x-aic-token': TOKEN } : { 'x-requested-with': 'aic' };
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...auth, 'idempotency-key': crypto.randomUUID(), ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  // Governance needs a recent Google sign-in: confirm it's you, then repeat the action.
  if (r.status === 403 && body.step_up_url) {
    toast('Confirming it’s you with Google — then repeat the action.', 'info');
    setTimeout(() => { location.href = body.step_up_url; }, 900);
    throw Object.assign(new Error('Redirecting to Google to confirm it’s you…'), { quiet: true });
  }
  if (!r.ok) throw Object.assign(new Error(body.title || r.statusText), { status: r.status, body });
  return body;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

/* ================================================================== icons (inline, stroke) */
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  work: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  company: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.2c3 .2 5 2.6 5 5.8"/>',
  talk: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  audit: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  out: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  plan: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  accept: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  ship: '<path d="M4 15l8 4 8-4"/><path d="M12 3v12M7 8l5-5 5 5"/>',
  note: '<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
  google: '',
};
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || P.spark}</svg>`;
const GOOGLE = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

/* ================================================================== toasts, overlays */
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'bad' ? 'warn' : kind === 'info' ? 'spark' : 'check', 'sm')}<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, kind === 'bad' ? 6000 : 3200);
}
const fail = (e) => { if (!e.quiet) toast(e.message || String(e), 'bad'); };

let overlay = null;
function closeOverlay() { overlay?.forEach((n) => n.remove()); overlay = null; document.removeEventListener('keydown', overlayKeys, true); }
function overlayKeys(e) { if (e.key === 'Escape') { e.stopPropagation(); closeOverlay(); } }
function openOverlay(kind, html, cls = '') {
  closeOverlay();
  const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.onclick = closeOverlay;
  const box = document.createElement('div'); box.className = `${kind} ${cls}`; box.setAttribute('role', 'dialog'); box.innerHTML = html;
  document.body.append(scrim, box);
  overlay = [scrim, box];
  document.addEventListener('keydown', overlayKeys, true);
  setTimeout(() => box.querySelector('[autofocus], input, textarea, select')?.focus(), 30);
  return box;
}
const modal = (title, body, foot = '', cls = '') => openOverlay('modal', `<div class="m-head"><h2>${title}</h2><span class="spacer"></span><button class="icon-btn" data-act="close">${icon('x')}</button></div>
  <div class="m-body">${body}</div>${foot ? `<div class="m-foot">${foot}</div>` : ''}`, cls);
const drawer = (title, body, extra = '') => openOverlay('drawer', `<div class="d-head">${title}<span class="spacer"></span>${extra}<button class="icon-btn" data-act="close">${icon('x')}</button></div><div class="d-body">${body}</div>`);

/* ================================================================== vocabulary */
const KIND = {
  plan: { icon: 'plan', label: 'Plan to approve' }, acceptance: { icon: 'accept', label: 'Work to accept' },
  uncertain: { icon: 'question', label: 'Needs your judgment' }, failed: { icon: 'warn', label: 'Stuck' },
  escalation: { icon: 'question', label: 'Question from your team' }, directive: { icon: 'spark', label: 'Proposal from a conversation' },
  release: { icon: 'ship', label: 'Ready to release' }, note: { icon: 'note', label: 'Team note to review' }, connection: { icon: 'db', label: 'Database request' },
};
const STATUS = {
  planned: 'planned', ready: 'ready to start', in_progress: 'in progress', submitted: 'submitted for checks', verifying: 'being verified',
  in_review: 'in independent review', awaiting_acceptance: 'waiting for your acceptance', accepted: 'accepted', changes_requested: 'sent back for changes',
  awaiting_input: 'waiting on you', uncertain: 'uncertain — needs you', failed: 'failed', cancelled: 'cancelled', superseded: 'superseded',
};
const statusTone = (s) => (s === 'accepted' ? 'ok' : ['failed'].includes(s) ? 'bad' : ['uncertain', 'awaiting_input', 'awaiting_acceptance', 'changes_requested'].includes(s) ? 'warn' : ['in_progress', 'verifying', 'in_review', 'submitted'].includes(s) ? 'accent' : '');
const CAT = { manager: 'Lead', producer: 'Builder', reviewer: 'Independent reviewer', qa: 'QA' };
// Employee categories in the ledger → the four roles people see.
const roleOf = (category) => ({ executive: 'manager', manager: 'manager', specialist: 'producer', producer: 'producer', reviewer: 'reviewer', qa: 'qa' }[category] || '');
const PROVIDER_COLOR = { openai: '#10a37f', anthropic: '#c96442', gemini: '#4285f4', openrouter: '#6d5bd0', groq: '#f55036', ollama: '#3d3d3d', custom: '#64748b' };

function ava(name, category = '', state = '', size = '') {
  return `<span class="ava ${size} ${roleOf(category) || category} ${state}" title="${esc(name)}">${esc(initials(name))}${state ? '<span class="st"></span>' : ''}</span>`;
}
function human(ev) {
  const p = ev.payload || {}; const s = ev.subject ? `“${ev.subject}”` : '';
  const who = ev.actor_name && ev.actor_name !== 'Platform' ? ev.actor_name : '';
  switch (ev.type) {
    case 'task.status_changed': {
      const tone = statusTone(p.to);
      if (p.kind === 'planning' && p.to === 'awaiting_acceptance') return { i: 'plan', t: 'accent', x: `A plan is ready for your approval` };
      return { i: p.to === 'accepted' ? 'accept' : p.to === 'failed' ? 'warn' : 'arrow', t: tone, x: `${s || 'A task'} is ${STATUS[p.to] || p.to}` };
    }
    case 'run.started': return { i: 'bolt', t: 'accent', x: `${empName(p.employee_id) || 'An employee'} started working` };
    case 'run.ended': return { i: p.outcome === 'failed' ? 'warn' : 'check', t: p.outcome === 'failed' ? 'bad' : '', x: `A ${p.mode === 'review' ? 'review' : 'work'} session ended (${String(p.outcome).replace(/_/g, ' ')})` };
    case 'submission.created': return { i: 'ship', t: 'accent', x: `${s || 'Work'} was submitted — independent checks start now` };
    case 'evidence.recorded': return { i: p.result === 'pass' ? 'check' : 'warn', t: p.result === 'pass' ? 'ok' : p.result === 'fail' ? 'bad' : 'warn', x: `Check ${p.result === 'pass' ? 'passed' : p.result === 'fail' ? 'failed' : 'inconclusive'} on ${s || 'a task'}` };
    case 'evaluation.completed': return { i: 'audit', t: '', x: `Verification finished on ${s || 'a task'}: ${String(p.outcome).replace(/_/g, ' ')}` };
    case 'objective.created': return { i: 'spark', t: 'accent', x: `New objective ${s}` };
    case 'objective.completed': return { i: 'accept', t: 'ok', x: `Objective ${s} is complete` };
    case 'proposal.submitted': return { i: 'plan', t: 'accent', x: `${who || 'A lead'} proposed a plan` };
    case 'proposal.decided': return { i: 'check', t: 'ok', x: `Plan ${p.decision === 'approve' ? 'approved' : 'sent back'}${who ? ` by ${who}` : ''}` };
    case 'escalation.raised': return { i: 'question', t: 'warn', x: `${who || 'Someone'} needs a decision` };
    case 'decision.recorded': return { i: 'check', t: 'ok', x: `${who || 'You'} answered a question` };
    case 'directive.proposed': return { i: 'spark', t: 'accent', x: `${who || 'A lead'} proposed a change for you to confirm` };
    case 'directive.confirmed': return { i: 'check', t: 'ok', x: 'You confirmed a proposal' };
    case 'department.hired': return { i: 'company', t: 'accent', x: `Hired the ${p.key} team (${plural(p.employees, 'employee')})` };
    case 'connection.requested': return { i: 'db', t: 'warn', x: `${who || 'An employee'} asked for a ${p.kind} database` };
    case 'connection.provided': return { i: 'db', t: 'ok', x: `Database ${s} connected (${p.access === 'read' ? 'read-only' : 'read/write'})` };
    case 'action.intended': {
      const what = { push_branch: 'pushing work to its branch', merge_to_base: 'merging approved work into the main branch', execute: 'running a database statement', open_pr: 'opening a pull request', merge_pr: 'merging the pull request' }[p.action] || String(p.action || 'acting').replace(/_/g, ' ');
      return { i: 'bolt', t: '', x: `${who ? `${who}: ` : ''}${what.charAt(0).toUpperCase()}${what.slice(1)}` };
    }
    case 'command.rejected': case 'command.denied': return { i: 'shield', t: 'warn', x: `A rule stopped an action${who ? ` by ${who}` : ''}${p.command ? ` (${String(p.command).replace(/([A-Z])/g, ' $1').toLowerCase().trim()})` : ''}` };
    case 'release.approved': return { i: 'ship', t: 'ok', x: `Release approved for ${s || 'an objective'}` };
    case 'emergency_stop.initiated': return { i: 'stop', t: 'bad', x: 'Emergency stop: all work halted' };
    case 'scope.resumed': return { i: 'play', t: 'ok', x: 'Work resumed' };
    case 'tool_call.denied': return { i: 'shield', t: 'bad', x: `Blocked an action by ${who || 'an employee'} (policy)` };
    case 'instructions.set': return { i: 'note', t: 'accent', x: `Instructions updated for ${p.scope_type === 'company' ? 'the whole company' : p.scope_type === 'department' ? 'a team' : p.scope_type === 'role' ? 'a role' : 'an employee'}` };
    case 'instructions.cleared': return { i: 'note', t: '', x: 'Instructions removed' };
    case 'company.stack_set': return { i: 'layers', t: '', x: 'Tech stack updated' };
    case 'model_provider.added': return { i: 'key', t: '', x: `Connected ${p.label}` };
    case 'model_profile.added': return { i: 'chip', t: '', x: `Added model ${ev.aggregate_id}` };
    case 'employee.model_changed': return { i: 'chip', t: '', x: `${p.role} now uses ${p.model_profile}` };
    case 'user.added': return { i: 'people', t: '', x: `${p.name} joined as ${p.role}` };
    case 'user.email_set': return { i: 'people', t: '', x: `${s || 'Someone'} can now sign in as ${p.email}` };
    case 'user.access_removed': return { i: 'people', t: 'warn', x: `Access removed for ${s || 'a person'}` };
    case 'access_token.issued': return { i: 'key', t: '', x: 'An access token was issued' };
    case 'company.default_model_set': return { i: 'star', t: '', x: `New hires now use ${p.key}` };
    case 'mode.changed': return { i: 'shield', t: '', x: `Oversight changed to ${modeName(p.mode)}` };
    case 'plan.materialized': return { i: 'plan', t: 'ok', x: 'An approved plan became tasks' };
    case 'requirement.changed': return { i: 'note', t: 'warn', x: `Requirement ${p.key || ''} changed` };
    case 'ci.result': return { i: p.status === 'success' ? 'check' : 'warn', t: p.status === 'success' ? 'ok' : 'bad', x: `CI ${p.status === 'success' ? 'passed' : 'failed'}${p.name ? ` (${p.name})` : ''}` };
    case 'task.reassigned': return { i: 'people', t: '', x: `${s || 'A task'} was reassigned` };
    case 'review.unavailable': return { i: 'warn', t: 'warn', x: `Independent review couldn’t run on ${s || 'a task'} — it needs your judgment` };
    default: return { i: 'spark', t: '', x: ev.type.replace(/[._]/g, ' ') };
  }
}

/* ================================================================== state + shell */
const S = { me: null, setup: null, inbox: [], team: [], models: null, page: 'home', params: [], timer: null, deck: 0, chat: {} };
const empName = (id) => S.team.flatMap((d) => d.employees).find((e) => e.id === id)?.display_name;
const isManager = () => ['ceo', 'admin'].includes(S.me?.role);
const NAV = [
  { k: 'home', label: 'Home', i: 'home' }, { k: 'inbox', label: 'Decisions', i: 'inbox', badge: () => S.inbox.length },
  { k: 'work', label: 'Work', i: 'work' }, { k: 'company', label: 'Company', i: 'company' }, { k: 'talk', label: 'Talk', i: 'talk' },
  { sep: true },
  { k: 'setup', label: 'Setup', i: 'setup', badge: () => S.setup ? S.setup.steps.filter((s) => !s.done).length : 0, warn: true, managers: true },
  { k: 'people', label: 'People', i: 'people', managers: true }, { k: 'audit', label: 'Audit', i: 'audit' },
];
const TITLES = { home: 'Home', inbox: 'Decisions', work: 'Work', company: 'Company', talk: 'Talk', setup: 'Setup', people: 'People', audit: 'Audit' };

function renderShell() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#app').innerHTML = `<div class="shell">
    <aside class="side" id="side">
      <div class="brand"><div class="mark"></div><div><b id="co-name">${esc(S.companyName || 'AIC')}</b><small>CEO console</small></div></div>
      <nav class="nav" id="nav"></nav>
      <div class="grow"></div>
      <button class="btn hold" id="hold" title="Press and hold to stop all consequential work">${icon('stop')}<span>Hold to stop all work</span></button>
      <div class="me">${ava(S.me.name, 'user')}<div class="who"><b>${esc(S.me.name)}</b><small>${esc(S.me.role)}${S.me.owner ? ' · owner' : ''}</small></div>
        <button class="icon-btn" data-act="theme" title="Light / dark">${icon(dark ? 'sun' : 'moon')}</button>
        <button class="icon-btn" data-act="signout" title="Sign out">${icon('out')}</button></div>
    </aside>
    <div class="main">
      <div id="stopbar"></div>
      <div class="top" id="top"><button class="icon-btn menu-btn" data-act="menu">${icon('menu')}</button>
        <div class="crumbs" id="crumbs"></div><span class="spacer"></span>
        <span class="live" title="Updates every few seconds"><i></i>live</span><span id="bell"></span>
        <button class="kbar" data-act="palette">${icon('search', 'sm')}<span>Search or jump to…</span><kbd>Ctrl K</kbd></button></div>
      <main class="page" id="page"></main>
    </div></div>`;
  renderNav();
  renderShellBell();
  wireHold();
  addEventListener('scroll', () => $('#top')?.classList.toggle('scrolled', scrollY > 4), { passive: true });
}
function alertsOn() { try { return localStorage.getItem('aic-alerts') === 'on' && 'Notification' in window && Notification.permission === 'granted'; } catch { return false; } }
function renderShellBell() { const b = $('#bell'); if (b) b.innerHTML = alertsOn() ? '' : `<button class="btn sm ghost" data-act="alerts" title="Get a desktop alert when your team needs a decision">${icon('inbox', 'sm')}Alerts</button>`; }
function notify(items) {
  if (!alertsOn() || document.visibilityState === 'visible') return;
  const it = items[0];
  const n = new Notification(items.length > 1 ? `${items.length} decisions need you` : (KIND[it.kind]?.label || 'Decision needed'), { body: it.title, tag: 'aic-decisions' });
  n.onclick = () => { window.focus(); location.hash = '#/inbox'; n.close(); };
}
function newObjective() {
  if (!S.team.length) { toast('Hire a team first.', 'bad'); location.hash = '#/company/hire'; return; }
  modal('New objective', `<p class="muted" style="margin-bottom:6px">Say what must be true when it's done. The team lead turns this into a plan for your approval; every task is checked against these words, verbatim.</p>
    <label class="f">Title</label><input id="no-title" placeholder="Online ordering for the bakery" autofocus>
    <div class="field-row"><div><label class="f">Team</label><select id="no-team">${S.team.map((d) => `<option value="${esc(d.key)}">${esc(d.name)}</option>`).join('')}</select></div>
      <div style="max-width:180px"><label class="f">Budget <small>(USD, model spend)</small></label><input id="no-budget" type="number" min="0.05" step="0.05" value="1.00"></div></div>
    <label class="f">Requirements <small>— one per line</small></label><textarea id="no-reqs" rows="6" placeholder="Customers can browse the menu with prices&#10;Orders are stored in our PostgreSQL database&#10;The kitchen sees new orders within a minute"></textarea>
    <p class="small muted" style="margin-top:8px">Tip: concrete, checkable sentences work best ("returns 404 for unknown items" beats "handles errors well").</p>`,
  `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="obj-save">${icon('spark', 'sm')}Create &amp; ask for a plan</button>`);
}
function renderNav() {
  const nav = $('#nav'); if (!nav) return;
  nav.innerHTML = NAV.filter((n) => !n.managers || isManager()).map((n) => n.sep ? '<div class="sep"></div>' : (() => {
    const b = n.badge?.() || 0;
    return `<a href="#/${n.k}" class="${S.page === n.k ? 'on' : ''}">${icon(n.i)}${n.label}${b ? `<span class="badge ${n.warn ? 'warn' : ''}">${b}</span>` : ''}</a>`;
  })()).join('');
  const sb = $('#stopbar');
  if (sb) sb.innerHTML = S.setup?.stopped ? `<div class="stopbar">${icon('stop')}All work is stopped. Nothing consequential runs until you resume.<span class="spacer"></span><button class="btn sm" data-act="resume">${icon('play', 'sm')}Resume work</button></div>` : '';
}
function crumbs(...parts) { $('#crumbs').innerHTML = parts.map((p, i) => i === parts.length - 1 ? `<b>${p}</b>` : `<span>${p}</span>${icon('arrow', 'sm')}`).join(''); }
const page = () => $('#page');
const head = (title, sub = '', actions = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span class="spacer"></span>${actions}</div>`;

/* ================================================================== router */
const PAGES = {};
async function route(quiet = false) {
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
  S.page = PAGES[parts[0]] ? parts[0] : 'home';
  S.params = parts.slice(1);
  if (!quiet) { closeOverlay(); $('#side')?.classList.remove('open'); scrollTo({ top: 0 }); }
  renderNav();
  crumbs(TITLES[S.page]);
  try { await PAGES[S.page](...S.params); } catch (e) { if (!quiet) page().innerHTML = `<div class="card"><div class="callout bad">${icon('warn')}<div>${esc(e.message)}</div></div></div>`; }
}
addEventListener('hashchange', () => route());
const LIVE = new Set(['home', 'work', 'company', 'audit']);
async function tick() {
  try {
    const [setup, inbox, team] = await Promise.all([api('/api/setup'), api('/api/inbox'), api('/api/team')]);
    const changed = inbox.length !== S.inbox.length || JSON.stringify(team) !== JSON.stringify(S.team) || setup.stopped !== S.setup?.stopped;
    const fresh = inbox.filter((i) => !S.inbox.some((o) => o.id === i.id && o.kind === i.kind));
    if (fresh.length && S.inbox.length + fresh.length >= inbox.length) notify(fresh);
    S.setup = setup; S.inbox = inbox; S.team = team;
    renderNav();
    const busy = overlay || (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName));
    if (changed && !busy && LIVE.has(S.page)) route(true);
    if (S.page === 'inbox' && inbox.length && !$('.qi')) route(true);
  } catch { /* offline for a moment */ }
}

/* ================================================================== HOME */
PAGES.home = async () => {
  const [status, events] = await Promise.all([api('/api/status'), api('/api/events?limit=40')]);
  S.companyName = status.company?.name; if ($('#co-name')) $('#co-name').textContent = S.companyName;
  const objs = status.objectives;
  const emps = S.team.flatMap((d) => d.employees);
  const working = emps.filter((e) => e.state === 'working');
  const waiting = emps.filter((e) => e.state === 'waiting');
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const spent = objs.reduce((s, o) => s + o.budget.spent, 0);
  const steps = S.setup?.steps || [];
  const doneSteps = steps.filter((s) => s.done).length;
  const stepLink = { models: '#/setup/models', stack: '#/setup/stack', teams: '#/company/hire', people: '#/people', brief: '#/talk' };
  page().innerHTML = `
    <div class="page-head"><div class="hello"><div><h1>${greet}, <span>${esc(firstName(S.me.name))}</span></h1>
      <div class="stats">
        <a class="stat" href="#/inbox">${icon('inbox', 'sm')}<b>${S.inbox.length}</b> ${S.inbox.length === 1 ? 'decision needs' : 'decisions need'} you</a>
        <a class="stat" href="#/company">${icon('bolt', 'sm')}<b>${working.length}</b> working now${waiting.length ? ` · <span class="warn">${waiting.length} waiting on you</span>` : ''}</a>
        <a class="stat" href="#/work">${icon('work', 'sm')}<b>${objs.filter((o) => o.status !== 'completed').length}</b> active ${objs.filter((o) => o.status !== 'completed').length === 1 ? 'objective' : 'objectives'}</a>
        <span class="stat">${icon('chip', 'sm')}<b>${money(spent)}</b> model spend</span>
      </div></div></div></div>
    <div class="grid two">
      <div class="stack">
        ${doneSteps < steps.length && isManager() ? `<div class="card"><div class="card-head"><div class="ring" style="--p:${Math.round(100 * doneSteps / steps.length)}" data-label="${doneSteps}/${steps.length}"></div>
            <div><h2>Set up your company</h2><div class="muted">A few minutes. Everything runs on your own accounts — we host nothing.</div></div></div>
          <div class="steps">${steps.map((s) => `<a class="step ${s.done ? 'done' : ''}" href="${stepLink[s.key]}" style="color:inherit;text-decoration:none">
            <span class="tick">${icon('check', 'sm')}</span><span class="txt"><b>${esc(s.title)}</b><small>${esc(s.detail)}</small></span>${s.done ? '' : icon('arrow', 'sm')}</a>`).join('')}</div></div>` : ''}
        ${S.inbox.length ? `<div class="card"><div class="card-head"><h2>Needs you</h2><span class="spacer"></span><a href="#/inbox" class="btn sm">Open decisions ${icon('arrow', 'sm')}</a></div>
          <div class="needs">${S.inbox.slice(0, 4).map((it, i) => `<a class="need" href="#/inbox/${i}"><span class="k k-${it.kind}">${icon(KIND[it.kind]?.icon)}</span><span class="t">${esc(it.title)}</span>${icon('arrow', 'sm')}</a>`).join('')}</div></div>` : ''}
        ${objs.length ? objs.slice().reverse().map(objectiveCard).join('') : `<div class="card empty">${artEmpty()}<h3>No objectives yet</h3><p>Tell a team lead what you want. They come back with a plan for you to approve.</p>
          <p style="margin-top:14px"><a class="btn primary" href="#/talk">${icon('talk', 'sm')}Brief a team lead</a></p></div>`}
      </div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>On the floor</h2><span class="spacer"></span><a href="#/company" class="btn sm ghost">Company ${icon('arrow', 'sm')}</a></div>
          ${emps.length ? `<div class="row" style="gap:8px">${emps.filter((e) => e.status === 'active').map((e) => `<a href="#/company" title="${esc(e.display_name)} — ${e.state}">${ava(e.display_name, e.category, e.state === 'idle' ? '' : e.state, 'sm')}</a>`).join('')}</div>
          <div class="legend" style="margin-top:12px"><span><i style="--c:var(--ok)"></i>working</span><span><i style="--c:var(--warn)"></i>waiting on you</span><span><i style="--c:var(--line-2)"></i>idle</span></div>`
          : `<div class="muted">No one hired yet. <a href="#/company/hire">Hire a team</a></div>`}</div>
        <div class="card"><div class="card-head"><h2>Activity</h2><span class="spacer"></span><a href="#/audit" class="btn sm ghost">Full audit ${icon('arrow', 'sm')}</a></div>
          <div class="feed">${events.filter((e) => !['employee.hired', 'action.outcome_recorded', 'review.assigned', 'task.created', 'conversation.message', 'conversation.started'].includes(e.type)).slice(0, 14).map((e) => {
            const h = human(e); return `<div class="ev"><span class="dot ${h.t}">${icon(h.i, 'sm')}</span><div class="body">${esc(h.x)}<small>${ago(e.occurred_at)}</small></div></div>`;
          }).join('') || '<div class="muted">Nothing yet.</div>'}</div></div>
      </div>
    </div>`;
};
function artEmpty() {
  return `<svg class="art" viewBox="0 0 120 90" fill="none"><rect x="14" y="20" width="92" height="56" rx="10" fill="var(--sunken)"/><rect x="26" y="34" width="40" height="6" rx="3" fill="var(--line-2)"/><rect x="26" y="46" width="62" height="6" rx="3" fill="var(--line)"/><rect x="26" y="58" width="30" height="6" rx="3" fill="var(--line)"/><circle cx="94" cy="22" r="12" fill="var(--accent-soft)"/><path d="M89 22.5l3.5 3.5 6.5-7" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function stages(o) {
  const b = o.tasks.byStatus || {};
  const n = (...k) => k.reduce((s, x) => s + (b[x] || 0), 0);
  const total = o.tasks.total;
  const stuck = n('failed', 'awaiting_input', 'uncertain') > 0;
  const plan = o.delivery === 'planning' ? 'now' : 'done';
  const building = n('planned', 'ready', 'in_progress', 'changes_requested', 'awaiting_input', 'failed');
  const checking = n('submitted', 'verifying', 'in_review', 'awaiting_acceptance', 'uncertain');
  const build = !total ? '' : building ? (n('awaiting_input', 'failed') ? 'stuck' : 'now') : 'done';
  const verify = !total ? '' : checking ? (n('uncertain') ? 'stuck' : 'now') : building ? '' : 'done';
  const ship = o.status === 'completed' ? (S.inbox.some((i) => i.kind === 'release' && i.id === o.id) ? 'now' : 'done') : '';
  void stuck;
  return [['Plan', plan], ['Build', build], ['Verify', verify], ['Ship', ship]];
}
function pipe(o) { return `<div class="pipe">${stages(o).map(([l, c]) => `<div class="stage ${c}"><div class="bar"><i></i></div><span>${l}</span></div>`).join('')}</div>`; }
function deliveryChip(d) {
  const m = { on_track: ['ok', 'On track'], at_risk: ['warn', 'At risk'], blocked: ['bad', 'Blocked'], done: ['ok', 'Done'], planning: ['accent', 'Planning'] }[d] || ['', d];
  return `<span class="chip dot ${m[0]}">${m[1]}</span>`;
}
function truth(o) {
  return `<div class="truth"><span class="muted">Verified</span><div class="meter"><i style="width:${o.verifiedPct}%"></i></div><b>${o.verifiedPct}%</b>
    <span class="muted">Claimed</span><div class="meter claimed"><i style="width:${o.claimedPct}%"></i></div><span class="muted">${o.claimedPct}%</span></div>
    ${o.discrepancy > 0 ? `<div class="small warn" style="margin-top:6px">${icon('warn', 'sm')} ${o.discrepancy} points claimed by employees but not yet independently verified.</div>` : ''}`;
}
function objectiveCard(o) {
  return `<a class="card obj" href="#/work/${o.id}"><div class="row"><h3>${esc(o.title)}</h3><span class="chip">${esc(o.department)}</span>${deliveryChip(o.delivery)}<span class="spacer"></span>
      ${o.pendingDecisions ? `<span class="chip warn">${plural(o.pendingDecisions, 'decision')} waiting</span>` : ''}</div>
    ${pipe(o)}${truth(o)}
    <div class="row small muted" style="margin-top:10px">${esc(o.deliveryReason)}<span class="spacer"></span>${money(o.budget.spent)} of ${money(o.budget.limit)}</div></a>`;
}

/* ================================================================== DECISIONS */
PAGES.inbox = async (idx) => {
  crumbs('Decisions');
  const items = S.inbox = await api('/api/inbox');
  renderNav();
  if (idx !== undefined) S.deck = Math.min(Number(idx) || 0, Math.max(0, items.length - 1));
  if (!items.length) {
    page().innerHTML = head('Decisions', 'Everything your teams need from you, one at a time.') + `<div class="card empty">${artEmpty()}<h3>All clear</h3><p>Nothing needs you right now. Your teams will ask when they do.</p></div>`;
    return;
  }
  S.deck = Math.min(S.deck, items.length - 1);
  page().innerHTML = head('Decisions', `${plural(items.length, 'thing')} waiting on you. <span class="hint">Shortcuts: <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>A</kbd> approve · <kbd>R</kbd> request changes · <kbd>N</kbd> note</span>`) +
    `<div class="deck"><div class="queue" id="queue">${items.map((it, i) => `<div class="qi ${i === S.deck ? 'on' : ''}" data-act="deck" data-i="${i}"><span class="k k-${it.kind}">${icon(KIND[it.kind]?.icon, 'sm')}</span><span class="t">${esc(it.title)}</span></div>`).join('')}</div>
     <div class="focus" id="focus"><div class="card main"><div class="skel" style="width:40%"></div><div class="skel" style="margin-top:12px"></div><div class="skel" style="margin-top:8px;width:70%"></div></div><div class="ghost-1"></div><div class="ghost-2"></div></div></div>`;
  await renderDecision();
};
async function renderDecision() {
  const it = S.inbox[S.deck]; if (!it) return;
  $$('.qi').forEach((q, i) => q.classList.toggle('on', i === S.deck));
  const k = KIND[it.kind] || { icon: 'spark', label: it.kind };
  let body = ''; let primary = null; let secondary = null; let note = { show: true, ph: 'Optional note — required when you request changes' };
  try {
    if (it.kind === 'plan') {
      const p = await api('/api/proposals/' + it.id);
      const tasks = p.content.tasks || [];
      body = `<p class="muted">${esc(p.content.summary)}</p>
        <div style="margin-top:10px">${tasks.map((t) => `<div class="task-li"><b>${esc(t.title)}</b><span class="chip">${esc(t.owner_role.replace(/_/g, ' '))}</span><span class="chip accent">${money(t.budget_usd)}</span>
          <div class="spec">${esc(t.spec)} <span class="muted small">· covers ${t.requirement_keys.map(esc).join(', ')}</span></div></div>`).join('')}</div>
        <div class="row small muted" style="margin-top:8px">${plural(tasks.length, 'task')} · ${money(tasks.reduce((s, t) => s + Number(t.budget_usd || 0), 0))} budget${(p.content.risks || []).length ? ` · Risks: ${p.content.risks.map(esc).join('; ')}` : ''}</div>`;
      primary = { label: 'Approve plan', act: 'd-plan-approve' }; secondary = { label: 'Request changes', act: 'd-plan-changes' };
    } else if (['acceptance', 'uncertain', 'failed'].includes(it.kind)) {
      const d = await api('/api/tasks/' + it.id);
      body = `<p class="muted">${esc(it.detail)}</p>${evidenceTable(d)}<p style="margin-top:10px"><a href="#" data-act="open-task" data-id="${it.id}">Open the full task ${icon('arrow', 'sm')}</a></p>`;
      if (it.kind === 'acceptance') { primary = { label: 'Accept work', act: 'd-accept' }; secondary = { label: 'Request changes', act: 'd-reject' }; }
      else if (it.kind === 'uncertain') { primary = { label: 'Accept anyway', act: 'd-accept-uncertain' }; secondary = { label: 'Request changes', act: 'd-reject' }; note.ph = 'Why you decide this way (required)'; }
      else { primary = { label: 'Try again', act: 'd-retry' }; secondary = { label: 'Cancel task', act: 'd-cancel' }; note.ph = 'What should change on the next attempt? (shown to the employee; required to cancel)';
        body += `<div class="row" style="margin-top:12px"><label class="small muted" for="retry-budget">Extra budget for the retry</label><input id="retry-budget" type="number" min="0" step="0.05" value="0.10" style="width:110px"><span class="small muted">USD</span></div>`; }
    } else if (it.kind === 'escalation') {
      body = it.detail ? `<div class="callout">${icon('spark')}<div>${esc(it.detail)}</div></div>` : '';
      note.ph = 'Your answer'; primary = { label: 'Send answer', act: 'd-answer' };
    } else if (it.kind === 'directive') {
      const d = await api('/api/directives/' + it.id);
      body = directiveDetails(d);
      primary = { label: 'Confirm', act: 'd-dir-confirm' }; secondary = { label: 'Decline', act: 'd-dir-decline' };
    } else if (it.kind === 'release') {
      body = `<div class="callout ok">${icon('accept')}<div>Every task is accepted and checks pass on the integration branch. Approving merges this exact commit to your main branch.</div></div>`;
      primary = { label: 'Approve release', act: 'd-release' }; note.show = false;
    } else if (it.kind === 'note') {
      body = `<pre class="code">${esc(it.detail)}</pre><p class="small muted" style="margin-top:8px">Approved notes are shown to the whole team as advice (requirements still win).</p>`;
      primary = { label: 'Approve note', act: 'd-note-ok' }; secondary = { label: 'Reject', act: 'd-note-no' };
    } else if (it.kind === 'connection') {
      const c = isManager() ? (await api('/api/connections')).find((x) => x.id === it.id) : null;
      body = `<p class="muted">${esc(it.detail)}</p>${c?.task_title ? `<p class="small">For task <b>${esc(c.task_title)}</b> — it is paused until you decide.</p>` : ''}
        ${isManager() ? connectionForm(c?.kind || 'postgres', c) : '<div class="callout">Only the CEO or an admin can connect databases.</div>'}`;
      note.show = false;
      if (isManager()) { primary = { label: 'Connect database', act: 'd-conn' }; secondary = { label: 'Decline', act: 'd-conn-decline' }; }
    }
  } catch (e) { body = `<div class="callout bad">${icon('warn')}<div>${esc(e.message)}</div></div>`; }
  $('#focus').innerHTML = `<div class="card main" data-kind="${it.kind}">
      <div class="d-kind k-${it.kind}"><span class="k">${icon(k.icon, 'sm')}</span>${k.label}</div>
      <div class="d-title">${esc(it.title)}</div>${body}
      ${note.show ? `<label class="f" for="note">Note</label><textarea id="note" rows="2" placeholder="${esc(note.ph)}"></textarea>` : ''}
      <div class="d-actions">${primary ? `<button class="btn primary" data-act="${primary.act}" data-id="${it.id}" data-primary>${icon('check', 'sm')}${primary.label}<kbd>A</kbd></button>` : ''}
        ${secondary ? `<button class="btn" data-act="${secondary.act}" data-id="${it.id}" data-secondary>${secondary.label}<kbd>R</kbd></button>` : ''}
        <span class="spacer"></span><span class="hint">${S.deck + 1} of ${S.inbox.length}</span>
        <button class="icon-btn" data-act="deck-step" data-d="-1" title="Previous (K)">${icon('back', 'sm')}</button><button class="icon-btn" data-act="deck-step" data-d="1" title="Next (J)">${icon('arrow', 'sm')}</button></div></div>
    <div class="ghost-1"></div>${S.inbox.length > 2 ? '<div class="ghost-2"></div>' : ''}`;
}
function evidenceTable(d) {
  if (!d.claimVsEvidence?.length) return '<div class="muted small">No acceptance criteria recorded.</div>';
  return `<div class="evi head"><span>What had to be true</span><span>Employee claimed</span><span>Platform verified</span></div>
    ${d.claimVsEvidence.map((x) => `<div class="evi"><span>${esc(x.criterion)}</span><span class="muted">${x.claimed ? esc(x.claimed.replace(/_/g, ' ')) : '—'}</span>
      <span><span class="chip ${x.verified === 'passed' ? 'ok' : x.verified === 'failed' ? 'bad' : 'warn'}">${esc(x.verified)}</span>${x.claimed === 'met' && x.verified === 'failed' ? `<div class="flag">${icon('warn', 'sm')}claim contradicted</div>` : ''}</span></div>`).join('')}`;
}
function directiveDetails(d) {
  const p = d.payload || {};
  if (d.directive_type === 'create_objective') {
    const reqs = p.requirements || [];
    return `<p class="muted">${esc(p.summary || '')}</p><div class="card flat" style="background:var(--surface-2)"><div class="row"><b>${esc(p.title || 'New objective')}</b><span class="spacer"></span>${p.budget_usd ? `<span class="chip accent">budget ${money(p.budget_usd)}</span>` : ''}${p.department ? `<span class="chip">${esc(p.department)}</span>` : ''}</div>
      ${reqs.length ? `<ol style="margin:10px 0 0;padding-left:20px">${reqs.map((r) => `<li>${esc(typeof r === 'string' ? r : r.text)}</li>`).join('')}</ol>` : ''}</div>`;
  }
  return `<p class="muted">${esc(p.summary || '')}</p><pre class="code">${esc(JSON.stringify(p, null, 2))}</pre>`;
}
async function decided(msg) {
  const card = $('#focus .card.main'); card?.classList.add('leave');
  toast(msg);
  await new Promise((r) => setTimeout(r, 260));
  S.inbox = await api('/api/inbox'); renderNav();
  if (S.page === 'inbox') route(true);
}
const noteEl = () => $('.drawer #note') || $('.modal #note') || $('#note');
const noteVal = () => (noteEl()?.value || '').trim();
function needNote(what) { const v = noteVal(); if (!v) { noteEl()?.focus(); toast(`Write ${what} in the note first.`, 'bad'); } return v; }

/* ================================================================== connections (shared form) */
function connectionForm(kind, c = null, extra = '') {
  const cfg = c?.config || {};
  return `<div id="conn-form" data-kind="${kind}" data-id="${c?.id || ''}">
    ${extra}
    <div class="field-row"><div><label class="f">Host</label><input id="cf-host" value="${esc(cfg.host || '')}" placeholder="db.example.com or 127.0.0.1" autocomplete="off"></div>
      <div style="max-width:140px"><label class="f">Port</label><input id="cf-port" type="number" value="${esc(cfg.port || (kind === 'mysql' ? 3306 : 5432))}"></div></div>
    <div class="field-row"><div><label class="f">Database</label><input id="cf-db" value="${esc(cfg.database || '')}" placeholder="app"></div>
      <div><label class="f">User</label><input id="cf-user" value="${esc(cfg.user || '')}" placeholder="app_user" autocomplete="off"></div></div>
    <label class="f">Password <small>— stored encrypted on your machine; employees never see it</small></label>
    <div class="secret"><input id="cf-pass" type="password" autocomplete="new-password" placeholder="••••••••"><button class="icon-btn" data-act="reveal" data-for="cf-pass" type="button">${icon('eye', 'sm')}</button></div>
    <div class="row" style="margin-top:12px"><label class="row tight"><input type="checkbox" id="cf-ssl" ${cfg.ssl ? 'checked' : ''}> Require SSL</label><span class="spacer"></span>
      <div class="seg" id="cf-access"><button type="button" class="${c?.access === 'read_write' ? '' : 'on'}" data-v="read">Read-only</button><button type="button" class="${c?.access === 'read_write' ? 'on' : ''}" data-v="read_write">Read &amp; write</button></div></div>
    <p class="small muted" style="margin-top:8px">Read-only runs every query in a read-only transaction. Read &amp; write lets builders change data; every write is logged with its exact SQL.</p>
    <div class="row" style="margin-top:6px"><button class="btn sm" data-act="conn-test" type="button">${icon('bolt', 'sm')}Test connection</button><span id="cf-result" class="small"></span></div></div>`;
}
function readConn() {
  const f = $('#conn-form');
  return { id: f.dataset.id || undefined, kind: f.dataset.kind, access: $('#cf-access .on')?.dataset.v || 'read', password: $('#cf-pass').value,
    config: { host: $('#cf-host').value.trim(), port: Number($('#cf-port').value), database: $('#cf-db').value.trim(), user: $('#cf-user').value.trim(), ssl: $('#cf-ssl').checked } };
}

/* ================================================================== WORK */
PAGES.work = async (id) => {
  const status = await api('/api/status');
  if (!id) {
    crumbs('Work');
    page().innerHTML = head('Work', 'Every objective, its real progress, and where it is stuck.', `<a class="btn" href="#/talk">${icon('talk', 'sm')}Brief a lead</a><button class="btn primary" data-act="new-objective">${icon('plus', 'sm')}New objective</button>`) +
      (status.objectives.length ? `<div class="stack">${status.objectives.slice().reverse().map(objectiveCard).join('')}</div>` :
        `<div class="card empty">${artEmpty()}<h3>No work yet</h3><p>Write what you want done, or talk it through with a team lead first.</p><p style="margin-top:14px" class="row"><span class="spacer"></span><button class="btn primary" data-act="new-objective">New objective</button><a class="btn" href="#/talk">Brief a team lead</a><span class="spacer"></span></p></div>`);
    return;
  }
  const o = status.objectives.find((x) => x.id === id);
  if (!o) { page().innerHTML = '<div class="card">Objective not found.</div>'; return; }
  crumbs('Work', esc(o.title));
  const tab = S.params[1] || 'board';
  const release = S.inbox.find((i) => i.kind === 'release' && i.id === id);
  page().innerHTML = head(esc(o.title), `${esc(o.department)} · ${esc(o.deliveryReason)}`, `${release ? `<button class="btn primary" data-act="release" data-id="${id}">${icon('ship', 'sm')}Approve release</button>` : ''}`) +
    `<div class="card">${pipe(o)}<div class="grid two" style="gap:24px"><div>${truth(o)}</div><div class="small muted">Budget: <b style="color:var(--ink)">${money(o.budget.spent)}</b> spent of ${money(o.budget.limit)}${o.budget.reserved ? ` (${money(o.budget.reserved)} reserved for running work)` : ''}</div></div></div>
    <div class="row" style="margin:18px 0 12px"><div class="seg"><button class="${tab === 'board' ? 'on' : ''}" data-act="nav" data-href="#/work/${id}/board">Board</button><button class="${tab === 'requirements' ? 'on' : ''}" data-act="nav" data-href="#/work/${id}/requirements">Requirements</button></div></div>
    <div id="work-tab"></div>`;
  if (tab === 'requirements') return requirementsTab(id);
  const tasks = (await api('/api/tasks?objective=' + id)).filter((t) => !['cancelled', 'superseded'].includes(t.status));
  const cols = [
    ['Up next', ['planned', 'ready'], ''], ['In progress', ['in_progress', 'changes_requested'], ''], ['Waiting on you', ['awaiting_input', 'awaiting_acceptance', 'uncertain'], 'you'],
    ['Being verified', ['submitted', 'verifying', 'in_review'], ''], ['Done', ['accepted'], ''], ['Problems', ['failed'], ''],
  ];
  const owner = (t) => S.team.flatMap((d) => d.employees).find((e) => e.display_name === t.owner);
  $('#work-tab').innerHTML = `<div class="board">${cols.map(([name, sts, cls]) => {
    const list = tasks.filter((t) => sts.includes(t.status));
    return `<div class="col ${cls}"><h4>${name}<span class="n">${list.length}</span></h4>${list.map((t) => {
      const e = owner(t);
      return `<div class="tcard" data-act="open-task" data-id="${t.id}"><b>${esc(t.title)}</b><div class="meta">${t.owner ? ava(t.owner, e?.category, e?.state === 'working' ? 'working' : '', 'sm') : ''}<span>${esc(t.owner || 'unassigned')}</span><span class="spacer"></span>
        ${t.kind === 'planning' ? '<span class="chip">plan</span>' : ''}${t.status === 'changes_requested' ? '<span class="chip warn">rework</span>' : ''}${t.hold ? '<span class="chip bad">held</span>' : ''}${t.attempt > 1 ? `<span title="attempt">#${t.attempt}</span>` : ''}</div></div>`;
    }).join('')}</div>`;
  }).join('')}</div>`;
};
async function requirementsTab(id) {
  const reqs = await api(`/api/objectives/${id}/requirements`);
  $('#work-tab').innerHTML = `<div class="grid two"><div class="card"><h2 style="margin-bottom:10px">Requirements <span class="muted small">(verbatim — every task is checked against these)</span></h2>
      ${reqs.map((r) => `<div class="task-li"><b>${esc(r.key)}</b><span class="chip">v${r.version}</span><span></span><div class="spec">${esc(r.text)}</div></div>`).join('')}</div>
    <div class="card"><h2>Change or add one</h2><p class="small muted" style="margin-top:6px">History is kept. Unaccepted work on the old version is withdrawn and the lead re-plans for your approval. Accepted work stays accepted against its version.</p>
      <div class="field-row"><div style="max-width:140px"><label class="f">Key</label><input id="rq-key" placeholder="REQ-${reqs.length + 1}"></div><div><label class="f">Why</label><input id="rq-why" placeholder="Reason for the change"></div></div>
      <label class="f">New text</label><textarea id="rq-text" rows="4"></textarea>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="req-save" data-id="${id}">Apply change</button></div></div></div>`;
}
async function openTask(id) {
  const d = await api('/api/tasks/' + id); const t = d.task;
  const runs = d.runs || [];
  const box = drawer(`<div><div class="small muted">${esc(t.objective_title || '')}</div><h2>${esc(t.title)}</h2></div>`, `
    <div class="row" style="margin-bottom:14px"><span class="chip dot ${statusTone(t.status)}">${esc(STATUS[t.status] || t.status)}</span><span class="chip">risk ${esc(t.risk_tier)}</span>
      <span class="chip">attempt ${t.attempt}/${t.max_attempts}</span>${t.assurance_label ? `<span class="chip ok" title="How this was verified">${esc(t.assurance_label)}</span>` : ''}${t.hold ? `<span class="chip bad">held: ${esc(t.hold)}</span>` : ''}</div>
    <div class="row" style="margin-bottom:16px">${t.owner_name ? `${ava(t.owner_name, '', '', 'sm')}<span>${esc(t.owner_name)}</span>` : '<span class="muted">Unassigned</span>'}</div>
    ${d.requirements.length ? `<h3>Requirements</h3><div style="margin:6px 0 16px">${d.requirements.map((r) => `<div class="small"><b>${esc(r.key)}</b> <span class="muted">v${r.version}</span> ${esc(r.text)}</div>`).join('')}</div>` : ''}
    <h3 style="margin-bottom:6px">Claim vs. evidence</h3>${evidenceTable(d)}
    ${t.status === 'awaiting_acceptance' || t.status === 'uncertain' ? `<label class="f">Note</label><textarea id="note" rows="2" placeholder="${t.status === 'uncertain' ? 'Why you accept work that could not be verified (required)' : 'Optional — required to request changes'}"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="${t.status === 'uncertain' ? 'd-accept-uncertain' : 'd-accept'}" data-id="${t.id}">${icon('check', 'sm')}${t.status === 'uncertain' ? 'Accept anyway' : 'Accept work'}</button><button class="btn" data-act="d-reject" data-id="${t.id}">Request changes</button></div>` : ''}
    ${t.status === 'failed' ? `<label class="f">What should change next time?</label><textarea id="note" rows="2" placeholder="Shown to the employee as feedback"></textarea>
      <div class="row" style="margin-top:10px"><input id="retry-budget" type="number" min="0" step="0.05" value="0.10" style="width:110px" title="Extra budget (USD)"><button class="btn primary" data-act="d-retry" data-id="${t.id}">Try again</button><button class="btn" data-act="d-cancel" data-id="${t.id}">Cancel task</button></div>` : ''}
    ${['planned', 'ready', 'awaiting_input', 'changes_requested'].includes(t.status) ? `<p style="margin-top:12px"><button class="btn sm ghost" data-act="cancel-ask" data-id="${t.id}">Cancel this task…</button></p>` : ''}
    ${['planned', 'ready', 'in_progress', 'awaiting_input', 'changes_requested', 'failed'].includes(t.status) ? `<h3 style="margin-top:20px">Reassign</h3><div id="reassign" class="row" style="margin-top:8px"><span class="muted small">Loading teammates…</span></div>` : ''}
    <h3 style="margin-top:20px">Sessions</h3><div style="margin-top:6px">${runs.map((r) => `<div class="row small" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="chip">${esc(r.mode)}</span>${esc(r.employee)}<span class="spacer"></span><span class="${r.status === 'failed' ? 'bad' : 'muted'}">${esc(r.status)}${r.failure_reason ? ` — ${esc(r.failure_reason)}` : ''}</span><span class="muted">${money(r.cost_usd)}</span></div>`).join('') || '<span class="muted small">None yet.</span>'}</div>
    <details style="margin-top:20px"><summary class="muted" style="cursor:pointer">Ledger timeline (${d.timeline.length} events)</summary><pre class="code" style="margin-top:8px">${d.timeline.map((e) => `${e.seq}  ${new Date(e.at).toLocaleString()}  ${e.type}  ${JSON.stringify(e.payload).slice(0, 140)}`).map(esc).join('\n')}</pre></details>`);
  const ra = box.querySelector('#reassign');
  if (ra) {
    const cands = await api(`/api/tasks/${id}/candidates`).catch(() => []);
    ra.innerHTML = cands.length ? `<select id="ra-who" style="width:auto">${cands.map((c) => `<option value="${c.id}">${esc(c.display_name)}</option>`).join('')}</select><input id="ra-why" placeholder="Why?" style="flex:1;min-width:140px"><button class="btn sm" data-act="reassign" data-id="${id}">Reassign</button>`
      : '<span class="muted small">No other teammate can take this task.</span>';
  }
}

/* ================================================================== COMPANY */
PAGES.company = async (tab = 'floor', key) => {
  crumbs('Company', tab === 'hire' ? 'Hire a team' : tab === 'build' ? 'Design a team' : 'Floor');
  const tabs = `<div class="seg"><button class="${tab === 'floor' ? 'on' : ''}" data-act="nav" data-href="#/company">Floor</button><button class="${tab === 'hire' ? 'on' : ''}" data-act="nav" data-href="#/company/hire">Hire a team</button><button class="${tab === 'build' ? 'on' : ''}" data-act="nav" data-href="#/company/build">Design a team</button></div>`;
  if (tab === 'hire') return hireTab(tabs);
  if (tab === 'build') return buildTab(tabs, key);
  const deps = S.team = await api('/api/team');
  page().innerHTML = head('Company', 'Your AI departments. Click anyone to see their record and choose their model.', tabs) +
    `<div class="legend" style="margin:-6px 0 16px">${Object.entries(CAT).map(([c, l]) => `<span><i style="--c:var(--c-${c})"></i>${l}</span>`).join('')}<span><i style="--c:var(--ok)"></i>working now</span><span><i style="--c:var(--warn)"></i>waiting on you</span></div>` +
    (deps.length ? `<div class="stack">${deps.map(room).join('')}</div>` : `<div class="card empty">${artEmpty()}<h3>No teams yet</h3><p>Hire a ready-made team, or describe the roles you need.</p>
      <p style="margin-top:14px" class="row" ><span class="spacer"></span><a class="btn primary" href="#/company/hire">Hire a team</a><a class="btn" href="#/company/build">Design a team</a><span class="spacer"></span></p></div>`);
};
function room(d) {
  const emps = d.employees.filter((e) => e.status === 'active');
  const seat = (e) => `<div class="seat" data-act="emp" data-id="${e.id}">${ava(e.display_name, e.category, e.state === 'idle' ? '' : e.state, 'lg')}<b>${esc(e.display_name)}</b><small>${esc(e.model_profile)}</small></div>`;
  const leads = emps.filter((e) => roleOf(e.category) === 'manager'); const checks = emps.filter((e) => ['reviewer', 'qa'].includes(e.category));
  const builders = emps.filter((e) => !leads.includes(e) && !checks.includes(e));
  const busy = emps.filter((e) => e.state === 'working').length;
  return `<div class="card room"><div class="room-head"><h2>${esc(d.name)}</h2><span class="chip" title="Oversight level">${modeName(d.mode || d.default_mode)}</span>${busy ? `<span class="chip ok dot">${busy} working</span>` : ''}<span class="spacer"></span><span class="muted small">${plural(emps.length, 'employee')}</span>${isManager() ? `<button class="btn sm" data-act="team-settings" data-key="${esc(d.key)}">${icon('setup', 'sm')}Oversight &amp; instructions</button>` : ''}</div>
    ${leads.length ? `<div class="tier lead">${leads.map(seat).join('')}</div>` : ''}<div class="tier">${builders.map(seat).join('')}</div>${checks.length ? `<div class="tier checks">${checks.map(seat).join('')}</div>` : ''}</div>`;
}
const modeName = (m) => ({ M1: 'Autonomous', M2: 'Exceptions only', M3: 'Milestones', M4: 'Plan gates', M5: 'Supervised', M6: 'Stopped' }[m] || m);
async function openEmployee(id) {
  const d = S.team.find((x) => x.employees.some((e) => e.id === id)); const e = d.employees.find((x) => x.id === id);
  const models = isManager() ? await api('/api/models').catch(() => null) : null;
  drawer(`<div class="row">${ava(e.display_name, e.category, e.state === 'idle' ? '' : e.state, 'lg')}<div><h2>${esc(e.display_name)}</h2><div class="muted small">${esc(e.role_title)} · ${esc(d.name)}</div></div></div>`, `
    <div class="row" style="margin-bottom:16px"><span class="chip ${e.state === 'working' ? 'ok' : e.state === 'waiting' ? 'warn' : ''} dot">${e.state === 'working' ? 'Working now' : e.state === 'waiting' ? 'Waiting on you' : 'Idle'}</span><span class="chip">${CAT[roleOf(e.category)] || e.category}</span></div>
    <div class="grid cols" style="grid-template-columns:repeat(3,1fr);gap:10px">${[['Accepted', e.accepted], ['In flight', e.active], ['Rework rate', e.reworkRate === null ? '—' : `${e.reworkRate}%`]].map(([l, v]) => `<div class="card flat" style="padding:12px"><div class="muted small">${l}</div><div style="font-size:22px;font-weight:700">${v}</div></div>`).join('')}</div>
    <p class="small muted" style="margin-top:8px">Rework rate = share of submissions that independent checks sent back. Numbers come from the ledger, not from the employee.</p>
    <h3 style="margin-top:20px">Model</h3>
    ${models ? `<p class="small muted" style="margin:4px 0 8px">Applies to every ${esc(e.role_title)} in ${esc(d.name)}. Running sessions finish on their current model.</p>
      <div class="row"><select id="emp-model" style="flex:1">${models.models.map((m) => `<option value="${esc(m.key)}" ${m.key === e.model_profile ? 'selected' : ''}>${esc(m.key)} — ${esc(m.family)}${m.provider === 'scripted' ? ' (offline demo)' : ` · ${money(m.price_per_million.input)}/${money(m.price_per_million.output)} per 1M`}</option>`).join('')}</select>
      <button class="btn primary" data-act="emp-model" data-dept="${esc(d.key)}" data-role="${esc(e.role_key)}">Apply</button></div>
      ${e.category === 'reviewer' ? '<div class="callout" style="margin-top:10px">' + icon('shield') + '<div>Put reviewers on a <b>different model family</b> than builders — same-family models share blind spots, and higher-risk work only counts reviews from a different family.</div></div>' : ''}`
      : `<div class="muted">${esc(e.model_profile)}</div>`}
    <h3 style="margin-top:22px">Instructions</h3>
    <p class="small muted" style="margin:4px 0 10px">Standing guidance on <i>how</i> to work — tone, conventions, focus. They never grant permissions, and an objective's requirements win if they conflict.</p>
    <div id="emp-ins"><div class="skel"></div></div>`);
  const all = await api('/api/instructions').catch(() => []);
  const team = all.find((i) => i.scope_type === 'department' && i.team_key === d.key);
  const company = all.find((i) => i.scope_type === 'company');
  const role = all.find((i) => i.scope_type === 'role' && i.team_key === d.key && i.role_key === e.role_key);
  const mine = all.find((i) => i.scope_type === 'employee' && i.scope_id === e.id);
  const inherited = [[company, 'Whole company', '#/setup/instructions'], [team, d.name, null]].filter(([x]) => x);
  $('#emp-ins').innerHTML = `${inherited.length ? `<div class="small muted" style="margin-bottom:8px">Also applies: ${inherited.map(([x, l]) => `<span class="chip" title="${esc(x.body)}">${esc(l)}</span>`).join(' ')}</div>` : ''}
    ${isManager() ? `<label class="f">For ${esc(e.display_name)} only</label><textarea id="ins-emp" rows="3" placeholder="e.g. You own edge cases: always test empty input and unicode.">${esc(mine?.body || '')}</textarea>
      <div class="row" style="margin-top:6px"><button class="btn sm primary" data-act="ins-save" data-scope="employee" data-employee="${e.id}" data-src="ins-emp">Save</button>${mine ? `<span class="small muted">v${mine.version}</span>` : ''}</div>
      <label class="f">For every ${esc(e.role_title)} in ${esc(d.name)}</label><textarea id="ins-role" rows="3" placeholder="e.g. Add a JSDoc comment to every exported function.">${esc(role?.body || '')}</textarea>
      <div class="row" style="margin-top:6px"><button class="btn sm primary" data-act="ins-save" data-scope="role" data-team="${esc(d.key)}" data-role="${esc(e.role_key)}" data-src="ins-role">Save</button>${role ? `<span class="small muted">v${role.version}</span>` : ''}</div>`
      : [mine, role].filter(Boolean).map((x) => `<pre class="code">${esc(x.body)}</pre>`).join('') || '<div class="muted small">No instructions.</div>'}`;
}
async function teamSettings(key) {
  const d = S.team.find((x) => x.key === key);
  const all = await api('/api/instructions').catch(() => []);
  const team = all.find((i) => i.scope_type === 'department' && i.team_key === key);
  modal(`${esc(d.name)} — settings`, `<label class="f" style="margin-top:0">Oversight</label>
    <div class="pick" id="ts-mode">${MODE_INFO.map(([m, l]) => `<button type="button" class="${(d.mode || d.default_mode) === m ? 'on' : ''}" data-act="ts-mode" data-v="${m}">${l}</button>`).join('')}</div>
    <p class="small muted" id="ts-mode-help" style="margin-top:8px">${MODE_INFO.find(([m]) => m === (d.mode || d.default_mode))?.[2] || ''}</p>
    <label class="f">Team instructions <small>— every employee in ${esc(d.name)} follows these</small></label>
    <textarea id="ins-team" rows="5" placeholder="e.g. Prefer the standard library over new dependencies. Keep pull requests small.">${esc(team?.body || '')}</textarea>`,
  `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="ts-save" data-team="${esc(key)}">Save</button>`);
}
const MODE_INFO = [
  ['M1', 'Autonomous', 'The team plans and executes on its own; you see results and exceptions.'],
  ['M3', 'Milestones', 'You review at milestones; routine steps run on their own.'],
  ['M4', 'Plan gates', 'You approve every plan before work starts (recommended).'],
  ['M5', 'Supervised', 'You approve plans and every consequential step.'],
];
async function hireTab(tabs) {
  const teams = await api('/api/catalog');
  page().innerHTML = head('Company', 'Ready-made teams with built-in checks. Hiring uses your default model — change any role later.', tabs) +
    `<div class="grid cols">${teams.map((t) => `<div class="card" style="display:flex;flex-direction:column">
      <div class="row"><h3>${esc(t.name)}</h3><span class="spacer"></span>${t.hired ? '<span class="chip ok dot">hired</span>' : `<span class="chip">${t.source === 'recommended' ? 'Recommended' : 'Custom'}</span>`}</div>
      <p class="small muted" style="margin:8px 0 12px;flex:1">${esc(t.purpose)}</p>
      <div class="row tight" style="margin-bottom:12px">${t.roles.map((r) => `<span title="${esc(r.title)} ×${r.count}">${ava(r.title, r.category, '', 'sm')}</span>`).join('')}<span class="small muted" style="margin-left:6px">${plural(t.roles.reduce((s, r) => s + r.count, 0), 'seat')}</span></div>
      ${t.errors.length ? `<div class="small bad">${icon('warn', 'sm')} ${esc(t.errors[0])}</div>` : ''}
      <div class="row">${t.hired ? '' : `<button class="btn primary sm" data-act="hire" data-key="${t.key}" ${t.errors.length ? 'disabled' : ''}>Hire</button>`}<button class="btn sm" data-act="team-detail" data-key="${t.key}">How it works</button>
        ${t.format === 'team_spec' ? `<a class="btn sm ghost" href="#/company/build/${t.key}">${t.source === 'custom' ? 'Edit' : 'Copy'}</a>` : ''}</div></div>`).join('')}</div>`;
}
async function teamDetail(key) {
  const t = (await api('/api/catalog')).find((x) => x.key === key);
  modal(esc(t.name), `<p class="muted">${esc(t.purpose)}</p>
    <h3 style="margin-top:14px">How work flows</h3><div class="row tight" style="margin-top:8px">${t.workflow.map((s, i) => `${i ? icon('arrow', 'sm') : ''}<span class="chip ${s.gate !== 'none' ? 'accent' : ''}" title="${esc(s.gate)}">${esc(s.key.replace(/_/g, ' '))}${s.gate !== 'none' ? ' · ' + esc(s.gate.replace(/_/g, ' ')) : ''}</span>`).join('')}</div>
    ${t.roles.map((r) => `<div class="row" style="margin-top:16px;align-items:flex-start">${ava(r.title, r.category)}<div style="flex:1"><b>${esc(r.title)}</b> <span class="muted small">×${r.count} · ${CAT[roleOf(r.category)] || r.category}${r.reportsTo ? ` · reports to ${esc(r.reportsTo)}` : ''}</span>
      <div class="small">${esc(r.does)}</div>${r.criteria.length ? `<div class="small muted" style="margin-top:4px">Checked by: ${r.criteria.map((c) => esc(c.statement)).join(' · ')}</div>` : ''}</div></div>`).join('')}
    ${t.neverAutonomous.length ? `<div class="callout warn" style="margin-top:16px">${icon('shield')}<div><b>Always needs a human:</b> ${t.neverAutonomous.map(esc).join('; ')}</div></div>` : ''}`,
  t.hired ? '' : `<button class="btn primary" data-act="hire" data-key="${t.key}">Hire this team</button>`);
}

/* ---------------- team builder (describe roles → platform derives the rest) */
let draft = null; let caps = [];
const blankRole = (o = {}) => ({ title: '', does: '', count: 1, type: 'member', works_with: ['documents'], reviews: [], document: '', sections: '', human_judges: '', affects_people: false, ...o });
function toSpec(d) {
  return { team: d.team, name: d.name, purpose: d.purpose, mode: d.mode, risk: d.risk, never_autonomous: d.never.split('\n').map((x) => x.trim()).filter(Boolean),
    roles: d.roles.map((r) => {
      const o = { title: r.title, does: r.does, count: Number(r.count) || 1 };
      if (r.type === 'lead') o.lead = true; if (r.type === 'qa') o.qa = true; if (r.type === 'reviewer') o.reviews = r.reviews;
      if (r.works_with.length) o.works_with = r.works_with;
      if (r.document) o.delivers = [{ document: r.document, ...(r.sections ? { sections: r.sections.split(',').map((s) => s.trim()).filter(Boolean) } : {}) }];
      if (r.human_judges) o.human_judges = r.human_judges; if (r.affects_people) o.affects_people = true;
      return o;
    }) };
}
function fromSpec(s) {
  return { team: s.team, name: s.name, purpose: s.purpose, mode: s.mode || 'plan_gates', risk: s.risk || 'standard', never: (s.never_autonomous || []).join('\n'), teamTouched: true,
    roles: s.roles.map((r) => blankRole({ title: r.title, does: r.does, count: r.count || 1, type: r.lead ? 'lead' : r.qa ? 'qa' : (r.reviews || []).length ? 'reviewer' : 'member',
      works_with: r.works_with || ['documents'], reviews: r.reviews || [], document: r.delivers?.find((x) => x.document)?.document || '',
      sections: (r.delivers?.find((x) => x.document)?.sections || []).join(', '), human_judges: r.human_judges || '', affects_people: !!r.affects_people })) };
}
async function buildTab(tabs, key) {
  if (!caps.length) caps = await api('/api/capabilities');
  if (key) draft = fromSpec(await api(`/api/catalog/${key}/spec`));
  else if (!draft) draft = { team: '', name: '', purpose: '', mode: 'plan_gates', risk: 'standard', never: 'Anything sent outside the company', roles: [blankRole({ type: 'lead' }), blankRole(), blankRole({ type: 'reviewer' })] };
  page().innerHTML = head('Company', 'Describe the roles. The platform derives tools, checks, the review chain and safeguards — and refuses unsafe designs.', tabs) + '<div id="builder"></div>';
  renderBuilder();
}
const TYPES = [['lead', 'Lead', 'Plans and reports to you'], ['member', 'Builder', 'Does the work'], ['reviewer', 'Reviewer', 'Independently checks others'], ['qa', 'QA', 'Tests from outside the chain']];
function renderBuilder(result = '') {
  const d = draft; const titles = d.roles.map((r) => r.title).filter(Boolean);
  $('#builder').innerHTML = `<div class="grid two"><div class="stack">
    <div class="card"><div class="field-row"><div><label class="f">Team name</label><input id="b-name" value="${esc(d.name)}" placeholder="Growth Marketing"></div><div><label class="f">Key</label><input id="b-team" value="${esc(d.team)}" placeholder="growth_marketing"></div></div>
      <label class="f">What this team is for</label><textarea id="b-purpose" rows="2" placeholder="What good output looks like">${esc(d.purpose)}</textarea>
      <div class="field-row"><div><label class="f">Oversight</label><select id="b-mode">${[['autonomous', 'Autonomous'], ['exceptions', 'Exceptions only'], ['milestones', 'Milestones'], ['plan_gates', 'Plan gates (recommended)'], ['supervised', 'Supervised']].map(([v, l]) => `<option value="${v}" ${v === d.mode ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="f">Risk</label><select id="b-risk">${['low', 'standard', 'high', 'critical'].map((m) => `<option ${m === d.risk ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
      <label class="f">Never without a human <small>(one per line)</small></label><textarea id="b-never" rows="2">${esc(d.never)}</textarea></div>
    ${d.roles.map((r, i) => `<div class="card"><div class="row" style="align-items:flex-start">${ava(r.title || '?', { lead: 'manager', member: 'producer', reviewer: 'reviewer', qa: 'qa' }[r.type], '', '')}
      <div style="flex:1"><div class="field-row"><div><label class="f" style="margin-top:0">Role</label><input data-i="${i}" data-f="title" value="${esc(r.title)}" placeholder="Content Strategist"></div>
        <div style="max-width:110px"><label class="f" style="margin-top:0">Seats</label><input type="number" min="1" max="10" data-i="${i}" data-f="count" value="${r.count}"></div></div>
      <div class="pick" style="margin-top:10px">${TYPES.map(([v, l, h]) => `<button type="button" class="${r.type === v ? 'on' : ''}" title="${h}" data-act="b-type" data-i="${i}" data-v="${v}">${l}</button>`).join('')}</div>
      <label class="f">What they do</label><textarea rows="2" data-i="${i}" data-f="does" placeholder="One or two sentences">${esc(r.does)}</textarea>
      ${r.type === 'reviewer' ? `<label class="f">Reviews</label><div class="pick">${titles.filter((t) => t !== r.title).map((t) => `<button type="button" class="${r.reviews.includes(t) ? 'on' : ''}" data-act="b-review" data-i="${i}" data-v="${esc(t)}">${esc(t)}</button>`).join('') || '<span class="muted small">Name the other roles first</span>'}</div>` : ''}
      <label class="f">Works with</label><div class="pick">${caps.map((c) => `<button type="button" title="${esc(c.label)}" class="${r.works_with.includes(c.key) ? 'on' : ''}" data-act="b-cap" data-i="${i}" data-v="${c.key}">${esc(c.key.replace(/_/g, ' '))}</button>`).join('')}</div>
      ${r.type === 'member' || r.type === 'qa' ? `<div class="field-row"><div><label class="f">Delivers document</label><input data-i="${i}" data-f="document" value="${esc(r.document)}" placeholder="growth/PLAN.md"></div><div><label class="f">Required sections</label><input data-i="${i}" data-f="sections" value="${esc(r.sections)}" placeholder="Summary, Details"></div></div>
        <label class="f">A person must accept this work <small>(optional)</small></label><input data-i="${i}" data-f="human_judges" value="${esc(r.human_judges)}" placeholder="The CEO approves the messaging">
        <label class="row tight" style="margin-top:10px"><input type="checkbox" data-i="${i}" data-f="affects_people" ${r.affects_people ? 'checked' : ''}> Affects individuals (always decided by a human)</label>` : ''}</div>
      <button class="icon-btn" data-act="b-remove" data-i="${i}" title="Remove role">${icon('trash', 'sm')}</button></div></div>`).join('')}
    <button class="btn" data-act="b-add">${icon('plus', 'sm')}Add a role</button></div>
    <div><div class="card" style="position:sticky;top:76px"><h2>Check &amp; save</h2><p class="small muted" style="margin-top:6px">Every design is checked against the architecture rules: independent review, separation of duties, and no role that both reads untrusted content and acts outside.</p>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="b-check">Check design</button><button class="btn primary" data-act="b-save">Save</button><button class="btn primary" data-act="b-save-hire">Save &amp; hire</button></div>
      <div id="b-result" style="margin-top:14px">${result}</div></div></div></div>`;
  $$('#builder [data-f]').forEach((el) => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', (e) => {
    const r = draft.roles[Number(e.target.dataset.i)]; const f = e.target.dataset.f;
    r[f] = f === 'affects_people' ? e.target.checked : e.target.value;
  }));
  ['name', 'team', 'mode', 'risk', 'purpose', 'never'].forEach((f) => $('#b-' + f).addEventListener('input', (e) => {
    draft[f] = e.target.value;
    if (f === 'name' && !draft.teamTouched) { draft.team = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); $('#b-team').value = draft.team; }
    if (f === 'team') draft.teamTouched = true;
  }));
}
function builderResult(t, saved) {
  return `${saved ? `<div class="callout ok" style="margin-bottom:10px">${icon('check')}<div><b>Saved.</b> ${esc(saved)}</div></div>` : ''}
    ${t.errors.length ? t.errors.map((x) => `<div class="callout bad" style="margin-bottom:6px">${icon('warn')}<div>${esc(x)}</div></div>`).join('') : `<div class="callout ok">${icon('check')}<div>Passes every architecture rule.</div></div>`}
    ${[...t.warnings, ...t.notes].map((x) => `<div class="small warn" style="margin-top:6px">! ${esc(x)}</div>`).join('')}
    ${t.workflow.length ? `<h3 style="margin-top:14px">Workflow</h3><div class="row tight" style="margin-top:6px">${t.workflow.map((s, i) => `${i ? icon('arrow', 'sm') : ''}<span class="chip">${esc(s.key.replace(/_/g, ' '))}</span>`).join('')}</div>` : ''}
    ${t.roles.length ? `<h3 style="margin-top:14px">What the platform derived</h3>${t.roles.map((r) => `<div style="margin-top:8px"><b>${esc(r.title)}</b> <span class="muted small">${esc(r.category)}</span>
      ${r.criteria.map((c) => `<div class="small">${icon('check', 'sm')} ${esc(c.statement)} <span class="muted">— ${esc(c.by)}</span></div>`).join('')}</div>`).join('')}` : ''}`;
}

/* ================================================================== TALK */
PAGES.talk = async (empId) => {
  crumbs('Talk');
  const leads = S.team.flatMap((d) => d.employees.filter((e) => roleOf(e.category) === 'manager' && e.status === 'active').map((e) => ({ ...e, team: d.name })));
  if (!leads.length) {
    page().innerHTML = head('Talk', 'Brief a team lead in plain words.') + `<div class="card empty">${artEmpty()}<h3>No team leads yet</h3><p>Hire a team first — its lead is who you talk to.</p><p style="margin-top:14px"><a class="btn primary" href="#/company/hire">Hire a team</a></p></div>`;
    return;
  }
  const lead = leads.find((l) => l.id === empId) || leads[0];
  page().innerHTML = head('Talk', 'Leads answer from the ledger. Anything that changes work comes back as a proposal you confirm.') +
    `<div class="card pad-0 talk"><div class="leads">${leads.map((l) => `<a class="lead-i ${l.id === lead.id ? 'on' : ''}" href="#/talk/${l.id}" style="color:inherit;text-decoration:none">${ava(l.display_name, 'manager', l.state === 'idle' ? '' : l.state)}<div><b>${esc(l.display_name)}</b><small>${esc(l.team)}</small></div></a>`).join('')}</div>
    <div class="convo"><div class="head">${ava(lead.display_name, 'manager')}<div><b>${esc(lead.display_name)}</b><div class="small muted">${esc(lead.team)} · uses ${esc(lead.model_profile)}</div></div></div>
      <div class="msgs" id="msgs"><div class="msg sys">Loading the conversation…</div></div>
      <div class="compose"><textarea id="say" rows="1" placeholder="Tell ${esc(firstName(lead.display_name))} what you need… (Enter to send, Shift+Enter for a new line)"></textarea><button class="btn primary" data-act="send" data-id="${lead.id}">${icon('send', 'sm')}Send</button></div></div></div>`;
  const hist = await api('/api/chat/' + lead.id).catch(() => ({ messages: [], directives: [] }));
  const timeline = [...hist.messages.map((m) => ({ at: m.created_at, html: `<div class="msg ${m.author_type === 'user' ? 'me' : 'them'}">${esc(m.body)}</div>` })),
    ...hist.directives.map((d) => ({ at: d.created_at, after: 1, html: directiveCard(d) }))].sort((a, b) => (new Date(a.at) - new Date(b.at)) || ((a.after || 0) - (b.after || 0)));
  $('#msgs').innerHTML = timeline.length ? timeline.map((t) => t.html).join('') : `<div class="empty" style="padding:30px 10px"><h3>Start with what you want</h3><p>Plain words are fine. ${esc(firstName(lead.display_name))} will ask questions and propose a plan.</p>
    <div class="suggest">${['What are you working on, and what do you need from me?', 'Build a small REST API for orders, stored in PostgreSQL', 'What would it take to add user sign-in to our app?'].map((s) => `<button data-act="suggest">${esc(s)}</button>`).join('')}</div></div>`;
  scrollMsgs();
  const say = $('#say');
  say.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('[data-act="send"]').click(); } });
  say.addEventListener('input', () => { say.style.height = 'auto'; say.style.height = Math.min(180, say.scrollHeight) + 'px'; });
  say.focus();
};
function directiveCard(d) {
  const p = d.payload || {}; const pending = d.status === 'pending_confirmation';
  return `<div class="dir ${pending ? '' : 'done'}" data-dir="${d.id}"><div class="row small" style="margin-bottom:6px">${icon('spark', 'sm')}<b>Proposal</b><span class="chip ${pending ? 'accent' : d.status === 'confirmed' || d.status === 'applied' ? 'ok' : ''}">${esc(pending ? 'waiting for you' : d.status)}</span></div>
    ${directiveDetails(d)}${pending ? `<div class="row" style="margin-top:10px"><button class="btn primary sm" data-act="dir-yes" data-id="${d.id}">${icon('check', 'sm')}Confirm</button><button class="btn sm" data-act="dir-no" data-id="${d.id}">Decline</button></div>` : ''}</div>`;
}
const scrollMsgs = () => { const m = $('#msgs'); if (m) m.scrollTop = m.scrollHeight; };

/* ================================================================== SETUP */
PAGES.setup = async (section) => {
  crumbs('Setup');
  if (!isManager()) { page().innerHTML = head('Setup') + '<div class="card">Only the CEO or an admin can change setup.</div>'; return; }
  const [setup, models, presets, roles, stack, conns, authCfg, instr] = await Promise.all([api('/api/setup'), api('/api/models'), api('/api/providers/presets'), api('/api/roles'), api('/api/stack'), api('/api/connections'), fetch('/api/auth/config').then((r) => r.json()).catch(() => ({})), api('/api/instructions').catch(() => [])]);
  S.setup = setup; S.models = models; S.presets = presets; S.stack = stack; renderNav();
  const done = Object.fromEntries(setup.steps.map((s) => [s.key, s.done]));
  const real = models.models.filter((m) => m.provider !== 'scripted');
  const toc = [['models', 'AI models', done.models], ['roles', 'Who uses which model', roles.length > 0 && real.length > 0], ['stack', 'Tech stack', done.stack], ['databases', 'Databases', conns.some((c) => c.status === 'active')], ['instructions', 'Instructions', instr.some((i) => i.scope_type === 'company')], ['access', 'Sign-in & access', !!authCfg.google], ['infra', 'Infrastructure', true]];
  page().innerHTML = head('Setup', 'Your company runs on your own accounts. Keys and passwords are encrypted on this machine; employees never see them.') +
    `<div class="setup-grid"><nav class="toc">${toc.map(([k, l, d]) => `<a href="#/setup/${k}" class="${d ? 'done' : ''}"><span class="tick"></span>${l}</a>`).join('')}</nav><div class="stack">
    <section class="card" id="sec-models"><div class="card-head">${icon('chip', 'lg')}<div><h2>AI models</h2><div class="muted small">Your employees think with models you choose and pay for directly.${models.spend_cap_usd ? ` Lifetime spend cap: <b>${money(models.spend_cap_usd)}</b> per key.` : ''}</div></div><span class="spacer"></span><button class="btn primary" data-act="add-provider">${icon('plus', 'sm')}Add a provider</button></div>
      ${models.providers.length ? models.providers.map((p) => {
        const ms = models.models.filter((m) => m.provider_id === p.id);
        return `<div class="prov card flat" style="background:var(--surface-2)"><div class="prov-head"><span class="logo" style="background:${PROVIDER_COLOR[p.kind] || '#64748b'}">${esc(p.label[0])}</span><div style="flex:1"><b>${esc(p.label)}</b><div class="small muted">${p.key_fingerprint ? `${icon('key', 'sm')} ${esc(p.key_fingerprint)}` : 'no key (local)'}${p.base_url ? ` · ${esc(p.base_url)}` : ''}</div></div>
          <button class="btn sm" data-act="add-models" data-id="${p.id}">${icon('plus', 'sm')}Model</button><button class="icon-btn" data-act="rm-provider" data-id="${p.id}" title="Remove provider">${icon('trash', 'sm')}</button></div>
          <div class="models">${ms.map(modelChip).join('') || '<span class="muted small">No models chosen yet.</span>'}</div></div>`;
      }).join('') : `<div class="callout">${icon('spark')}<div>No provider connected yet. Add OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, a local Ollama, or any OpenAI-compatible endpoint. The key is checked for free before it's saved.</div></div>`}
      ${models.models.some((m) => m.source === 'config') ? `<div class="small muted" style="margin-top:12px">From <code>aic.config.yaml</code>: <span class="models" style="display:inline-flex">${models.models.filter((m) => m.source === 'config').map(modelChip).join('')}</span></div>` : ''}</section>

    <section class="card" id="sec-roles"><div class="card-head">${icon('company', 'lg')}<div><h2>Who uses which model</h2><div class="muted small">Change any role at any time. Tip: reviewers on a different model family than builders.</div></div></div>
      ${roles.length ? `<div class="scroll-x"><table class="t"><tr><th>Team</th><th>Role</th><th>Seats</th><th style="width:44%">Model</th></tr>${roles.map((r) => `<tr><td class="muted">${esc(r.department_name)}</td><td><span class="row tight">${ava(r.title, r.category, '', 'sm')}${esc(r.title)}</span></td><td>${r.seats}</td>
        <td><select data-act-change="role-model" data-dept="${esc(r.department)}" data-role="${esc(r.role)}">${models.models.map((m) => `<option value="${esc(m.key)}" ${m.key === r.model ? 'selected' : ''}>${esc(m.key)}${m.provider === 'scripted' ? ' (offline demo)' : ''}</option>`).join('')}</select></td></tr>`).join('')}</table></div>` : '<div class="muted">Hire a team first.</div>'}</section>

    <section class="card" id="sec-stack"><div class="card-head">${icon('layers', 'lg')}<div><h2>Tech stack</h2><div class="muted small">Every task your teams get carries these choices.</div></div></div>
      ${['language', 'framework', 'database', 'package_manager'].map((k) => `<label class="f">${k.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())}</label><div class="pick" data-stack="${k}">${stack.choices[k].map((v) => `<button type="button" class="${stack.stack[k] === v ? 'on' : ''}" data-act="stack-pick" data-k="${k}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>`).join('')}
      <div class="field-row"><div><label class="f">Test command</label><input id="st-test" value="${esc(stack.stack.test_command || '')}" placeholder="npm test"></div><div><label class="f">Anything else <small>(conventions, hosting…)</small></label><input id="st-notes" value="${esc(stack.stack.notes || '')}" placeholder="Deploy on Vercel; use Tailwind"></div></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-act="stack-save">Save stack</button>${stack.stack.database && /postgres|mysql/i.test(stack.stack.database) && !conns.some((c) => c.status === 'active') ? `<span class="small muted">${icon('db', 'sm')} You picked ${esc(stack.stack.database)} — connect it below, or your team will ask when they need it.</span>` : ''}</div></section>

    <section class="card" id="sec-databases"><div class="card-head">${icon('db', 'lg')}<div><h2>Databases</h2><div class="muted small">Employees ask for a database when they need one; you can also add one now. They use it through the platform and never see the password.</div></div><span class="spacer"></span><button class="btn" data-act="add-db">${icon('plus', 'sm')}Add database</button></div>
      ${conns.length ? conns.map((c) => `<div class="conn"><span class="dbicon ${c.kind}">${icon('db')}</span><div style="flex:1;min-width:0"><div class="row tight"><b>${esc(c.name)}</b><span class="chip ${c.status === 'active' ? 'ok' : c.status === 'requested' ? 'warn' : ''} dot">${c.status === 'requested' ? 'requested' : c.status}</span>${c.status === 'active' ? `<span class="chip">${c.access === 'read' ? 'read-only' : 'read & write'}</span>` : ''}${c.team ? `<span class="chip">${esc(c.team)}</span>` : ''}</div>
        <div class="small muted">${c.status === 'active' ? `${esc(c.key_fingerprint || '')}${c.last_check?.version ? ` · ${esc(c.last_check.version)}` : ''}` : esc(c.purpose)}${c.requested_by ? ` · asked by ${esc(c.requested_by)}` : ''}</div></div>
        ${c.status === 'requested' ? `<button class="btn primary sm" data-act="conn-open" data-id="${c.id}">Connect</button>` : c.status === 'active' ? `<button class="btn sm" data-act="conn-open" data-id="${c.id}">Update</button><button class="icon-btn" data-act="conn-revoke" data-id="${c.id}" title="Revoke">${icon('trash', 'sm')}</button>` : ''}</div>`).join('') : '<div class="muted small">No databases yet.</div>'}</section>

    <section class="card" id="sec-instructions"><div class="card-head">${icon('note', 'lg')}<div><h2>Company-wide instructions</h2><div class="muted small">Every employee follows these. Add more for a team (Company → a team → Oversight &amp; instructions) or a single person (click them on the floor).</div></div></div>
      <textarea id="ins-company" rows="5" placeholder="e.g. Our customers are small bakeries. Write in plain English. Never store card numbers.">${esc(instr.find((i) => i.scope_type === 'company')?.body || '')}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="ins-save" data-scope="company" data-src="ins-company">Save instructions</button><span class="small muted">${instr.length ? `${plural(instr.length, 'set')} of instructions active across the company` : 'No instructions yet'}</span></div></section>

    <section class="card" id="sec-access"><div class="card-head">${icon('shield', 'lg')}<div><h2>Sign-in &amp; access</h2></div></div>
      ${authCfg.google ? `<div class="callout ok">${icon('check')}<div>Google sign-in is on. Only people you add can get in; governance needs a recent sign-in.</div></div>` : `<div class="callout">${icon('key')}<div>Google sign-in is off. Add <code>auth.google</code> to <code>aic.config.yaml</code> with your own OAuth client — see <code>docs/connect-your-infrastructure.md</code>.</div></div>`}
      <p style="margin-top:12px"><a class="btn" href="#/people">${icon('people', 'sm')}Manage people</a></p></section>

    <section class="card" id="sec-infra"><div class="card-head">${icon('setup', 'lg')}<div><h2>Infrastructure</h2><div class="muted small">Set in <code>aic.config.yaml</code> on this machine.</div></div></div>
      <div class="grid cols" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">${[['Code hosting', setup.code_host === 'github' ? 'GitHub' : 'Local git repository'], ['Where code runs', setup.sandbox === 'docker' ? 'Isolated Docker containers' : 'Local processes (not isolated)'], ['Spend cap', setup.spend_cap_usd ? `${money(setup.spend_cap_usd)} lifetime per key` : 'not set']].map(([l, v]) => `<div class="card flat" style="padding:12px"><div class="small muted">${l}</div><b>${esc(v)}</b></div>`).join('')}</div>
      ${setup.sandbox !== 'docker' ? `<div class="callout warn" style="margin-top:12px">${icon('warn')}<div>Agent commands run as plain local processes. Switch <code>sandbox.kind</code> to <code>docker</code> before real work.</div></div>` : ''}</section>
    </div></div>`;
  if (section) setTimeout(() => $('#sec-' + section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
};
function modelChip(m) {
  const isDefault = S.models?.default_model === m.key;
  return `<span class="model">${icon('chip', 'sm')}<b>${esc(m.key)}</b>${m.provider !== 'scripted' ? `<span class="muted small">${money(m.price_per_million.input)} / ${money(m.price_per_million.output)}</span>` : '<span class="muted small">offline demo</span>'}
    ${m.spent_usd ? `<span class="chip small" title="Lifetime spend on this key">${money(m.spent_usd)}</span>` : ''}${m.employees ? `<span class="chip" title="Employees using it">${m.employees}</span>` : ''}
    <button class="star ${isDefault ? 'on' : ''}" data-act="default-model" data-key="${esc(m.key)}" title="${isDefault ? 'Default for new hires' : 'Make default for new hires'}">${icon('star', 'sm')}</button></span>`;
}

/* ---------------- provider wizard */
function providerWizard() {
  modal('Add a model provider', `<p class="muted" style="margin-bottom:14px">Pick where your models come from. You'll paste your own key; we check it for free.</p>
    <div class="tiles">${S.presets.presets.map((p) => `<button class="tile" data-act="pw-pick" data-kind="${p.kind}"><span class="logo" style="background:${PROVIDER_COLOR[p.kind]}">${esc(p.name[0])}</span><b>${esc(p.name)}</b><small>${esc(p.models.length ? p.models.map((m) => m.model).slice(0, 2).join(', ') + (p.models.length > 2 ? '…' : '') : p.key_hint)}</small></button>`).join('')}</div>`);
}
function providerKeyStep(kind) {
  const p = S.presets.presets.find((x) => x.kind === kind);
  modal(`Connect ${esc(p.name)}`, `<div class="row" style="margin-bottom:6px"><span class="logo" style="background:${PROVIDER_COLOR[kind]}">${esc(p.name[0])}</span><div class="small muted">${esc(p.key_hint)}${p.pricing_url ? ` · <a href="${esc(p.pricing_url)}" target="_blank" rel="noopener">pricing</a>` : ''}</div></div>
    ${p.needs_key ? `<label class="f">API key</label><div class="secret"><input id="pw-key" type="password" autocomplete="off" placeholder="Paste your key" autofocus><button class="icon-btn" data-act="reveal" data-for="pw-key" type="button">${icon('eye', 'sm')}</button></div>` : ''}
    ${kind === 'custom' || kind === 'ollama' || kind === 'openrouter' || kind === 'groq' ? `<label class="f">Base URL <small>(OpenAI-compatible)</small></label><input id="pw-url" value="${esc(p.base_url || '')}" placeholder="https://…/v1">` : ''}
    <label class="f">Name <small>(how it shows here)</small></label><input id="pw-label" value="${esc(p.name)}">
    <div class="callout" style="margin-top:14px">${icon('shield')}<div>The key is encrypted on this machine and only ever sent to ${esc(p.name)}. The ledger keeps a fingerprint, never the key.</div></div>`,
  `<button class="btn" data-act="add-provider">Back</button><button class="btn primary" data-act="pw-verify" data-kind="${kind}">${icon('key', 'sm')}Verify &amp; save key</button>`);
}
function providerModelsStep(providerId, kind, available) {
  const p = S.presets.presets.find((x) => x.kind === kind) || { models: [], family: 'custom', name: 'Provider' };
  const rows = p.models.map((m, i) => `<label class="pick-model ${i === 0 ? 'on' : ''}"><input type="checkbox" data-pm="${i}" ${i === 0 ? 'checked' : ''}><span><b>${esc(m.label)}</b><div class="small muted"><code>${esc(m.model)}</code>${m.note ? ` · ${esc(m.note)}` : ''}${available.length && !available.includes(m.model) ? ' · <span class="warn">not visible to this key</span>' : ''}</div></span>
    <input type="number" step="0.01" min="0" value="${m.input}" data-pin="${i}" title="Input $ per 1M tokens"><input type="number" step="0.01" min="0" value="${m.output}" data-pout="${i}" title="Output $ per 1M tokens"></label>`).join('');
  modal(`Choose ${esc(p.name)} models`, `<p class="muted">Key verified ${icon('check', 'sm')}${available.length ? ` — it can use ${available.length} models.` : ''} Pick the ones your employees may use. Prices are per 1M tokens (input / output); they were checked ${esc(S.presets.prices_checked)} — confirm on the provider's pricing page.</p>
    <div style="margin-top:12px">${rows}</div>
    <div class="pick-model" style="grid-template-columns:auto 1fr 90px 90px"><input type="checkbox" id="pm-other"><span><input id="pm-other-id" list="pm-avail" placeholder="Another model id${available.length ? ' (start typing)' : ''}"><datalist id="pm-avail">${available.map((a) => `<option value="${esc(a)}">`).join('')}</datalist></span>
      <input type="number" step="0.01" min="0" id="pm-other-in" placeholder="in $"><input type="number" step="0.01" min="0" id="pm-other-out" placeholder="out $"></div>
    <label class="row tight" style="margin-top:10px"><input type="checkbox" id="pm-default" ${S.models?.models.some((m) => m.source === 'dashboard') ? '' : 'checked'}> Make the first one the default for new hires</label>`,
  `<button class="btn" data-act="close">Skip for now</button><button class="btn primary" data-act="pm-save" data-id="${providerId}" data-kind="${kind}">Add models</button>`);
  $$('.pick-model input[type="checkbox"]').forEach((c) => c.addEventListener('change', () => c.closest('.pick-model').classList.toggle('on', c.checked)));
  $('#pm-other-id')?.addEventListener('input', () => { $('#pm-other').checked = !!$('#pm-other-id').value; });
}

/* ================================================================== PEOPLE */
const ROLE_HELP = { approver: 'Approves plans, accepts work, curates team notes', viewer: 'Sees everything, changes nothing', auditor: 'Read-only plus the audit trail', member: 'Talks to teams', admin: 'Manages people, teams and setup' };
PAGES.people = async () => {
  crumbs('People');
  if (!isManager()) { page().innerHTML = head('People') + '<div class="card">Only the CEO or an admin can manage people.</div>'; return; }
  const users = await api('/api/users');
  page().innerHTML = head('People', 'Who can sign in. They use their Google account; Google proves the email, you decide the role.') + `<div class="grid two">
    <div class="card pad-0">${users.map((u) => `<div class="conn" style="padding:14px 18px">${ava(u.name, 'user')}<div style="flex:1;min-width:0"><b>${esc(u.name)}</b><div class="small muted">${u.email ? esc(u.email) : 'no sign-in'}${u.active_tokens ? ` · ${plural(u.active_tokens, 'access token')}` : ''}</div></div>
      <span class="chip ${u.role === 'ceo' ? 'accent' : ''}">${esc(u.role)}</span>${u.role !== 'ceo' && (u.email || u.active_tokens) ? `<button class="btn sm ghost" data-act="rm-person" data-id="${u.id}">Remove</button>` : ''}</div>`).join('')}</div>
    <div class="card"><h2>Invite someone</h2><label class="f">Name</label><input id="p-name" placeholder="Ava Patel"><label class="f">Google email</label><input id="p-email" type="email" placeholder="ava@gmail.com">
      <label class="f">Role</label><div class="pick" id="p-role">${Object.keys(ROLE_HELP).map((r, i) => `<button type="button" class="${i === 0 ? 'on' : ''}" data-act="p-role" data-v="${r}">${r}</button>`).join('')}</div>
      <p class="small muted" id="p-help" style="margin-top:8px">${ROLE_HELP.approver}</p>
      <button class="btn primary" style="margin-top:8px" data-act="invite">${icon('plus', 'sm')}Add person</button></div></div>`;
};

/* ================================================================== AUDIT */
PAGES.audit = async () => {
  crumbs('Audit');
  const [a, ev] = await Promise.all([api('/api/audit'), api('/api/events?limit=300')]);
  page().innerHTML = head('Audit', 'Every change is an event in a hash-chained ledger. Nothing — human or AI — can rewrite history unnoticed.') +
    `<div class="card" style="margin-bottom:14px"><div class="callout ${a.ok ? 'ok' : 'bad'}">${icon(a.ok ? 'audit' : 'warn', 'lg')}<div><b>${a.ok ? `Ledger intact — ${a.checked} events verified` : `TAMPERING DETECTED at event ${a.brokenAt}`}</b><div class="small">${a.ok ? 'Each event’s hash covers the one before it.' : 'Stop work and investigate.'}</div></div></div></div>
    <div class="card"><div class="row" style="margin-bottom:10px"><input id="au-q" placeholder="Filter events (e.g. denied, connection, accepted)…" style="max-width:360px"><span class="spacer"></span><span class="small muted">latest ${ev.length}</span></div>
      <div class="scroll-x"><table class="t" id="au-t"><tr><th>#</th><th>What happened</th><th>Who</th><th>When</th></tr>${ev.map((e) => { const h = human(e); return `<tr data-q="${esc((h.x + ' ' + e.type + ' ' + (e.actor_name || '')).toLowerCase())}"><td class="muted">${e.seq}</td><td><span class="row tight"><span class="${h.t}">${icon(h.i, 'sm')}</span>${esc(h.x)}</span><div class="small muted mono">${esc(e.type)}</div></td><td>${esc(e.actor_name || e.actor.type)}</td><td class="muted small">${ago(e.occurred_at)}</td></tr>`; }).join('')}</table></div></div>`;
  $('#au-q').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('#au-t tr[data-q]').forEach((r) => { r.hidden = !!q && !r.dataset.q.includes(q); }); });
};

/* ================================================================== command palette */
function palette() {
  const cmds = [
    ...NAV.filter((n) => !n.sep && (!n.managers || isManager())).map((n) => ({ g: 'Go to', l: n.label, i: n.i, run: () => { location.hash = '#/' + n.k; } })),
    ...S.inbox.map((it, i) => ({ g: 'Decisions', l: it.title, i: KIND[it.kind]?.icon, run: () => { location.hash = '#/inbox/' + i; } })),
    ...S.team.flatMap((d) => d.employees.filter((e) => roleOf(e.category) === 'manager').map((e) => ({ g: 'Talk', l: `Talk to ${e.display_name} (${d.name})`, i: 'talk', run: () => { location.hash = '#/talk/' + e.id; } }))),
    ...(isManager() ? [
      { g: 'Do', l: 'Add a model provider', i: 'key', run: async () => { location.hash = '#/setup/models'; await waitFor('#sec-models'); providerWizard(); } },
      { g: 'Do', l: 'Add a database', i: 'db', run: async () => { location.hash = '#/setup/databases'; await waitFor('#sec-databases'); addDatabase(); } },
      { g: 'Do', l: 'Choose the tech stack', i: 'layers', run: () => { location.hash = '#/setup/stack'; } },
      { g: 'Do', l: 'Invite a person', i: 'people', run: () => { location.hash = '#/people'; } },
      { g: 'Do', l: 'Hire a team', i: 'company', run: () => { location.hash = '#/company/hire'; } },
      { g: 'Do', l: 'New objective', i: 'plus', run: () => newObjective() },
      { g: 'Do', l: 'Write company-wide instructions', i: 'note', run: () => { location.hash = '#/setup/instructions'; } },
      ...S.team.map((d) => ({ g: 'Do', l: `Oversight & instructions for ${d.name}`, i: 'setup', run: () => teamSettings(d.key) })),
      { g: 'Do', l: 'Design a team', i: 'plus', run: () => { location.hash = '#/company/build'; } },
    ] : []),
    { g: 'Do', l: 'Toggle light / dark', i: 'moon', run: toggleTheme },
  ];
  const box = openOverlay('modal', `<input id="pal-q" placeholder="Search pages, decisions, people, actions…" autocomplete="off"><div class="list" id="pal-l"></div>`, 'palette');
  let sel = 0; let shown = cmds;
  const draw = () => {
    let g = '';
    $('#pal-l').innerHTML = shown.map((c, i) => `${c.g !== g ? `<div class="grp">${(g = c.g)}</div>` : ''}<div class="it ${i === sel ? 'on' : ''}" data-i="${i}">${icon(c.i, 'sm')}<span>${esc(c.l)}</span></div>`).join('') || '<div class="muted" style="padding:14px">Nothing matches.</div>';
    $('#pal-l .it.on')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (c) => { closeOverlay(); c?.run(); };
  draw();
  const q = box.querySelector('#pal-q');
  q.addEventListener('input', () => { const t = q.value.toLowerCase().trim(); shown = cmds.filter((c) => (c.l + ' ' + c.g).toLowerCase().includes(t)); sel = 0; draw(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter') run(shown[sel]);
  });
  box.querySelector('#pal-l').addEventListener('click', (e) => { const it = e.target.closest('.it'); if (it) run(shown[Number(it.dataset.i)]); });
}
const waitFor = (sel) => new Promise((r) => { const t0 = Date.now(); const f = () => ($(sel) || Date.now() - t0 > 4000 ? r() : setTimeout(f, 50)); f(); });
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('aic-theme', dark ? 'dark' : 'light'); } catch {}
  const b = $('[data-act="theme"]'); if (b) b.innerHTML = icon(dark ? 'sun' : 'moon');
}
function addDatabase(kind = 'postgres') {
  modal('Add a database', `<div class="seg" id="db-kind" style="margin-bottom:6px"><button type="button" class="${kind === 'postgres' ? 'on' : ''}" data-act="db-kind" data-v="postgres">PostgreSQL</button><button type="button" class="${kind === 'mysql' ? 'on' : ''}" data-act="db-kind" data-v="mysql">MySQL</button></div>
    ${connectionForm(kind, null, `<div class="field-row"><div><label class="f">Name</label><input id="cf-name" placeholder="orders db" autofocus></div><div><label class="f">For team</label><select id="cf-team"><option value="">Every team</option>${S.team.map((d) => `<option value="${esc(d.key)}">${esc(d.name)}</option>`).join('')}</select></div></div>
      <label class="f">What it's for</label><input id="cf-purpose" placeholder="Customer orders for the shop app">`)}`,
  `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="db-save">${icon('db', 'sm')}Connect</button>`);
}

/* ================================================================== actions */
const busy = async (el, fn) => { el?.classList.add('busy'); try { return await fn(); } catch (e) { fail(e); } finally { el?.classList.remove('busy'); } };
const ACT = {
  close: () => closeOverlay(),
  nav: (el) => { location.hash = el.dataset.href; },
  menu: () => $('#side').classList.toggle('open'),
  theme: toggleTheme,
  palette,
  signout: async () => { await post('/auth/logout').catch(() => null); try { sessionStorage.removeItem('aic-token'); } catch {} location.href = '/'; },
  resume: (el) => busy(el, async () => {
    try { await post('/api/resume', { reason: 'resumed from the dashboard' }); }
    catch (e) { if (!/unresolved/i.test(e.message)) throw e; await post('/api/resume', { reason: 'resumed from the dashboard (acknowledged unresolved actions)', ack: true }); }
    toast('Work resumed.'); await tick(); route(true);
  }),
  reveal: (el) => { const i = $('#' + el.dataset.for); i.type = i.type === 'password' ? 'text' : 'password'; },
  // decisions deck
  deck: (el) => { S.deck = Number(el.dataset.i); renderDecision(); },
  'deck-step': (el) => { S.deck = (S.deck + Number(el.dataset.d) + S.inbox.length) % S.inbox.length; renderDecision(); },
  'd-plan-approve': (el) => busy(el, async () => { await post(`/api/proposals/${el.dataset.id}/decision`, { decision: 'approve', rationale: noteVal() }); decided('Plan approved — the team starts now.'); }),
  'd-plan-changes': (el) => { const n = needNote('what should change'); if (n) busy(el, async () => { await post(`/api/proposals/${el.dataset.id}/decision`, { decision: 'request_changes', rationale: n }); decided('Sent back to the lead.'); }); },
  'd-accept': (el) => busy(el, async () => { await post(`/api/tasks/${el.dataset.id}/accept`, { rationale: noteVal() }); closeOverlay(); decided('Accepted.'); }),
  'd-accept-uncertain': (el) => { const n = needNote('why you accept it'); if (n) busy(el, async () => { await post(`/api/tasks/${el.dataset.id}/accept`, { rationale: n, uncertain: true }); closeOverlay(); decided('Accepted with your note on record.'); }); },
  'd-reject': (el) => { const n = needNote('what should change'); if (n) busy(el, async () => { await post(`/api/tasks/${el.dataset.id}/reject`, { rationale: n }); closeOverlay(); decided('Sent back for changes.'); }); },
  'd-answer': (el) => { const n = needNote('your answer'); if (n) busy(el, async () => { await post(`/api/escalations/${el.dataset.id}/resolve`, { answer: n }); decided('Answer sent — the task resumes.'); }); },
  'd-dir-confirm': (el) => busy(el, async () => { await post(`/api/directives/${el.dataset.id}/confirm`); decided('Confirmed.'); }),
  'd-dir-decline': (el) => busy(el, async () => { await post(`/api/directives/${el.dataset.id}/decline`, { reason: noteVal() || 'declined' }); decided('Declined.'); }),
  'd-release': (el) => busy(el, async () => { await post(`/api/objectives/${el.dataset.id}/release`); decided('Release approved — merging the approved commit.'); }),
  'd-note-ok': (el) => busy(el, async () => { await post(`/api/notes/${el.dataset.id}`, { decision: 'approve', reason: noteVal() }); decided('Note shared with the team.'); }),
  'd-note-no': (el) => busy(el, async () => { await post(`/api/notes/${el.dataset.id}`, { decision: 'reject', reason: noteVal() }); decided('Note rejected.'); }),
  'd-conn': (el) => busy(el, async () => { const c = readConn(); await post('/api/connections', { connection_id: el.dataset.id, config: c.config, password: c.password, access: c.access }); decided('Database connected — the task resumes.'); }),
  'd-conn-decline': (el) => busy(el, async () => { await post(`/api/connections/${el.dataset.id}/decline`, { reason: 'Not now' }); decided('Declined — the team will continue without it.'); }),
  release: (el) => busy(el, async () => { await post(`/api/objectives/${el.dataset.id}/release`); toast('Release approved.'); route(true); }),
  // connections
  'conn-test': (el) => busy(el, async () => {
    const c = readConn(); const out = $('#cf-result'); out.className = 'small muted'; out.textContent = 'Connecting…';
    let kind = c.kind; if (!kind && c.id) kind = 'postgres';
    const r = await post('/api/connections/test', { kind, config: c.config, password: c.password }).catch((e) => ({ ok: false, error: e.message }));
    out.className = `small ${r.ok ? 'ok' : 'bad'}`; out.textContent = r.ok ? `✓ Connected — ${r.version} · ${plural(r.tables, 'table')}` : `✗ ${r.error}`;
  }),
  'conn-open': async (el) => {
    const c = (await api('/api/connections')).find((x) => x.id === el.dataset.id);
    modal(`${c.status === 'requested' ? 'Connect' : 'Update'} “${esc(c.name)}”`, `<p class="muted">${esc(c.purpose)}${c.requested_by ? ` — asked by ${esc(c.requested_by)}` : ''}</p>${connectionForm(c.kind, c)}`,
      `${c.status === 'requested' ? `<button class="btn" data-act="conn-decline" data-id="${c.id}">Decline</button>` : '<button class="btn" data-act="close">Cancel</button>'}<button class="btn primary" data-act="conn-save" data-id="${c.id}">${icon('db', 'sm')}Save &amp; connect</button>`);
  },
  'conn-save': (el) => busy(el, async () => { const c = readConn(); await post('/api/connections', { connection_id: el.dataset.id, config: c.config, password: c.password, access: c.access }); closeOverlay(); toast('Database connected.'); route(true); }),
  'conn-decline': (el) => busy(el, async () => { await post(`/api/connections/${el.dataset.id}/decline`, { reason: 'Declined in setup' }); closeOverlay(); toast('Declined.'); route(true); }),
  'conn-revoke': (el) => { if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.classList.add('btn', 'danger', 'sm'); el.textContent = 'Revoke?'; return; } busy(el, async () => { await post(`/api/connections/${el.dataset.id}/revoke`); toast('Revoked — employees can no longer use it.'); route(true); }); },
  'add-db': () => addDatabase(),
  'db-kind': (el) => addDatabase(el.dataset.v),
  'db-save': (el) => busy(el, async () => {
    const c = readConn(); const name = $('#cf-name').value.trim(); if (!name) { toast('Give the database a name.', 'bad'); return; }
    await post('/api/connections', { kind: c.kind, name, purpose: $('#cf-purpose').value.trim() || undefined, team: $('#cf-team').value, config: c.config, password: c.password, access: c.access });
    closeOverlay(); toast('Database connected.'); route(true);
  }),
  // tasks
  'open-task': (el) => openTask(el.dataset.id).catch(fail),
  reassign: (el) => { const reason = $('#ra-why').value.trim(); if (!reason) { toast('Say why you are reassigning.', 'bad'); return; } busy(el, async () => { await post(`/api/tasks/${el.dataset.id}/reassign`, { employeeId: $('#ra-who').value, reason }); toast('Reassigned.'); openTask(el.dataset.id); }); },
  'req-save': (el) => busy(el, async () => {
    const key = $('#rq-key').value.trim(); const text = $('#rq-text').value.trim(); const reason = $('#rq-why').value.trim();
    const r = await post(`/api/objectives/${el.dataset.id}/requirements`, { key, text, reason });
    toast(`${key} is now v${r.version}. ${r.superseded.length} task(s) withdrawn; the lead will re-plan.`); route(true);
  }),
  // company
  emp: (el) => openEmployee(el.dataset.id).catch(fail),
  'emp-model': (el) => busy(el, async () => { const r = await post(`/api/teams/${el.dataset.dept}/roles/${el.dataset.role}/model`, { key: $('#emp-model').value }); toast(`${plural(r.employees, 'employee')} switched.`); closeOverlay(); S.team = await api('/api/team'); route(true); }),
  hire: (el) => busy(el, async () => { const r = await post(`/api/catalog/${el.dataset.key}/hire`); closeOverlay(); toast(`Hired ${plural(r.employees.length, 'employee')}. Say hello in Talk.`); S.team = await api('/api/team'); location.hash = '#/company'; }),
  'team-detail': (el) => teamDetail(el.dataset.key).catch(fail),
  'b-type': (el) => { draft.roles[el.dataset.i].type = el.dataset.v; renderBuilder(); },
  'b-review': (el) => { const r = draft.roles[el.dataset.i]; r.reviews = r.reviews.includes(el.dataset.v) ? r.reviews.filter((x) => x !== el.dataset.v) : [...r.reviews, el.dataset.v]; el.classList.toggle('on'); },
  'b-cap': (el) => { const r = draft.roles[el.dataset.i]; r.works_with = r.works_with.includes(el.dataset.v) ? r.works_with.filter((x) => x !== el.dataset.v) : [...r.works_with, el.dataset.v]; el.classList.toggle('on'); },
  'b-add': () => { draft.roles.push(blankRole()); renderBuilder(); },
  'b-remove': (el) => { draft.roles.splice(Number(el.dataset.i), 1); renderBuilder(); },
  'b-check': (el) => busy(el, async () => { const t = await post('/api/teams/check', { spec: toSpec(draft) }); $('#b-result').innerHTML = builderResult(t); }),
  'b-save': (el) => saveDraft(el, false),
  'b-save-hire': (el) => saveDraft(el, true),
  // talk
  suggest: (el) => { $('#say').value = el.textContent; $('#say').focus(); },
  send: async (el) => {
    const say = $('#say'); const message = say.value.trim(); if (!message) return;
    say.value = ''; say.style.height = 'auto';
    const msgs = $('#msgs'); if (msgs.querySelector('.empty')) msgs.innerHTML = '';
    msgs.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(message)}</div><div class="typing" id="typing"><i></i><i></i><i></i></div>`); scrollMsgs();
    el.classList.add('busy');
    try {
      const r = await post('/api/chat', { employee: el.dataset.id, message });
      $('#typing')?.remove();
      msgs.insertAdjacentHTML('beforeend', `<div class="msg them">${esc(r.reply)}</div>${r.directives.map((d) => directiveCard({ id: d.id, status: 'pending_confirmation', directive_type: d.type, payload: { summary: d.summary } })).join('')}`);
      if (r.directives.length) { S.inbox = await api('/api/inbox'); renderNav(); for (const d of r.directives) { const full = await api('/api/directives/' + d.id).catch(() => null); if (full) { const n = msgs.querySelector(`[data-dir="${d.id}"]`); if (n) n.outerHTML = directiveCard(full); } } }
    } catch (e) { $('#typing')?.remove(); msgs.insertAdjacentHTML('beforeend', `<div class="msg sys bad">${esc(e.message)}</div>`); }
    finally { el.classList.remove('busy'); scrollMsgs(); say.focus(); }
  },
  'dir-yes': (el) => busy(el, async () => { await post(`/api/directives/${el.dataset.id}/confirm`); const d = await api('/api/directives/' + el.dataset.id); el.closest('.dir').outerHTML = directiveCard(d); toast('Confirmed — it’s in motion.'); S.inbox = await api('/api/inbox'); renderNav(); }),
  'dir-no': (el) => busy(el, async () => { await post(`/api/directives/${el.dataset.id}/decline`, { reason: 'declined in chat' }); const d = await api('/api/directives/' + el.dataset.id); el.closest('.dir').outerHTML = directiveCard(d); toast('Declined.'); S.inbox = await api('/api/inbox'); renderNav(); }),
  // setup
  'add-provider': providerWizard,
  'pw-pick': (el) => providerKeyStep(el.dataset.kind),
  'pw-verify': (el) => busy(el, async () => {
    const kind = el.dataset.kind;
    const r = await post('/api/providers', { kind, label: $('#pw-label').value, api_key: $('#pw-key')?.value, base_url: $('#pw-url')?.value });
    toast('Key verified and stored encrypted.');
    providerModelsStep(r.providerId, kind, r.available || []);
  }),
  'add-models': (el) => { const p = S.models.providers.find((x) => x.id === el.dataset.id); providerModelsStep(p.id, p.kind, []); },
  'pm-save': (el) => busy(el, async () => {
    const p = S.presets.presets.find((x) => x.kind === el.dataset.kind) || { models: [] };
    const picks = [];
    $$('[data-pm]').forEach((c) => { if (c.checked) { const i = c.dataset.pm; picks.push({ model: p.models[i].model, input_price: Number($(`[data-pin="${i}"]`).value), output_price: Number($(`[data-pout="${i}"]`).value) }); } });
    if ($('#pm-other')?.checked && $('#pm-other-id').value.trim()) picks.push({ model: $('#pm-other-id').value.trim(), input_price: Number($('#pm-other-in').value), output_price: Number($('#pm-other-out').value) });
    if (!picks.length) { toast('Pick at least one model.', 'bad'); return; }
    if (picks.some((m) => p.kind !== 'ollama' && (!(m.input_price > 0) || !(m.output_price > 0)))) { toast('Enter both prices — the spend cap needs them.', 'bad'); return; }
    let first = null;
    for (const m of picks) { const r = await post('/api/models', { provider_id: el.dataset.id, ...m }).catch((e) => { if (e.status === 409) return null; throw e; }); first ??= r?.key; }
    if (first && $('#pm-default')?.checked) await post('/api/models/default', { key: first });
    closeOverlay(); toast(`${plural(picks.length, 'model')} ready.`); route(true);
  }),
  'rm-provider': (el) => { if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.classList.add('btn', 'danger', 'sm'); el.textContent = 'Remove?'; return; } busy(el, async () => { await post(`/api/providers/${el.dataset.id}/remove`); toast('Provider removed and its key deleted.'); route(true); }); },
  'default-model': (el) => busy(el, async () => { await post('/api/models/default', { key: el.dataset.key }); toast(`${el.dataset.key} is the default for new hires.`); route(true); }),
  'stack-pick': (el) => { $$(`[data-stack="${el.dataset.k}"] button`).forEach((b) => { if (b !== el) b.classList.remove('on'); }); el.classList.toggle('on'); },
  'stack-save': (el) => busy(el, async () => {
    const stack = { test_command: $('#st-test').value, notes: $('#st-notes').value };
    $$('[data-stack]').forEach((g) => { stack[g.dataset.stack] = g.querySelector('.on')?.dataset.v || ''; });
    await post('/api/stack', { stack }); toast('Stack saved — every new task carries it.'); await tick(); route(true);
  }),
  // instructions & oversight
  'ins-save': (el) => busy(el, async () => {
    const r = await post('/api/instructions', { scope_type: el.dataset.scope, team: el.dataset.team, role: el.dataset.role, employee: el.dataset.employee, body: $('#' + el.dataset.src).value });
    toast(r.version ? `Saved (v${r.version}) — applies from the next session.` : 'Instructions removed.');
  }),
  'team-settings': (el) => teamSettings(el.dataset.key).catch(fail),
  'ts-mode': (el) => { $$('#ts-mode button').forEach((b) => b.classList.toggle('on', b === el)); $('#ts-mode-help').textContent = MODE_INFO.find(([m]) => m === el.dataset.v)?.[2] || ''; },
  'ts-save': (el) => busy(el, async () => {
    const d = S.team.find((x) => x.key === el.dataset.team); const mode = $('#ts-mode .on')?.dataset.v;
    if (mode && mode !== (d.mode || d.default_mode)) await post(`/api/teams/${el.dataset.team}/mode`, { mode, reason: 'changed in team settings' });
    await post('/api/instructions', { scope_type: 'department', team: el.dataset.team, body: $('#ins-team').value });
    closeOverlay(); toast('Team settings saved.'); S.team = await api('/api/team'); route(true);
  }),
  // objectives & failed work
  'new-objective': () => newObjective(),
  'obj-save': (el) => busy(el, async () => {
    const requirements = $('#no-reqs').value.split('\n').map((x) => x.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(Boolean);
    const r = await post('/api/objectives', { title: $('#no-title').value, team: $('#no-team').value, requirements, budget_usd: Number($('#no-budget').value) });
    closeOverlay(); toast('Objective created — the lead is drafting a plan for your approval.'); location.hash = '#/work/' + r.objectiveId;
  }),
  'd-retry': (el) => busy(el, async () => { await post(`/api/tasks/${el.dataset.id}/retry`, { add_budget_usd: Number(($('.drawer #retry-budget') || $('#retry-budget'))?.value || 0), reason: noteVal() || 'retry requested by the CEO' }); closeOverlay(); decided('Sent back to the team for another attempt.'); }),
  'd-cancel': (el) => { const n = needNote('why you are cancelling'); if (n) busy(el, async () => { await post(`/api/tasks/${el.dataset.id}/cancel`, { reason: n }); closeOverlay(); decided('Task cancelled.'); }); },
  'cancel-ask': (el) => { el.outerHTML = `<div class="row"><input id="cancel-why" placeholder="Why cancel?" style="flex:1"><button class="btn sm danger" data-act="cancel-do" data-id="${el.dataset.id}">Cancel task</button></div>`; $('#cancel-why').focus(); },
  'cancel-do': (el) => { const reason = $('#cancel-why').value.trim(); if (!reason) { toast('Say why.', 'bad'); return; } busy(el, async () => { await post(`/api/tasks/${el.dataset.id}/cancel`, { reason }); closeOverlay(); toast('Task cancelled.'); route(true); }); },
  alerts: async () => {
    if (!('Notification' in window)) { toast('This browser has no notifications.', 'bad'); return; }
    const p = await Notification.requestPermission();
    try { localStorage.setItem('aic-alerts', p === 'granted' ? 'on' : 'off'); } catch {}
    toast(p === 'granted' ? 'Desktop alerts on — you’ll hear about new decisions.' : 'Alerts are blocked in this browser.', p === 'granted' ? 'ok' : 'bad'); renderShellBell();
  },
  // people
  'p-role': (el) => { $$('#p-role button').forEach((b) => b.classList.toggle('on', b === el)); $('#p-help').textContent = ROLE_HELP[el.dataset.v]; },
  invite: (el) => busy(el, async () => {
    const r = await post('/api/users', { name: $('#p-name').value, email: $('#p-email').value, role: $('#p-role .on').dataset.v });
    toast(`Added. ${r.signIn}`); route(true);
  }),
  'rm-person': (el) => { if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.classList.add('danger'); el.textContent = 'Remove access?'; return; } busy(el, async () => { await post(`/api/users/${el.dataset.id}/remove`); toast('Access removed — their sessions end now.'); route(true); }); },
};
async function saveDraft(el, hire) {
  await busy(el, async () => {
    try {
      const r = await post('/api/teams', { spec: toSpec(draft) });
      let note = r.saved;
      if (hire) { const h = await post(`/api/catalog/${r.team.key}/hire`); note += ` — hired ${plural(h.employees.length, 'employee')}`; S.team = await api('/api/team'); }
      $('#b-result').innerHTML = builderResult(r.team, note);
    } catch (e) {
      const t = await post('/api/teams/check', { spec: toSpec(draft) }).catch(() => null);
      $('#b-result').innerHTML = `<div class="callout bad">${icon('warn')}<div>${esc(e.message)}</div></div>` + (t ? builderResult(t) : '');
    }
  });
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.dataset.act) e.preventDefault();
  Promise.resolve(fn(el, e)).catch(fail);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act-change]'); if (!el) return;
  if (el.dataset.actChange === 'role-model') busy(el, async () => { const r = await post(`/api/teams/${el.dataset.dept}/roles/${el.dataset.role}/model`, { key: el.value }); toast(`${plural(r.employees, 'employee')} now use ${el.value}.`); S.team = await api('/api/team'); });
});
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing && !overlay)) { e.preventDefault(); palette(); return; }
  if (overlay || typing || S.page !== 'inbox' || !S.inbox.length || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') { S.deck = (S.deck + 1) % S.inbox.length; renderDecision(); e.preventDefault(); }
  else if (k === 'k' || e.key === 'ArrowUp') { S.deck = (S.deck - 1 + S.inbox.length) % S.inbox.length; renderDecision(); e.preventDefault(); }
  else if (k === 'a') $('[data-primary]')?.click();
  else if (k === 'r') $('[data-secondary]')?.click();
  else if (k === 'n') { $('#note')?.focus(); e.preventDefault(); }
});
document.addEventListener('click', (e) => { const seg = e.target.closest('#cf-access button'); if (seg) { $$('#cf-access button').forEach((b) => b.classList.toggle('on', b === seg)); } });

/* ================================================================== hold to stop */
function wireHold() {
  const b = $('#hold'); if (!b) return;
  let t = null;
  const cancel = () => { clearTimeout(t); t = null; b.classList.remove('arming'); };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault(); b.classList.add('arming');
    t = setTimeout(async () => {
      cancel();
      try { const r = await post('/api/emergency-stop', { reason: 'dashboard emergency stop' }); toast(`Stopped. ${plural(r.heldTasks ?? 0, 'task')} held, ${plural((r.interruptedRuns || []).length, 'session')} interrupted.`, 'bad'); await tick(); route(true); }
      catch (err) { fail(err); }
    }, 1200);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => { if (t) { cancel(); toast('Keep holding to stop all work.', 'info'); } }));
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); });
}

/* ================================================================== boot */
async function signInScreen() {
  const cfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({}));
  $('#app').innerHTML = `<div class="signin"><div class="card"><div class="mark"></div><h1 style="font-size:22px">AIC</h1><p class="muted" style="margin-top:6px">Your company’s AI departments — accountable, verified, under your control.</p>
    ${cfg.google ? `<a class="gbtn" href="/auth/google">${GOOGLE}Continue with Google</a><p class="small muted">Only people your CEO added can sign in.</p>` : ''}
    <div class="hr"></div><p class="small muted">Or open the link printed by <code>aic serve</code> (it carries a one-time owner token).</p></div></div>`;
}
(async function boot() {
  try { S.me = await api('/api/me'); } catch { return signInScreen(); }
  [S.setup, S.inbox, S.team] = await Promise.all([api('/api/setup').catch(() => null), api('/api/inbox').catch(() => []), api('/api/team').catch(() => [])]);
  S.companyName = (await api('/api/status').catch(() => ({}))).company?.name;
  renderShell();
  if (!location.hash || location.hash === '#') location.hash = '#/home'; else route();
  S.timer = setInterval(tick, 5000);
})();
