/* ══════════════════════════════════════════
   OrangeHRM QA Analytics — app.js
   ══════════════════════════════════════════ */

/* ─── State ─── */
const State = {
  allRuns: [],
  filteredRuns: [],
  filters: {
    branch: '',
    env: '',
    testTags: [],   // multi-select array (was testType)
    userRole: '',
    status: '',
  },
  dateRangeDays: 0,
  passThreshold: 100,
  sort: { col: 'formattedDate', dir: 'desc' },
  tableSearch: '',
  charts: {},
  refreshTimer: null,
  countdown: 60,
  compareIds: new Set(),
};

/* ─── Utils ─── */
const Utils = {
  formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
  },
  formatDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString('en-ZA', { month: 'short', day: 'numeric' });
  },
  formatDuration(min) {
    if (min == null) return '—';
    if (min < 1) return `${Math.round(min * 60)}s`;
    const m = Math.floor(min), s = Math.round((min - m) * 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  },
  avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; },
  sum(arr) { return arr.reduce((a, b) => a + b, 0); },
  groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key] || 'unknown';
      (acc[k] = acc[k] || []).push(item);
      return acc;
    }, {});
  },
  unique(arr) { return [...new Set(arr)]; },
  pct(v) { return v != null ? `${Math.round(v)}%` : '—'; },
  escape(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

/* ─── Mock Data ─── */
const MOCK_DATA = (() => {
  const types = ['authenticate', 'regression', 'smoke', 'e2e', 'sanity', 'skip-auth', 'dashboard'];
  const branches = ['main', 'develop', 'release/2.1', 'environment/QA', '4/merge'];
  const envs = ['staging', 'production', 'qa', 'uat'];
  const roles = ['admin-user', 'general-user', 'unknown'];
  const failNames = [
    'Invalid Login Test Suite › should display invalid credentials error when submitting login form with incorrect username and password',
    'should display invalid credentials error when submitting login form with incorrect username and password',
    'PIM › add employee validates required fields',
    'Leave › submit leave request without dates',
    'Admin › change password enforces complexity',
  ];
  const byBranch = {};
  let rn = 1;
  branches.forEach(branch => {
    byBranch[branch] = { byTestType: {} };
    types.slice(0, 4).forEach(type => {
      const runs = [];
      for (let i = 0; i < 10; i++) {
        const date = new Date(Date.now() - (i * 2 + Math.random()) * 86400000);
        const total = Math.floor(Math.random() * 60) + 40;
        const failed = Math.random() > .72 ? Math.floor(Math.random() * 4) + 1 : 0;
        const skipped = Math.floor(Math.random() * 2);
        const flaky = Math.random() > .7 ? Math.floor(Math.random() * 2) + 1 : 0;
        const passed = total - failed - skipped;
        const passRate = Math.round((passed / total) * 100);
        const failedTests = [];
        for (let f = 0; f < failed; f++) {
          failedTests.push({
            name: failNames[f % failNames.length],
            classname: `layers/ui/login/InvalidLogin.spec.ts`,
            failureMessage: `expect(locator).toBeVisible() failed`,
          });
        }
        runs.push({
          runNumber: rn++, date: date.toISOString(), branch,
          env: envs[Math.floor(Math.random() * envs.length)],
          userRole: roles[Math.floor(Math.random() * roles.length)],
          passed, failed, skipped, flaky, total, passRate,
          durationMin: +(Math.random() * 6 + 1).toFixed(2),
          reportUrl: failed > 0 ? 'https://example.com/report' : null,
          allureUrl: 'https://example.com/allure',
          failedTests,
        });
      }
      byBranch[branch].byTestType[type] = { runs };
    });
  });
  return { byBranch };
})();

/* ─── Data ─── */
const DataModule = {
  URL: 'https://pub-1a2929fbcaf44458951bbb84b49b5f3f.r2.dev/orangehrm-automation/test-results-history.json',
  usingMock: false,

  async fetch() {
    try {
      const res = await window.fetch(DataModule.URL, { cache: 'no-store', mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      DataModule.usingMock = false;
      return await res.json();
    } catch (e) {
      DataModule.usingMock = true;
      DataModule.lastError = e.message;
      return MOCK_DATA;
    }
  },

  normalize(raw) {
    const runs = [];
    for (const [branch, bd] of Object.entries(raw.byBranch || {})) {
      for (const [testType, td] of Object.entries(bd.byTestType || bd || {})) {
        const rawRuns = Array.isArray(td) ? td : (td.runs || []);
        for (const run of rawRuns) {
          const passRate = run.passRate != null ? Number(run.passRate) : null;
          let durationMin = null;
          const rawD = run.durationMin ?? run.durationMs ?? run.duration ?? run.durationSec ?? null;
          if (rawD != null) {
            if (typeof rawD === 'number') {
              durationMin = run.durationMs != null && run.durationMin == null ? rawD / 60000 : rawD;
            } else {
              const s = String(rawD).trim();
              const mm = s.match(/(\d+(?:\.\d+)?)\s*m/);
              const sm = s.match(/(\d+(?:\.\d+)?)\s*s/);
              durationMin = (mm ? parseFloat(mm[1]) : 0) + (sm ? parseFloat(sm[1]) / 60 : 0) || parseFloat(s) || null;
            }
          }
          runs.push({
            ...run,
            branch: run.branch || branch,
            testType: run.testType || testType,
            passRate, durationMin,
            failed: Number(run.failed ?? 0),
            passed: Number(run.passed ?? 0),
            skipped: Number(run.skipped ?? 0),
            flaky: Number(run.flaky ?? 0),
            total: Number(run.total ?? 0),
            userRole: run.userRole || run.role || run.triggeredBy || 'unknown',
            failedTests: Array.isArray(run.failedTests) ? run.failedTests : [],
            formattedDate: Utils.formatDate(run.date),
            _dateMs: run.date ? new Date(run.date).getTime() : 0,
          });
        }
      }
    }
    return runs.sort((a, b) => b._dateMs - a._dateMs);
  },
};

/* ─── Dropdown Module ─── */
const DropdownModule = {
  /** Toggle open/close for a dropdown by wrapper id */
  toggle(wrapperId) {
    const wrap = document.getElementById(wrapperId);
    if (!wrap) return;
    const isOpen = wrap.classList.contains('open');
    // Close all
    document.querySelectorAll('.dropdown-wrap.open').forEach(w => w.classList.remove('open'));
    if (!isOpen) wrap.classList.add('open');
  },

  /** Close all dropdowns when clicking outside */
  closeAll(e) {
    if (!e.target.closest('.dropdown-wrap')) {
      document.querySelectorAll('.dropdown-wrap.open').forEach(w => w.classList.remove('open'));
    }
  },

  /** Build a single-select radio panel (branch, env, user) */
  buildRadioPanel(panelId, values, filterKey, labelId, allLabel) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = `<label class="dd-option"><input type="radio" name="${filterKey}" value="" ${!State.filters[filterKey] ? 'checked' : ''} /> ${allLabel}</label>`
      + Utils.unique(values.filter(Boolean)).sort().map(v =>
        `<label class="dd-option"><input type="radio" name="${filterKey}" value="${Utils.escape(v)}" ${State.filters[filterKey] === v ? 'checked' : ''} /> ${Utils.escape(v)}</label>`
      ).join('');

    panel.querySelectorAll(`input[name="${filterKey}"]`).forEach(input => {
      input.addEventListener('change', () => {
        State.filters[filterKey] = input.value;
        DropdownModule.updateSingleLabel(labelId, allLabel, input.value);
        DropdownModule.closeAll({ target: document.body });
        App.updateUI();
      });
    });
  },

  /** Build the multi-select checkbox panel for Test Tags */
  buildTagsPanel(values) {
    const panel = document.getElementById('dd-tags-panel');
    if (!panel) return;
    const sorted = Utils.unique(values.filter(Boolean)).sort();
    panel.innerHTML = sorted.map(v =>
      `<label class="dd-option">
        <input type="checkbox" name="filter-tag" value="${Utils.escape(v)}" ${State.filters.testTags.includes(v) ? 'checked' : ''} />
        <span class="pill pill-purple" style="pointer-events:none">@${Utils.escape(v)}</span>
      </label>`
    ).join('');

    panel.querySelectorAll('input[name="filter-tag"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = [...panel.querySelectorAll('input[name="filter-tag"]:checked')].map(c => c.value);
        State.filters.testTags = checked;
        DropdownModule.updateTagsLabel();
        App.updateUI();
        // Don't close panel so user can pick multiple
      });
    });
  },

  /** Update the label text for single-select dropdowns */
  updateSingleLabel(labelId, allLabel, value) {
    const el = document.getElementById(labelId);
    if (!el) return;
    el.textContent = value || allLabel;
    el.classList.toggle('active', !!value);
  },

  /** Update the Tags label to show selected chip count or names */
  updateTagsLabel() {
    const el = document.getElementById('dd-tags-label');
    if (!el) return;
    const tags = State.filters.testTags;
    if (!tags.length) {
      el.textContent = 'Filter Tags';
      el.classList.remove('active');
    } else if (tags.length <= 2) {
      el.innerHTML = tags.map(t => `<span class="dd-chip">@${Utils.escape(t)}</span>`).join(' ');
      el.classList.add('active');
    } else {
      el.innerHTML = `<span class="dd-chip">${tags.length} tags</span>`;
      el.classList.add('active');
    }
  },

  /** Rebuild all dropdown panels with current data */
  populate() {
    const runs = State.allRuns;
    this.buildRadioPanel('dd-branch-panel', runs.map(r => r.branch), 'branch', 'dd-branch-label', 'All Branches');
    this.buildRadioPanel('dd-env-panel', runs.map(r => r.env), 'env', 'dd-env-label', 'All Envs');
    this.buildTagsPanel(runs.map(r => r.testType));
    this.buildRadioPanel('dd-user-panel', runs.map(r => r.userRole), 'userRole', 'dd-user-label', 'All Users');

    // Status radio listeners
    document.querySelectorAll('input[name="filter-status"]').forEach(input => {
      input.addEventListener('change', () => {
        State.filters.status = input.value;
        DropdownModule.updateSingleLabel('dd-status-label', 'Filter Status', input.value ? (input.value === 'PASS' ? 'Passed' : 'Failed') : '');
        DropdownModule.closeAll({ target: document.body });
        App.updateUI();
      });
    });
  },
};

/* ─── Filters ─── */
const FilterModule = {
  apply() {
    const { branch, env, testTags, userRole, status } = State.filters;
    const cutoff = State.dateRangeDays > 0 ? Date.now() - State.dateRangeDays * 86400000 : 0;
    const thr = State.passThreshold;

    State.filteredRuns = State.allRuns
      .filter(r => {
        if (cutoff && r._dateMs < cutoff) return false;
        if (branch && r.branch !== branch) return false;
        if (env && r.env !== env) return false;
        if (testTags.length > 0 && !testTags.includes(r.testType)) return false;
        if (userRole && r.userRole !== userRole) return false;
        return true;
      })
      .map(r => ({
        ...r,
        status: (r.passRate != null && r.passRate >= thr) || (r.failed === 0 && r.passed > 0) ? 'PASS' : 'FAIL',
      }))
      .filter(r => {
        if (status && r.status !== status) return false;
        return true;
      });
  },

  syncDatePills() {
    document.querySelectorAll('.date-pill').forEach(p =>
      p.classList.toggle('active', Number(p.dataset.days) === State.dateRangeDays)
    );
  },
};

/* ─── Charts ─── */
const CHART_DEFAULTS = {
  plugins: {
    legend: { labels: { color: '#44495e', font: { family: 'DM Mono, monospace', size: 10 }, boxWidth: 7, padding: 10 } },
    tooltip: {
      backgroundColor: '#1a1d26', borderColor: '#ffffff17', borderWidth: 1,
      titleColor: '#f0f1f5', bodyColor: '#7c82a0',
      titleFont: { family: 'DM Sans, sans-serif', size: 11 },
      bodyFont: { family: 'DM Mono, monospace', size: 10 },
      padding: 8, cornerRadius: 5,
    },
  },
  scales: {
    x: { ticks: { color: '#44495e', font: { family: 'DM Mono, monospace', size: 9 }, maxRotation: 40, maxTicksLimit: 10 }, grid: { color: '#ffffff08' } },
    y: { ticks: { color: '#44495e', font: { family: 'DM Mono, monospace', size: 9 } }, grid: { color: '#ffffff08' } },
  },
};

const ChartModule = {
  destroy(id) { if (State.charts[id]) { State.charts[id].destroy(); delete State.charts[id]; } },
  create(id, cfg) {
    this.destroy(id);
    const canvas = document.getElementById(id);
    if (!canvas) return;
    State.charts[id] = new Chart(canvas, cfg);
  },
  labels(sorted) {
    return sorted.map((r, i) => {
      if (!r.date) return `#${r.runNumber ?? i + 1}`;
      return `#${r.runNumber ?? i + 1} ${Utils.formatDateShort(r.date)}`;
    });
  },
  ttTitle(sorted) {
    return items => {
      const r = sorted[items[0].dataIndex];
      return r ? `Run #${r.runNumber} · ${r.formattedDate}` : '';
    };
  },

  passRate(runs, id = 'chart-passrate') {
    const thr = State.passThreshold;
    const s = [...runs].sort((a, b) => a._dateMs - b._dateMs).slice(-40);
    this.create(id, {
      type: 'line',
      data: {
        labels: this.labels(s),
        datasets: [
          {
            label: 'Pass Rate %',
            data: s.map(r => r.passRate),
            borderColor: '#22d17b', backgroundColor: '#22d17b0c', fill: true, tension: .4,
            pointBackgroundColor: s.map(r => r.status === 'FAIL' ? '#f25f5c' : '#22d17b'),
            pointRadius: 3, pointHoverRadius: 5, borderWidth: 1.5,
          },
          {
            label: `Threshold ${thr}%`,
            data: s.map(() => thr),
            borderColor: '#f5c54266', borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false,
          },
        ],
      },
      options: {
        ...CHART_DEFAULTS, responsive: true,
        plugins: { ...CHART_DEFAULTS.plugins, tooltip: { ...CHART_DEFAULTS.plugins.tooltip, callbacks: { title: this.ttTitle(s) } } },
        scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => v + '%' } } },
      },
    });
  },

  failures(runs, id = 'chart-failures') {
    const s = [...runs].sort((a, b) => a._dateMs - b._dateMs).slice(-40);
    this.create(id, {
      type: 'bar',
      data: {
        labels: this.labels(s),
        datasets: [{
          label: 'Failures',
          data: s.map(r => r.failed),
          backgroundColor: s.map(r => r.failed > 0 ? '#f25f5c44' : '#22d17b22'),
          borderColor: s.map(r => r.failed > 0 ? '#f25f5c' : '#22d17b'),
          borderWidth: 1, borderRadius: 3,
        }],
      },
      options: {
        ...CHART_DEFAULTS, responsive: true,
        plugins: { ...CHART_DEFAULTS.plugins, tooltip: { ...CHART_DEFAULTS.plugins.tooltip, callbacks: { title: this.ttTitle(s) } } },
        scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, stepSize: 1, precision: 0 } } },
      },
    });
  },

  flaky(runs, id = 'chart-flaky') {
    const s = [...runs].sort((a, b) => a._dateMs - b._dateMs).slice(-40);
    this.create(id, {
      type: 'bar',
      data: {
        labels: this.labels(s),
        datasets: [{
          label: 'Flaky', data: s.map(r => r.flaky || 0),
          backgroundColor: '#f9731633', borderColor: '#f97316', borderWidth: 1, borderRadius: 3,
        }],
      },
      options: {
        ...CHART_DEFAULTS, responsive: true,
        scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, stepSize: 1, precision: 0 } } },
      },
    });
  },

  duration(runs, id = 'chart-duration') {
    const withDur = runs.filter(r => r.durationMin != null && r.durationMin > 0);
    const avg = Utils.avg(withDur.map(r => r.durationMin));
    const s = [...withDur].sort((a, b) => a._dateMs - b._dateMs).slice(-50);
    if (!s.length) return;
    this.create(id, {
      type: 'line',
      data: {
        labels: this.labels(s),
        datasets: [
          {
            label: 'Duration (min)', data: s.map(r => +r.durationMin.toFixed(2)),
            borderColor: '#4f8ef7', backgroundColor: '#4f8ef70a', fill: true, tension: .4,
            pointRadius: 2, pointHoverRadius: 5, borderWidth: 1.5,
          },
          {
            label: `Avg ${Utils.formatDuration(avg)}`, data: s.map(() => +avg.toFixed(2)),
            borderColor: '#4f8ef744', borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false,
          },
        ],
      },
      options: {
        ...CHART_DEFAULTS, responsive: true,
        scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => v + 'm' } } },
      },
    });
  },

  barAvgPass(runs, key, id) {
    const g = Utils.groupBy(runs, key);
    const labels = Object.keys(g).sort();
    const data = labels.map(k => Utils.avg(g[k].map(r => r.passRate || 0)).toFixed(1));
    const colors = data.map(v => +v >= 90 ? '#22d17b33' : +v >= 70 ? '#f5c54233' : '#f25f5c33');
    const borders = data.map(v => +v >= 90 ? '#22d17b' : +v >= 70 ? '#f5c542' : '#f25f5c');
    this.create(id, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Avg Pass Rate %', data, backgroundColor: colors, borderColor: borders, borderWidth: 1, borderRadius: 4 }] },
      options: { ...CHART_DEFAULTS, responsive: true, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => v + '%' } } } },
    });
  },

  barCount(runs, key, id) {
    const g = Utils.groupBy(runs, key);
    const labels = Object.keys(g).sort();
    const data = labels.map(k => g[k].length);
    const pal = ['#4f8ef7', '#22d17b', '#a78bfa', '#f5c542', '#f97316'];
    this.create(id, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Run Count', data, backgroundColor: labels.map((_, i) => pal[i % pal.length] + '33'), borderColor: labels.map((_, i) => pal[i % pal.length]), borderWidth: 1, borderRadius: 4 }] },
      options: { ...CHART_DEFAULTS, responsive: true },
    });
  },

  renderAll(runs) {
    this.passRate(runs, 'chart-passrate');
    this.failures(runs, 'chart-failures');
    this.flaky(runs, 'chart-flaky');
    this.passRate(runs, 'chart-passrate-full');
    this.failures(runs, 'chart-failures-full');
    this.flaky(runs, 'chart-flaky-full');
    this.duration(runs, 'chart-duration');
    this.barAvgPass(runs, 'testType', 'chart-bar-type');
    this.barAvgPass(runs, 'branch', 'chart-bar-branch');
    this.barCount(runs, 'env', 'chart-bar-env');
    this.barAvgPass(runs, 'userRole', 'chart-bar-user');
  },
};

/* ─── Summary ─── */
const SummaryModule = {
  render(runs) {
    const total = runs.length;
    const avgPass = Utils.avg(runs.map(r => r.passRate || 0));
    const totFail = Utils.sum(runs.map(r => r.failed));
    const totFlaky = Utils.sum(runs.map(r => r.flaky || 0));
    const avgDur = Utils.avg(runs.filter(r => r.durationMin != null).map(r => r.durationMin));
    const failing = runs.filter(r => r.status === 'FAIL').length;
    const passColor = avgPass >= State.passThreshold ? 'var(--green)' : avgPass >= 70 ? 'var(--yellow)' : 'var(--red)';
    const cards = [
      { label: 'Total Runs', value: total, sub: `${failing} failing`, icon: '▦', color: 'var(--blue)', bg: 'var(--blue-bg)' },
      { label: 'Avg Pass Rate', value: Utils.pct(avgPass), sub: `threshold ${State.passThreshold}%`, icon: '✓', color: passColor, bg: avgPass >= State.passThreshold ? 'var(--green-bg)' : avgPass >= 70 ? 'var(--yellow-bg)' : 'var(--red-bg)' },
      { label: 'Total Failures', value: totFail, sub: 'test cases', icon: '✗', color: totFail === 0 ? 'var(--green)' : 'var(--red)', bg: totFail === 0 ? 'var(--green-bg)' : 'var(--red-bg)' },
      { label: 'Flaky Tests', value: totFlaky, sub: 'across runs', icon: '⚡', color: totFlaky === 0 ? 'var(--green)' : 'var(--orange)', bg: totFlaky === 0 ? 'var(--green-bg)' : 'var(--orange-bg)' },
      { label: 'Avg Duration', value: Utils.formatDuration(avgDur), sub: 'per run', icon: '⏱', color: 'var(--purple)', bg: '#a78bfa12' },
    ];
    document.getElementById('summary-cards').innerHTML = cards.map(c => `
      <div class="summary-card">
        <div class="s-accent-line" style="background:${c.color}"></div>
        <div class="s-label">${c.label}</div>
        <div class="s-value" style="color:${c.color}">${Utils.escape(String(c.value))}</div>
        <div class="s-sub">${c.sub}</div>
        <div class="s-icon" style="background:${c.bg};color:${c.color}">${c.icon}</div>
      </div>`).join('');
  },
};

/* ─── Breakdown ─── */
const BreakdownModule = {
  render(runs, key, id) {
    const g = Utils.groupBy(runs, key);
    const rows = Object.entries(g)
      .map(([k, items]) => ({ k, avg: Utils.avg(items.map(r => r.passRate || 0)), n: items.length }))
      .sort((a, b) => b.avg - a.avg);
    document.getElementById(id).innerHTML = rows.map(r => {
      const c = r.avg >= State.passThreshold ? '#22d17b' : r.avg >= 70 ? '#f5c542' : '#f25f5c';
      return `<div class="stat-bar-item">
        <div class="sb-label" title="${Utils.escape(r.k)}">${Utils.escape(r.k)}</div>
        <div class="sb-track"><div class="sb-fill" style="width:${r.avg.toFixed(1)}%;background:${c}"></div></div>
        <div class="sb-val">${Utils.pct(r.avg)}</div>
      </div>`;
    }).join('');
  },
  renderAll(runs) {
    this.render(runs, 'testType', 'breakdown-type');
    this.render(runs, 'branch', 'breakdown-branch');
    this.render(runs, 'env', 'breakdown-env');
    this.render(runs, 'userRole', 'breakdown-user');
  },
};

/* ─── Top Failing ─── */
const TopFailingModule = {
  render(runs) {
    const sub = document.getElementById('top-failing-sub');
    const list = document.getElementById('top-failing-list');
    const hasPerTest = runs.some(r => r.failedTests && r.failedTests.length > 0);
    if (hasPerTest) {
      const counts = {};
      runs.forEach(r => (r.failedTests || []).forEach(t => {
        if (!counts[t.name]) counts[t.name] = { name: t.name, classname: t.classname, msg: t.failureMessage, count: 0 };
        counts[t.name].count++;
      }));
      const sorted = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 8);
      sub.textContent = `${sorted.length} distinct · ${runs.filter(r => r.failed > 0).length} failing runs`;
      list.innerHTML = sorted.length === 0
        ? `<div class="failing-empty">✓ No test failures in this window</div>`
        : sorted.map((t, i) => `<div class="failing-item">
          <div class="failing-rank ${i < 2 ? 'hot' : ''}">${i + 1}</div>
          <div style="flex:1;min-width:0">
            <div class="failing-name" title="${Utils.escape(t.name)}">${Utils.escape(t.name)}</div>
            <div class="failing-file">${Utils.escape(t.classname || '')}</div>
            ${t.msg ? `<div class="failing-msg" title="${Utils.escape(t.msg)}">${Utils.escape(t.msg.split('\n')[0])}</div>` : ''}
          </div>
          <div class="failing-badge">${t.count}×</div>
        </div>`).join('');
    } else {
      const worst = [...runs].filter(r => r.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 6);
      sub.textContent = 'run-level data';
      list.innerHTML = worst.length === 0
        ? `<div class="failing-empty">✓ No failures in this window</div>`
        : worst.map((r, i) => `<div class="failing-item">
          <div class="failing-rank ${i < 2 ? 'hot' : ''}">${i + 1}</div>
          <div style="flex:1;min-width:0">
            <div class="failing-name">Run #${r.runNumber} · ${Utils.escape(r.branch)} / ${Utils.escape(r.testType)}</div>
            <div class="failing-file">${r.formattedDate} · ${Utils.escape(r.env)}</div>
          </div>
          <div class="failing-badge">${r.failed} fails</div>
        </div>`).join('');
    }
  },
};

/* ─── Table ─── */
const TableModule = {
  render() {
    const search = State.tableSearch.toLowerCase();
    const avgDur = Utils.avg(State.filteredRuns.filter(r => r.durationMin != null && r.durationMin > 0).map(r => r.durationMin));
    const outlier = avgDur * 1.5;
    let rows = State.filteredRuns.filter(r => {
      if (!search) return true;
      return [r.branch, r.testType, r.env, r.runNumber, r.formattedDate].some(v => String(v || '').toLowerCase().includes(search));
    });
    const { col, dir } = State.sort;
    rows = rows.sort((a, b) => {
      let av = a[col], bv = b[col];
      if (col === 'formattedDate') { av = a._dateMs; bv = b._dateMs; }
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      return av < bv ? (dir === 'asc' ? -1 : 1) : av > bv ? (dir === 'asc' ? 1 : -1) : 0;
    });
    document.getElementById('table-count').textContent = `${rows.length} runs`;
    const rClass = r => r.passRate >= State.passThreshold ? 'high' : r.passRate >= 70 ? 'mid' : 'low';
    document.getElementById('runs-tbody').innerHTML = rows.map(r => {
      const sel = State.compareIds.has(r.runNumber);
      const isOutlier = avgDur > 0 && r.durationMin != null && r.durationMin > outlier;
      const rLink = r.reportUrl
        ? `<a href="${Utils.escape(r.reportUrl)}" target="_blank" class="link-btn">Report</a>`
        : `<span class="link-btn disabled">Report</span>`;
      const aLink = r.allureUrl
        ? `<a href="${Utils.escape(r.allureUrl)}" target="_blank" class="link-btn">Allure</a>`
        : `<span class="link-btn disabled">Allure</span>`;
      return `<tr class="${r.status === 'FAIL' ? 'row-fail' : ''}${sel ? ' row-compare' : ''}">
        <td><input type="checkbox" class="cmp-cb" ${sel ? 'checked' : ''} ${!sel && State.compareIds.size >= 2 ? 'disabled' : ''} onchange="CompareModule.toggle(${r.runNumber},this.checked)"/></td>
        <td class="mono">#${r.runNumber ?? '—'}</td>
        <td class="mono col-hide">${r.formattedDate}</td>
        <td class="mono">${Utils.escape(r.branch || '—')}</td>
        <td class="col-hide"><span class="pill pill-purple">@${Utils.escape(r.testType || '—')}</span></td>
        <td class="col-hide"><span class="pill pill-orange">${Utils.escape(r.userRole || '—')}</span></td>
        <td class="col-hide"><span class="pill pill-blue">${Utils.escape(r.env || '—')}</span></td>
        <td>
          <div class="rate-bar">
            <div class="rate-track"><div class="rate-fill ${rClass(r)}" style="width:${r.passRate ?? 0}%"></div></div>
            <span class="mono">${Utils.pct(r.passRate)}</span>
          </div>
        </td>
        <td class="mono" style="color:${r.failed > 0 ? 'var(--red)' : 'var(--green)'}">${r.failed}</td>
        <td class="mono col-hide" style="color:${(r.flaky || 0) > 0 ? 'var(--orange)' : 'var(--text-3)'}">${r.flaky || 0}</td>
        <td class="mono col-hide">${Utils.formatDuration(r.durationMin)}${isOutlier ? ' <span class="badge badge-skip" style="font-size:9px">slow</span>' : ''}</td>
        <td><span class="badge badge-${r.status === 'PASS' ? 'pass' : 'fail'}">${r.status}</span></td>
        <td class="col-hide"><div class="links-cell">${rLink}${aLink}</div></td>
      </tr>`;
    }).join('');
    document.querySelectorAll('#runs-table thead th[data-col]').forEach(th => {
      th.classList.toggle('sorted', th.dataset.col === col);
      const a = th.textContent.replace(/[↑↓↕]/g, '').trim();
      th.textContent = a + ' ' + (th.dataset.col === col ? (dir === 'asc' ? '↑' : '↓') : '');
    });
  },
};

/* ─── Compare ─── */
const CompareModule = {
  toggle(rn, checked) {
    if (checked) { if (State.compareIds.size >= 2) return; State.compareIds.add(rn); }
    else State.compareIds.delete(rn);
    TableModule.render();
    this.updateBar();
  },
  clear() { State.compareIds.clear(); TableModule.render(); this.updateBar(); },
  updateBar() {
    const n = State.compareIds.size;
    document.getElementById('compare-bar').classList.toggle('hidden', n === 0);
    document.getElementById('cmp-count').textContent = n;
    const btn = document.getElementById('compare-btn');
    btn.disabled = n !== 2;
    btn.style.opacity = n === 2 ? '1' : '0.5';
  },
  open() {
    if (State.compareIds.size !== 2) return;
    const runs = [...State.compareIds].map(id => State.filteredRuns.find(r => r.runNumber === id)).filter(Boolean);
    if (runs.length < 2) return;
    const [a, b] = runs;
    const field = (label, va, vb, hb = null) => {
      let cA = '', cB = '';
      const na = parseFloat(va), nb = parseFloat(vb);
      if (hb !== null && !isNaN(na) && !isNaN(nb) && na !== nb) {
        cA = hb ? na > nb ? 'better' : 'worse' : na < nb ? 'better' : 'worse';
        cB = hb ? na > nb ? 'worse' : 'better' : na < nb ? 'worse' : 'better';
      }
      return `<tr><td>${label}</td><td class="${cA}">${Utils.escape(String(va))}</td><td class="${cB}">${Utils.escape(String(vb))}</td></tr>`;
    };
    const failList = r => {
      if (!r.failedTests || !r.failedTests.length) return r.failed > 0
        ? `<div style="color:var(--text-3);font-size:10px;font-family:var(--mono)">No per-test data</div>`
        : `<div style="color:var(--green);font-size:10px;font-family:var(--mono)">✓ All passed</div>`;
      return r.failedTests.slice(0, 5).map(t =>
        `<div style="font-size:10px;font-family:var(--mono);color:var(--text-2);padding:3px 0;border-bottom:1px solid var(--border)">✗ ${Utils.escape(t.name)}</div>`
      ).join('') + (r.failedTests.length > 5
        ? `<div style="font-size:10px;color:var(--text-3);padding:3px 0;font-family:var(--mono)">…+${r.failedTests.length - 5} more</div>` : '');
    };
    document.getElementById('compare-modal-body').innerHTML = `
      <table class="cmp-table" style="margin-bottom:16px">
        <tr><th>Metric</th><th>Run #${a.runNumber}</th><th>Run #${b.runNumber}</th></tr>
        ${field('Date', a.formattedDate, b.formattedDate)}
        ${field('Branch', a.branch || '—', b.branch || '—')}
        ${field('Tag', a.testType || '—', b.testType || '—')}
        ${field('Env', a.env || '—', b.env || '—')}
        ${field('Pass Rate', Utils.pct(a.passRate), Utils.pct(b.passRate), true)}
        ${field('Passed', a.passed, b.passed, true)}
        ${field('Failed', a.failed, b.failed, false)}
        ${field('Flaky', a.flaky || 0, b.flaky || 0, false)}
        ${field('Duration', Utils.formatDuration(a.durationMin), Utils.formatDuration(b.durationMin), false)}
        ${field('Status', a.status, b.status)}
      </table>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><div style="font-size:10px;font-weight:600;color:var(--accent);font-family:var(--mono);margin-bottom:8px">FAILED — Run #${a.runNumber}</div>${failList(a)}</div>
        <div><div style="font-size:10px;font-weight:600;color:var(--accent);font-family:var(--mono);margin-bottom:8px">FAILED — Run #${b.runNumber}</div>${failList(b)}</div>
      </div>`;
    document.getElementById('compare-modal').classList.add('open');
  },
  close() { document.getElementById('compare-modal').classList.remove('open'); },
};

/* ─── Export ─── */
const ExportModule = {
  download(runs) {
    const cols = ['runNumber', 'date', 'branch', 'testType', 'userRole', 'env', 'passRate', 'passed', 'failed', 'skipped', 'flaky', 'total', 'durationMin', 'status'];
    const csv = [
      cols.join(','),
      ...runs.map(r => cols.map(c => {
        const v = String(r[c] ?? '');
        return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')),
    ].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `test-results-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },
};

/* ─── Nav ─── */
const NavModule = {
  current: 'overview',
  show(page) {
    this.current = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    const el = document.getElementById(`page-${page}`);
    if (el) { el.classList.add('active'); el.classList.remove('fade-in'); void el.offsetWidth; el.classList.add('fade-in'); }
    if (['trends', 'breakdown'].includes(page)) setTimeout(() => ChartModule.renderAll(State.filteredRuns), 50);
  },
};

/* ─── Timer ─── */
const TimerModule = {
  start() {
    clearInterval(State.refreshTimer);
    State.countdown = 60;
    State.refreshTimer = setInterval(() => {
      State.countdown--;
      const el = document.getElementById('countdown');
      if (el) el.textContent = `Refresh in ${State.countdown}s`;
      if (State.countdown <= 0) App.refresh();
    }, 1000);
  },
};

/* ─── Mobile Module ─── */
const MobileModule = {
  openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('visible');
    document.body.style.overflow = 'hidden';
  },
  closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
    document.body.style.overflow = '';
  },
  toggleFilterSheet() {
    const sheet = document.getElementById('filter-sheet');
    const overlay = document.getElementById('filter-sheet-overlay');
    const isOpen = sheet.classList.contains('open');
    if (isOpen) {
      this.closeFilterSheet();
    } else {
      sheet.classList.add('open');
      overlay.classList.add('visible');
      document.body.style.overflow = 'hidden';
    }
  },
  closeFilterSheet() {
    document.getElementById('filter-sheet').classList.remove('open');
    document.getElementById('filter-sheet-overlay').classList.remove('visible');
    document.body.style.overflow = '';
  },
  clearFilters() {
    State.filters = { branch: '', env: '', testTags: [], userRole: '', status: '' };
    State.dateRangeDays = 0;
    // Reset all radios/checkboxes in sheet
    document.querySelectorAll('#filter-sheet input[type=radio][value=""]').forEach(r => r.checked = true);
    document.querySelectorAll('#filter-sheet input[type=checkbox]').forEach(c => c.checked = false);
    document.querySelectorAll('.date-pill').forEach(p => p.classList.toggle('active', p.dataset.days === '0'));
    DropdownModule.updateTagsLabel();
    App.updateUI();
  },

  /** Build filter sheet panels (called after data loads) */
  populateSheet() {
    const runs = State.allRuns;
    this._buildSheetRadio('fs-branch-panel', Utils.unique(runs.map(r => r.branch)).sort(), 'branch', 'filter-status-branch');
    this._buildSheetRadio('fs-env-panel', Utils.unique(runs.map(r => r.env)).sort(), 'env', 'filter-status-env');
    this._buildSheetRadio('fs-user-panel', Utils.unique(runs.map(r => r.userRole)).sort(), 'userRole', 'filter-status-user');
    this._buildSheetCheckbox('fs-tags-panel', Utils.unique(runs.map(r => r.testType)).sort());

    // Status radios
    document.querySelectorAll('input[name="filter-status-m"]').forEach(input => {
      input.addEventListener('change', () => {
        State.filters.status = input.value;
        // sync desktop dropdown label
        DropdownModule.updateSingleLabel('dd-status-label', 'Filter Status',
          input.value ? (input.value === 'PASS' ? 'Passed' : 'Failed') : '');
        App.updateUI();
      });
    });

    // Mobile date pills
    document.querySelectorAll('#date-group-mobile .date-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        State.dateRangeDays = Number(btn.dataset.days);
        // sync both pill groups
        document.querySelectorAll('.date-pill').forEach(p =>
          p.classList.toggle('active', Number(p.dataset.days) === State.dateRangeDays)
        );
        App.updateUI();
      });
    });

    // Mobile threshold
    document.getElementById('pass-threshold-m')?.addEventListener('input', e => {
      State.passThreshold = Number(e.target.value);
      document.getElementById('threshold-val-m').textContent = `${State.passThreshold}%`;
      // sync desktop slider
      const desk = document.getElementById('pass-threshold');
      if (desk) desk.value = State.passThreshold;
      document.getElementById('threshold-val').textContent = `${State.passThreshold}%`;
      App.updateUI();
    });
  },

  _buildSheetRadio(panelId, values, filterKey, radioName) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = `<label class="dd-option"><input type="radio" name="${radioName}" value="" checked /> All</label>`
      + values.filter(Boolean).map(v =>
        `<label class="dd-option"><input type="radio" name="${radioName}" value="${Utils.escape(v)}" /> ${Utils.escape(v)}</label>`
      ).join('');
    panel.querySelectorAll(`input[name="${radioName}"]`).forEach(input => {
      input.addEventListener('change', () => {
        State.filters[filterKey] = input.value;
        // sync desktop dropdown label
        const labelMap = { branch: 'dd-branch-label', env: 'dd-env-label', userRole: 'dd-user-label' };
        const allMap   = { branch: 'All Branches', env: 'All Envs', userRole: 'All Users' };
        if (labelMap[filterKey]) DropdownModule.updateSingleLabel(labelMap[filterKey], allMap[filterKey], input.value);
        App.updateUI();
      });
    });
  },

  _buildSheetCheckbox(panelId, values) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = values.filter(Boolean).map(v =>
      `<label class="dd-option">
        <input type="checkbox" name="filter-tag-m" value="${Utils.escape(v)}" ${State.filters.testTags.includes(v) ? 'checked' : ''} />
        <span class="pill pill-purple" style="pointer-events:none">@${Utils.escape(v)}</span>
      </label>`
    ).join('');
    panel.querySelectorAll('input[name="filter-tag-m"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = [...panel.querySelectorAll('input[name="filter-tag-m"]:checked')].map(c => c.value);
        State.filters.testTags = checked;
        DropdownModule.updateTagsLabel();
        App.updateUI();
      });
    });
  },
};


const App = {
  async init() {
    // Mobile bottom nav
    document.querySelectorAll('.mbn-item').forEach(btn => {
      btn.addEventListener('click', () => {
        NavModule.show(btn.dataset.page);
        // sync bottom nav active state
        document.querySelectorAll('.mbn-item').forEach(b => b.classList.toggle('active', b === btn));
        // also close sidebar if open
        MobileModule.closeSidebar();
      });
    });

    // Sidebar nav items also close the drawer on mobile
    document.querySelectorAll('.nav-item').forEach(n => {
      n.addEventListener('click', () => {
        NavModule.show(n.dataset.page);
        // sync bottom nav
        document.querySelectorAll('.mbn-item').forEach(b => b.classList.toggle('active', b.dataset.page === n.dataset.page));
        MobileModule.closeSidebar();
      });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', e => DropdownModule.closeAll(e));

    // Date pills
    document.querySelectorAll('.date-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        State.dateRangeDays = Number(btn.dataset.days);
        FilterModule.syncDatePills();
        App.updateUI();
      });
    });

    // Pass threshold
    document.getElementById('pass-threshold')?.addEventListener('input', e => {
      State.passThreshold = Number(e.target.value);
      document.getElementById('threshold-val').textContent = `${State.passThreshold}%`;
      App.updateUI();
    });

    // Header search (mirrors to table search)
    document.getElementById('header-search')?.addEventListener('input', e => {
      State.tableSearch = e.target.value;
      TableModule.render();
    });

    // Table search
    document.getElementById('table-search')?.addEventListener('input', e => {
      State.tableSearch = e.target.value;
      TableModule.render();
    });

    // Table sort
    document.querySelectorAll('#runs-table thead th[data-col]').forEach(th => {
      th.addEventListener('click', () => {
        const c = th.dataset.col;
        if (State.sort.col === c) State.sort.dir = State.sort.dir === 'asc' ? 'desc' : 'asc';
        else { State.sort.col = c; State.sort.dir = 'asc'; }
        TableModule.render();
      });
    });

    await this.refresh();
  },

  async refresh() {
    this.showLoading(true);
    TimerModule.start();
    try {
      const raw = await DataModule.fetch();
      State.allRuns = DataModule.normalize(raw);
      DropdownModule.populate();
      MobileModule.populateSheet();
      this.updateUI();
      document.getElementById('last-updated').textContent =
        (DataModule.usingMock ? '⚠ Mock · ' : '') + 'Updated ' + new Date().toLocaleTimeString('en-ZA');
      const banner = document.getElementById('mock-banner');
      if (DataModule.usingMock) {
        banner.style.display = 'flex';
        document.getElementById('mock-error-detail').textContent = `(${DataModule.lastError})`;
      } else {
        banner.style.display = 'none';
      }
      this.showLoading(false);
    } catch (e) {
      console.error(e);
      document.getElementById('loading-state').style.display = 'none';
      document.getElementById('error-state').style.display = 'flex';
      document.getElementById('error-message').textContent = `Failed to load: ${e.message}`;
    }
  },

  updateUI() {
    FilterModule.apply();
    const runs = State.filteredRuns;
    SummaryModule.render(runs);
    ChartModule.renderAll(runs);
    BreakdownModule.renderAll(runs);
    TopFailingModule.render(runs);
    TableModule.render();
  },

  exportCSV() { ExportModule.download(State.filteredRuns); },

  showLoading(visible) {
    document.getElementById('loading-state').style.display = visible ? 'flex' : 'none';
    document.getElementById('error-state').style.display = 'none';
    document.querySelectorAll('.page').forEach(p =>
      p.classList.toggle('active', !visible && p.id === `page-${NavModule.current}`)
    );
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
