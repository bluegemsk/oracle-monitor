export const queries = {
  health: {
    title: 'Health Snapshot',
    sql: `
      SELECT
        (SELECT COUNT(*) FROM v$session WHERE username IS NOT NULL) AS total_sessions,
        (SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE' AND username IS NOT NULL) AS active_sessions,
        (SELECT COUNT(*) FROM v$session WHERE blocking_session IS NOT NULL) AS blocked_sessions,
        (SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE' AND last_call_et > 300 AND username IS NOT NULL) AS long_running
      FROM dual
    `,
    hint: 'High blocked_sessions or long_running → investigate Locks and Sessions tabs immediately.'
  },

  sessions: {
    title: 'Active Sessions',
    sql: `
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
                s.last_call_et DESC
    `,
    hint: 'Sessions with high secs_active and non-Idle waits, or that are blocking others, are the usual suspects. Use Kill only when necessary.'
  },

  locks: {
    title: 'Blocking Locks',
    sql: `
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
      ORDER  BY w.seconds_in_wait DESC
    `,
    hint: 'A single blocker with many waiters for a long time usually means a missing COMMIT or a long-running transaction. blocking_sql shows the blocker\'s current SQL, or its last SQL if it is idle.'
  },

  topSql: {
    title: 'Top SQL by Elapsed Time',
    sql: `
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
      FETCH  FIRST 15 ROWS ONLY
    `,
    hint: 'Totals since each statement was loaded into the shared pool. High elapsed_sec + high disk_reads → likely missing index or bad plan. Click SQL_ID for explain plan.'
  },

  waits: {
    title: 'Top Non-Idle Wait Events',
    sql: `
      SELECT event,
             wait_class,
             total_waits,
             ROUND(time_waited_micro/1000000, 1) AS time_waited_sec
      FROM   v$system_event
      WHERE  wait_class != 'Idle'
      ORDER  BY time_waited_micro DESC
      FETCH  FIRST 10 ROWS ONLY
    `,
    hint: 'Totals since instance startup. The top wait class often reveals the main bottleneck (User I/O, Concurrency, Commit, Application, etc.). Use ASH for what is happening now.'
  },

  resources: {
    title: 'Resource Snapshot',
    sql: `
      SELECT
        ROUND((1 - (phy.value / NULLIF(gets.value + cons.value, 0))) * 100, 2) AS buffer_cache_hit_pct,
        (SELECT current_utilization FROM v$resource_limit WHERE resource_name = 'sessions') AS current_sessions,
        (SELECT TRIM(limit_value) FROM v$resource_limit WHERE resource_name = 'sessions') AS max_sessions
      FROM v$sysstat phy, v$sysstat gets, v$sysstat cons
      WHERE phy.name = 'physical reads'
        AND gets.name = 'db block gets'
        AND cons.name = 'consistent gets'
    `,
    hint: 'Buffer cache hit ratio consistently below 90–95% often indicates memory pressure or heavy full table scans.'
  },

  ash: {
    title: 'Recent Activity (ASH – last 30 min)',
    sql: `
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
      FETCH  FIRST 12 ROWS ONLY
    `,
    hint: 'Shows which SQL was most active in the last 30 minutes. ASH samples active sessions once per second, so samples = seconds of DB time and approx_aas = average active sessions running that SQL.'
  }
};
