/* ══════════════════════════════════════════
   OrangeHRM QA Analytics — app.js
   ══════════════════════════════════════════ */

/* ─── State ─── */
const State = {
  allRuns: [],
  filteredRuns: [],
  visualSection: 'quality',
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
  expandedRuns: new Set(),
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
  delta(curr, prev) {
    if (curr == null || prev == null) return null;
    return +(curr - prev).toFixed(1);
  },
  deltaLabel(delta, suffix = '%') {
    if (delta == null || Number.isNaN(delta)) return 'No prior baseline';
    const rounded = Math.abs(delta) >= 10 ? Math.round(delta) : delta.toFixed(1).replace(/\.0$/, '');
    return `${delta > 0 ? '+' : ''}${rounded}${suffix}`;
  },
  ratio(part, total) {
    return total > 0 ? (part / total) * 100 : 0;
  },
  clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  },
  titleCase(value) {
    return String(value || 'Unknown')
      .replace(/[-_/]+/g, ' ')
      .replace(/\b\w/g, ch => ch.toUpperCase());
  },
  formatDateOnly(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleDateString('en-ZA', { dateStyle: 'medium' });
  },
  matchesSearch(run, search) {
    if (!search) return true;
    const haystacks = [
      run.branch,
      run.testType,
      run.env,
      run.userRole,
      run.runNumber,
      run.formattedDate,
      run.status,
      ...(run.failedTests || []).flatMap(t => [t.name, t.classname, t.failureMessage]),
    ];
    return haystacks.some(v => String(v || '').toLowerCase().includes(search));
  },
};

const AnalyticsModule = {
  criticalTags: new Set(['smoke', 'sanity', 'critical', 'authenticate']),

  splitRuns(runs) {
    const ordered = [...runs].sort((a, b) => b._dateMs - a._dateMs);
    const midpoint = Math.max(1, Math.floor(ordered.length / 2));
    return {
      current: ordered.slice(0, midpoint),
      previous: ordered.slice(midpoint),
    };
  },

  classifyFailure(test = {}) {
    const haystack = `${test.name || ''} ${test.classname || ''} ${test.failureMessage || ''}`.toLowerCase();
    if (/(api|request|response|endpoint|graphql)/.test(haystack)) return 'API';
    if (/(auth|login|logout|password|session|credential|token)/.test(haystack)) return 'Auth';
    if (/(data|fixture|db|database|employee|record|seed|sync)/.test(haystack)) return 'Data';
    if (/(ui|locator|page|modal|button|form|dashboard|grid|table|click|visible)/.test(haystack)) return 'UI';
    return 'Workflow';
  },

  moduleName(test = {}) {
    const raw = test.classname || test.name || 'unknown';
    const normalized = String(raw).replace(/\\/g, '/').toLowerCase();
    const parts = normalized.split('/').filter(Boolean);
    const specLike = parts.find(part => part.includes('.spec'));
    const base = specLike
      ? specLike.replace(/\.[^.]+$/, '').replace(/\.spec$/i, '')
      : parts.reverse().find(part => !part.includes('.')) || parts[parts.length - 1] || 'unknown';
    return Utils.titleCase(base || 'unknown');
  },

  countFailuresBy(runs, mapper) {
    const map = {};
    runs.forEach(run => {
      (run.failedTests || []).forEach(test => {
        const key = mapper(test, run) || 'Unknown';
        map[key] = (map[key] || 0) + 1;
      });
    });
    return Object.entries(map)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  },

  summarize(runs) {
    const ordered = [...runs].sort((a, b) => b._dateMs - a._dateMs);
    const latest = ordered[0] || null;
    const avgPass = Utils.avg(runs.map(r => r.passRate || 0));
    const avgFailures = Utils.avg(runs.map(r => r.failed || 0));
    const failingRuns = runs.filter(r => r.status === 'FAIL').length;
    const totalFailures = Utils.sum(runs.map(r => r.failed || 0));
    const totalFlaky = Utils.sum(runs.map(r => r.flaky || 0));
    const flakyRunShare = Utils.ratio(runs.filter(r => (r.flaky || 0) > 0).length, runs.length);
    const criticalRuns = runs.filter(r => this.criticalTags.has(String(r.testType || '').toLowerCase()));
    const criticalFailingRuns = criticalRuns.filter(r => r.status === 'FAIL').length;
    const passPenalty = 100 - avgPass;
    const failPenalty = Utils.clamp(avgFailures * 7, 0, 28);
    const flakyPenalty = Utils.clamp(flakyRunShare * 0.35, 0, 16);
    const criticalPenalty = criticalFailingRuns > 0 ? 18 : 0;
    const releaseScore = Math.round(Utils.clamp(100 - passPenalty - failPenalty - flakyPenalty - criticalPenalty, 0, 100));
    const releaseStatus = releaseScore >= 90 && criticalFailingRuns === 0
      ? 'Ready to Release'
      : releaseScore >= 75 && criticalFailingRuns === 0
        ? 'Release With Caution'
        : 'Hold Release';
    const decisionTone = releaseStatus === 'Ready to Release' ? 'good' : releaseStatus === 'Release With Caution' ? 'warn' : 'bad';
    const windows = this.splitRuns(runs);
    const currentAvgPass = Utils.avg(windows.current.map(r => r.passRate || 0));
    const previousAvgPass = Utils.avg(windows.previous.map(r => r.passRate || 0));
    const currentAvgFailures = Utils.avg(windows.current.map(r => r.failed || 0));
    const previousAvgFailures = Utils.avg(windows.previous.map(r => r.failed || 0));
    const currentFlakyShare = Utils.ratio(windows.current.filter(r => (r.flaky || 0) > 0).length, windows.current.length);
    const previousFlakyShare = Utils.ratio(windows.previous.filter(r => (r.flaky || 0) > 0).length, windows.previous.length);
    const categoryCounts = this.countFailuresBy(runs, test => this.classifyFailure(test));
    const moduleCounts = this.countFailuresBy(runs, test => this.moduleName(test));
    const topCategory = categoryCounts[0] || null;
    const topModule = moduleCounts[0] || null;

    return {
      latest,
      avgPass,
      avgFailures,
      failingRuns,
      totalFailures,
      totalFlaky,
      flakyRunShare,
      criticalRuns,
      criticalFailingRuns,
      releaseScore,
      releaseStatus,
      decisionTone,
      passDelta: Utils.delta(currentAvgPass, previousAvgPass),
      failureDelta: Utils.delta(currentAvgFailures, previousAvgFailures),
      flakyDelta: Utils.delta(currentFlakyShare, previousFlakyShare),
      categoryCounts,
      moduleCounts,
      topCategory,
      topModule,
      categoryShare: topCategory ? Utils.ratio(topCategory.count, Math.max(1, categoryCounts.reduce((sum, item) => sum + item.count, 0))) : 0,
      moduleShare: topModule ? Utils.ratio(topModule.count, Math.max(1, moduleCounts.reduce((sum, item) => sum + item.count, 0))) : 0,
    };
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
    const search = State.tableSearch.trim().toLowerCase();

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
        if (!Utils.matchesSearch(r, search)) return false;
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
    legend: {
      position: 'bottom',
      align: 'start',
      labels: {
        color: '#7c82a0',
        font: { family: 'DM Mono, monospace', size: 10 },
        boxWidth: 10,
        boxHeight: 10,
        usePointStyle: true,
        pointStyle: 'rectRounded',
        padding: 16,
      },
    },
    tooltip: {
      backgroundColor: '#1a1d26', borderColor: '#ffffff17', borderWidth: 1,
      titleColor: '#f0f1f5', bodyColor: '#7c82a0',
      titleFont: { family: 'DM Sans, sans-serif', size: 11 },
      bodyFont: { family: 'DM Mono, monospace', size: 10 },
      padding: 8, cornerRadius: 5,
    },
  },
  layout: {
    padding: { top: 6, right: 6, bottom: 2, left: 2 },
  },
  scales: {
    x: { ticks: { color: '#44495e', font: { family: 'DM Mono, monospace', size: 9 }, maxRotation: 40, maxTicksLimit: 10 }, grid: { color: '#ffffff08' } },
    y: { ticks: { color: '#44495e', font: { family: 'DM Mono, monospace', size: 9 } }, grid: { color: '#ffffff08' } },
  },
};

const CHART_COLORS = {
  pass: '#22d17b',
  passFill: '#22d17b24',
  fail: '#f25f5c',
  failFill: '#f25f5c3d',
  flaky: '#f5c542',
  flakyFill: '#f5c54233',
  skipped: '#c1c7d6',
  skippedFill: '#c1c7d633',
  duration: '#4f8ef7',
  durationFill: '#4f8ef71f',
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
    const isTrendsView = id === 'chart-passrate-full';
    this.create(id, {
      type: 'line',
      data: {
        labels: this.labels(s),
        datasets: [
          {
            label: 'Pass Rate %',
            data: s.map(r => r.passRate),
            borderColor: CHART_COLORS.pass,
            backgroundColor: CHART_COLORS.passFill,
            fill: true,
            tension: .35,
            pointBackgroundColor: s.map(r => r.status === 'FAIL' ? CHART_COLORS.fail : CHART_COLORS.pass),
            pointBorderColor: '#0e0f13',
            pointBorderWidth: 1.5,
            pointRadius: isTrendsView ? 4 : 3,
            pointHoverRadius: isTrendsView ? 6 : 5,
            borderWidth: isTrendsView ? 2 : 1.5,
          },
          {
            label: `Threshold ${thr}%`,
            data: s.map(() => thr),
            borderColor: `${CHART_COLORS.flaky}99`, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false,
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
    const isTrendsView = id === 'chart-failures-full';
    if (isTrendsView) {
      const totals = s.map(r => Math.max(1, (r.passed || 0) + (r.failed || 0) + (r.flaky || 0) + (r.skipped || 0)));
      const asPct = (value, idx) => +((value / totals[idx]) * 100).toFixed(1);
      this.create(id, {
        type: 'bar',
        data: {
          labels: this.labels(s),
          datasets: [
            {
              label: 'Passed',
              data: s.map((r, i) => asPct(r.passed || 0, i)),
              backgroundColor: CHART_COLORS.passFill,
              borderColor: CHART_COLORS.pass,
              borderWidth: 1,
              borderRadius: 3,
              borderSkipped: false,
              stack: 'outcomes',
            },
            {
              label: 'Failed',
              data: s.map((r, i) => asPct(r.failed || 0, i)),
              backgroundColor: CHART_COLORS.failFill,
              borderColor: CHART_COLORS.fail,
              borderWidth: 1,
              borderRadius: 3,
              borderSkipped: false,
              stack: 'outcomes',
            },
            {
              label: 'Flaky',
              data: s.map((r, i) => asPct(r.flaky || 0, i)),
              backgroundColor: CHART_COLORS.flakyFill,
              borderColor: CHART_COLORS.flaky,
              borderWidth: 1,
              borderRadius: 3,
              borderSkipped: false,
              stack: 'outcomes',
            },
            {
              label: 'Skipped',
              data: s.map((r, i) => asPct(r.skipped || 0, i)),
              backgroundColor: CHART_COLORS.skippedFill,
              borderColor: CHART_COLORS.skipped,
              borderWidth: 1,
              borderRadius: 3,
              borderSkipped: false,
              stack: 'outcomes',
            },
          ],
        },
        options: {
          ...CHART_DEFAULTS,
          responsive: true,
          plugins: {
            ...CHART_DEFAULTS.plugins,
            tooltip: {
              ...CHART_DEFAULTS.plugins.tooltip,
              callbacks: {
                title: this.ttTitle(s),
                label: ctx => {
                  const run = s[ctx.dataIndex];
                  const countMap = {
                    Passed: run.passed || 0,
                    Failed: run.failed || 0,
                    Flaky: run.flaky || 0,
                    Skipped: run.skipped || 0,
                  };
                  const count = countMap[ctx.dataset.label] ?? 0;
                  return `${ctx.dataset.label}: ${ctx.formattedValue}% (${count})`;
                },
              },
            },
          },
          scales: {
            ...CHART_DEFAULTS.scales,
            x: { ...CHART_DEFAULTS.scales.x, stacked: true },
            y: {
              ...CHART_DEFAULTS.scales.y,
              stacked: true,
              min: 0,
              max: 100,
              ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => `${v}%` },
            },
          },
        },
      });
      return;
    }
    this.create(id, {
      type: 'bar',
      data: {
        labels: this.labels(s),
        datasets: [{
          label: 'Failures',
          data: s.map(r => r.failed),
          backgroundColor: s.map(r => r.failed > 0 ? CHART_COLORS.failFill : CHART_COLORS.passFill),
          borderColor: s.map(r => r.failed > 0 ? CHART_COLORS.fail : CHART_COLORS.pass),
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
    const isTrendsView = id === 'chart-flaky-full';
    if (isTrendsView) {
      this.create(id, {
        type: 'bar',
        data: {
          labels: this.labels(s),
          datasets: [
            {
              type: 'bar',
              label: 'Failed',
              data: s.map(r => r.failed || 0),
              backgroundColor: CHART_COLORS.failFill,
              borderColor: CHART_COLORS.fail,
              borderWidth: 1,
              borderRadius: 3,
              yAxisID: 'y',
            },
            {
              type: 'line',
              label: 'Flaky',
              data: s.map(r => r.flaky || 0),
              borderColor: CHART_COLORS.flaky,
              backgroundColor: CHART_COLORS.flakyFill,
              pointBackgroundColor: CHART_COLORS.flaky,
              pointBorderColor: '#0e0f13',
              pointBorderWidth: 1.5,
              pointRadius: 4,
              pointHoverRadius: 6,
              borderWidth: 2,
              tension: .35,
              yAxisID: 'y',
            },
            {
              type: 'line',
              label: 'Skipped',
              data: s.map(r => r.skipped || 0),
              borderColor: CHART_COLORS.skipped,
              backgroundColor: CHART_COLORS.skippedFill,
              pointBackgroundColor: CHART_COLORS.skipped,
              pointBorderColor: '#0e0f13',
              pointBorderWidth: 1.5,
              pointRadius: 3,
              pointHoverRadius: 5,
              borderWidth: 1.5,
              tension: .35,
              yAxisID: 'y',
            },
          ],
        },
        options: {
          ...CHART_DEFAULTS,
          responsive: true,
          plugins: { ...CHART_DEFAULTS.plugins, tooltip: { ...CHART_DEFAULTS.plugins.tooltip, callbacks: { title: this.ttTitle(s) } } },
          scales: {
            ...CHART_DEFAULTS.scales,
            y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, stepSize: 1, precision: 0 } },
          },
        },
      });
      return;
    }
    this.create(id, {
      type: 'bar',
      data: {
        labels: this.labels(s),
        datasets: [{
          label: 'Flaky', data: s.map(r => r.flaky || 0),
          backgroundColor: CHART_COLORS.flakyFill, borderColor: CHART_COLORS.flaky, borderWidth: 1, borderRadius: 3,
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
            borderColor: CHART_COLORS.duration, backgroundColor: CHART_COLORS.durationFill, fill: true, tension: .35,
            pointRadius: 3, pointHoverRadius: 5, borderWidth: 2,
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
        if (!counts[t.name]) {
          counts[t.name] = {
            name: t.name,
            classname: t.classname,
            msg: t.failureMessage,
            count: 0,
            latestDateMs: -1,
            latestRunNumber: null,
            latestReportUrl: null,
          };
        }
        counts[t.name].count++;
        if ((r._dateMs || 0) >= counts[t.name].latestDateMs) {
          counts[t.name].latestDateMs = r._dateMs || 0;
          counts[t.name].latestRunNumber = r.buildNumber ?? r.runNumber ?? null;
          counts[t.name].latestReportUrl = r.reportUrl || null;
        }
      }));
      const sorted = Object.values(counts)
        .sort((a, b) => (b.latestDateMs - a.latestDateMs) || (b.count - a.count))
        .slice(0, 8);
      sub.textContent = `${sorted.length} distinct · ${runs.filter(r => r.failed > 0).length} failing runs`;
      list.innerHTML = sorted.length === 0
        ? `<div class="failing-empty">✓ No test failures in this window</div>`
        : sorted.map((t, i) => `<div class="failing-item">
          <div class="failing-rank ${i < 2 ? 'hot' : ''}">${i + 1}</div>
          <div style="flex:1;min-width:0">
            <div class="failing-name" title="${Utils.escape(t.name)}">${Utils.escape(t.name)}</div>
            <div class="failing-file">${Utils.escape(t.classname || '')}</div>
            ${t.msg ? `<div class="failing-msg" title="${Utils.escape(t.msg)}">${Utils.escape(t.msg.split('\n')[0])}</div>` : ''}
            ${(t.latestRunNumber != null || t.latestReportUrl) ? `<div class="failing-meta">
              ${t.latestRunNumber != null ? `<span>Latest: #${Utils.escape(String(t.latestRunNumber))}</span>` : ''}
              ${t.latestReportUrl ? `<a href="${Utils.escape(t.latestReportUrl)}" target="_blank" rel="noopener noreferrer" class="failing-meta-link">Report</a>` : ''}
            </div>` : ''}
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
const ExecutiveModule = {
  render(runs) {
    const hero = document.getElementById('executive-hero');
    const insights = document.getElementById('insight-cards');
    if (!hero || !insights) return;

    if (!runs.length) {
      hero.innerHTML = `<div class="hero-main"><div class="hero-kicker">Executive Release View</div><div class="hero-title">No runs match the current filters.</div><div class="hero-text">Adjust the board filters to restore the release view.</div></div>`;
      insights.innerHTML = '';
      return;
    }

    const summary = AnalyticsModule.summarize(runs);
    const latest = summary.latest;
    const branchLabel = latest?.branch ? Utils.escape(latest.branch) : 'current branch set';
    const runLabel = latest?.runNumber != null ? `Run #${latest.runNumber}` : 'Latest run';
    const criticalSummary = summary.criticalRuns.length
      ? `${summary.criticalFailingRuns}/${summary.criticalRuns.length} critical runs failed`
      : 'No critical-tag runs in current filter';
    const topCategoryLine = summary.topCategory
      ? `${summary.topCategory.label} issues drive ${Math.round(summary.categoryShare)}% of logged failures`
      : 'No failure categories in the selected window';
    const topModuleLine = summary.topModule
      ? `${summary.topModule.label} contributes ${Math.round(summary.moduleShare)}% of observed failures`
      : 'No module concentration detected';

    hero.innerHTML = `
      <div class="hero-main">
        <div class="hero-kicker">Executive Release View</div>
        <div class="hero-title">${summary.releaseStatus}</div>
        <div class="hero-text">${runLabel} on ${branchLabel} closed at ${Utils.pct(summary.avgPass)} average pass reliability with a release health score of ${summary.releaseScore}/100.</div>
      </div>
      <div class="hero-score ${summary.decisionTone}">
        <div class="hero-score-label">Release score</div>
        <div class="hero-score-value">${summary.releaseScore}</div>
        <div class="hero-score-sub">${criticalSummary}</div>
      </div>
      <div class="hero-bullets">
        <div class="hero-bullet">${summary.passDelta == null ? 'Baseline is forming from current S3 history.' : `Pass reliability moved ${Utils.deltaLabel(summary.passDelta)} versus the previous run window.`}</div>
        <div class="hero-bullet">${summary.failureDelta == null ? 'Failure baseline is forming.' : `Average failures per run changed ${Utils.deltaLabel(summary.failureDelta, '')}.`}</div>
        <div class="hero-bullet">${topCategoryLine}</div>
        <div class="hero-bullet">${topModuleLine}</div>
      </div>`;

    const cards = [
      {
        label: 'Release Recommendation',
        tone: summary.decisionTone,
        value: summary.releaseStatus,
        body: summary.criticalFailingRuns > 0
          ? 'Critical-tag failures are present, so release risk is elevated.'
          : 'No critical-tag failures are blocking the current release view.',
      },
      {
        label: 'Trend Movement',
        tone: summary.passDelta >= 0 ? 'good' : 'bad',
        value: summary.passDelta == null ? 'Baseline forming' : `${Utils.deltaLabel(summary.passDelta)} pass rate`,
        body: summary.failureDelta == null
          ? 'Waiting for more historical contrast from S3.'
          : `Average failures per run are ${summary.failureDelta > 0 ? 'up' : summary.failureDelta < 0 ? 'down' : 'flat'} ${Utils.deltaLabel(summary.failureDelta, '')} versus the previous window.`,
      },
      {
        label: 'Failure Driver',
        tone: summary.topCategory ? 'warn' : 'good',
        value: summary.topCategory ? summary.topCategory.label : 'No active driver',
        body: summary.topCategory
          ? `${summary.topCategory.count} failures mapped to this category in the current view.`
          : 'No failure categories were detected in the selected runs.',
      },
      {
        label: 'Stability Risk',
        tone: summary.flakyRunShare < 10 ? 'good' : summary.flakyRunShare < 25 ? 'warn' : 'bad',
        value: `${Utils.pct(summary.flakyRunShare)} flaky exposure`,
        body: summary.flakyDelta == null
          ? 'Tracking flaky prevalence as more history accumulates.'
          : `Flaky exposure moved ${Utils.deltaLabel(summary.flakyDelta)} compared with the previous window.`,
      },
    ];

    insights.innerHTML = cards.map(card => `
      <div class="insight-card ${card.tone}">
        <div class="insight-label">${card.label}</div>
        <div class="insight-value">${Utils.escape(card.value)}</div>
        <div class="insight-body">${Utils.escape(card.body)}</div>
      </div>`).join('');
  },
};

const LastRunModule = {
  buildContent(target) {
    if (!target) return '';
    const approval = target.status === 'PASS' && (target.flaky || 0) === 0
      ? 'Go for release approval'
      : target.status === 'PASS'
        ? 'Review flaky signals before approval'
        : 'Do not approve release yet';
    const failedTests = (target.failedTests || []).slice(0, 6);
    const links = `
      <div class="links-cell">
        ${target.reportUrl ? `<a href="${Utils.escape(target.reportUrl)}" target="_blank" class="link-btn">Report</a>` : `<span class="link-btn disabled">Report</span>`}
        ${target.allureUrl ? `<a href="${Utils.escape(target.allureUrl)}" target="_blank" class="link-btn">Allure</a>` : `<span class="link-btn disabled">Allure</span>`}
      </div>`;

    return `
      <div class="last-run-modal-grid">
        <div class="last-run-modal-hero">
          <div class="hero-kicker">Approval Snapshot</div>
          <div class="hero-title">Run #${Utils.escape(String(target.runNumber ?? '—'))}</div>
          <div class="hero-text">${Utils.escape(target.branch || 'unknown branch')} · ${Utils.escape(target.env || 'unknown env')} · ${Utils.escape(target.testType || 'unknown tag')} · ${target.formattedDate}</div>
          <div class="last-run-approval ${target.status === 'PASS' && (target.flaky || 0) === 0 ? 'good' : target.status === 'PASS' ? 'warn' : 'bad'}">${approval}</div>
        </div>
        <div class="last-run-modal-stats">
          <div class="last-run-modal-stat"><span>Pass rate</span><strong>${Utils.pct(target.passRate)}</strong></div>
          <div class="last-run-modal-stat"><span>Passed</span><strong>${target.passed}</strong></div>
          <div class="last-run-modal-stat"><span>Failed</span><strong>${target.failed}</strong></div>
          <div class="last-run-modal-stat"><span>Skipped</span><strong>${target.skipped}</strong></div>
          <div class="last-run-modal-stat"><span>Flaky</span><strong>${target.flaky || 0}</strong></div>
          <div class="last-run-modal-stat"><span>Duration</span><strong>${Utils.formatDuration(target.durationMin)}</strong></div>
        </div>
      </div>
      <div class="last-run-modal-section">
        <div class="section-hd">
          <div class="section-title"><span class="section-title-dot"></span>Release Decision Support</div>
          ${links}
        </div>
        <div class="last-run-modal-notes">
          <div class="hero-bullet">Status is <strong>${target.status}</strong> against the current release threshold of ${State.passThreshold}%.</div>
          <div class="hero-bullet">${target.failed > 0 ? `${target.failed} failing tests require resolution or explicit sign-off.` : 'No failing tests were recorded in the latest run.'}</div>
          <div class="hero-bullet">${(target.flaky || 0) > 0 ? `${target.flaky} flaky tests were detected and should be reviewed for release confidence.` : 'No flaky tests were recorded in the latest run.'}</div>
        </div>
      </div>
      <div class="last-run-modal-section">
        <div class="section-hd">
          <div class="section-title"><span class="section-title-dot"></span>Latest Failures</div>
          <span class="section-sub">${failedTests.length} shown</span>
        </div>
        ${failedTests.length
          ? failedTests.map(test => `
            <div class="failing-item">
              <div class="failing-rank hot">!</div>
              <div style="flex:1;min-width:0">
                <div class="failing-name">${Utils.escape(test.name || 'Unnamed failure')}</div>
                <div class="failing-file">${Utils.escape(test.classname || 'No file path')}</div>
                ${test.failureMessage ? `<div class="failing-msg">${Utils.escape(String(test.failureMessage).split('\n')[0])}</div>` : ''}
              </div>
            </div>`).join('')
          : `<div class="failing-empty">No per-test failures were attached to the latest run</div>`}
      </div>`;
  },

  render(runs) {
    const panel = document.getElementById('last-run-panel');
    if (!panel) return;
    const latest = [...runs].sort((a, b) => b._dateMs - a._dateMs)[0];
    if (!latest) {
      panel.innerHTML = '';
      return;
    }

    const approval = latest.status === 'PASS' && (latest.flaky || 0) === 0
      ? { label: 'Approval Ready', tone: 'good', detail: 'Latest run cleared pass threshold with no flaky tests logged.' }
      : latest.status === 'PASS'
        ? { label: 'Approve With Caution', tone: 'warn', detail: 'Latest run passed, but flaky activity was detected.' }
        : { label: 'Hold Approval', tone: 'bad', detail: 'Latest run failed and should be reviewed before release approval.' };

    panel.innerHTML = `
      <div class="last-run-card ${approval.tone}">
        <div class="last-run-copy">
          <div class="last-run-kicker">Latest ${Utils.escape(Utils.titleCase(latest.testType || 'Selected'))} Run</div>
          <div class="last-run-title">Run #${Utils.escape(String(latest.runNumber ?? '—'))} · ${Utils.escape(latest.branch || 'unknown branch')}</div>
          <div class="last-run-text">${latest.formattedDate} · ${Utils.escape(latest.env || 'unknown env')} · ${Utils.escape(latest.testType || 'unknown tag')}</div>
          <div class="last-run-text">${approval.detail}</div>
        </div>
        <div class="last-run-metrics">
          <div class="last-run-metric">
            <span class="last-run-metric-label">Status</span>
            <span class="badge badge-${latest.status === 'PASS' ? 'pass' : 'fail'}">${latest.status}</span>
          </div>
          <div class="last-run-metric">
            <span class="last-run-metric-label">Pass rate</span>
            <span class="last-run-metric-value">${Utils.pct(latest.passRate)}</span>
          </div>
          <div class="last-run-metric">
            <span class="last-run-metric-label">Failures</span>
            <span class="last-run-metric-value">${latest.failed}</span>
          </div>
          <div class="last-run-metric">
            <span class="last-run-metric-label">Flaky</span>
            <span class="last-run-metric-value">${latest.flaky || 0}</span>
          </div>
        </div>
        <div class="last-run-actions">
          <div class="last-run-approval ${approval.tone}">${approval.label}</div>
          <button class="btn btn-primary" id="last-run-open-btn" type="button">Review Last Run</button>
        </div>
      </div>`;

    document.getElementById('last-run-open-btn')?.addEventListener('click', () => this.open(latest));
  },

  open(run = null) {
    const modal = document.getElementById('last-run-modal');
    const body = document.getElementById('last-run-modal-body');
    if (!modal || !body) return;
    const target = run || [...State.filteredRuns].sort((a, b) => b._dateMs - a._dateMs)[0];
    if (!target) return;
    body.innerHTML = this.buildContent(target);
    modal.classList.add('open');
  },

  close() {
    document.getElementById('last-run-modal')?.classList.remove('open');
  },
};

const RiskModule = {
  renderCategoryList(runs) {
    const sub = document.getElementById('failure-categories-sub');
    const list = document.getElementById('failure-categories-list');
    if (!sub || !list) return;
    const categories = AnalyticsModule.summarize(runs).categoryCounts.slice(0, 5);
    const total = categories.reduce((sum, item) => sum + item.count, 0);
    sub.textContent = total ? `${total} categorized failure points` : 'No categorized failure data';
    list.innerHTML = categories.length
      ? categories.map(item => `
        <div class="failing-item">
          <div class="failing-rank">${Utils.escape(String(item.count))}</div>
          <div style="flex:1;min-width:0">
            <div class="failing-name">${Utils.escape(item.label)}</div>
            <div class="failing-file">${Math.round(Utils.ratio(item.count, total))}% of categorized failures</div>
          </div>
          <div class="failing-badge">${item.count}x</div>
        </div>`).join('')
      : `<div class="failing-empty">No failure categories found for the selected runs</div>`;
  },

  renderModules(runs) {
    const sub = document.getElementById('top-modules-sub');
    const list = document.getElementById('top-modules-list');
    if (!sub || !list) return;
    const modules = AnalyticsModule.summarize(runs).moduleCounts.slice(0, 6);
    const total = modules.reduce((sum, item) => sum + item.count, 0);
    sub.textContent = total ? `${modules.length} modules with repeated failures` : 'No module hotspots';
    list.innerHTML = modules.length
      ? modules.map((item, i) => `
        <div class="failing-item">
          <div class="failing-rank ${i < 2 ? 'hot' : ''}">${i + 1}</div>
          <div style="flex:1;min-width:0">
            <div class="failing-name">${Utils.escape(item.label)}</div>
            <div class="failing-file">${Math.round(Utils.ratio(item.count, total))}% of module-linked failures</div>
          </div>
          <div class="failing-badge">${item.count}x</div>
        </div>`).join('')
      : `<div class="failing-empty">No module-level hotspots found for the selected runs</div>`;
  },
};

const TableModule = {
  toggleDetails(rn) {
    if (State.expandedRuns.has(rn)) State.expandedRuns.delete(rn);
    else State.expandedRuns.add(rn);
    this.render();
  },

  render() {
    const avgDur = Utils.avg(State.filteredRuns.filter(r => r.durationMin != null && r.durationMin > 0).map(r => r.durationMin));
    const outlier = avgDur * 1.5;
    let rows = [...State.filteredRuns];
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
      const expanded = State.expandedRuns.has(r.runNumber);
      const isOutlier = avgDur > 0 && r.durationMin != null && r.durationMin > outlier;
      const rLink = r.reportUrl
        ? `<a href="${Utils.escape(r.reportUrl)}" target="_blank" class="link-btn">Report</a>`
        : `<span class="link-btn disabled">Report</span>`;
      const aLink = r.allureUrl
        ? `<a href="${Utils.escape(r.allureUrl)}" target="_blank" class="link-btn">Allure</a>`
        : `<span class="link-btn disabled">Allure</span>`;
      return `<tr class="${r.status === 'FAIL' ? 'row-fail' : ''}${sel ? ' row-compare' : ''}">
        <td><input type="checkbox" class="cmp-cb" data-run-number="${r.runNumber}" ${sel ? 'checked' : ''} ${!sel && State.compareIds.size >= 2 ? 'disabled' : ''} /></td>
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
        <td class="mobile-row-toggle-cell">
          <button class="mobile-row-toggle" type="button" data-run-number="${r.runNumber}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${expanded ? 'Hide details' : 'View details'}
          </button>
        </td>
        <td class="mobile-row-details-cell">
          <div class="mobile-row-details ${expanded ? 'open' : ''}">
            <div class="mobile-detail-grid">
              <div class="mobile-detail-item">
                <span class="mobile-detail-label">Tag</span>
                <span class="pill pill-purple">@${Utils.escape(r.testType || '—')}</span>
              </div>
              <div class="mobile-detail-item">
                <span class="mobile-detail-label">User</span>
                <span class="pill pill-orange">${Utils.escape(r.userRole || '—')}</span>
              </div>
              <div class="mobile-detail-item">
                <span class="mobile-detail-label">Env</span>
                <span class="pill pill-blue">${Utils.escape(r.env || '—')}</span>
              </div>
              <div class="mobile-detail-item">
                <span class="mobile-detail-label">Flaky</span>
                <span class="mono">${r.flaky || 0}</span>
              </div>
              <div class="mobile-detail-item">
                <span class="mobile-detail-label">Duration</span>
                <span class="mono">${Utils.formatDuration(r.durationMin)}${isOutlier ? ' slow' : ''}</span>
              </div>
              <div class="mobile-detail-item mobile-detail-links">
                <span class="mobile-detail-label">Links</span>
                <div class="links-cell">${rLink}${aLink}</div>
              </div>
            </div>
          </div>
        </td>
      </tr>`;
    }).join('');
    document.querySelectorAll('.cmp-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        CompareModule.toggle(Number(cb.dataset.runNumber), cb.checked);
      });
    });
    document.querySelectorAll('.mobile-row-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toggleDetails(Number(btn.dataset.runNumber));
      });
    });
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

const ExportImageModule = {
  safeName(name) {
    return String(name || 'export')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export';
  },

  downloadDataUrl(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${filename}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },

  replaceCanvases(source, clone) {
    const srcCanvases = source.querySelectorAll('canvas');
    const cloneCanvases = clone.querySelectorAll('canvas');
    cloneCanvases.forEach((canvas, index) => {
      const src = srcCanvases[index];
      if (!src) return;
      const img = document.createElement('img');
      img.src = src.toDataURL('image/png');
      img.style.width = `${src.clientWidth || src.width}px`;
      img.style.height = `${src.clientHeight || src.height}px`;
      img.style.display = 'block';
      img.style.maxWidth = '100%';
      canvas.replaceWith(img);
    });
  },

  async nodeToPng(node, filename) {
    if (typeof window.html2canvas !== 'function') {
      throw new Error('html2canvas not loaded');
    }

    const canvas = await window.html2canvas(node, {
      backgroundColor: '#0e0f13',
      scale: window.devicePixelRatio > 1 ? 2 : 1,
      useCORS: true,
      logging: false,
      onclone: clonedDoc => {
        clonedDoc.querySelectorAll('.btn-export-image').forEach(btn => btn.remove());
      },
    });

    this.downloadDataUrl(canvas.toDataURL('image/png'), filename);
  },

  async downloadCard(button) {
    const target = document.getElementById(button.dataset.exportTarget);
    if (!target) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Exporting...';
    try {
      await this.nodeToPng(target, button.dataset.exportFilename || 'dashboard-export');
    } catch (e) {
      console.error('Export failed', e, target);
      alert('Could not export this section as an image.');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  },

  ensureId(node, fallback) {
    if (!node.id) node.id = fallback;
    return node.id;
  },

  attachButton(card, filename, label) {
    if (card.dataset.exportEnhanced === 'true') return;
    const header = card.querySelector('.section-hd, .table-toolbar, .failing-card-hd');
    if (!header) return;
    const targetId = this.ensureId(card, `export-${filename}`);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-export-image';
    btn.textContent = 'Download PNG';
    btn.dataset.exportTarget = targetId;
    btn.dataset.exportFilename = filename;
    btn.setAttribute('aria-label', `Download ${label} as image`);
    btn.addEventListener('click', () => this.downloadCard(btn));

    let actions = header.querySelector('.section-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'section-actions';
      header.appendChild(actions);
    }
    actions.appendChild(btn);
    card.dataset.exportEnhanced = 'true';
  },

  enhance() {
    document.querySelectorAll('.chart-card, .chart-card-full, .breakdown-card, .failing-card, .table-card').forEach((card, index) => {
      const title = card.querySelector('.section-title')?.textContent?.trim() || `section-${index + 1}`;
      const filename = this.safeName(title);
      this.attachButton(card, filename, title);
    });
  },
};

const ReportModule = {
  palette: {
    bg: [235, 240, 246],
    panel: [248, 250, 252],
    panelSoft: [220, 228, 240],
    text: [27, 36, 58],
    muted: [95, 107, 128],
    blue: [73, 104, 149],
    green: [34, 209, 123],
    yellow: [212, 168, 74],
    red: [242, 95, 92],
    border: [195, 206, 223],
    navy: [42, 56, 84],
  },

  getPdf() {
    const ctor = window.jspdf?.jsPDF;
    if (!ctor) throw new Error('jsPDF not loaded');
    return new ctor({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  },

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  savePdf(pdf, filename) {
    const blob = pdf.output('blob');
    this.downloadBlob(blob, filename);
  },

  async runWithButton(buttonId, task) {
    const button = document.getElementById(buttonId);
    const original = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = 'Generating...';
    }
    try {
      await task();
    } catch (e) {
      console.error('Report generation failed', e);
      alert('Could not generate the report. Please try again.');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  },

  currentTimestamp() {
    return new Date().toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
  },

  latestRun(runs = State.filteredRuns) {
    return [...runs].sort((a, b) => b._dateMs - a._dateMs)[0] || null;
  },

  scopeMeta(runs = State.filteredRuns) {
    const sorted = [...runs].sort((a, b) => a._dateMs - b._dateMs);
    const from = sorted[0]?.date || null;
    const to = sorted[sorted.length - 1]?.date || null;
    const chips = [
      State.dateRangeDays > 0 ? `Range: last ${State.dateRangeDays}d` : 'Range: all history',
      `Runs: ${runs.length}`,
      State.filters.branch ? `Branch: ${State.filters.branch}` : 'Branch: all',
      State.filters.env ? `Env: ${State.filters.env}` : 'Env: all',
      State.filters.testTags.length ? `Tags: ${State.filters.testTags.join(', ')}` : 'Tags: all',
      State.filters.userRole ? `User: ${State.filters.userRole}` : 'User: all',
      State.filters.status ? `Status: ${State.filters.status}` : `Threshold: ${State.passThreshold}%`,
    ];
    const dateSpan = from && to
      ? `${Utils.formatDateOnly(from)} to ${Utils.formatDateOnly(to)}`
      : 'No date span available';
    return { chips, dateSpan };
  },

  renderScopeSummary() {
    const el = document.getElementById('report-scope-summary');
    if (!el) return;
    const meta = this.scopeMeta();
    el.innerHTML = meta.chips.map(chip => `<span class="report-scope-chip">${Utils.escape(chip)}</span>`).join('');
  },

  setFill(pdf, color) {
    pdf.setFillColor(...color);
  },

  setText(pdf, color) {
    pdf.setTextColor(...color);
  },

  async captureNode(node) {
    return window.html2canvas(node, {
      backgroundColor: '#0e0f13',
      scale: window.devicePixelRatio > 1 ? 2 : 1,
      useCORS: true,
      logging: false,
      onclone: clonedDoc => {
        clonedDoc.querySelectorAll('.btn-export-image').forEach(btn => btn.remove());
      },
    });
  },

  async captureClone(node, width = null) {
    const rect = node.getBoundingClientRect();
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';
    host.style.padding = '16px';
    host.style.background = '#0e0f13';
    host.style.zIndex = '-1';

    const clone = node.cloneNode(true);
    clone.style.display = 'block';
    clone.style.visibility = 'visible';
    clone.style.opacity = '1';
    clone.style.width = `${Math.ceil(width || rect.width || 820)}px`;
    clone.querySelectorAll('.btn-export-image').forEach(btn => btn.remove());
    ExportImageModule.replaceCanvases(node, clone);
    host.appendChild(clone);
    document.body.appendChild(host);

    try {
      return await this.captureNode(clone);
    } finally {
      document.body.removeChild(host);
    }
  },

  addImagePage(pdf, title, subtitle, canvas) {
    const sourceCanvas = this.trimCanvas(canvas);
    pdf.addPage();
    this.paintPageBackground(pdf);
    this.setText(pdf, this.palette.text);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.text(title, 16, 20);
    if (subtitle) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      this.setText(pdf, this.palette.muted);
      pdf.text(subtitle, 16, 27);
    }

    const pageWidth = 182;
    const ratio = sourceCanvas.height / sourceCanvas.width;
    const imgHeight = pageWidth * ratio;
    const maxHeight = 250;
    const drawHeight = Math.min(imgHeight, maxHeight);
    const imgData = sourceCanvas.toDataURL('image/png');
    pdf.setDrawColor(...this.palette.border);
    pdf.setFillColor(...this.palette.panel);
    pdf.roundedRect(14, 34, 182, Math.min(drawHeight + 12, 246), 4, 4, 'FD');
    pdf.addImage(imgData, 'PNG', 14, 40, pageWidth, drawHeight, undefined, 'FAST');
  },

  addCanvasPageById(pdf, canvasId, title, subtitle) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.width || !canvas.height) return false;
    this.addImagePage(pdf, title, subtitle, canvas);
    return true;
  },

  addCanvasPanel(pdf, canvasId, title, subtitle, y, panelHeight = 108) {
    const source = document.getElementById(canvasId);
    if (!source || !source.width || !source.height) return false;
    const canvas = this.trimCanvas(source);
    const x = 14;
    const w = 138;
    const innerX = x + 4;
    const innerW = w - 8;
    const titleY = y + 10;
    const subtitleY = y + 17;
    const imageY = y + 24;
    const imageH = panelHeight - 32;
    const ratio = canvas.height / canvas.width;
    const naturalH = innerW * ratio;
    const drawH = Math.min(imageH, naturalH);
    const drawW = drawH / ratio;
    const drawX = innerX + ((innerW - drawW) / 2);

    pdf.setDrawColor(...this.palette.border);
    pdf.setFillColor(...this.palette.panel);
    pdf.roundedRect(x, y, w, panelHeight, 4, 4, 'FD');
    this.setText(pdf, this.palette.text);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text(title, x + 4, titleY);
    if (subtitle) {
      this.setText(pdf, this.palette.muted);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.text(subtitle, x + 4, subtitleY);
    }

    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', drawX, imageY, drawW, drawH, undefined, 'FAST');
    return true;
  },

  trimCanvas(sourceCanvas, padding = 8) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !width || !height) return sourceCanvas;

    const { data } = ctx.getImageData(0, 0, width, height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[((y * width) + x) * 4 + 3];
        if (alpha > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX === -1 || maxY === -1) return sourceCanvas;

    const cropX = Math.max(0, minX - padding);
    const cropY = Math.max(0, minY - padding);
    const cropW = Math.min(width - cropX, (maxX - minX) + (padding * 2));
    const cropH = Math.min(height - cropY, (maxY - minY) + (padding * 2));

    const trimmed = document.createElement('canvas');
    trimmed.width = cropW;
    trimmed.height = cropH;
    trimmed.getContext('2d').drawImage(
      sourceCanvas,
      cropX,
      cropY,
      cropW,
      cropH,
      0,
      0,
      cropW,
      cropH
    );
    return trimmed;
  },

  async withVisiblePage(pageId, task) {
    const page = document.getElementById(pageId);
    if (!page) return task();
    const wasActive = page.classList.contains('active');
    const previous = {
      position: page.style.position,
      left: page.style.left,
      top: page.style.top,
      width: page.style.width,
      zIndex: page.style.zIndex,
      visibility: page.style.visibility,
      pointerEvents: page.style.pointerEvents,
      display: page.style.display,
    };

    if (!wasActive) {
      page.classList.add('active');
      page.style.position = 'fixed';
      page.style.left = '-99999px';
      page.style.top = '0';
      page.style.width = '1280px';
      page.style.zIndex = '-1';
      page.style.visibility = 'visible';
      page.style.opacity = '0';
      page.style.pointerEvents = 'none';
      page.style.display = 'block';
    }

    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return await task();
    } finally {
      if (!wasActive) {
        page.classList.remove('active');
        page.style.position = previous.position;
        page.style.left = previous.left;
        page.style.top = previous.top;
        page.style.width = previous.width;
        page.style.zIndex = previous.zIndex;
        page.style.visibility = previous.visibility;
        page.style.opacity = '';
        page.style.pointerEvents = previous.pointerEvents;
        page.style.display = previous.display;
      }
    }
  },

  async ensureTrendChartsReady(runs) {
    await this.withVisiblePage('page-trends', async () => {
      ChartModule.renderAll(runs);
      await new Promise(resolve => setTimeout(resolve, 120));
      ['chart-passrate-full', 'chart-failures-full', 'chart-flaky-full', 'chart-duration'].forEach(id => {
        const chart = State.charts[id];
        if (!chart) return;
        chart.resize();
        chart.update('none');
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  },

  paintPageBackground(pdf) {
    pdf.setFillColor(...this.palette.bg);
    pdf.rect(0, 0, 210, 297, 'F');
    pdf.setFillColor(...this.palette.panelSoft);
    pdf.rect(0, 0, 210, 16, 'F');
    pdf.setFillColor(...this.palette.blue);
    pdf.rect(160, 0, 50, 297, 'F');
    pdf.setGState?.(new pdf.GState({ opacity: 0.08 }));
    pdf.setFillColor(...this.palette.navy);
    pdf.circle(182, 50, 36, 'F');
    pdf.circle(202, 120, 26, 'F');
    pdf.setGState?.(new pdf.GState({ opacity: 1 }));
    pdf.setFillColor(...this.palette.bg);
    pdf.roundedRect(12, 18, 144, 266, 8, 8, 'F');
  },

  addCover(pdf, title, body, decision, options = {}) {
    const focusLabel = options.focusLabel || 'REPORT FOCUS';
    const reportType = options.reportType || 'Management Report';
    const footerNote = options.footerNote || 'Prepared for management review';
    this.paintPageBackground(pdf);
    this.setFill(pdf, this.palette.blue);
    pdf.roundedRect(16, 24, 62, 8, 4, 4, 'F');
    this.setText(pdf, this.palette.panel);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('ORANGEHRM QA ANALYTICS', 20, 29);
    this.setText(pdf, this.palette.text);
    pdf.setFontSize(28);
    pdf.text(title, 16, 56);
    this.setText(pdf, this.palette.muted);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    const lines = pdf.splitTextToSize(body, 118);
    pdf.text(lines, 16, 72);

    this.setFill(pdf, this.palette.panel);
    pdf.setDrawColor(...this.palette.border);
    pdf.roundedRect(16, 110, 128, 42, 6, 6, 'FD');
    this.setText(pdf, this.palette.blue);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text(focusLabel, 22, 123);
    this.setText(pdf, this.palette.text);
    pdf.setFontSize(16);
    pdf.text(decision, 22, 137);

    this.setFill(pdf, this.palette.panel);
    pdf.setDrawColor(...this.palette.border);
    pdf.roundedRect(16, 166, 58, 24, 5, 5, 'FD');
    pdf.roundedRect(80, 166, 64, 24, 5, 5, 'FD');
    this.setText(pdf, this.palette.muted);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text('REPORT TYPE', 22, 175);
    pdf.text('GENERATED', 86, 175);
    this.setText(pdf, this.palette.text);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text(reportType, 22, 185);
    pdf.text(this.currentTimestamp(), 86, 185);

    this.setText(pdf, this.palette.panel);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.text('Release', 164, 44);
    pdf.text('Approval', 164, 54);
    pdf.text('Report', 164, 64);
    this.setText(pdf, this.palette.muted);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.text(footerNote, 16, 210);
  },

  decisionMeta(run) {
    if (!run) return { text: 'No latest run available for approval review.', color: this.palette.muted, short: 'NO DATA' };
    if (run.status === 'PASS' && (run.flaky || 0) === 0) return { text: 'Recommendation: GO for release approval.', color: this.palette.green, short: 'GO' };
    if (run.status === 'PASS') return { text: 'Recommendation: GO with caution. Review flaky signals before approval.', color: this.palette.yellow, short: 'CAUTION' };
    return { text: 'Recommendation: NO GO until latest failures are resolved.', color: this.palette.red, short: 'NO GO' };
  },

  addSectionHeading(pdf, title, y) {
    this.setText(pdf, this.palette.blue);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text(title, 14, y);
  },

  addMetricCard(pdf, x, y, w, h, label, value, color = this.palette.text) {
    this.setFill(pdf, this.palette.panel);
    pdf.setDrawColor(...this.palette.border);
    pdf.roundedRect(x, y, w, h, 4, 4, 'FD');
    this.setText(pdf, this.palette.muted);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(label.toUpperCase(), x + 4, y + 7);
    this.setText(pdf, color);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.text(String(value), x + 4, y + 18);
  },

  addBodyPage(pdf, heading) {
    pdf.addPage();
    this.paintPageBackground(pdf);
    this.addSectionHeading(pdf, heading, 20);
  },

  addInsightBlock(pdf, x, y, w, h, title, value, body, tone = this.palette.text) {
    this.setFill(pdf, this.palette.panel);
    pdf.setDrawColor(...this.palette.border);
    pdf.roundedRect(x, y, w, h, 4, 4, 'FD');
    this.setText(pdf, this.palette.blue);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.text(String(title).toUpperCase(), x + 4, y + 7);
    this.setText(pdf, tone);
    pdf.setFontSize(14);
    pdf.text(String(value), x + 4, y + 17);
    this.addWrappedText(pdf, body, x + 4, y + 25, w - 8, this.palette.muted, 9);
  },

  addWrappedText(pdf, text, x, y, width, color = this.palette.muted, size = 10) {
    this.setText(pdf, color);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(size);
    const lines = pdf.splitTextToSize(text, width);
    pdf.text(lines, x, y);
    return y + (lines.length * (size * 0.45 + 2));
  },

  approvalDecision(run) {
    return this.decisionMeta(run).text;
  },

  async downloadOverall() {
    await this.runWithButton('report-overall-btn', async () => {
      const pdf = this.getPdf();
      const latest = this.latestRun();
      const summary = AnalyticsModule.summarize(State.filteredRuns);
      const scope = this.scopeMeta(State.filteredRuns);
      await this.ensureTrendChartsReady(State.filteredRuns);
      this.addCover(
        pdf,
        'Overall Automation Report',
        `This report is designed for management and HOD review. It summarizes overall automation execution health, recent trends, risk concentration, and the latest run summary across the selected reporting scope. Date span: ${scope.dateSpan}.`,
        'Automation Health Summary',
        {
          focusLabel: 'REPORT FOCUS',
          reportType: 'Automation Summary',
          footerNote: 'Prepared for automation performance and trend review',
        }
      );

      this.addBodyPage(pdf, 'Executive Summary');
      const statusTone = summary.decisionTone === 'good'
        ? this.palette.green
        : summary.decisionTone === 'warn'
          ? this.palette.yellow
          : this.palette.red;
      this.setFill(pdf, this.palette.panel);
      pdf.setDrawColor(...this.palette.border);
      pdf.roundedRect(14, 28, 182, 30, 5, 5, 'FD');
      this.setText(pdf, this.palette.blue);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text('AUTOMATION HEALTH', 20, 38);
      this.setText(pdf, statusTone);
      pdf.setFontSize(22);
      pdf.text(summary.releaseStatus, 20, 52);
      this.setText(pdf, this.palette.muted);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.text(`Report scope: ${State.filteredRuns.length} runs across the current dashboard filters.`, 110, 38);
      pdf.text(`Date span: ${scope.dateSpan}`, 110, 54);
      pdf.text(`Latest run: #${latest?.runNumber ?? '-'} | ${latest?.testType || 'Unknown tag'} | ${latest?.env || 'Unknown env'}`, 110, 46);

      this.addMetricCard(pdf, 14, 68, 42, 26, 'Release Score', summary.releaseScore, statusTone);
      this.addMetricCard(pdf, 60, 68, 42, 26, 'Avg Pass Rate', Utils.pct(summary.avgPass), this.palette.green);
      this.addMetricCard(pdf, 106, 68, 42, 26, 'Failing Runs', summary.failingRuns, summary.failingRuns > 0 ? this.palette.red : this.palette.text);
      this.addMetricCard(pdf, 152, 68, 44, 26, 'Flaky Count', summary.totalFlaky, summary.totalFlaky > 0 ? this.palette.yellow : this.palette.text);
      this.addMetricCard(pdf, 14, 98, 42, 26, 'Total Runs', State.filteredRuns.length, this.palette.text);
      this.addMetricCard(pdf, 60, 98, 42, 26, 'Avg Failures', summary.avgFailures.toFixed(1), summary.avgFailures > 0 ? this.palette.red : this.palette.text);
      this.addMetricCard(pdf, 106, 98, 42, 26, 'Critical Fails', summary.criticalFailingRuns, summary.criticalFailingRuns > 0 ? this.palette.red : this.palette.text);
      this.addMetricCard(pdf, 152, 98, 44, 26, 'Latest Status', latest?.status || 'N/A', latest?.status === 'PASS' ? this.palette.green : this.palette.red);

      this.addInsightBlock(
        pdf,
        14,
        138,
        56,
        42,
        'Trend Movement',
        summary.passDelta == null ? 'Baseline' : `${Utils.deltaLabel(summary.passDelta)} pass`,
        summary.failureDelta == null
          ? 'Historical comparison is still forming for this reporting window.'
          : `Average failures per run moved ${Utils.deltaLabel(summary.failureDelta, '')} compared with the previous window.`,
        summary.passDelta >= 0 ? this.palette.green : this.palette.red
      );
      this.addInsightBlock(
        pdf,
        77,
        138,
        56,
        42,
        'Failure Driver',
        summary.topCategory?.label || 'No active driver',
        summary.topCategory
          ? `${summary.topCategory.count} logged failures mapped to this category in the current view.`
          : 'No failure category pattern stands out in the selected runs.',
        this.palette.yellow
      );
      this.addInsightBlock(
        pdf,
        140,
        138,
        56,
        42,
        'Hot Module',
        summary.topModule?.label || 'No repeated hotspot',
        summary.topModule
          ? `${Math.round(summary.moduleShare)}% of repeated module-linked failures come from this module.`
          : 'No single module is repeating enough to stand out.',
        this.palette.red
      );

      this.addBodyPage(pdf, 'Latest Run Summary');
      this.setFill(pdf, this.palette.panel);
      pdf.setDrawColor(...this.palette.border);
      pdf.roundedRect(14, 28, 182, 32, 5, 5, 'FD');
      this.setText(pdf, this.palette.blue);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(`LATEST ${Utils.titleCase(latest?.testType || 'Selected')} RUN`, 20, 39);
      this.setText(pdf, latest?.status === 'PASS' ? this.palette.green : this.palette.red);
      pdf.setFontSize(18);
      pdf.text(latest?.status === 'PASS' ? 'Latest Run Stable' : 'Latest Run Needs Attention', 20, 52);
      this.setText(pdf, this.palette.muted);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.text(`Run #${latest?.runNumber ?? '-'} | ${latest?.branch || 'Unknown branch'} | ${latest?.env || 'Unknown env'}`, 110, 40);
      pdf.text(`${latest?.formattedDate || 'Unknown date'} | ${latest?.testType || 'Unknown tag'}`, 110, 48);

      this.addMetricCard(pdf, 14, 70, 42, 26, 'Pass Rate', Utils.pct(latest?.passRate || 0), this.palette.green);
      this.addMetricCard(pdf, 60, 70, 42, 26, 'Failures', latest?.failed || 0, (latest?.failed || 0) > 0 ? this.palette.red : this.palette.text);
      this.addMetricCard(pdf, 106, 70, 42, 26, 'Flaky', latest?.flaky || 0, (latest?.flaky || 0) > 0 ? this.palette.yellow : this.palette.text);
      this.addMetricCard(pdf, 152, 70, 44, 26, 'Duration', Utils.formatDuration(latest?.durationMin || 0), this.palette.text);

      let overallY = 114;
      overallY = this.addWrappedText(
        pdf,
        latest?.status === 'PASS' && (latest?.flaky || 0) === 0
          ? 'The latest selected run passed cleanly with no flaky exposure and reflects stable execution behavior.'
          : latest?.status === 'PASS'
            ? 'The latest selected run passed, but flaky exposure remains part of the current stability picture.'
            : 'The latest selected run failed and should be highlighted as part of the current automation risk picture.',
        18,
        overallY,
        174,
        this.palette.text,
        10
      );
      overallY = this.addWrappedText(
        pdf,
        summary.criticalFailingRuns > 0
          ? `${summary.criticalFailingRuns} critical-tag runs failed in the current view, which raises automation risk in this reporting period.`
          : 'No critical-tag failures were observed in the selected reporting scope.',
        18,
        overallY + 5,
        174
      );
      overallY = this.addWrappedText(
        pdf,
        summary.topCategory
          ? `${summary.topCategory.label} is the leading failure category, while ${summary.topModule?.label || 'the current module set'} remains the main hotspot.`
          : 'No strong failure concentration was detected across the selected runs.',
        18,
        overallY + 5,
        174
      );

      this.addBodyPage(pdf, 'Trend Appendix');
      this.addWrappedText(
        pdf,
        'Recent automation trends across the selected reporting scope.',
        18,
        34,
        120,
        this.palette.muted,
        10
      );
      this.addCanvasPanel(pdf, 'chart-passrate-full', 'Release Health Trend', 'Pass-rate direction across recent runs.', 48, 108);
      this.addCanvasPanel(pdf, 'chart-failures-full', 'Run Outcome Composition', 'Share of pass, fail, flaky, and skipped outcomes.', 164, 108);

      this.addBodyPage(pdf, 'Trend Appendix');
      this.addWrappedText(
        pdf,
        'Execution stability and duration trends.',
        18,
        34,
        120,
        this.palette.muted,
        10
      );
      this.addCanvasPanel(pdf, 'chart-flaky-full', 'Risk Signals Trend', 'Recent instability signals, including flaky and failed behavior.', 48, 108);
      this.addCanvasPanel(pdf, 'chart-duration', 'Execution Duration Trend', 'Average run duration across the current reporting window.', 164, 108);

      this.savePdf(pdf, `overall-release-report-${new Date().toISOString().slice(0, 10)}.pdf`);
    });
  },

  async downloadLastRun() {
    await this.runWithButton('report-last-run-btn', async () => {
      const latest = this.latestRun();
      if (!latest) throw new Error('No latest run available');
      await this.ensureTrendChartsReady(State.filteredRuns);
      const pdf = this.getPdf();
      const decision = this.decisionMeta(latest);
      const scope = this.scopeMeta(State.filteredRuns);
      const buildSafeLastRunReport = () => {
        this.addCover(
          pdf,
          'Last Run Approval Report',
          `This report focuses on the latest selected run and is intended to support an explicit management go / no-go approval decision. Reporting date span: ${scope.dateSpan}.`,
          decision.text,
          {
            focusLabel: 'RELEASE DECISION',
            reportType: 'Approval Pack',
            footerNote: 'Prepared for management go / no-go review',
          }
        );

        pdf.addPage();
        this.paintPageBackground(pdf);
        this.addSectionHeading(pdf, 'Approval Summary', 18);
        this.setFill(pdf, this.palette.panelSoft);
        pdf.roundedRect(14, 24, 182, 22, 4, 4, 'F');
        this.setText(pdf, decision.color);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(18);
        pdf.text(decision.short, 20, 38);
        this.setText(pdf, this.palette.muted);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.text(`Run #${latest.runNumber} | ${latest.branch || 'Unknown branch'} | ${latest.env || 'Unknown env'} | ${latest.testType || 'Unknown tag'}`, 55, 38);
        pdf.text(`Date span: ${scope.dateSpan}`, 55, 46);

        const statusColor = latest.status === 'PASS' ? this.palette.green : this.palette.red;
        this.addMetricCard(pdf, 14, 56, 42, 26, 'Status', latest.status, statusColor);
        this.addMetricCard(pdf, 60, 56, 42, 26, 'Pass Rate', Utils.pct(latest.passRate), this.palette.green);
        this.addMetricCard(pdf, 106, 56, 42, 26, 'Failures', latest.failed, latest.failed > 0 ? this.palette.red : this.palette.text);
        this.addMetricCard(pdf, 152, 56, 44, 26, 'Flaky', latest.flaky || 0, (latest.flaky || 0) > 0 ? this.palette.yellow : this.palette.text);
        this.addMetricCard(pdf, 14, 86, 42, 26, 'Passed', latest.passed, this.palette.text);
        this.addMetricCard(pdf, 60, 86, 42, 26, 'Skipped', latest.skipped, this.palette.muted);
        this.addMetricCard(pdf, 106, 86, 42, 26, 'Duration', Utils.formatDuration(latest.durationMin), this.palette.text);
        this.addMetricCard(pdf, 152, 86, 44, 26, 'Run ID', `#${latest.runNumber}`, this.palette.blue);

        this.addSectionHeading(pdf, 'Decision Notes', 128);
        let noteY = 138;
        noteY = this.addWrappedText(pdf, latest.status === 'PASS'
          ? 'The latest run met the current dashboard pass threshold.'
          : 'The latest run did not meet the current dashboard pass threshold.', 18, noteY, 174);
        noteY = this.addWrappedText(pdf, latest.failed > 0
          ? `${latest.failed} failing tests need resolution or explicit management acceptance before approval.`
          : 'No failing tests were logged in the latest run.', 18, noteY + 2, 174);
        noteY = this.addWrappedText(pdf, (latest.flaky || 0) > 0
          ? `${latest.flaky} flaky tests were detected and should be reviewed as a release-confidence risk.`
          : 'No flaky tests were detected in the latest run.', 18, noteY + 2, 174);

        if (latest.failedTests?.length) {
          this.addSectionHeading(pdf, 'Top Attached Failures', noteY + 12);
          let fy = noteY + 22;
          latest.failedTests.slice(0, 4).forEach((test, idx) => {
            this.setFill(pdf, this.palette.panel);
            pdf.roundedRect(14, fy - 5, 182, 18, 3, 3, 'F');
            this.setText(pdf, this.palette.red);
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            pdf.text(`${idx + 1}. ${String(test.name || 'Unnamed failure').slice(0, 86)}`, 18, fy + 2);
            this.setText(pdf, this.palette.muted);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            pdf.text(String(test.classname || 'No file path').slice(0, 96), 18, fy + 9);
            fy += 22;
          });
        }

        pdf.addPage();
        this.paintPageBackground(pdf);
        this.addSectionHeading(pdf, 'Run Context', 18);
        this.setFill(pdf, this.palette.panelSoft);
        pdf.roundedRect(14, 26, 182, 30, 4, 4, 'F');
        this.setText(pdf, this.palette.text);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.text(`Latest ${Utils.titleCase(latest.testType || 'Selected')} Run`, 20, 40);
        this.setText(pdf, this.palette.muted);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.text(`Branch: ${latest.branch || 'Unknown branch'}`, 20, 48);
        pdf.text(`Environment: ${latest.env || 'Unknown environment'}`, 95, 48);
        pdf.text(`Executed: ${latest.formattedDate || 'Unknown date'}`, 20, 54);

        this.addSectionHeading(pdf, 'Approval Guidance', 72);
        let guidanceY = 82;
        guidanceY = this.addWrappedText(
          pdf,
          latest.status === 'PASS' && (latest.flaky || 0) === 0
            ? 'This run is the strongest candidate for release sign-off because it passed cleanly with no flaky exposure.'
            : latest.status === 'PASS'
              ? 'This run passed, but instability signals were detected. Approval should depend on whether the flaky coverage is understood and accepted.'
              : 'This run failed. Release approval should be blocked until the open failures are resolved or explicitly accepted.',
          18,
          guidanceY,
          174,
          this.palette.text
        );

        guidanceY = this.addWrappedText(
          pdf,
          latest.reportUrl ? `Execution report: ${latest.reportUrl}` : 'Execution report link was not attached to this run.',
          18,
          guidanceY + 6,
          174
        );
        guidanceY = this.addWrappedText(
          pdf,
          latest.allureUrl ? `Allure report: ${latest.allureUrl}` : 'Allure link was not attached to this run.',
          18,
          guidanceY + 4,
          174
        );

        this.addSectionHeading(pdf, 'Failure Summary', guidanceY + 14);
        let failureY = guidanceY + 24;
        const failures = (latest.failedTests || []).slice(0, 6);
        if (failures.length) {
          failures.forEach((test, idx) => {
            this.setFill(pdf, this.palette.panel);
            pdf.roundedRect(14, failureY - 5, 182, 20, 3, 3, 'F');
            this.setText(pdf, this.palette.red);
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            pdf.text(`${idx + 1}. ${String(test.name || 'Unnamed failure').slice(0, 84)}`, 18, failureY + 1);
            this.setText(pdf, this.palette.muted);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            pdf.text(String(test.classname || 'No file path').slice(0, 96), 18, failureY + 8);
            if (test.failureMessage) {
              pdf.text(String(test.failureMessage).split('\n')[0].slice(0, 110), 18, failureY + 14);
            }
            failureY += 24;
          });
        } else {
          this.addWrappedText(pdf, 'No attached per-test failures were included with the latest run.', 18, failureY, 174);
        }

        this.addBodyPage(pdf, 'Trend Appendix');
        this.addWrappedText(
          pdf,
          'Recent run-level trends for pass health and outcome composition across the selected reporting scope.',
          18,
          34,
          120,
          this.palette.muted,
          10
        );
        try {
          this.addCanvasPanel(pdf, 'chart-passrate-full', 'Pass Rate Trend', 'Recent pass performance in the selected filter window.', 48, 108);
          this.addCanvasPanel(pdf, 'chart-failures-full', 'Outcome Composition', 'How recent runs were split across pass, fail, flaky, and skipped outcomes.', 164, 108);
        } catch (e) {
          console.warn('Skipping last run trend appendix', e);
        }

        this.savePdf(pdf, `last-run-approval-report-${new Date().toISOString().slice(0, 10)}.pdf`);
      };
      buildSafeLastRunReport();
      return;

      this.addCover(
        pdf,
        'Last Run Approval Report',
        'This report focuses on the latest selected run and is intended to support an explicit management go / no-go approval decision.',
        decision.text
      );

      pdf.addPage();
      this.setFill(pdf, this.palette.bg);
      pdf.rect(0, 0, 210, 297, 'F');
      this.addSectionHeading(pdf, 'Approval Summary', 18);
      this.setFill(pdf, this.palette.panelSoft);
      pdf.roundedRect(14, 24, 182, 22, 4, 4, 'F');
      this.setText(pdf, decision.color);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(18);
      pdf.text(decision.short, 20, 38);
      this.setText(pdf, this.palette.muted);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.text(`Run #${latest.runNumber} · ${latest.branch || 'Unknown branch'} · ${latest.env || 'Unknown env'} · ${latest.testType || 'Unknown tag'}`, 55, 38);

      const statusColor = latest.status === 'PASS' ? this.palette.green : this.palette.red;
      this.addMetricCard(pdf, 14, 56, 42, 26, 'Status', latest.status, statusColor);
      this.addMetricCard(pdf, 60, 56, 42, 26, 'Pass Rate', Utils.pct(latest.passRate), this.palette.green);
      this.addMetricCard(pdf, 106, 56, 42, 26, 'Failures', latest.failed, latest.failed > 0 ? this.palette.red : this.palette.text);
      this.addMetricCard(pdf, 152, 56, 44, 26, 'Flaky', latest.flaky || 0, (latest.flaky || 0) > 0 ? this.palette.yellow : this.palette.text);
      this.addMetricCard(pdf, 14, 86, 42, 26, 'Passed', latest.passed, this.palette.text);
      this.addMetricCard(pdf, 60, 86, 42, 26, 'Skipped', latest.skipped, this.palette.muted);
      this.addMetricCard(pdf, 106, 86, 42, 26, 'Duration', Utils.formatDuration(latest.durationMin), this.palette.text);
      this.addMetricCard(pdf, 152, 86, 44, 26, 'Run ID', `#${latest.runNumber}`, this.palette.blue);

      this.addSectionHeading(pdf, 'Decision Notes', 128);
      let noteY = 138;
      noteY = this.addWrappedText(pdf, latest.status === 'PASS'
        ? 'The latest run met the current dashboard pass threshold.'
        : 'The latest run did not meet the current dashboard pass threshold.', 18, noteY, 174);
      noteY = this.addWrappedText(pdf, latest.failed > 0
        ? `${latest.failed} failing tests need resolution or explicit management acceptance before approval.`
        : 'No failing tests were logged in the latest run.', 18, noteY + 2, 174);
      noteY = this.addWrappedText(pdf, (latest.flaky || 0) > 0
        ? `${latest.flaky} flaky tests were detected and should be reviewed as a release-confidence risk.`
        : 'No flaky tests were detected in the latest run.', 18, noteY + 2, 174);

      if (latest.failedTests?.length) {
        this.addSectionHeading(pdf, 'Top Attached Failures', noteY + 12);
        let fy = noteY + 22;
        latest.failedTests.slice(0, 4).forEach((test, idx) => {
          this.setFill(pdf, this.palette.panel);
          pdf.roundedRect(14, fy - 5, 182, 18, 3, 3, 'F');
          this.setText(pdf, this.palette.red);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(9);
          pdf.text(`${idx + 1}. ${String(test.name || 'Unnamed failure').slice(0, 86)}`, 18, fy + 2);
          this.setText(pdf, this.palette.muted);
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(8);
          pdf.text(String(test.classname || 'No file path').slice(0, 96), 18, fy + 9);
          fy += 22;
        });
      }

      const temp = document.createElement('div');
      temp.innerHTML = LastRunModule.buildContent(latest);
      const canvas = await this.captureClone(temp, 820);
      this.addImagePage(
        pdf,
        `Run #${latest.runNumber} Approval Pack`,
        `${latest.branch || 'Unknown branch'} · ${latest.env || 'Unknown env'} · ${latest.testType || 'Unknown tag'}`,
        canvas
      );

      const trendNodes = [
        { id: 'chart-passrate-full', title: 'Pass Rate Trend', subtitle: 'Recent pass performance in the selected filter window.' },
        { id: 'chart-failures-full', title: 'Outcome Composition', subtitle: 'How recent runs were split across pass, fail, flaky, and skipped outcomes.' },
      ];
      for (const item of trendNodes) {
        const node = document.getElementById(item.id)?.closest('.chart-card-full');
        if (!node) continue;
        const trendCanvas = await this.captureClone(node);
        this.addImagePage(pdf, item.title, item.subtitle, trendCanvas);
      }

      this.savePdf(pdf, `last-run-approval-report-${new Date().toISOString().slice(0, 10)}.pdf`);
    });
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

const VisualsModule = {
  show(section) {
    State.visualSection = section;
    document.querySelectorAll('.visual-tab').forEach(tab =>
      tab.classList.toggle('active', tab.dataset.visualSection === section)
    );
    document.querySelectorAll('.visual-section').forEach(panel =>
      panel.classList.toggle('active', panel.dataset.visualSection === section)
    );
    if (NavModule.current === 'breakdown') {
      setTimeout(() => ChartModule.renderAll(State.filteredRuns), 50);
    }
  },
};

/* ─── Timer ─── */
const TimerModule = {
  nextMidnightDelay() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.getTime() - now.getTime();
  },

  updateLabel() {
    const el = document.getElementById('countdown');
    if (!el) return;
    el.textContent = 'Refresh daily at 00:00';
  },

  start() {
    clearTimeout(State.refreshTimer);
    this.updateLabel();
    State.refreshTimer = setTimeout(() => {
      App.refresh();
    }, this.nextMidnightDelay());
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
    State.passThreshold = 100;
    // Reset all radios/checkboxes in sheet
    document.querySelectorAll('#filter-sheet input[type=radio][value=""]').forEach(r => r.checked = true);
    document.querySelectorAll('#filter-sheet input[type=checkbox]').forEach(c => c.checked = false);
    document.querySelectorAll('.date-pill').forEach(p => p.classList.toggle('active', p.dataset.days === '0'));
    document.querySelectorAll('input[name="filter-status"][value=""]').forEach(r => r.checked = true);
    const desk = document.getElementById('pass-threshold');
    const mobile = document.getElementById('pass-threshold-m');
    if (desk) desk.value = 100;
    if (mobile) mobile.value = 100;
    const deskVal = document.getElementById('threshold-val');
    const mobileVal = document.getElementById('threshold-val-m');
    if (deskVal) deskVal.textContent = '100%';
    if (mobileVal) mobileVal.textContent = '100%';
    DropdownModule.updateSingleLabel('dd-status-label', 'Filter Status', '');
    DropdownModule.updateSingleLabel('dd-branch-label', 'All Branches', '');
    DropdownModule.updateSingleLabel('dd-env-label', 'All Envs', '');
    DropdownModule.updateSingleLabel('dd-user-label', 'All Users', '');
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
  bindClick(el, handler) {
    if (!el) return;
    el.removeAttribute('onclick');
    el.onclick = null;
    el.addEventListener('click', handler);
  },

  syncSearchInputs() {
    const header = document.getElementById('header-search');
    const table = document.getElementById('table-search');
    if (header && header.value !== State.tableSearch) header.value = State.tableSearch;
    if (table && table.value !== State.tableSearch) table.value = State.tableSearch;
  },

  bindStaticActions() {
    this.bindClick(document.getElementById('sidebar-overlay'), () => MobileModule.closeSidebar());
    this.bindClick(document.getElementById('hamburger'), () => MobileModule.openSidebar());
    this.bindClick(document.getElementById('filter-sheet-overlay'), () => MobileModule.closeFilterSheet());
    this.bindClick(document.querySelector('#filter-sheet .modal-close'), () => MobileModule.closeFilterSheet());
    this.bindClick(document.querySelector('#compare-modal .modal-close'), () => CompareModule.close());
    this.bindClick(document.getElementById('last-run-modal-close'), () => LastRunModule.close());
    const compareModal = document.getElementById('compare-modal');
    compareModal?.removeAttribute('onclick');
    compareModal?.addEventListener('click', e => {
      if (e.target === e.currentTarget) CompareModule.close();
    });
    const lastRunModal = document.getElementById('last-run-modal');
    lastRunModal?.addEventListener('click', e => {
      if (e.target === e.currentTarget) LastRunModule.close();
    });
    this.bindClick(document.querySelector('#error-state .btn'), () => this.refresh());
    this.bindClick(document.querySelector('.mobile-filter-btn'), () => MobileModule.toggleFilterSheet());
    this.bindClick(document.querySelector('#header-filters .threshold-chip'), () => MobileModule.toggleFilterSheet());
    this.bindClick(document.querySelector('.header-right .btn[title="Refresh"]'), () => this.refresh());
    this.bindClick(document.getElementById('report-overall-btn'), () => ReportModule.downloadOverall());
    this.bindClick(document.getElementById('report-last-run-btn'), () => ReportModule.downloadLastRun());

    document.querySelectorAll('button.btn').forEach(btn => {
      if (btn.textContent.includes('CSV')) {
        this.bindClick(btn, () => this.exportCSV());
      }
    });

    const sheetButtons = document.querySelectorAll('.filter-sheet-footer .btn');
    this.bindClick(sheetButtons[0], () => MobileModule.clearFilters());
    this.bindClick(sheetButtons[1], () => MobileModule.closeFilterSheet());

    this.bindClick(document.querySelector('#compare-bar .btn:not(#compare-btn)'), () => CompareModule.clear());
    this.bindClick(document.getElementById('compare-btn'), () => CompareModule.open());

    ['dd-status', 'dd-branch', 'dd-env', 'dd-tags', 'dd-user'].forEach(id => {
      const trigger = document.querySelector(`#${id} .dropdown-trigger`);
      this.bindClick(trigger, e => {
        e.stopPropagation();
        DropdownModule.toggle(id);
      });
    });

    document.querySelectorAll('.visual-tab').forEach(tab => {
      this.bindClick(tab, () => VisualsModule.show(tab.dataset.visualSection));
    });

    ExportImageModule.enhance();
  },

  async init() {
    this.bindStaticActions();

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
      this.syncSearchInputs();
      this.updateUI();
    });

    // Table search
    document.getElementById('table-search')?.addEventListener('input', e => {
      State.tableSearch = e.target.value;
      this.syncSearchInputs();
      this.updateUI();
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
      this.syncSearchInputs();
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
    this.syncSearchInputs();
    this.updateAdvancedFilterTrigger();
    const runs = State.filteredRuns;
    ExecutiveModule.render(runs);
    LastRunModule.render(runs);
    SummaryModule.render(runs);
    ChartModule.renderAll(runs);
    BreakdownModule.renderAll(runs);
    TopFailingModule.render(runs);
    RiskModule.renderModules(runs);
    RiskModule.renderCategoryList(runs);
    VisualsModule.show(State.visualSection);
    TableModule.render();
    ReportModule.renderScopeSummary();
    ExportImageModule.enhance();
  },

  updateAdvancedFilterTrigger() {
    const trigger = document.querySelector('#header-filters .threshold-chip');
    if (!trigger) return;
    const count = [
      State.dateRangeDays > 0,
      !!State.filters.status,
      !!State.filters.branch,
      !!State.filters.env,
      State.filters.testTags.length > 0,
      !!State.filters.userRole,
      State.passThreshold !== 100,
    ].filter(Boolean).length;
    trigger.dataset.count = count > 0 ? String(count) : '';
    trigger.classList.toggle('has-active-filters', count > 0);
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

Object.assign(window, { App, MobileModule, DropdownModule, CompareModule, LastRunModule, ExportImageModule, ReportModule });

document.addEventListener('DOMContentLoaded', () => App.init());
