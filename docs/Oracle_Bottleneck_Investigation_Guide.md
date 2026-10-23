# Oracle Bottleneck Investigation Guide  
**For Junior Database Administrators**  
*(Terminal / SQL*Plus / SQLcl version)*

This guide contains the same queries used by the Oracle Bottleneck Monitor web application.  
Use it when you only have a terminal (SQL\*Plus or SQLcl) and cannot use the web app.

**Required privileges:** `SELECT_CATALOG_ROLE` (or the individual `SELECT` grants on the `V_$` views — see the README).

---

## How to use this guide

1. Connect to the database as a user with the privileges above.
2. Start with **Step 1 – Health Snapshot**.
3. Follow the hints. If something looks bad, jump to the recommended next query.
4. For any interesting `SQL_ID`, run the Explain Plan query at the bottom.

> **RAC:** `V$` views show only the instance you are connected to.
> On a RAC database, connect to each instance, or ask a senior DBA.

Set a reasonable line size so output is readable:
```sql
SET LINESIZE 200
SET PAGESIZE 100
COLUMN sql_text      FORMAT A100
COLUMN blocking_sql  FORMAT A80
COLUMN event         FORMAT A40
COLUMN last_event    FORMAT A40
COLUMN machine       FORMAT A30
COLUMN program       FORMAT A30
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
Contact the owner of the blocking session or (with care) kill it. See **Ending a blocking session** below.

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

> **License note:** `V$ACTIVE_SESSION_HISTORY` requires the **Oracle Diagnostics Pack**
> (Enterprise Edition). Skip this step if your database is not licensed for it.

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

## Step 8 – Memory (SGA / PGA)

**Purpose:** Check whether the SGA (buffer cache, shared pool) and the PGA (sorts, hash joins) are sized well.
One compact result: one row per metric with a `status` (OK / WARN / BAD / INFO) and an `advice` text.
No Diagnostics or Tuning Pack views are used.

```sql
WITH p AS (
  SELECT name, value FROM v$parameter
  WHERE  name IN ('memory_target', 'sga_target', 'pga_aggregate_target', 'db_block_size')
), pga AS (
  SELECT name, value FROM v$pgastat
  WHERE  name IN ('aggregate PGA target parameter', 'total PGA allocated',
                  'maximum PGA allocated', 'over allocation count', 'cache hit percentage')
), wa AS (
  SELECT SUM(DECODE(name, 'workarea executions - optimal',   value)) AS optimal,
         SUM(DECODE(name, 'workarea executions - onepass',   value)) AS onepass,
         SUM(DECODE(name, 'workarea executions - multipass', value)) AS multipass
  FROM   v$sysstat
  WHERE  name LIKE 'workarea executions - %'
), comp AS (
  SELECT component, current_size, min_size, max_size
  FROM   v$sga_dynamic_components
  WHERE  component IN ('DEFAULT buffer cache', 'shared pool', 'large pool', 'java pool')
), rs AS (
  SELECT COUNT(*) AS ops FROM v$sga_resize_ops
  WHERE  start_time > SYSDATE - 1 AND oper_type IN ('GROW', 'SHRINK')
), sp AS (
  SELECT (SELECT SUM(bytes) FROM v$sgastat WHERE pool = 'shared pool' AND name = 'free memory') AS free_b,
         (SELECT current_size FROM comp WHERE component = 'shared pool') AS size_b
  FROM   dual
), lc AS (
  SELECT SUM(pins) AS pins, SUM(reloads) AS reloads, SUM(invalidations) AS invalidations
  FROM   v$librarycache
), adv AS (
  SELECT a.size_factor, a.estd_physical_read_factor
  FROM   v$db_cache_advice a
  WHERE  a.name = 'DEFAULT' AND a.advice_status = 'ON'
    AND  a.block_size = (SELECT TO_NUMBER(value) FROM p WHERE name = 'db_block_size')
    AND  a.size_factor = (SELECT MAX(b.size_factor) FROM v$db_cache_advice b
                          WHERE b.name = a.name AND b.block_size = a.block_size AND b.size_factor <= 2)
), tp AS (
  SELECT s.sid, s.serial#, s.username, s.program, pr.pga_alloc_mem
  FROM   v$session s
  JOIN   v$process pr ON pr.addr = s.paddr
  ORDER  BY pr.pga_alloc_mem DESC
  FETCH  FIRST 5 ROWS ONLY
), r AS (
  SELECT 1 AS ord, 'SGA' AS area, 'Memory mode' AS metric,
         CASE WHEN (SELECT TO_NUMBER(value) FROM p WHERE name = 'memory_target') > 0 THEN 'AMM (memory_target)'
              WHEN (SELECT TO_NUMBER(value) FROM p WHERE name = 'sga_target') > 0 THEN 'ASMM (sga_target)'
              ELSE 'Manual' END AS value,
         'INFO' AS status,
         'memory_target ' || ROUND((SELECT TO_NUMBER(value) FROM p WHERE name = 'memory_target') / 1048576) ||
         ' MB, sga_target ' || ROUND((SELECT TO_NUMBER(value) FROM p WHERE name = 'sga_target') / 1048576) ||
         ' MB, pga_aggregate_target ' || ROUND((SELECT TO_NUMBER(value) FROM p WHERE name = 'pga_aggregate_target') / 1048576) || ' MB.' AS advice
  FROM dual
  UNION ALL
  SELECT 2, 'SGA', 'Total SGA (MB)', TO_CHAR(ROUND(SUM(value) / 1048576)), 'INFO',
         'Fixed + variable + buffers + redo buffers (v$sga).'
  FROM v$sga
  UNION ALL
  SELECT 3, 'SGA', component || ' (MB)', TO_CHAR(ROUND(current_size / 1048576)), 'INFO',
         'min ' || ROUND(min_size / 1048576) || ' / max ' || ROUND(max_size / 1048576) ||
         ' MB since startup. A big min-max gap = this pool is being resized often.'
  FROM comp
  UNION ALL
  SELECT 4, 'SGA', 'Resize operations (24 h)', TO_CHAR(ops),
         CASE WHEN ops > 50 THEN 'BAD' WHEN ops > 10 THEN 'WARN' ELSE 'OK' END,
         CASE WHEN ops > 10 THEN 'Frequent grow/shrink between pools: SGA is undersized. Set minimum sizes (db_cache_size, shared_pool_size) or raise sga_target.'
              ELSE 'Pools are stable.' END
  FROM rs
  UNION ALL
  SELECT 5, 'Shared pool', 'Free memory (MB / %)',
         ROUND(free_b / 1048576) || ' / ' || ROUND(100 * free_b / NULLIF(size_b, 0), 1) || '%',
         CASE WHEN 100 * free_b / NULLIF(size_b, 0) < 5 THEN 'WARN' ELSE 'OK' END,
         CASE WHEN 100 * free_b / NULLIF(size_b, 0) < 5 THEN 'Low free memory. Only a problem if reloads are also high (next row) or you see ORA-04031.'
              ELSE 'Enough free memory.' END
  FROM sp
  UNION ALL
  SELECT 6, 'Shared pool', 'Library cache reloads % / invalidations',
         ROUND(100 * reloads / NULLIF(pins, 0), 2) || '% / ' || invalidations,
         CASE WHEN 100 * reloads / NULLIF(pins, 0) > 1 THEN 'WARN' ELSE 'OK' END,
         CASE WHEN 100 * reloads / NULLIF(pins, 0) > 1 THEN 'SQL is aged out and re-parsed: shared pool pressure or hard parsing. Check that the application uses bind variables; consider a larger shared pool.'
              ELSE 'Reloads under 1% of executions: healthy. Invalidations grow after DDL or statistics gathering.' END
  FROM lc
  UNION ALL
  SELECT 7, 'Buffer cache', 'Advice: physical reads change at ' || size_factor || 'x cache size',
         ROUND(100 * (estd_physical_read_factor - 1)) || '%',
         CASE WHEN estd_physical_read_factor < 0.8 THEN 'WARN' ELSE 'OK' END,
         CASE WHEN estd_physical_read_factor < 0.8 THEN 'A larger buffer cache would cut physical reads noticeably. Consider growing it if there is free RAM, but tune heavy SQL first.'
              ELSE 'A bigger cache would not help much. Do not chase the buffer cache hit ratio; look at Top SQL instead.' END
  FROM adv
  UNION ALL
  SELECT 8, 'PGA', 'Target / allocated / max allocated (MB)',
         ROUND(MAX(DECODE(name, 'aggregate PGA target parameter', value)) / 1048576) || ' / ' ||
         ROUND(MAX(DECODE(name, 'total PGA allocated', value)) / 1048576) || ' / ' ||
         ROUND(MAX(DECODE(name, 'maximum PGA allocated', value)) / 1048576),
         CASE WHEN MAX(DECODE(name, 'total PGA allocated', value)) > MAX(DECODE(name, 'aggregate PGA target parameter', value)) THEN 'WARN' ELSE 'OK' END,
         'The target is a goal, not a limit. Allocated above target means sessions need more PGA than configured.'
  FROM pga
  UNION ALL
  SELECT 9, 'PGA', 'Over allocation count', TO_CHAR(MAX(value)),
         CASE WHEN MAX(value) > 0 THEN 'BAD' ELSE 'OK' END,
         CASE WHEN MAX(value) > 0 THEN 'Oracle could not stay within pga_aggregate_target. Raise pga_aggregate_target.'
              ELSE 'PGA target is large enough.' END
  FROM pga WHERE name = 'over allocation count'
  UNION ALL
  SELECT 10, 'PGA', 'Cache hit %', TO_CHAR(ROUND(MAX(value), 1)),
         CASE WHEN MAX(value) < 80 THEN 'WARN' ELSE 'OK' END,
         CASE WHEN MAX(value) < 80 THEN 'Many sorts/hash joins spill to TEMP. Consider a larger pga_aggregate_target.'
              ELSE 'Most work areas fit in memory.' END
  FROM pga WHERE name = 'cache hit percentage'
  UNION ALL
  SELECT 11, 'PGA', 'Work areas optimal / onepass / multipass',
         optimal || ' / ' || onepass || ' / ' || multipass,
         CASE WHEN multipass > 0 THEN 'BAD' WHEN onepass > 0.05 * NULLIF(optimal, 0) THEN 'WARN' ELSE 'OK' END,
         CASE WHEN multipass > 0 THEN 'Multipass sorts/hashes: PGA is too small (very slow TEMP I/O). Raise pga_aggregate_target.'
              WHEN onepass > 0.05 * NULLIF(optimal, 0) THEN 'Many one-pass executions: PGA is a bit tight.'
              ELSE 'Sorts and hash joins run in memory.' END
  FROM wa
  UNION ALL
  SELECT 12 + ROW_NUMBER() OVER (ORDER BY pga_alloc_mem DESC) / 10, 'PGA by session', 'SID ' || sid || ',' || serial# || ' ' || NVL(username, '(background)'),
         ROUND(pga_alloc_mem / 1048576) || ' MB', 'INFO',
         'Program: ' || program || '. One session using much more PGA than others is usually a big sort, hash join or PL/SQL collection.'
  FROM tp
)
SELECT area, metric, value, status, advice
FROM   r
ORDER  BY ord, metric;
```

**What to look for / Hint:**  
Figures are cumulative since instance startup (resize operations: last 24 hours).  
- `Over allocation count` > 0 → Oracle could not stay within `pga_aggregate_target`: raise it.  
- Multipass work areas > 0 (or PGA cache hit % < 80) → PGA too small, sorts/hash joins spill to TEMP.  
- Many SGA resize operations (> 10 in 24 h) → SGA undersized; set minimum `db_cache_size` / `shared_pool_size` or raise `sga_target`.  
- Low shared pool free memory **and** library cache reloads > 1 % → shared pool pressure or hard parsing; check bind variables.  
- Buffer cache advice shows physical reads dropping by more than 20 % with a larger cache → consider a bigger buffer cache (tune heavy SQL first).  
- Do not tune for the buffer cache hit ratio alone.  
- `PGA by session` lists the 5 sessions using the most PGA.

---

## Explain Plan for a SQL_ID

When you have a suspicious `sql_id`, run:

```sql
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('your_sql_id_here', NULL, 'TYPICAL'));
```

**Hint:** Look for full table scans on large tables, high cost steps, or missing index operations.  
If the plan is gone (“SQL not found”), the statement has aged out of the shared pool.

---

## Ending a blocking session

Only do this when the blocker is clearly the problem and, if possible, after you have talked to its owner.

1. Note `blocking_sid` and `blocking_serial` from **Step 3**.
2. Check who it is:

   ```sql
   SELECT sid, serial#, username, machine, program, status, last_call_et
   FROM   v$session
   WHERE  sid = &blocking_sid;
   ```

3. Kill it. You need the `ALTER SYSTEM` privilege:

   ```sql
   ALTER SYSTEM KILL SESSION '<sid>,<serial#>' IMMEDIATE;
   ```

**Remember:** killing a session rolls back its uncommitted work. A big transaction
can take a long time to roll back, and the locks stay until the rollback finishes.

---

## Quick decision tree (for junior DBAs)

1. Run **Health Snapshot**.  
2. If blocked sessions > 0 → **Locks**.  
3. If long-running sessions exist → **Sessions**.  
4. Check **Top SQL** and **ASH** for heavy statements.  
5. Check **Wait Events** to understand the type of bottleneck.  
6. Always look at the explain plan of the top SQL.  
7. Suspected memory problems → **Memory** (Step 8).

---

*These queries are identical to those used by the Oracle Bottleneck Monitor web application.*
