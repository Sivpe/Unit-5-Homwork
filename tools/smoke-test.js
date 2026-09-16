/**
 * Smoke test for the MT5 web control server.
 *
 * Boots the server on a spare port and exercises the whole flow the way
 * the EA and the browser do:
 *
 *   browser  -> POST /api/command {active:true}
 *   EA       -> GET  /api/control      (should see active:true)
 *   EA       -> POST /api/report       (status push)
 *   browser  -> GET  /api/state        (should show the report)
 *   browser  -> POST /api/command {active:false, flatten:true}
 *   EA       -> GET  /api/control      (should see flatten:true)
 *   EA       -> POST /api/report {flatten_ack:true}
 *   EA       -> GET  /api/control      (flatten must be cleared)
 *
 * Run:  node server/tools/smoke-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

process.env.PORT = process.env.SMOKE_PORT || '8099';
process.env.HOST = '127.0.0.1';

const srv = require(path.join(__dirname, '..', 'server.js'));

const DATA_DIR = path.join(__dirname, '..', 'data');
const BASE = 'http://127.0.0.1:' + process.env.PORT;

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + JSON.stringify(detail) : ''));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(pathname, options, token) {
  const opts = options || {};
  const headers = { 'Content-Type': 'application/json' };
  if (token !== false) headers['x-control-token'] = (token === undefined ? TOKEN : token);
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  return { status: res.status, data };
}

let TOKEN = '';

async function main() {
  await sleep(600);
  TOKEN = fs.readFileSync(path.join(DATA_DIR, 'token.txt'), 'utf8').trim();
  console.log('Control token loaded (' + TOKEN.length + ' chars)\n');

  console.log('1. browser: initial state');
  let r = await call('/api/state');
  check('state answered', r.status === 200 && r.data.ok === true, r);
  check('bot starts stopped', r.data.active === false, r.data.active);
  check('EA reported offline', r.data.eaOnline === false, r.data.eaOnline);

  console.log('2. browser: press START');
  r = await call('/api/command', { method: 'POST', body: { active: true } });
  check('command accepted', r.status === 200 && r.data.active === true, r);

  console.log('3. EA: poll control');
  r = await call('/api/control');
  check('EA sees active:true', r.data.active === true, r.data);
  check('EA sees flatten:false', r.data.flatten === false, r.data);
  check('EA got poll interval', r.data.pollSeconds >= 1, r.data.pollSeconds);
  check('EA marked online', (await call('/api/state')).data.eaOnline === true);

  console.log('4. EA: push status report');
  r = await call('/api/report', {
    method: 'POST',
    body: {
      symbol: 'XAUUSDm', login: 12345678, account_server: 'Test-Demo',
      equity: 1234.5, balance: 1000, margin_free: 900,
      buy_count: 2, sell_count: 1, buy_lots: 0.03, sell_lots: 0.01,
      buy_pl: 12.5, sell_pl: -4.25, daily_pl: 8.25, drawdown: 1.2,
      spread: 18.3, step_pips: 150, radar_score: 5, radar_zone: 'GREEN',
      halt: 'NONE', session: true, module: true, active: true,
      flatten_ack: false
    }
  });
  check('report accepted', r.status === 200 && r.data.ok === true, r);

  console.log('5. browser: read the pushed status');
  r = await call('/api/state');
  const rep = r.data.report || {};
  check('symbol shown', rep.symbol === 'XAUUSDm', rep.symbol);
  check('equity shown', rep.equity === 1234.5, rep.equity);
  check('radar shown', rep.radar_zone === 'GREEN', rep.radar_zone);
  check('heartbeat fresh', r.data.eaLastSeenSeconds <= 2, r.data.eaLastSeenSeconds);

  console.log('6. browser: STOP + CLOSE ALL');
  r = await call('/api/command', { method: 'POST', body: { active: false, flatten: true } });
  check('stop accepted', r.data.active === false, r.data);
  check('close-all pending', r.data.flattenPending === true, r.data);

  console.log('7. EA: poll sees the close-all flag');
  r = await call('/api/control');
  check('EA sees active:false', r.data.active === false, r.data);
  check('EA sees flatten:true', r.data.flatten === true, r.data);

  console.log('8. EA: acknowledge after closing trades');
  r = await call('/api/report', { method: 'POST', body: { flatten_ack: true } });
  check('ack accepted', r.status === 200, r);
  r = await call('/api/control');
  check('close-all cleared', r.data.flatten === false, r.data);

  console.log('9. security: token required');
  r = await call('/api/state', {}, false);
  check('401 without token', r.status === 401, r.status);
  r = await call('/api/state', { headers: {} }, 'wrong-token');
  check('401 with wrong token', r.status === 401, r.status);

  console.log('10. static assets served');
  for (const asset of ['/', '/app.js', '/styles.css']) {
    const res = await fetch(BASE + asset);
    const body = await res.text();
    check('GET ' + asset, res.status === 200 && body.length > 200, res.status);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail === 0 ? 0 : 1;
  srv.shutdown();
}

main().catch((err) => {
  console.log('SMOKE TEST CRASHED: ' + err.stack);
  process.exitCode = 1;
  srv.shutdown();
});