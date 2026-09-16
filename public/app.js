/* SP Grid Hunter - web control front-end.
   Talks to the control server; the control server talks to the MT5 EA. */
'use strict';

const LS_SERVER = 'sgh.server';
const LS_TOKEN = 'sgh.token';
const REFRESH_MS = 2000;

const $ = (id) => document.getElementById(id);

const ui = {
  gate: $('gate'),
  gateForm: $('gate-form'),
  gateUrl: $('gate-url'),
  gateToken: $('gate-token'),
  gateError: $('gate-error'),
  app: $('app'),
  linkDot: $('link-dot'),
  linkText: $('link-text'),
  botState: $('bot-state'),
  botSub: $('bot-sub'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  btnFlatten: $('btn-flatten'),
  btnSettings: $('btn-settings'),
  closeOnStop: $('opt-close-on-stop'),
  cmdNote: $('cmd-note'),
  log: $('log'),
  footState: $('foot-state'),
  evo: $('evo'),
  modal: $('modal'),
  setUrl: $('set-url'),
  setToken: $('set-token'),
  setSave: $('set-save'),
  setClose: $('set-close')
};

const cfg = {
  server: localStorage.getItem(LS_SERVER) || location.origin,
  token: localStorage.getItem(LS_TOKEN) || ''
};

let busy = false;
let lastEventsKey = '';

function serverBase() {
  return cfg.server.replace(/\/+$/, '');
}

async function api(path, options) {
  const opts = options || {};
  const res = await fetch(serverBase() + path, {
    method: opts.method || 'GET',
    headers: { 'x-control-token': cfg.token, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store'
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = { ok: false, error: 'invalid server response' };
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data && data.error ? data.error : 'request failed (' + res.status + ')');
  }
  return data;
}

// ------------------------------------------------------------------
// formatting helpers
// ------------------------------------------------------------------
function setClass(el, cls, text) {
  el.className = 'v ' + (cls || '');
  el.textContent = text;
}

function money(v) {
  if (v === null || v === undefined || isNaN(v)) return '--';
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function num(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return '--';
  return Number(v).toFixed(digits === undefined ? 2 : digits);
}

function fmtTime(ms) {
  return new Date(ms).toTimeString().slice(0, 8);
}

function renderLog(events) {
  const key = events.map((e) => e.ts).join(',');
  if (key === lastEventsKey) return;
  lastEventsKey = key;
  ui.log.innerHTML = '';
  events.forEach((ev) => {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = fmtTime(ev.ts);
    const m = document.createElement('span');
    m.className = ev.level || 'info';
    m.textContent = ev.msg;
    li.appendChild(t);
    li.appendChild(m);
    ui.log.appendChild(li);
  });
}

// ------------------------------------------------------------------
// rendering
// ------------------------------------------------------------------
function render(state) {
  const r = state.report || {};
  const online = !!state.eaOnline;

  ui.linkDot.className = 'dot ' + (online ? 'online' : 'offline');
  ui.linkText.textContent = online
    ? 'EA connected \u2014 ' + (r.symbol || '?') + ' | last heartbeat ' +
      (state.eaLastSeenSeconds === 0 ? 'just now' : state.eaLastSeenSeconds + 's ago')
    : (state.eaLastSeen
        ? 'EA not responding \u2014 last heartbeat ' + state.eaLastSeenSeconds + 's ago'
        : 'EA has never connected');

  ui.botState.textContent = state.active ? 'ACTIVE' : 'STOPPED';
  ui.botState.className = 'state ' + (state.active ? 'active' : 'stopped');
  ui.botSub.textContent = state.active
    ? 'Grid entries are enabled.'
    : 'No new entries will be opened.';

  ui.btnStart.disabled = busy || state.active;
  ui.btnStop.disabled = busy || !state.active;

  ui.cmdNote.textContent = state.lastCommand
    ? 'Last command: ' + state.lastCommand.name + ' at ' + fmtTime(state.lastCommand.at)
    : 'No command sent yet.';

  setClass($('c-conn'), online ? 'positive' : 'negative', online ? 'ONLINE' : 'OFFLINE');
  $('c-conn-s').textContent = online
    ? 'Polling every ' + state.pollSeconds + 's (timeout ' + state.eaTimeoutSeconds + 's)'
    : 'Start MT5 with the EA attached on the trading machine';

  $('c-symbol').textContent = r.symbol || '--';
  $('c-account').textContent = r.login
    ? 'Login ' + r.login + (r.account_server ? ' @ ' + r.account_server : '')
    : 'no report yet';

  const positions = (r.buy_count || 0) + (r.sell_count || 0);
  setClass($('c-pos'), positions > 0 ? 'warn' : '', String(positions));
  $('c-pos-s').textContent = 'BUY ' + (r.buy_count || 0) + ' (' + num(r.buy_lots) +
    ' lots)  |  SELL ' + (r.sell_count || 0) + ' (' + num(r.sell_lots) + ' lots)';

  const pl = Number(r.buy_pl || 0) + Number(r.sell_pl || 0);
  setClass($('c-pl'), pl > 0 ? 'positive' : (pl < 0 ? 'negative' : ''), money(pl));
  $('c-pl-s').textContent = 'BUY ' + money(r.buy_pl) + '  |  SELL ' + money(r.sell_pl);

  setClass($('c-equity'), '', num(r.equity));
  $('c-dd').textContent = 'Balance ' + num(r.balance) + ' | Drawdown ' + num(r.drawdown) + '%';

  const zone = r.radar_zone || '--';
  const score = (r.radar_score === undefined || r.radar_score === null) ? '--' : r.radar_score;
  setClass($('c-radar'),
    zone === 'GREEN' ? 'positive' : (zone === 'CAUTION' ? 'warn' : 'negative'), zone);
  $('c-radar-s').textContent = 'Score ' + score + '/5';

  setClass($('c-spread'), '', num(r.spread, 1) + ' pips');
  $('c-step').textContent = 'Grid step ' + num(r.step_pips, 1) + ' pips';

  const daily = Number(r.daily_pl || 0);
  setClass($('c-daily'), daily > 0 ? 'positive' : (daily < 0 ? 'negative' : ''), money(daily));
  $('c-halt').textContent = 'Halt: ' + (r.halt || 'NONE') +
    (r.session === false ? ' | session closed' : '');

  ui.footState.textContent = 'Report ' + (r.receivedAt ? fmtTime(r.receivedAt) : 'n/a') +
    ' | bot ' + (state.active ? 'ACTIVE' : 'STOPPED') +
    (state.flattenPending ? ' | close-all pending' : '');
  ui.evo.textContent = (state.events || []).length + ' recent events';

  renderLog(state.events || []);
}

function showGateError(msg) {
  ui.gateError.textContent = msg || '';
}

// ------------------------------------------------------------------
// polling
// ------------------------------------------------------------------
let timer = null;

async function refresh() {
  try {
    const state = await api('/api/state');
    showGateError('');
    ui.gate.classList.add('hidden');
    ui.app.classList.remove('hidden');
    render(state);
  } catch (err) {
    if (ui.app.classList.contains('hidden')) {
      ui.gate.classList.remove('hidden');
      showGateError(err.message === 'invalid or missing control token'
        ? 'Wrong control token \u2014 copy it from server/data/token.txt'
        : 'Could not reach the control server: ' + err.message);
      return;
    }
    ui.linkDot.className = 'dot offline';
    ui.linkText.textContent = 'Control server unreachable: ' + err.message;
  } finally {
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_MS);
  }
}

async function sendCommand(body) {
  busy = true;
  ui.btnStart.disabled = true;
  ui.btnStop.disabled = true;
  try {
    const res = await api('/api/command', { method: 'POST', body });
    ui.cmdNote.textContent = (res.changes && res.changes.length)
      ? 'Sent: ' + res.changes.join(', ') + ' \u2014 the EA applies it within a few seconds.'
      : 'Nothing changed.';
  } catch (err) {
    ui.cmdNote.textContent = 'Command failed: ' + err.message;
  } finally {
    busy = false;
    refresh();
  }
}

// ------------------------------------------------------------------
// wiring
// ------------------------------------------------------------------
ui.gateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  cfg.server = ui.gateUrl.value.trim() || location.origin;
  cfg.token = ui.gateToken.value.trim();
  localStorage.setItem(LS_SERVER, cfg.server);
  localStorage.setItem(LS_TOKEN, cfg.token);
  refresh();
});

ui.btnStart.addEventListener('click', () => sendCommand({ active: true }));

ui.btnStop.addEventListener('click', () => {
  if (ui.closeOnStop.checked) sendCommand({ active: false, flatten: true });
  else sendCommand({ active: false });
});

ui.btnFlatten.addEventListener('click', () => {
  if (confirm('Close every open trade owned by the EA right now?')) {
    sendCommand({ flatten: true });
  }
});

ui.btnSettings.addEventListener('click', () => {
  ui.setUrl.value = cfg.server;
  ui.setToken.value = cfg.token;
  ui.modal.classList.remove('hidden');
});

ui.setClose.addEventListener('click', () => ui.modal.classList.add('hidden'));

ui.setSave.addEventListener('click', () => {
  cfg.server = ui.setUrl.value.trim() || location.origin;
  cfg.token = ui.setToken.value.trim();
  localStorage.setItem(LS_SERVER, cfg.server);
  localStorage.setItem(LS_TOKEN, cfg.token);
  ui.modal.classList.add('hidden');
  lastEventsKey = '';
  refresh();
});

ui.modal.addEventListener('click', (e) => {
  if (e.target === ui.modal) ui.modal.classList.add('hidden');
});

// ------------------------------------------------------------------
// boot
// ------------------------------------------------------------------
if (cfg.token) {
  ui.gateUrl.value = cfg.server;
  refresh();
} else {
  ui.gateUrl.value = location.origin;
  showGateError('Enter the token from server/data/token.txt to connect.');
}