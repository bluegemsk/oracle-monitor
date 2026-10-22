import express from 'express';
import oracledb from 'oracledb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { queries } from './queries.js';

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

const pools = {}; // name -> pool

function logError(context, err) {
  console.error(`\n[ERROR] ${context}`);
  console.error('Message:', err.message);
  if (err.code) console.error('Code:', err.code);
  if (err.errorNum) console.error('Oracle Error Number:', err.errorNum);
  if (err.offset) console.error('Offset:', err.offset);
  console.error('Stack:', err.stack);
  console.error('---');
}

async function initPools() {
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

// The selected database travels with each request (?db=... or body.db);
// defaults to the first database whose pool was created.
function getDbName(req) {
  return req.query.db || req.body?.db || Object.keys(pools)[0];
}

function getPool(req) {
  const dbName = getDbName(req);
  const pool = pools[dbName];
  if (!pool) throw new Error(`No pool for database "${dbName}"`);
  return pool;
}

// Database list
app.get('/api/dbs', (req, res) => {
  const dbs = Object.keys(pools);
  res.json({ dbs, current: dbs[0] });
});

// Main query endpoint
app.get('/api/:section', async (req, res) => {
  const section = queries[req.params.section];
  if (!section) return res.status(404).json({ error: 'Unknown section' });

  let conn;
  try {
    const pool = getPool(req);
    conn = await pool.getConnection();
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
    res.status(500).json({
      error: 'Query failed',
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
    const pool = getPool(req);
    conn = await pool.getConnection();
    const result = await conn.execute(
      `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:sqlId, NULL, 'TYPICAL'))`,
      { sqlId }
    );
    const plan = result.rows.map(r => r.PLAN_TABLE_OUTPUT).join('\n');
    res.json({ plan: plan || 'No plan available (SQL may have aged out of the shared pool).' });
  } catch (err) {
    logError(`Explain ${sqlId}`, err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// Kill session (use carefully!)
app.post('/api/kill', async (req, res) => {
  const { sid, serial } = req.body;
  if (!sid || !serial) return res.status(400).json({ error: 'sid and serial required' });

  let conn;
  try {
    const pool = getPool(req);
    conn = await pool.getConnection();
    await conn.execute(
      `ALTER SYSTEM KILL SESSION :sid_serial IMMEDIATE`,
      { sid_serial: `${sid},${serial}` }
    );
    console.log(`Session ${sid},${serial} killed from ${req.ip} on ${getDbName(req)}`);
    res.json({ success: true, message: `Session ${sid},${serial} killed` });
  } catch (err) {
    logError(`Kill session ${sid},${serial}`, err);
    res.status(500).json({
      error: 'Kill failed',
      details: err.message,
      hint: 'The monitoring user needs the ALTER SYSTEM privilege.'
    });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// Start
initPools().then(() => {
  app.listen(config.port, () => {
    console.log(`\n🚀 Oracle Monitor running at http://localhost:${config.port}`);
    console.log(`   Databases: ${Object.keys(pools).join(', ')}\n`);
  });
});
