# Oracle Bottleneck Monitor (Thin mode)

Simple, clean web dashboard for **junior DBAs** to quickly identify bottlenecks:
sessions, locks, heavy SQL, wait events, resources, and recent ASH activity.

Uses **node-oracledb in Thin mode** (no Oracle Client libraries required).

## Quick start

1. Create your local config from the template and edit it:

   ```bash
   cp src/config.example.js src/config.js
   ```

   - Change web login (`webUsername` / `webPassword`).
   - Add one or more databases under `dbs[]`.

   `src/config.js` is git-ignored so your credentials never get committed.

2. Create the monitoring database user and grant the required privileges (see below).

3. Install and run:

```bash
npm install
npm start        # or: npm run dev (auto-restart on changes)
```

4. Open http://localhost:3000 and log in.

## Project structure

```
oracle-monitor/
├── src/
│   ├── server.js            # Express app, API routes, Oracle connection pools
│   ├── queries.js           # Monitoring SQL (sessions, locks, top SQL, waits, ASH…)
│   ├── config.example.js    # Config template (committed)
│   └── config.js            # Your local config (git-ignored)
├── public/                  # Static frontend (dashboard + login page)
├── docs/
│   └── Oracle_Bottleneck_Investigation_Guide.md
├── package.json
└── README.md
```

See the [Oracle Bottleneck Investigation Guide](docs/Oracle_Bottleneck_Investigation_Guide.md) for a step-by-step troubleshooting walkthrough.

## Required Oracle privileges

### Recommended (simplest)
```sql
-- Create the user (example)
CREATE USER monitor_user IDENTIFIED BY "YourStrongPassword";

-- Read access to all dictionary and V$ views
GRANT SELECT_CATALOG_ROLE TO monitor_user;

-- Required only if you want the Kill Session button to work
GRANT ALTER SYSTEM TO monitor_user;
```

`SELECT_CATALOG_ROLE` is sufficient for all monitoring tabs, explain plans, and ASH.

### More restrictive alternative
If you prefer not to grant `SELECT_CATALOG_ROLE`, you can grant only the specific views:

```sql
GRANT SELECT ON v_$session                 TO monitor_user;
GRANT SELECT ON v_$sql                     TO monitor_user;
GRANT SELECT ON v_$lock                    TO monitor_user;
GRANT SELECT ON v_$system_event            TO monitor_user;
GRANT SELECT ON v_$sysstat                 TO monitor_user;
GRANT SELECT ON v_$resource_limit          TO monitor_user;
GRANT SELECT ON v_$active_session_history  TO monitor_user;
-- add more if you extend the queries
```

**Note:** Grant on the underlying `V_$` views (not the public `V$` synonyms).

| Feature                    | Privilege needed                              |
|----------------------------|-----------------------------------------------|
| All monitoring tabs + ASH  | `SELECT_CATALOG_ROLE` (or specific `SELECT`s) |
| Explain Plan               | Same as above                                 |
| Kill Session button        | `ALTER SYSTEM`                                |

## Features

- Web login with session protection
- **Multi-database** support (dropdown switcher)
- Overview / Sessions / Locks / Top SQL / Waits / Resources / **ASH (30 min)**
- Color highlighting for long waits and blockers
- Click any **SQL_ID** → execution plan modal
- **Kill Session** button (with confirmation) on the Sessions tab
- Simple bar charts (Chart.js) on Waits and ASH tabs
- Auto-refresh every 15 seconds
- Verbose error messages (console + UI)

## Requirements

- Node.js 18+
- Oracle Database 12.1 or later
- Network access to the database listener(s)

## Security notes

- Change default passwords and `sessionSecret` before real use.
- Give the monitoring database user the minimum privileges needed.
- The Kill feature is powerful — use it carefully and only with trusted users.
- In production, put the app behind TLS and stronger authentication.

## Tips for junior DBAs

- Start with **Overview** and **Locks**.
- High blocked sessions → look at the blocker and its SQL.
- High elapsed time + high disk reads → possible missing index.
- ASH tab shows what was hot in the last 30 minutes.
- Always check the blue hint box under each table.
