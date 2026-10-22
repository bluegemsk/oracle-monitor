let currentSection = 'health';
let currentDb = '';
let chart = null;
let refreshInterval = null;

async function init() {
  await loadDbs();
  setupTabs();
  setupAutoRefresh();
  loadSection('health');
}

async function loadDbs() {
  const res = await fetch('/api/dbs');
  const data = await res.json();
  const select = document.getElementById('dbSelect');
  select.innerHTML = data.dbs.map(d => `<option value="${d}">${d}</option>`).join('');
  select.value = data.current;
  currentDb = data.current;
  select.onchange = async () => {
    await fetch('/api/switch-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: select.value })
    });
    currentDb = select.value;
    loadSection(currentSection);
  };
}

async function loadSection(section) {
  const content = document.getElementById('content');
  const hint = document.getElementById('hint');
  const chartContainer = document.getElementById('chartContainer');
  content.innerHTML = '<p class="loading">Loading...</p>';
  hint.textContent = '';
  chartContainer.style.display = 'none';
  if (chart) { chart.destroy(); chart = null; }

  try {
    const res = await fetch(`/api/${section}`);
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json();
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

      let cell = escapeHtml(val);
      if ((c === 'SQL_ID' || c === 'sql_id') && val && /^[a-z0-9]{13}$/i.test(val)) {
        cell = `<a href="#" class="sql-link" data-sqlid="${val}">${cell}</a>`;
      }
      html += `<td class="${cls}">${cell}</td>`;
    });

    if (section === 'sessions') {
      html += `<td><button class="kill-btn small" data-sid="${row.SID}" data-serial="${row.SERIAL#}">Kill</button></td>`;
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
    modal.style.display = 'block';
    try {
      const res = await fetch(`/api/explain/${sqlId}`);
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
        body: JSON.stringify({ sid, serial })
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

function setupAutoRefresh() {
  refreshInterval = setInterval(() => loadSection(currentSection), 15000);
  document.getElementById('refreshBtn').onclick = () => loadSection(currentSection);
}

document.getElementById('logoutBtn').onclick = async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

init();
