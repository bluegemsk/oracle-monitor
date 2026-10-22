import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import oracledb from 'oracledb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { queries } from './queries.js';

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// databaseLoginPage: 'yes' → user enters DB credentials in the browser (kept only in
// server memory for the browser session); 'no' → credentials come from config.dbs.
const loginPage = ['yes', 'true'].includes(String(config.databaseLoginPage).toLowerCase());
const idleMs = (config.sessionIdleMinutes || 30) * 60 * 1000;

const PRIVILEGES = {
  NORMAL: undefined,
  SYSDBA: oracledb.SYSDBA,
  SYSOPER: oracledb.SYSOPER
};

const sessionStore = new session.MemoryStore();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: sessionStore,
  // Random per process: a restart invalidates every session (and its credentials)
  secret: crypto.randomBytes(32).toString('hex'),
  name: 'oramon.sid',
  resave: false,
  saveUninitialized: false,
  // No maxAge → browser-session cookie, gone when the browser closes
  cookie: { httpOnly: true, sameSite: 'strict' }
}));

// Server-side idle timeout for stored DB credentials
app.use((req, res, next) => {
  if (req.session.db) {
    if (Date.now() - req.session.lastSeen > idleMs) {
      return req.session.regenerate(() => next());
    }
    req.session.lastSeen = Date.now();
  }
  next();
});

// Page gating: in login-page mode the dashboard requires DB credentials first
app.get(['/', '/index.html'], (req, res, next) => {
  if (loginPage && !req.session.db) return res.redirect('/connect.html');
  next();
});
app.get('/connect.html', (req, res, next) => {
  if (!loginPage || req.session.db) return res.redirect('/');
  next();
});

app.use(express.static(publicDir));

const pools = {}; // name -> pool

function logError(context, err) {
  if (err.status) return; // expected client errors (e.g. not connected), not worth a stack trace
  console.error(`\n[ERROR] ${context}`);
  console.error('Message:', err.message);
  if (err.code) console.error('Code:', err.code);
  if (err.errorNum) console.error('Oracle Error Number:', err.errorNum);
  if (err.offset) console.error('Offset:', err.offset);
  console.error('Stack:', err.stack);
  console.error('---');
}

async function initPools() {
  if (loginPage) return;
  for (const db of config.dbs) {
    try {
      pools[db.name] = await oracledb.createPool({
        user: db.user,
        password: db.password,
        connectString: db.connectString,
        poolMin: 1,
        poolMax: 4,
        poolIncrement: 1,
        poolTimeout: 60
      });
      console.log(`✓ Pool created for database "${db.name}"`);
    } catch (err) {
      logError(`Failed to create pool for "${db.name}"`, err);
      // Continue with other DBs
    }
  }
  if (Object.keys(pools).length === 0) {
    console.error('No database pools could be created. Exiting.');
    process.exit(1);
  }
}

// Drop expired sessions so abandoned credentials don't linger in memory
setInterval(() => {
  sessionStore.all((err, sessions) => {
    if (err || !sessions) return;
    for (const [sid, sess] of Object.entries(sessions)) {
      if (sess.db && Date.now() - sess.lastSeen > idleMs) sessionStore.destroy(sid);
    }
  });
}, 60 * 1000).unref();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Label of the database the request works with
function getDbName(req) {
  if (loginPage) {
    const db = req.session.db;
    return db ? `${db.user}@${db.connectString}` : null;
  }
  // The selected database travels with each request (?db=... or body.db);
  // defaults to the first database whose pool was created.
  return req.query.db || req.body?.db || Object.keys(pools)[0];
}

// Login-page mode: standalone connection with the session's credentials.
// Config mode: connection from the selected database's pool.
async function getConnection(req) {
  if (loginPage) {
    const db = req.session.db;
    if (!db) throw httpError(401, 'Not connected to a database');
    return oracledb.getConnection({
      user: db.user,
      password: db.password,
      connectString: db.connectString,
      privilege: PRIVILEGES[db.privilege]
    });
  }
  const dbName = getDbName(req);
  const pool = pools[dbName];
  if (!pool) throw httpError(400, `No pool for database "${dbName}"`);
  return pool.getConnection();
}

// Database connect / disconnect (login-page mode)
app.post('/api/connect', async (req, res) => {
  if (!loginPage) return res.status(404).json({ error: 'Database login page is disabled' });
  const { user, password, connectString } = req.body;
  const privilege = String(req.body.privilege || 'NORMAL').toUpperCase();
  if (!user || !password || !connectString) {
    return res.status(400).json({ error: 'Username, password and connection string are required' });
  }
  if (!(privilege in PRIVILEGES)) return res.status(400).json({ error: 'Invalid privilege' });

  let conn;
  try {
    conn = await oracledb.getConnection({ user, password, connectString, privilege: PRIVILEGES[privilege] });
  } catch (err) {
    logError(`Connect ${user}@${connectString} (${privilege})`, err);
    return res.status(401).json({ error: 'Connection failed', details: err.message });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error', details: err.message });
    req.session.db = { user, password, connectString, privilege };
    req.session.lastSeen = Date.now();
    console.log(`✓ ${req.ip} connected as ${user}@${connectString} (${privilege})`);
    res.json({ success: true });
  });
});

app.post('/api/disconnect', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('oramon.sid');
    res.json({ success: true });
  });
});

// Database list / current connection
app.get('/api/dbs', (req, res) => {
  if (loginPage) {
    const db = req.session.db;
    if (!db) return res.status(401).json({ error: 'Not connected to a database' });
    return res.json({
      loginPage: true,
      dbs: [getDbName(req)],
      current: getDbName(req),
      privilege: db.privilege,
      refreshSeconds: config.refreshSeconds
    });
  }
  const dbs = Object.keys(pools);
  res.json({ loginPage: false, dbs, current: dbs[0], refreshSeconds: config.refreshSeconds });
});

// Main query endpoint
app.get('/api/:section', async (req, res) => {
  const section = queries[req.params.section];
  if (!section) return res.status(404).json({ error: 'Unknown section' });

  let conn;
  try {
    conn = await getConnection(req);
    const result = await conn.execute(section.sql);
    res.json({
      title: section.title,
      rows: result.rows,
      hint: section.hint,
      fetchedAt: new Date().toISOString(),
      db: getDbName(req)
    });
  } catch (err) {
    logError(`Query ${req.params.section}`, err);
    res.status(err.status || 500).json({
      error: err.status ? err.message : 'Query failed',
      details: err.message,
      code: err.errorNum || null
    });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// Explain plan
app.get('/api/explain/:sqlId', async (req, res) => {
  const { sqlId } = req.params;
  if (!/^[a-z0-9]{13}$/i.test(sqlId)) {
    return res.status(400).json({ error: 'Invalid SQL ID' });
  }
  let conn;
  try {
    conn = await getConnection(req);
    const result = await conn.execute(
      `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:sqlId, NULL, 'TYPICAL'))`,
      { sqlId }
    );
    const plan = result.rows.map(r => r.PLAN_TABLE_OUTPUT).join('\n');
    res.json({ plan: plan || 'No plan available (SQL may have aged out of the shared pool).' });
  } catch (err) {
    logError(`Explain ${sqlId}`, err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// Kill session (use carefully!)
app.post('/api/kill', async (req, res) => {
  // ALTER SYSTEM does not accept bind variables, so the values are validated as
  // positive integers and put into the statement text.
  const sid = Number(req.body.sid);
  const serial = Number(req.body.serial);
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(serial) || serial <= 0) {
    return res.status(400).json({ error: 'sid and serial must be positive integers' });
  }

  let conn;
  try {
    conn = await getConnection(req);
    await conn.execute(`ALTER SYSTEM KILL SESSION '${sid},${serial}' IMMEDIATE`);
    console.log(`Session ${sid},${serial} killed from ${req.ip} on ${getDbName(req)}`);
    res.json({ success: true, message: `Session ${sid},${serial} killed` });
  } catch (err) {
    logError(`Kill session ${sid},${serial}`, err);
    res.status(err.status || 500).json({
      error: err.status ? err.message : 'Kill failed',
      details: err.errorNum === 1031
        ? `${err.message} — the monitoring user needs the ALTER SYSTEM privilege.`
        : err.message
    });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// Start
initPools().then(() => {
  app.listen(config.port, () => {
    console.log(`\n🚀 Oracle Monitor running at http://localhost:${config.port}`);
    console.log(loginPage
      ? '   Database login page: enabled (credentials entered in the browser)\n'
      : `   Databases: ${Object.keys(pools).join(', ')}\n`);
  });
});
