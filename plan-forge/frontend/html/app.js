/* ============================================================
   PLAN FORGE — frontend application
   ============================================================ */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'planforge_token';
  const USER_KEY = 'planforge_user';

  // ===================================================================
  // ARTIFACT SCHEMAS (fields per artifact type — kept client-side for UI)
  // ===================================================================
  const SCHEMAS = {
    project_plan: {
      brief: "A full project charter — objectives, scope, deliverables, phases, team, risks, success criteria.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Customer Portal Redesign", required: true },
        { id: "objective", label: "Objective / Business Goal", type: "textarea", placeholder: "What outcome are you trying to achieve? Why now?", required: true },
        { id: "scope", label: "Scope (what's in)", type: "textarea", placeholder: "e.g. Redesign of login, dashboard, billing pages. New auth provider." },
        { id: "duration", label: "Target Duration", type: "select", options: [
          "Under 1 month", "1–3 months", "3–6 months", "6–12 months", "Over 12 months"
        ]},
        { id: "team_size", label: "Team Size", type: "number", placeholder: "5" },
        { id: "constraints", label: "Constraints / Non-Negotiables", type: "textarea", placeholder: "e.g. Must ship before Q3. Fixed budget of $120k." }
      ]
    },
    timeline: {
      brief: "A phased timeline with milestones, rendered as a Gantt chart + milestone table.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Mobile App Launch", required: true },
        { id: "start_date", label: "Start Date", type: "date", required: true },
        { id: "end_date", label: "Target End Date", type: "date", required: true },
        { id: "phases", label: "Known Phases (optional)", type: "textarea", placeholder: "e.g. Discovery, Design, Build, QA, Launch — or leave blank to infer." },
        { id: "deliverables", label: "Major Deliverables / Milestones", type: "textarea", placeholder: "e.g. Beta release, App Store submission, Marketing launch." }
      ]
    },
    wbs: {
      brief: "A hierarchical breakdown of the project into workstreams, tasks, and sub-tasks.",
      fields: [
        { id: "project_name", label: "Project / Deliverable", type: "text", placeholder: "e.g. Website Relaunch", required: true },
        { id: "scope", label: "What are we building?", type: "textarea", placeholder: "Describe the end deliverable in 2–4 sentences.", required: true },
        { id: "depth", label: "Breakdown Depth", type: "select", options: [
          "2 levels (workstreams → tasks)",
          "3 levels (workstreams → tasks → subtasks)",
          "4 levels (detailed for execution)"
        ]},
        { id: "known_components", label: "Known Workstreams (optional)", type: "textarea", placeholder: "e.g. Backend, Frontend, Content, Infra — or leave blank to infer." }
      ]
    },
    risk_register: {
      brief: "A prioritized risk register — each risk with likelihood, impact, mitigation, and owner.",
      fields: [
        { id: "project_context", label: "Project Context", type: "textarea", placeholder: "Describe the project and its current state in 3–5 sentences.", required: true },
        { id: "phase", label: "Current Phase", type: "select", options: [
          "Initiation / Planning", "Execution", "Monitoring", "Closing", "Ongoing / BAU"
        ]},
        { id: "known_risks", label: "Known Concerns (optional)", type: "textarea", placeholder: "Any risks already on your radar — or leave blank to infer." },
        { id: "appetite", label: "Risk Appetite", type: "select", options: [
          "Low — must avoid surprises",
          "Medium — balanced",
          "High — moving fast, some risk acceptable"
        ]}
      ]
    },
    raci: {
      brief: "A RACI matrix — who's Responsible, Accountable, Consulted, Informed for each activity.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. CRM Migration", required: true },
        { id: "activities", label: "Activities / Decisions", type: "textarea", placeholder: "List key activities, one per line.\ne.g.\nRequirements gathering\nVendor selection\nData migration\nUAT sign-off\nGo-live decision", required: true },
        { id: "roles", label: "Roles Involved", type: "textarea", placeholder: "List roles (not people).\ne.g.\nProject Manager\nEngineering Lead\nBusiness Sponsor\nEnd User Rep\nQA Lead", required: true }
      ]
    },
    status_report: {
      brief: "A concise weekly status report — traffic-light health, progress, next steps, risks, asks.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Payments Platform v2", required: true },
        { id: "report_date", label: "Report Date", type: "date" },
        { id: "overall_status", label: "Overall Status", type: "select", options: [
          "🟢 Green — on track",
          "🟡 Yellow — at risk, manageable",
          "🔴 Red — off track, escalation needed"
        ]},
        { id: "accomplishments", label: "What Got Done This Period", type: "textarea", placeholder: "Bullets. Be specific — 'shipped API v2' not 'made progress'.", required: true },
        { id: "next_steps", label: "Planned for Next Period", type: "textarea", placeholder: "What's the plan for next week?" },
        { id: "blockers", label: "Blockers / Risks / Asks", type: "textarea", placeholder: "What do you need from stakeholders?" }
      ]
    },
    stakeholder_map: {
      brief: "A stakeholder analysis — power/interest grid, engagement strategy per stakeholder.",
      fields: [
        { id: "project_context", label: "Project Context", type: "textarea", placeholder: "Describe the project and the org it lives in.", required: true },
        { id: "known_stakeholders", label: "Known Stakeholders", type: "textarea", placeholder: "List with role — e.g.\nMaria Chen, VP Product\nFinance team\nEnd customers\nRegulators", required: true },
        { id: "sensitivity", label: "Political Sensitivity", type: "select", options: [
          "Low — routine project", "Medium — visible", "High — board-level / cross-org"
        ]}
      ]
    },
    sprint_plan: {
      brief: "An agile sprint plan — goal, committed stories, capacity, risks.",
      fields: [
        { id: "team_name", label: "Team / Product", type: "text", placeholder: "e.g. Checkout Squad", required: true },
        { id: "sprint_start", label: "Sprint Start Date", type: "date" },
        { id: "sprint_end", label: "Sprint End Date", type: "date" },
        { id: "sprint_goal", label: "Sprint Goal", type: "textarea", placeholder: "The single outcome this sprint is committed to.", required: true },
        { id: "backlog", label: "Backlog / Candidate Stories", type: "textarea", placeholder: "Rough list of stories/features being considered.", required: true },
        { id: "team_members", label: "Team Member Count", type: "number", placeholder: "e.g. 5" },
        { id: "constraints", label: "Holidays / Known Absences", type: "textarea", placeholder: "Any capacity hits this sprint." }
      ]
    },
    retro: {
      brief: "A retrospective — structured reflection on what worked, what didn't, and concrete action items.",
      fields: [
        { id: "name", label: "Project / Sprint Name", type: "text", placeholder: "e.g. Q1 Launch Retro", required: true },
        { id: "retro_date", label: "Retrospective Date", type: "date" },
        { id: "outcomes", label: "What Happened / Outcomes", type: "textarea", placeholder: "What was delivered, how it went, headline results.", required: true },
        { id: "format", label: "Retro Format", type: "select", options: [
          "Start / Stop / Continue",
          "What went well / What didn't / Action items",
          "4Ls — Liked / Learned / Lacked / Longed for",
          "Sailboat — Wind / Anchors / Rocks / Island",
          "Mad / Sad / Glad"
        ]},
        { id: "tone", label: "Tone", type: "select", options: [
          "Honest & direct — surface real issues",
          "Constructive & balanced",
          "Celebratory — mostly wins, light on critique"
        ]}
      ]
    },
    meeting_agenda: {
      brief: "A focused meeting agenda — objective, timed sections, decisions required, pre-reads.",
      fields: [
        { id: "meeting_title", label: "Meeting Title", type: "text", placeholder: "e.g. Q2 Roadmap Review", required: true },
        { id: "meeting_date", label: "Meeting Date & Time", type: "datetime-local" },
        { id: "objective", label: "Objective (one sentence)", type: "textarea", placeholder: "What must be true by the end of this meeting?", required: true },
        { id: "duration", label: "Duration", type: "select", options: [
          "15 min", "30 min", "45 min", "60 min", "90 min", "2+ hours"
        ]},
        { id: "attendees", label: "Attendees & Roles", type: "textarea", placeholder: "Who's in the room and why?" },
        { id: "topics", label: "Topics / Decisions to Cover", type: "textarea", placeholder: "Rough list — the agenda will prioritize and time-box." }
      ]
    },
    comms_plan: {
      brief: "A communication plan — who needs what info, when, through what channel.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. ERP Rollout", required: true },
        { id: "audiences", label: "Audiences", type: "textarea", placeholder: "Who needs to be informed?\ne.g.\nExec sponsors\nEnd users\nSupport team\nCustomers", required: true },
        { id: "key_messages", label: "Key Messages / Milestones to Communicate", type: "textarea", placeholder: "e.g. Kickoff, training dates, go-live, post-launch support." },
        { id: "launch_date", label: "Launch / Key Date", type: "date" },
        { id: "duration_months", label: "Campaign Duration (months)", type: "number", placeholder: "e.g. 6" }
      ]
    },
    budget: {
      brief: "A budget breakdown — categorized costs, contingency, assumptions.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Office Relocation", required: true },
        { id: "total_budget", label: "Total Budget (USD)", type: "number", placeholder: "250000" },
        { id: "scope_summary", label: "Scope Summary", type: "textarea", placeholder: "What needs to be funded? Main cost drivers.", required: true },
        { id: "start_date", label: "Budget Start Date", type: "date" },
        { id: "end_date", label: "Budget End Date", type: "date" },
        { id: "currency", label: "Currency", type: "select", options: [
          "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "PKR", "Other"
        ]}
      ]
    }
  };

  const TYPE_LABEL = {
    project_plan: "Project Charter",
    timeline: "Timeline",
    wbs: "WBS",
    risk_register: "Risk Register",
    raci: "RACI Matrix",
    status_report: "Status Report",
    stakeholder_map: "Stakeholder Map",
    sprint_plan: "Sprint Plan",
    retro: "Retrospective",
    meeting_agenda: "Meeting Agenda",
    comms_plan: "Comms Plan",
    budget: "Budget"
  };

  // ===================================================================
  // STATE
  // ===================================================================
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
    artifacts: [],      // list of {id, artifact_type, title, created_at}
    activeArtifact: null, // full artifact when viewing a saved one
  };

  // ===================================================================
  // API CLIENT
  // ===================================================================
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

    const res = await fetch(path, { ...options, headers });

    // handle expired token
    if (res.status === 401 && state.token) {
      logout();
      throw new Error('Session expired — please sign in again.');
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  // ===================================================================
  // TOASTS
  // ===================================================================
  function toast(msg, kind = 'info', ms = 3500) {
    const host = $('toast-host');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      el.style.transition = 'opacity 0.3s, transform 0.3s';
      setTimeout(() => el.remove(), 350);
    }, ms);
  }

  // ===================================================================
  // AUTH FLOW
  // ===================================================================
  function showAuth() {
    $('auth-view').classList.remove('hidden');
    $('app-view').classList.add('hidden');
  }

  function showApp() {
    $('auth-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('user-email').textContent = state.user?.email || '—';
    loadArtifacts();
  }

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function logout() {
    state.token = null;
    state.user = null;
    state.artifacts = [];
    state.activeArtifact = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    showAuth();
  }

  // tab switching
  document.querySelectorAll('.auth-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('login-form').classList.toggle('hidden', tab !== 'login');
      $('signup-form').classList.toggle('hidden', tab !== 'signup');
    });
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      const { token, user } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: $('login-email').value.trim(),
          password: $('login-password').value
        })
      });
      setSession(token, user);
      showApp();
      toast('Access granted');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '▸ Grant Access';
    }
  });

  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('signup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { token, user } = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: $('signup-name').value.trim(),
          email: $('signup-email').value.trim(),
          password: $('signup-password').value
        })
      });
      setSession(token, user);
      showApp();
      toast('Account created');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '▸ Create Account';
    }
  });

  $('logout-btn').addEventListener('click', () => {
    logout();
    toast('Signed out');
  });

  // ===================================================================
  // SETTINGS MODAL
  // ===================================================================
  const settingsModal = $('settings-modal');
  const configProvider = $('config-provider');
  const configModel = $('config-model');
  const configApiKey = $('config-api-key');
  const configTestBtn = $('config-test-btn');
  const configTestStatus = $('config-test-status');
  const configSaveBtn = $('config-save-btn');

  const modelOptions = {
    claude: [
      { value: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Latest)' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
    ],
    openai: [
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
      { value: 'gpt-4', label: 'GPT-4' },
      { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
    ],
    gemini: [
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' }
    ]
  };

  function updateModelOptions() {
    const provider = configProvider.value;
    const options = modelOptions[provider] || [];
    configModel.innerHTML = options.map(opt =>
      `<option value="${opt.value}">${opt.label}</option>`
    ).join('');
  }

  async function loadConfig() {
    try {
      const { config } = await api('/api/config');
      configProvider.value = config.provider || 'claude';
      updateModelOptions();
      configModel.value = config.model || 'claude-sonnet-4-20250514';
      configApiKey.value = '';
    } catch (err) {
      toast('Failed to load config: ' + err.message, 'error');
    }
  }

  $('settings-btn').addEventListener('click', () => {
    console.log('Settings button clicked');
    loadConfig();
    settingsModal.classList.remove('hidden');
    console.log('Modal visibility:', settingsModal.classList.contains('hidden'));
  });

  $('settings-close').addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  $('settings-cancel').addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  settingsModal.querySelector('.modal-backdrop').addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  configProvider.addEventListener('change', updateModelOptions);

  configTestBtn.addEventListener('click', async () => {
    const provider = configProvider.value;
    const apiKey = configApiKey.value.trim();

    if (!apiKey) {
      configTestStatus.textContent = 'API key required';
      configTestStatus.style.color = 'var(--red)';
      return;
    }

    configTestBtn.disabled = true;
    configTestStatus.textContent = 'testing…';
    configTestStatus.style.color = 'var(--ghost)';

    try {
      await api('/api/config/test', {
        method: 'POST',
        body: JSON.stringify({ provider, api_key: apiKey })
      });
      configTestStatus.textContent = '✓ Valid';
      configTestStatus.style.color = 'var(--green)';
    } catch (err) {
      configTestStatus.textContent = '✗ Invalid';
      configTestStatus.style.color = 'var(--red)';
      toast('Test failed: ' + err.message, 'error');
    } finally {
      configTestBtn.disabled = false;
    }
  });

  configSaveBtn.addEventListener('click', async () => {
    const provider = configProvider.value;
    const model = configModel.value;
    const apiKey = configApiKey.value.trim();

    if (!apiKey) {
      toast('API key is required', 'error');
      return;
    }

    configSaveBtn.disabled = true;
    configTestBtn.disabled = true;

    try {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ provider, model, api_key: apiKey })
      });
      toast('Configuration saved. Backend restarting…');
      settingsModal.classList.add('hidden');

      setTimeout(() => {
        location.reload();
      }, 1500);
    } catch (err) {
      toast('Failed to save config: ' + err.message, 'error');
      configSaveBtn.disabled = false;
      configTestBtn.disabled = false;
    }
  });

  // ===================================================================
  // DYNAMIC FORM FIELDS
  // ===================================================================
  const genSelect = $('gen-type');
  const dynWrap = $('dynamic-fields');
  const missionText = $('mission-text');

  function renderFields() {
    const schema = SCHEMAS[genSelect.value];
    missionText.textContent = schema.brief;
    dynWrap.innerHTML = "";
    schema.fields.forEach(f => {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const lab = document.createElement('label');
      lab.setAttribute('for', 'f_' + f.id);
      lab.innerHTML = f.label + (f.required ? ' <span class="req">*</span>' : '');
      wrap.appendChild(lab);

      let input;
      if (f.type === "textarea") {
        input = document.createElement('textarea');
        input.rows = 3;
      } else if (f.type === "select") {
        input = document.createElement('select');
        f.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          input.appendChild(o);
        });
      } else {
        input = document.createElement('input');
        input.type = f.type;
      }
      input.id = 'f_' + f.id;
      input.dataset.key = f.id;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.required) input.dataset.required = "1";
      wrap.appendChild(input);
      dynWrap.appendChild(wrap);
    });
  }

  genSelect.addEventListener('change', renderFields);

  function collectInputs() {
    const schema = SCHEMAS[genSelect.value];
    const inputs = {};
    const missing = [];
    schema.fields.forEach(f => {
      const el = $('f_' + f.id);
      const v = (el.value || '').trim();
      inputs[f.id] = v;
      if (f.required && !v) missing.push(f.label);
    });
    return { inputs, missing, type: genSelect.value };
  }

  // ===================================================================
  // ARCHIVE / SIDEBAR
  // ===================================================================
  async function loadArtifacts() {
    try {
      const { artifacts } = await api('/api/artifacts');
      state.artifacts = artifacts;
      renderArchive();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderArchive() {
    const list = $('archive-list');
    const count = $('archive-count');
    count.textContent = `${state.artifacts.length} item${state.artifacts.length === 1 ? '' : 's'}`;

    if (!state.artifacts.length) {
      list.innerHTML = `<div class="archive-empty">No artifacts yet.<small>generate your first one →</small></div>`;
      return;
    }

    list.innerHTML = state.artifacts.map(a => `
      <div class="archive-item ${state.activeArtifact?.id === a.id ? 'active' : ''}" data-id="${a.id}">
        <div class="a-type">${TYPE_LABEL[a.artifact_type] || a.artifact_type}</div>
        <div class="a-title">${escapeHtml(a.title)}</div>
        <div class="a-date">${formatDate(a.created_at)}</div>
      </div>
    `).join('');

    list.querySelectorAll('.archive-item').forEach(el => {
      el.addEventListener('click', () => openArtifact(Number(el.dataset.id)));
    });
  }

  async function openArtifact(id) {
    const _md = outputBody.querySelector('.md');
    if (_md && _md.classList.contains('editing')) {
      exitEditMode(true);
    }
    try {
      const { artifact } = await api(`/api/artifacts/${id}`);
      state.activeArtifact = artifact;
      renderArchive();
      renderOutput(artifact);
      // set the form to match
      if (SCHEMAS[artifact.artifact_type]) {
        genSelect.value = artifact.artifact_type;
        renderFields();
        // populate fields from saved inputs (best-effort)
        Object.entries(artifact.inputs || {}).forEach(([k, v]) => {
          const el = $('f_' + k);
          if (el) el.value = v;
        });
        missionText.textContent = SCHEMAS[artifact.artifact_type].brief;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('new-artifact-btn').addEventListener('click', () => {
    const _md = outputBody.querySelector('.md');
    if (_md && _md.classList.contains('editing')) {
      exitEditMode(true);
    }
    state.activeArtifact = null;
    renderArchive();
    resetOutput();
    dynWrap.querySelectorAll('input, textarea').forEach(el => el.value = '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ===================================================================
  // DEPLOY / GENERATE
  // ===================================================================
  const deployBtn = $('deploy-btn');

  async function deploy() {
    const { inputs, missing, type } = collectInputs();
    if (missing.length) {
      renderError('Missing required fields:\n• ' + missing.join('\n• '));
      return;
    }

    deployBtn.disabled = true;
    $('input-status').textContent = 'drafting…';
    hideOutputActions();
    renderThinking();

    try {
      const { artifact } = await api('/api/artifacts', {
        method: 'POST',
        body: JSON.stringify({
          artifact_type: type,
          title: inferTitle(type, inputs),
          inputs
        })
      });
      state.activeArtifact = artifact;
      state.artifacts.unshift({
        id: artifact.id,
        artifact_type: artifact.artifact_type,
        title: artifact.title,
        created_at: artifact.created_at
      });
      renderArchive();
      renderOutput(artifact);
      toast('Artifact saved to archive');
    } catch (err) {
      renderError(err.message);
    } finally {
      deployBtn.disabled = false;
      $('input-status').textContent = 'ready';
    }
  }

  // document extraction
  const uploadDocBtn = $('upload-doc-btn');
  const uploadFileInput = $('upload-file-input');
  const uploadHint = $('upload-hint');

  uploadDocBtn.addEventListener('click', () => {
    uploadFileInput.value = '';
    uploadFileInput.click();
  });

  uploadFileInput.addEventListener('change', async () => {
    const file = uploadFileInput.files[0];
    if (!file) return;

    const type = genSelect.value;
    uploadHint.textContent = '⏳ Extracting…';
    uploadHint.style.color = 'var(--ghost)';
    uploadDocBtn.disabled = true;

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('artifact_type', type);

      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${state.token}` },
        body: formData
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Extraction failed');
      }

      const { fields } = await res.json();

      // Populate form fields
      let filled = 0;
      Object.entries(fields).forEach(([key, value]) => {
        const el = $('f_' + key);
        if (el && value) {
          el.value = value;
          filled++;
        }
      });

      uploadHint.textContent = `✓ Filled ${filled} field${filled !== 1 ? 's' : ''} from ${file.name}`;
      uploadHint.style.color = 'var(--green)';
      toast(`Auto-filled ${filled} field${filled !== 1 ? 's' : ''} from document`);
    } catch (err) {
      uploadHint.textContent = '✗ ' + err.message;
      uploadHint.style.color = 'var(--red)';
      toast(err.message, 'error');
    } finally {
      uploadDocBtn.disabled = false;
    }
  });

  deployBtn.addEventListener('click', deploy);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('app-view').classList.contains('hidden')) {
      e.preventDefault();
      if (!deployBtn.disabled) deploy();
    }
  });

  function inferTitle(type, inputs) {
    return inputs.project_name
        || inputs.meeting_title
        || inputs.team_name
        || inputs.name
        || `${TYPE_LABEL[type]} — ${new Date().toISOString().slice(0,10)}`;
  }

  // ===================================================================
  // OUTPUT RENDERING
  // ===================================================================
  const outputBody = $('output-body');


  function resetOutput() {
    outputBody.innerHTML = `
      <div class="empty-state">
        <span class="big">Standing by.</span>
        <span class="small">Set specifications above, then generate.</span>
      </div>`;
    hideOutputActions();
  }

  function renderThinking() {
    const steps = [
      'Parsing specifications',
      'Loading PM template',
      'Drafting with claude-sonnet-4',
      'Formatting output',
      'Saving to archive'
    ];
    outputBody.innerHTML = `
      <div class="thinking">
        <span class="bars"><span></span><span></span><span></span><span></span><span></span></span>
        Drafting artifact
      </div>
      <div id="log-stream"></div>
    `;
    let i = 0;
    const stream = $('log-stream');
    const tick = setInterval(() => {
      if (i >= steps.length || !stream.isConnected) return clearInterval(tick);
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = steps[i++];
      stream.appendChild(line);
    }, 600);
  }

  function renderError(message) {
    outputBody.innerHTML = `<div class="err-box"><b>Error</b>${escapeHtml(message).replace(/\n/g, '<br>')}</div>`;
    hideOutputActions();
  }

  async function renderOutput(artifact) {
    const body = artifact.content;
    const md = marked.parse(body, { breaks: true });
    outputBody.innerHTML = `<div class="md">${md}</div>` + renderTitleBlock(artifact);
    outputBody.dataset.raw = body;

    // Update export options based on artifact type
    updateExportOptions(artifact.artifact_type);

    // syntax highlight (skip mermaid blocks)
    outputBody.querySelectorAll('pre code').forEach(el => {
      if (!el.classList.contains('language-mermaid')) {
        try { hljs.highlightElement(el); } catch (e) {}
      }
    });

    // mermaid
    await renderMermaid(outputBody);

    showOutputActions();
  }

  async function renderMermaid(root) {
    const blocks = root.querySelectorAll('pre code.language-mermaid, code.language-mermaid');
    let idx = 0;
    for (const block of blocks) {
      const code = block.textContent;
      const id = 'mmd_' + Date.now() + '_' + (idx++);
      try {
        const { svg } = await mermaid.render(id, code);
        const container = document.createElement('div');
        container.className = 'mermaid';
        container.dataset.mermaidSrc = code;
        container.innerHTML = svg;
        const pre = block.closest('pre') || block;
        pre.replaceWith(container);
      } catch (e) {
        console.warn('mermaid render failed', e);
      }
    }
  }

  function renderTitleBlock(artifact) {
    const d = new Date(artifact.created_at);
    const dateStr = d.toISOString().slice(0, 10);
    const user = state.user?.email || 'unknown';
    const userShort = user.split('@')[0];
    const rev = `A-${String(artifact.id).padStart(3, '0')}`;
    return `
      <div class="title-block">
        <div class="cell highlight">
          <span class="k">Project</span>
          <span class="v">${escapeHtml(artifact.title)}</span>
        </div>
        <div class="cell">
          <span class="k">Artifact</span>
          <span class="v">${TYPE_LABEL[artifact.artifact_type] || artifact.artifact_type}</span>
        </div>
        <div class="cell">
          <span class="k">Drawn By</span>
          <span class="v">${escapeHtml(userShort)}</span>
        </div>
        <div class="cell">
          <span class="k">Date</span>
          <span class="v">${dateStr}</span>
        </div>
        <div class="cell">
          <span class="k">Rev.</span>
          <span class="v">${rev}</span>
        </div>
      </div>`;
  }

  function showOutputActions() {
    $('copy-btn').classList.remove('hidden');
    $('edit-btn').classList.remove('hidden');
    $('download-btn').classList.remove('hidden');
  }

  function hideOutputActions() {
    ['copy-btn', 'edit-btn', 'download-btn'].forEach(id => $(id).classList.add('hidden'));
  }

  function openEditor() {
    const raw = outputBody.dataset.raw;
    if (!raw) return;

    const mdContainer = outputBody.querySelector('.md');
    if (!mdContainer) return;

    // Store snapshot for cancel
    outputBody.dataset.snapshot = outputBody.innerHTML;

    // Replace output with textarea
    const textarea = document.createElement('textarea');
    textarea.id = 'inline-editor';
    textarea.className = 'inline-editor';
    textarea.value = raw;
    textarea.spellcheck = true;

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'editor-buttons';
    buttonGroup.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="inline-cancel">✕ Cancel</button>
      <button class="btn btn-sm" id="inline-save">💾 Save</button>
    `;

    outputBody.innerHTML = '';
    outputBody.appendChild(textarea);
    outputBody.appendChild(buttonGroup);

    textarea.focus();

    // Wire up buttons
    $('inline-save').addEventListener('click', () => closeEditor(true));
    $('inline-cancel').addEventListener('click', () => closeEditor(false));
  }

  async function closeEditor(save = false) {
    if (!save) {
      // Restore from snapshot
      outputBody.innerHTML = outputBody.dataset.snapshot;
      delete outputBody.dataset.snapshot;
      return;
    }

    const textarea = $('inline-editor');
    if (!textarea) return;

    const newMarkdown = textarea.value;
    outputBody.dataset.raw = newMarkdown;
    const md = marked.parse(newMarkdown, { breaks: true });
    outputBody.innerHTML = `<div class="md">${md}</div>` + renderTitleBlock(state.activeArtifact);
    outputBody.querySelectorAll('pre code').forEach(el => {
      if (!el.classList.contains('language-mermaid')) {
        try { hljs.highlightElement(el); } catch(e) {}
      }
    });
    await renderMermaid(outputBody);
    toast('Changes saved');
    delete outputBody.dataset.snapshot;
  }

  // copy
  $('copy-btn').addEventListener('click', async () => {
    const raw = outputBody.dataset.raw;
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      toast('Copied to clipboard');
    } catch { toast('Copy failed', 'error'); }
  });

  // edit
  $('edit-btn').addEventListener('click', openEditor);


  // export artifact
  const downloadBtn = $('download-btn');
  const downloadFormat = $('download-format');

  function getSafeName() {
    return (state.activeArtifact?.title || 'artifact')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  downloadBtn.addEventListener('click', () => {
    downloadFormat.classList.toggle('hidden');
  });

  // Format to extension mapping
  const formatExtensions = {
    'markdown': 'md',
    'csv': 'csv',
    'excel': 'xlsx',
    'jira': 'csv',
    'msproject': 'xml',
    'asana': 'csv',
    'azure': 'csv',
    'monday': 'csv',
    'generic': 'xlsx',
    'trello': 'csv',
    'linear': 'csv',
    'github': 'csv',
    'smartsheet': 'xlsx',
    'wrike': 'csv',
    'notion': 'html',
    'confluence': 'txt',
    'googlesheets': 'csv'
  };

  // Smart export formats mapping based on artifact type
  const artifactTypeFormats = {
    'project_plan': ['markdown', 'excel', 'generic', 'msproject', 'asana', 'monday', 'jira', 'azure', 'smartsheet'],
    'timeline': ['markdown', 'excel', 'generic', 'msproject', 'asana', 'monday', 'jira', 'wrike'],
    'wbs': ['markdown', 'excel', 'generic', 'msproject', 'asana', 'jira', 'azure'],
    'risk_register': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'googlesheets'],
    'raci': ['markdown', 'excel', 'csv', 'generic', 'confluence'],
    'status_report': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'googlesheets'],
    'stakeholder_map': ['markdown', 'excel', 'generic', 'confluence'],
    'sprint_plan': ['markdown', 'excel', 'generic', 'jira', 'asana', 'monday', 'linear', 'azure', 'github'],
    'retro': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'googlesheets'],
    'meeting_agenda': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'notion'],
    'comms_plan': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'googlesheets', 'notion'],
    'budget': ['markdown', 'excel', 'csv', 'generic', 'googlesheets']
  };

  // Tool descriptions
  const formatDescriptions = {
    'markdown': 'Markdown File',
    'csv': 'CSV Format',
    'excel': 'Excel Workbook',
    'jira': 'Jira Issues',
    'msproject': 'MS Project',
    'asana': 'Asana Tasks',
    'azure': 'Azure DevOps',
    'monday': 'Monday.com',
    'generic': 'Generic PM Excel',
    'trello': 'Trello Cards',
    'linear': 'Linear Issues',
    'github': 'GitHub Issues',
    'smartsheet': 'Smartsheet',
    'wrike': 'Wrike Tasks',
    'notion': 'Notion Page',
    'confluence': 'Confluence Doc',
    'googlesheets': 'Google Sheets'
  };

  // Tool emojis
  const formatEmojis = {
    'markdown': '📄',
    'csv': '📊',
    'excel': '📈',
    'jira': '🔵',
    'msproject': '📅',
    'asana': '🟦',
    'azure': '🔷',
    'monday': '🔷',
    'generic': '📋',
    'trello': '🟩',
    'linear': '⚡',
    'github': '🐙',
    'smartsheet': '📊',
    'wrike': '⭐',
    'notion': '📝',
    'confluence': '⚙️',
    'googlesheets': '📑'
  };

  // Function to update export options based on artifact type
  function updateExportOptions(artifactType) {
    const allowedFormats = artifactTypeFormats[artifactType] || Object.keys(formatExtensions);
    const options = downloadFormat.querySelectorAll('option');
    const optgroups = downloadFormat.querySelectorAll('optgroup');

    // Update individual options
    options.forEach(option => {
      const format = option.value;
      const shouldShow = allowedFormats.includes(format);
      option.style.display = shouldShow ? 'block' : 'none';
      option.disabled = !shouldShow;
    });

    // Hide optgroups that have no visible options
    optgroups.forEach(group => {
      const visibleOptions = Array.from(group.querySelectorAll('option'))
        .filter(opt => opt.style.display !== 'none');
      group.style.display = visibleOptions.length > 0 ? 'block' : 'none';
    });

    // Reset to markdown if current selection is hidden
    if (downloadFormat.value && !allowedFormats.includes(downloadFormat.value)) {
      downloadFormat.value = 'markdown';
    }
  }

  downloadFormat.addEventListener('change', async () => {
    const format = downloadFormat.value;
    const safeName = getSafeName() || 'artifact';
    if (!state.activeArtifact) return;

    try {
      downloadBtn.disabled = true;
      const response = await fetch(
        `/api/artifacts/${state.activeArtifact.id}/export?format=${format}`,
        { headers: { 'Authorization': `Bearer ${state.token}` } }
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Export failed: ${response.statusText}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = formatExtensions[format] || 'txt';
      a.download = `${safeName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(`✓ Downloaded as ${format.toUpperCase()}`);
    } catch (err) {
      console.error('Download error:', err);
      toast('❌ Download failed: ' + err.message, 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadFormat.classList.add('hidden');
      downloadFormat.value = 'markdown';
    }
  });


  // ===================================================================
  // HELPERS
  // ===================================================================
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diffHr = (now - d) / 36e5;
    if (diffHr < 1) return 'just now';
    if (diffHr < 24) return Math.floor(diffHr) + 'h ago';
    if (diffHr < 24 * 7) return Math.floor(diffHr / 24) + 'd ago';
    return d.toISOString().slice(0, 10);
  }

  // ===================================================================
  // THEME SWITCHER
  // ===================================================================
  const THEME_KEY = 'planforge_theme';
  const themeBtns = document.querySelectorAll('.theme-btn');

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    themeBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
    updateMermaidTheme(theme);
  }

  function updateMermaidTheme(theme) {
    const themes = {
      light: {
        background: '#f8fafb',
        primaryColor: '#5b6cff',
        primaryTextColor: '#0f172a',
        primaryBorderColor: '#5b6cff',
        lineColor: '#cbd5e1',
        secondaryColor: '#eef2ff',
        tertiaryColor: '#ffffff',
      },
      dark: {
        background: '#1a1f35',
        primaryColor: '#818cf8',
        primaryTextColor: '#f1f5f9',
        primaryBorderColor: '#818cf8',
        lineColor: '#64748b',
        secondaryColor: '#312e81',
        tertiaryColor: '#0f172a',
      },
      midnight: {
        background: '#0f172a',
        primaryColor: '#60a5fa',
        primaryTextColor: '#e2e8f0',
        primaryBorderColor: '#60a5fa',
        lineColor: '#475569',
        secondaryColor: '#1e3a8a',
        tertiaryColor: '#020617',
      }
    };
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'light' ? 'default' : 'dark',
        themeVariables: themes[theme] || themes.light,
        fontFamily: "'JetBrains Mono', monospace"
      });
    } catch (e) { console.warn('mermaid theme update failed', e); }
  }

  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.theme);
    });
  });

  // Load saved theme or default to light
  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  setTheme(savedTheme);

  // ===================================================================
  // MERMAID INIT (theme-aware)
  // ===================================================================
  // Mermaid is initialized by the theme switcher with theme-appropriate colors

  // ===================================================================
  // BOOT
  // ===================================================================
  renderFields();
  if (state.token && state.user) {
    // verify token is still valid
    api('/api/auth/me').then(({ user }) => {
      state.user = user;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      showApp();
    }).catch(() => {
      logout();
    });
  } else {
    showAuth();
  }
})();
