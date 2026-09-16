/**
 * mt5-web-control - control server (zero dependencies)
 * ------------------------------------------------------------------
 * Bridges a web page to an MT5 Expert Advisor.
 *
 *   EA  --- GET  /api/control   --> polls for { active, flatten }
 *   EA  --- POST /api/report    --> pushes live status / heartbeat
 *   WEB --- GET  /api/state     --> reads bot + EA status
 *   WEB --- POST /api/command   --> start / stop / close-all
 *
 * Auth: every /api/* call must send the shared token in the
 *       "x-control-token" header (or ?token= query string).
 *       The token is generated on first run into server/data/token.txt
 *
 * Run:  node server/server.js
 * Env:  PORT, HOST, CONTROL_TOKEN, EA_TIMEOUT_SECONDS, EA_POLL_SECONDS
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const EVENT_FILE = path.join(DATA_DIR, 'events.log');
const EA_TIMEOUT_MS = Math.max(5, parseInt(process.env.EA_TIMEOUT_SECONDS || '20', 10)) * 1000;
const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 200;
const POLL_SECONDS = Math.max(1, parseInt(process.env.EA_POLL_SECONDS || '3', 10));

// ------------------------------------------------------------------
// config / persistence
// ------------------------------------------------------------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadToken() {
  if (process.env.CONTROL_TOKEN && process.env.CONTROL_TOKEN.trim() !== '') {
    return process.env.CONTROL_TOKEN.trim();
  }
  ensureDir(DATA_DIR);
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t !== '') return t;
  }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t, 'utf8');
  return t;
}

const CONTROL_TOKEN = loadToken();

const state = {
  active: false,
  flattenPending: false,
  lastCommand: null, // { name, at }
  updatedAt: Date.now(),
  ea: null,          // last status report pushed by the EA
  eaLastSeen: 0,     // ms epoch
  eaOnline: false,
  events: []
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof saved.active === 'boolean') state.active = saved.active;
      if (typeof saved.flattenPending === 'boolean') state.flattenPending = saved.flattenPending;
      if (saved.lastCommand) state.lastCommand = saved.lastCommand;
    }
  } catch (err) {
    logEvent('error', 'Could not read state.json: ' + err.message);
  }
}

function saveState() {
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      active: state.active,
      flattenPending: state.flattenPending,
      lastCommand: state.lastCommand,
      updatedAt: state.updatedAt
    }, null, 2), 'utf8');
  } catch (err) {
    logEvent('error', 'Could not write state.json: ' + err.message);
  }
}

function logEvent(level, msg) {
  const ev = { ts: Date.now(), level, msg };
  state.events.push(ev);
  if (state.events.length > MAX_EVENTS) state.events.shift();
  const line = new Date(ev.ts).toISOString() + ' [' + level + '] ' + msg + '\n';
  process.stdout.write(line);
  try {
    ensureDir(DATA_DIR);
    fs.appendFileSync(EVENT_FILE, line, 'utf8');
  } catch (err) { /* logging must never break the server */ }
}
// ------------------------------------------------------------------
// http helpers
// ------------------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-control-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function authorized(req, url) {
  const header = req.headers['x-control-token'];
  if (header && header === CONTROL_TOKEN) return true;
  return url.searchParams.get('token') === CONTROL_TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function eaTouch() {
  state.eaLastSeen = Date.now();
  if (!state.eaOnline) {
    state.eaOnline = true;
    logEvent('ok', 'EA connected (heartbeat received)');
  }
}

function secondsSince(t) {
  if (!t) return null;
  return Math.round((Date.now() - t) / 1000);
}

function recentEvents() {
  return state.events.slice(-MAX_EVENTS).reverse();
}

// ------------------------------------------------------------------
// api handlers
// ------------------------------------------------------------------
function apiControl(req, res) {
  // called by the EA every few seconds
  eaTouch();
  json(res, 200, {
    ok: true,
    active: state.active,
    flatten: state.flattenPending,
    pollSeconds: POLL_SECONDS,
    eaTimeoutSeconds: Math.round(EA_TIMEOUT_MS / 1000),
    serverTime: new Date().toISOString(),
    lastCommand: state.lastCommand ? state.lastCommand.name : null
  });
}

async function apiReport(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    json(res, 400, { ok: false, error: 'invalid json' });
    return;
  }

  eaTouch();
  state.ea = Object.assign({}, body, { receivedAt: Date.now() });

  if (body.flatten_ack === true) {
    state.flattenPending = false;
    state.updatedAt = Date.now();
    saveState();
    logEvent('ok', 'EA confirmed: all bot trades closed');
  }

  json(res, 200, { ok: true });
}

function apiState(req, res) {
  const online = state.eaLastSeen > 0 && Date.now() - state.eaLastSeen <= EA_TIMEOUT_MS;
  json(res, 200, {
    ok: true,
    active: state.active,
    flattenPending: state.flattenPending,
    lastCommand: state.lastCommand,
    updatedAt: state.updatedAt,
    eaOnline: online,
    eaLastSeen: state.eaLastSeen || null,
    eaLastSeenSeconds: secondsSince(state.eaLastSeen),
    eaTimeoutSeconds: Math.round(EA_TIMEOUT_MS / 1000),
    pollSeconds: POLL_SECONDS,
    report: state.ea,
    events: recentEvents()
  });
}

async function apiCommand(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    json(res, 400, { ok: false, error: 'invalid json' });
    return;
  }

  const changes = [];

  if (typeof body.active === 'boolean' && body.active !== state.active) {
    state.active = body.active;
    state.lastCommand = { name: body.active ? 'START' : 'STOP', at: Date.now() };
    changes.push(body.active ? 'bot START requested' : 'bot STOP requested');
    logEvent('cmd', body.active ? 'START - bot enabled' : 'STOP - bot paused');
  }
  if (body.flatten === true) {
    state.flattenPending = true;
    state.lastCommand = {
      name: (state.active ? 'START' : 'STOP') + '+CLOSE_ALL',
      at: Date.now()
    };
    changes.push('close-all requested');
    logEvent('cmd', 'CLOSE ALL - waiting for EA acknowledgement');
  }

  if (changes.length > 0) {
    state.updatedAt = Date.now();
    saveState();
  }

  json(res, 200, {
    ok: true,
    active: state.active,
    flattenPending: state.flattenPending,
    lastCommand: state.lastCommand,
    changes
  });
}


// ------------------------------------------------------------------
// static files
// ------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    json(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

// ------------------------------------------------------------------
// http server
// ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  if (pathname === '/healthz') {
    json(res, 200, { ok: true, up: true, active: state.active });
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (!authorized(req, url)) {
      json(res, 401, { ok: false, error: 'invalid or missing control token' });
      return;
    }
    try {
      if (pathname === '/api/control' && req.method === 'GET') return apiControl(req, res);
      if (pathname === '/api/state' && req.method === 'GET') return apiState(req, res);
      if (pathname === '/api/report' && req.method === 'POST') return await apiReport(req, res);
      if (pathname === '/api/command' && req.method === 'POST') return await apiCommand(req, res);
      json(res, 404, { ok: false, error: 'unknown endpoint' });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  serveStatic(res, pathname);
});

// watchdog: flip the EA to offline once the heartbeat stops
const watchdog = setInterval(() => {
  if (state.eaOnline && state.eaLastSeen > 0 && Date.now() - state.eaLastSeen > EA_TIMEOUT_MS) {
    state.eaOnline = false;
    logEvent('warn', 'EA offline - no heartbeat for ' +
      Math.round((Date.now() - state.eaLastSeen) / 1000) +
      's (MT5 terminal or EA stopped?)');
  }
}, 2000);

// A second copy of the server on the same port is an easy mistake on a laptop
// (autostart + a manual double-click). Say so clearly instead of dumping a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('*** Port ' + PORT + ' is already in use - the control server seems to be running already.');
    console.error('*** Open http://localhost:' + PORT + ' instead of starting it again,');
    console.error('*** or use another port, e.g.:  set PORT=8081 && node server\\server.js');
    console.error('');
  } else {
    console.error('*** Server error: ' + err.message);
  }
  clearInterval(watchdog);
  process.exitCode = 1;
});

loadState();

let shuttingDown = false;

// Stop the timers, drop open sockets and let Node exit on its own so any
// buffered console output (or redirected log file) is flushed properly.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveState();
  logEvent('info', 'server shutting down');
  clearInterval(watchdog);
  server.close();
  server.closeAllConnections();
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('------------------------------------------------------------');
  console.log(' MT5 web control server running');
  console.log('   URL          : http://' + shown + ':' + PORT);
  console.log('   Control token: ' + CONTROL_TOKEN);
  console.log('   Bot state    : ' + (state.active ? 'ACTIVE (restored)' : 'STOPPED'));
  console.log('   EA timeout   : ' + Math.round(EA_TIMEOUT_MS / 1000) + 's');
  console.log('------------------------------------------------------------');
  console.log(' 1. Open the URL above in any browser, paste the token.');
  console.log(' 2. In MT5: Tools > Options > Expert Advisors > allow WebRequest for:');
  console.log('      http://<this-machine-ip>:' + PORT);
  console.log('------------------------------------------------------------');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, shutdown, state, CONTROL_TOKEN };

