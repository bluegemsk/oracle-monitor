# Oracle Bottleneck Monitor

A simple web dashboard that helps **junior database administrators** find out
why an Oracle database is slow: who is connected, who is blocking whom, which
SQL is heavy, and what the database is waiting on.

- Built for **local use in a closed, internal environment**.
- No application login: open the page and start working.
- Uses node-oracledb in **Thin mode**, so no Oracle Client installation is needed.

For working in a terminal (SQL\*Plus / SQLcl) without the web app, see the
[Oracle Bottleneck Investigation Guide](docs/Oracle_Bottleneck_Investigation_Guide.md).
It uses the same queries.

---

## What you see

| Tab           | What it shows                                    | Look here when…                              |
|---------------|--------------------------------------------------|----------------------------------------------|
| **Overview**  | Number of sessions, active, blocked, long-running | Always start here                            |
| **Sessions**  | All user sessions, what they run and wait on      | Users say "the app hangs"                    |
| **Locks**     | Waiting sessions and the session blocking them    | Overview shows blocked sessions > 0          |
| **Top SQL**   | Statements with the most elapsed time             | The database is slow in general              |
| **Waits**     | Top wait events since instance startup            | You want the *type* of bottleneck (I/O, locks…) |
| **Resources** | Buffer cache hit ratio, sessions used vs. limit   | Suspected memory or session-limit problems   |
| **ASH (30 min)** | SQL that was most active in the last 30 minutes | A problem happened a few minutes ago        |

On every tab:

- The **blue hint box** under the table explains how to read the result.
- **Red / orange cells** mark long waits (> 5 min / > 1 min) and blocked sessions.
- Click any **SQL_ID** to see its execution plan.
- The **Kill** button (Sessions tab) ends a session after a confirmation.
- Data refreshes automatically every 15 seconds (configurable), or press **Refresh**.

---

## Setup

You need **Node.js 18+**, **Oracle Database 12.1+**, and network access to the
database listener.

### 1. Create a monitoring user in the database

Run as a DBA (e.g. `SYS` or `SYSTEM`):

```sql
CREATE USER monitor_user IDENTIFIED BY "YourStrongPassword";
GRANT CREATE SESSION      TO monitor_user;
GRANT SELECT_CATALOG_ROLE TO monitor_user;   -- read access to the V$ views
GRANT ALTER SYSTEM        TO monitor_user;   -- only needed for the Kill button
```

<details>
<summary>Prefer minimal grants instead of SELECT_CATALOG_ROLE?</summary>

Grant only the views the app uses. Grant them on the `V_$` views, not on the
public `V$` synonyms:

```sql
GRANT SELECT ON v_$session                  TO monitor_user;
GRANT SELECT ON v_$sql                      TO monitor_user;
GRANT SELECT ON v_$sqlarea                  TO monitor_user;
GRANT SELECT ON v_$system_event             TO monitor_user;
GRANT SELECT ON v_$sysstat                  TO monitor_user;
GRANT SELECT ON v_$resource_limit           TO monitor_user;
GRANT SELECT ON v_$active_session_history   TO monitor_user;
-- needed for the execution plan (DBMS_XPLAN.DISPLAY_CURSOR)
GRANT SELECT ON v_$sql_plan                 TO monitor_user;
GRANT SELECT ON v_$sql_plan_statistics_all  TO monitor_user;
```
</details>

> **License note:** the **ASH** tab reads `V$ACTIVE_SESSION_HISTORY`, which
> requires the **Oracle Diagnostics Pack** (Enterprise Edition). If your
> database is not licensed for it, do not use the ASH tab.

### 2. Configure the app

```bash
cp src/config.example.js src/config.js
```

Edit `src/config.js`. It is git-ignored, so passwords in it are never committed.

| Setting              | Default  | Meaning |
|----------------------|----------|---------|
| `databaseLoginPage`  | `'no'`   | `'yes'` = ask for database credentials in the browser. `'no'` = use the databases from `dbs`. See below. |
| `sessionIdleMinutes` | `30`     | Login page mode: forget the credentials after this many idle minutes. |
| `dbs`                | example  | List of databases (`name`, `user`, `password`, `connectString`). Used only when `databaseLoginPage` is `'no'`. |
| `port`               | `3000`   | Web port. |
| `refreshSeconds`     | `15`     | Auto-refresh interval. |

The connection string uses the Easy Connect format: `host:port/service_name`,
e.g. `dbhost:1521/ORCLPDB1`.

### 3. Install and start

```bash
npm install
npm start
```

Open **http://localhost:3000**.

(`npm run dev` restarts the server automatically when you change the code.)

---

## Two ways to connect: `databaseLoginPage`

**`'no'`: credentials from the config file.**
The app connects to all databases in `dbs` at startup. Switch between them with
the dropdown in the header. Use this for a fixed set of databases you monitor every day.

**`'yes'`: database login page.**
The first page asks for:

- **Username** (schema) and **password**
- **Connect as**: Normal, SYSDBA or SYSOPER
- **Connection string**, e.g. `dbhost:1521/ORCLPDB1`

The credentials are checked with a test connection and kept **only in the
server's memory** for your browser session. They are never saved to disk. They
are forgotten when you click **Disconnect**, close the browser, stay idle for
`sessionIdleMinutes`, or restart the server. Use this when you need to look at
different databases, or don't want any password in the config file.

---

## When something goes wrong

Errors are shown on the page and printed in detail in the terminal where you ran `npm start`.

| Message                                   | Usual cause / what to do |
|-------------------------------------------|--------------------------|
| `ORA-01017: invalid username/password`    | Wrong username or password. |
| `NJS-503: connection … could not be established` | Wrong host or port, the listener is down, or a firewall is blocking it. |
| `ORA-12514: listener does not currently know of service` | Wrong service name in the connection string. |
| `ORA-00942: table or view does not exist` | The user is missing `SELECT_CATALOG_ROLE` (or a grant from the list above). |
| `ORA-01031: insufficient privileges` on Kill | The user needs `GRANT ALTER SYSTEM`. |
| `No database pools could be created. Exiting.` | `databaseLoginPage` is `'no'` and no database in `dbs` could be reached. Check `src/config.js`. |
| Execution plan: "No plan available"       | The statement has aged out of the shared pool. |

---

## Tips for junior DBAs

1. Start with **Overview**.
2. Blocked sessions > 0 → open **Locks**. One blocker with many waiters usually
   means a transaction that was never committed.
3. Long-running sessions → open **Sessions** and look at `EVENT` and `SQL_TEXT`.
4. Database slow in general → check **Top SQL** and **ASH**, then click the SQL_ID
   to see the execution plan.
5. **Waits** tells you the *kind* of problem: `User I/O` = disk, `Concurrency` =
   locks/latches, `Commit` = redo writes.
6. **Before you kill a session**, find out whose it is (`USERNAME`, `MACHINE`,
   `PROGRAM`) and, if possible, ask the owner first. Killing a session rolls back its
   uncommitted work, and the rollback can take as long as the work did.

---

## Security

This tool is meant for a **closed internal network**:

- There is no application login. Anyone who can open the page can see the data
  and use **Kill**. Do not expose the port outside your admin network.
- Give the monitoring user only the privileges above. Leave out `ALTER SYSTEM`
  if you don't need the Kill button.
- Prefer `databaseLoginPage: 'yes'` if you don't want any database password in a file.

---

## Project structure

```
oracle-monitor/
├── src/
│   ├── server.js           # Web server, API, database connections
│   ├── queries.js          # All monitoring SQL with hints (add new tabs here)
│   ├── config.example.js   # Config template
│   └── config.js           # Your local config (git-ignored)
├── public/                 # Web pages (dashboard, database login page)
└── docs/
    └── Oracle_Bottleneck_Investigation_Guide.md   # Same queries for the terminal
```

If you change a query in `src/queries.js`, update the guide in `docs/` too,
so both stay the same.
