# Oracle Bottleneck Investigation Guide  
**For Junior Database Administrators**  
*(Terminal / SQL*Plus / SQLcl version)*

This guide contains the same queries used by the Oracle Bottleneck Monitor web application.  
You can run them directly when you only have a remote PL/SQL terminal.

**Required privileges:** `SELECT_CATALOG_ROLE` (or the individual `SELECT` grants on the `V_$` views — see the README).

---

## How to use this guide

1. Connect to the database as a user with the privileges above.
2. Start with **Step 1 – Health Snapshot**.
3. Follow the hints. If something looks bad, jump to the recommended next query.
4. For any interesting `SQL_ID`, run the Explain Plan query at the bottom.

Set a reasonable line size so output is readable:
```sql
SET LINESIZE 200
SET PAGESIZE 100
COLUMN sql_text FORMAT A100
```

---

## Step 1 – Health Snapshot

**Purpose:** Quick overview – is anything obviously wrong right now?

```sql
SELECT
  (SELECT COUNT(*) FROM v$session WHERE username IS NOT NULL) AS total_sessions,
  (SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE' AND username IS NOT NULL) AS active_sessions,
  (SELECT COUNT(*) FROM v$session WHERE blocking_session IS NOT NULL) AS blocked_sessions,
  (SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE' AND last_call_et > 300 AND username IS NOT NULL) AS long_running
FROM dual;
```

**What to look for / Hint:**  
- High `blocked_sessions` → go immediately to **Step 3 (Locks)**.  
- High `long_running` (sessions active > 5 minutes) → go to **Step 2 (Sessions)**.  
- Otherwise continue to the next steps.

---

## Step 2 – Active Sessions

**Purpose:** See who is connected, what they are waiting on, and whether they are blocking others.

```sql
SELECT s.sid, s.serial#, s.username, s.status,
       s.last_call_et AS secs_active,
       s.event, s.wait_class, s.seconds_in_wait,
       s.blocking_session, s.machine, s.program, s.module,
       s.sql_id,
       SUBSTR(q.sql_text, 1, 100) AS sql_text
FROM   v$session s
LEFT   JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number
WHERE  s.username IS NOT NULL
ORDER  BY CASE WHEN s.blocking_session IS NOT NULL THEN 0 ELSE 1 END,
          s.last_call_et DESC;
```

**What to look for / Hint:**  
- Sessions with `secs_active` > 300 and a non-Idle `wait_class` are usually the problem.  
- Any session that has a value in `blocking_session` is waiting on someone else.  
- Note the `sql_id` of suspicious sessions for later explain plans.

---

## Step 3 – Blocking Locks

**Purpose:** Find who is blocking whom.

```sql
SELECT w.sid AS waiting_sid,
       w.username AS waiting_user,
       w.seconds_in_wait,
       w.event,
       b.sid AS blocking_sid,
       b.serial# AS blocking_serial,
       b.username AS blocking_user,
       b.machine AS blocking_machine,
       SUBSTR(bq.sql_text, 1, 80) AS blocking_sql
FROM   v$session w
JOIN   v$session b ON b.sid = w.blocking_session
LEFT   JOIN v$sqlarea bq ON bq.sql_id = NVL(b.sql_id, b.prev_sql_id)
WHERE  w.blocking_session IS NOT NULL
ORDER  BY w.seconds_in_wait DESC;
```

**What to look for / Hint:**  
A single blocker with many waiters for a long time almost always means a missing `COMMIT` or a long-running transaction that should have finished.  
`blocking_sql` shows the blocker's current SQL, or — if the blocker is idle — the last SQL it ran (often the uncommitted DML).  
Contact the owner of the blocking session or (with care) kill it.

---

## Step 4 – Top SQL by Elapsed Time

**Purpose:** Find the SQL statements that have consumed the most time.

```sql
SELECT sql_id,
       ROUND(elapsed_time/1000000, 1) AS elapsed_sec,
       ROUND(cpu_time/1000000, 1) AS cpu_sec,
       executions,
       ROUND(buffer_gets / NULLIF(executions, 0)) AS gets_per_exec,
       disk_reads,
       SUBSTR(sql_text, 1, 120) AS sql_text
FROM   v$sqlarea
WHERE  executions > 0
  AND  parsing_schema_name NOT IN ('SYS','SYSTEM','PUBLIC')
ORDER  BY elapsed_time DESC
FETCH  FIRST 15 ROWS ONLY;
```

**What to look for / Hint:**  
- Figures are totals since each statement was loaded into the shared pool (`V$SQLAREA` = one row per `sql_id`).  
- High `elapsed_sec` + high `disk_reads` → likely missing index or bad plan (full scans).  
- High `gets_per_exec` (logical reads per execution) → inefficient SQL.  
- Take the `sql_id` and run an explain plan (see end of this document).

---

## Step 5 – Top Non-Idle Wait Events

**Purpose:** See where the database is spending its time overall.

```sql
SELECT event,
       wait_class,
       total_waits,
       ROUND(time_waited_micro/1000000, 1) AS time_waited_sec
FROM   v$system_event
WHERE  wait_class != 'Idle'
ORDER  BY time_waited_micro DESC
FETCH  FIRST 10 ROWS ONLY;
```

**What to look for / Hint:**  
Figures are cumulative since instance startup — use Step 7 (ASH) for what is happening right now.  
The top `wait_class` usually points to the main bottleneck:  
- `User I/O` → disk / storage  
- `Concurrency` → locks / latches  
- `Commit` → redo / log file sync  
- `Application` → often row lock waits or custom waits

---

## Step 6 – Resource Snapshot

**Purpose:** Quick check of buffer cache efficiency and session limits.

```sql
SELECT
  ROUND((1 - (phy.value / NULLIF(gets.value + cons.value, 0))) * 100, 2) AS buffer_cache_hit_pct,
  (SELECT current_utilization FROM v$resource_limit WHERE resource_name = 'sessions') AS current_sessions,
  (SELECT TRIM(limit_value) FROM v$resource_limit WHERE resource_name = 'sessions') AS max_sessions
FROM v$sysstat phy, v$sysstat gets, v$sysstat cons
WHERE phy.name = 'physical reads'
  AND gets.name = 'db block gets'
  AND cons.name = 'consistent gets';
```

**What to look for / Hint:**  
A buffer cache hit ratio consistently below 90–95 % often means memory pressure or heavy full table scans.

---

## Step 7 – Recent Activity (ASH – last 30 minutes)

**Purpose:** See which SQL was most active in the recent past (very useful after a short performance degradation).

```sql
SELECT a.sql_id,
       a.samples,
       ROUND(a.samples / 1800, 2) AS approx_aas,
       (SELECT SUBSTR(st.sql_text, 1, 100) FROM v$sqlarea st WHERE st.sql_id = a.sql_id) AS sql_text,
       a.last_event
FROM  (SELECT sql_id,
              COUNT(*) AS samples,
              MAX(NVL(event, 'ON CPU')) KEEP (DENSE_RANK LAST ORDER BY sample_time) AS last_event
       FROM   v$active_session_history
       WHERE  sample_time > SYSTIMESTAMP - INTERVAL '30' MINUTE
         AND  session_type = 'FOREGROUND'
         AND  sql_id IS NOT NULL
       GROUP  BY sql_id) a
ORDER  BY a.samples DESC
FETCH  FIRST 12 ROWS ONLY;
```

**What to look for / Hint:**  
High `samples` (or high `approx_aas`) = the SQL that contributed most to the load in the last 30 minutes.  
ASH samples active sessions once per second, so `samples` ≈ seconds of DB time and
`approx_aas` = `samples / 1800` = average number of sessions actively running that SQL.  
`last_event` = `ON CPU` means the session was on CPU (not waiting) in its latest sample.

---

## Explain Plan for a SQL_ID

When you have a suspicious `sql_id`, run:

```sql
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('your_sql_id_here', NULL, 'TYPICAL'));
```

**Hint:** Look for full table scans on large tables, high cost steps, or missing index operations.  
If the plan is gone (“SQL not found”), the statement has aged out of the shared pool.

---

## Quick decision tree (for junior DBAs)

1. Run **Health Snapshot**.  
2. If blocked sessions > 0 → **Locks**.  
3. If long-running sessions exist → **Sessions**.  
4. Check **Top SQL** and **ASH** for heavy statements.  
5. Check **Wait Events** to understand the type of bottleneck.  
6. Always look at the explain plan of the top SQL.

---

*These queries are identical to those used by the Oracle Bottleneck Monitor web application.*
