let currentSection = 'health';
let currentDb = '';
let chart = null;
let refreshInterval = null;
let refreshSeconds = 15;
let loadSeq = 0; // only the latest loadSection() response is rendered

async function init() {
  await loadDbs();
  setupTabs();
  setupAutoRefresh();
  loadSection('health');
}

async function loadDbs() {
  const res = await fetch('/api/dbs');
  if (res.status === 401) { window.location.href = '/connect.html'; return; }
  const data = await res.json();
  if (data.refreshSeconds > 0) refreshSeconds = data.refreshSeconds;
  const select = document.getElementById('dbSelect');

  if (data.loginPage) {
    // Single database connected with credentials entered on the connect page
    currentDb = data.current;
    select.style.display = 'none';
    const label = document.getElementById('dbLabel');
    label.textContent = data.privilege === 'NORMAL' ? data.current : `${data.current} (${data.privilege})`;
    label.style.display = '';
    const btn = document.getElementById('disconnectBtn');
    btn.style.display = '';
    btn.onclick = async () => {
      await fetch('/api/disconnect', { method: 'POST' });
      window.location.href = '/connect.html';
    };
    return;
  }

  select.innerHTML = data.dbs.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  select.value = data.current;
  currentDb = data.current;
  select.onchange = () => {
    currentDb = select.value;
    loadSection(currentSection);
  };
}

async function loadSection(section) {
  const seq = ++loadSeq;
  const content = document.getElementById('content');
  const hint = document.getElementById('hint');
  const chartContainer = document.getElementById('chartContainer');
  content.innerHTML = '<p class="loading">Loading...</p>';
  hint.textContent = '';
  chartContainer.style.display = 'none';
  if (chart) { chart.destroy(); chart = null; }

  try {
    const res = await fetch(`/api/${section}?${dbParam()}`);
    if (res.status === 401) { window.location.href = '/connect.html'; return; }
    const data = await res.json();
    if (seq !== loadSeq) return; // a newer request (tab switch / refresh) superseded this one
    if (!res.ok) {
      content.innerHTML = `<div class="error"><strong>Error:</strong> ${escapeHtml(data.error)}<br><small>${escapeHtml(data.details || '')}</small></div>`;
      return;
    }

    document.getElementById('lastUpdate').textContent = `Updated: ${new Date(data.fetchedAt).toLocaleTimeString()} (${data.db})`;
    hint.textContent = data.hint || '';

    if (!data.rows || data.rows.length === 0) {
      content.innerHTML = `<p class="empty">No data.</p>`;
      return;
    }

    content.innerHTML = renderTable(data.rows, section);

    // Simple charts for certain sections
    if (section === 'waits' || section === 'ash') {
      renderChart(data.rows, section);
    }
  } catch (err) {
    if (seq !== loadSeq) return;
    content.innerHTML = `<div class="error">Network error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderTable(rows, section) {
  const cols = Object.keys(rows[0]);
  let html = '<table><thead><tr>';
  cols.forEach(c => html += `<th>${escapeHtml(c)}</th>`);
  if (section === 'sessions') html += '<th>Action</th>';
  html += '</tr></thead><tbody>';

  rows.forEach(row => {
    html += '<tr>';
    cols.forEach(c => {
      let val = row[c] == null ? '' : String(row[c]);
      let cls = '';
      const num = Number(val);
      if ((c === 'SECS_ACTIVE' || c === 'SECONDS_IN_WAIT') && num > 300) cls = 'bad';
      else if ((c === 'SECS_ACTIVE' || c === 'SECONDS_IN_WAIT') && num > 60) cls = 'warn';
      if (c === 'BLOCKING_SESSION' && val) cls = 'bad';
      if (c === 'STATUS' && section === 'memory') cls = val === 'BAD' ? 'bad' : val === 'WARN' ? 'warn' : '';

      let cell = escapeHtml(val);
      if ((c === 'SQL_ID' || c === 'sql_id') && val && /^[a-z0-9]{13}$/i.test(val)) {
        cell = `<a href="#" class="sql-link" data-sqlid="${val}">${cell}</a>`;
      }
      html += `<td class="${cls}">${cell}</td>`;
    });

    if (section === 'sessions') {
      html += `<td><button class="kill-btn small" data-sid="${row.SID}" data-serial="${row['SERIAL#']}">Kill</button></td>`;
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

function renderChart(rows, section) {
  const container = document.getElementById('chartContainer');
  container.style.display = 'block';
  const ctx = document.getElementById('chart').getContext('2d');

  let labels, values, title;
  if (section === 'waits') {
    labels = rows.map(r => r.EVENT || r.event);
    values = rows.map(r => r.TIME_WAITED_SEC || r.time_waited_sec);
    title = 'Top Wait Events (seconds)';
  } else if (section === 'ash') {
    labels = rows.map(r => (r.SQL_ID || r.sql_id || '').slice(0, 8) + '…');
    values = rows.map(r => r.SAMPLES || r.samples);
    title = 'ASH Samples (last 30 min)';
  }

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: title, data: values, backgroundColor: '#2b6cb0' }]
    },
    options: {
      responsive: true,
      plugins: { title: { display: true, text: title } },
      scales: { y: { beginAtZero: true } }
    }
  });
}

// Event delegation for SQL links and Kill buttons
document.getElementById('content').addEventListener('click', async (e) => {
  if (e.target.classList.contains('sql-link')) {
    e.preventDefault();
    const sqlId = e.target.dataset.sqlid;
    const modal = document.getElementById('modal');
    const planText = document.getElementById('planText');
    planText.textContent = 'Loading plan…';
    modal.style.display = 'flex';
    try {
      const res = await fetch(`/api/explain/${sqlId}?${dbParam()}`);
      const data = await res.json();
      planText.textContent = data.plan || data.error || 'No plan available';
    } catch (err) {
      planText.textContent = 'Error: ' + err.message;
    }
  }

  if (e.target.classList.contains('kill-btn')) {
    const sid = e.target.dataset.sid;
    const serial = e.target.dataset.serial;
    if (!confirm(`Kill session ${sid},${serial}?\n\nThis will disconnect the user immediately.`)) return;
    try {
      const res = await fetch('/api/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, serial, db: currentDb })
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message);
        loadSection(currentSection);
      } else {
        alert('Kill failed: ' + (data.details || data.error));
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }
});

// Modal close
document.querySelector('.close').onclick = () => document.getElementById('modal').style.display = 'none';
window.onclick = (e) => { if (e.target.id === 'modal') e.target.style.display = 'none'; };

function setupTabs() {
  document.querySelectorAll('#tabs button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSection = btn.dataset.section;
      loadSection(currentSection);
    };
  });
}

const MIN_REFRESH_SECONDS = 5;

function setupAutoRefresh() {
  const toggle = document.getElementById('autoRefresh');
  const loop = document.getElementById('refreshLoop');
  loop.min = MIN_REFRESH_SECONDS;
  loop.value = Math.max(MIN_REFRESH_SECONDS, Math.round(refreshSeconds) || 15);
  toggle.checked = refreshSeconds > 0;
  document.getElementById('refreshBtn').onclick = () => loadSection(currentSection);
  toggle.onchange = restartAutoRefresh;
  loop.onchange = () => {
    const v = parseInt(loop.value, 10);
    loop.value = Number.isInteger(v) && v >= MIN_REFRESH_SECONDS ? v : MIN_REFRESH_SECONDS;
    restartAutoRefresh();
  };
  restartAutoRefresh();
}

// Always clears the previous timer first, so there is never more than one running.
function restartAutoRefresh() {
  clearInterval(refreshInterval);
  refreshInterval = null;
  const loop = document.getElementById('refreshLoop');
  loop.disabled = !document.getElementById('autoRefresh').checked;
  if (loop.disabled) return;
  refreshInterval = setInterval(() => loadSection(currentSection), parseInt(loop.value, 10) * 1000);
}

function dbParam() {
  return `db=${encodeURIComponent(currentDb)}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
