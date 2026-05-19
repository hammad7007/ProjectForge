/* ============================================================
   PLAN FORGE — frontend application
   ============================================================ */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'planforge_token';
  const USER_KEY = 'planforge_user';
  const METHODOLOGY_KEY = 'planforge_methodology';
  const VALID_METHODOLOGIES = ['PMBOK', 'Agile', 'PRINCE2', 'Hybrid'];

  // Snapshot key used by the graceful-reauth path: when the JWT expires
  // mid-session we stash the in-flight form state here so the user can
  // resume after re-login instead of losing typed inputs.
  const FORM_SNAPSHOT_KEY = 'planforge_form_snapshot';

  // Set to the interval id returned by `renderThinking` so we can clear
  // it deterministically from renderError / renderOutput. The previous
  // implementation relied on `!stream.isConnected` and leaked timers
  // across error transitions (audit M11).
  let thinkingInterval = null;

  function getMethodology() {
    const m = localStorage.getItem(METHODOLOGY_KEY) || '';
    return VALID_METHODOLOGIES.includes(m) ? m : '';
  }

  // Platform-aware keyboard modifier label for the Generate hint.
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  const KBD_MOD = IS_MAC ? '⌘' : 'Ctrl';

  // ===================================================================
  // ARTIFACT SCHEMAS (fields per artifact type — kept client-side for UI)
  // ===================================================================
  const SCHEMAS = {
    project_plan: {
      brief: "A full project charter — objectives, scope, deliverables, phases, team, risks, success criteria, governance.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Customer Portal Redesign", required: true, maxLength: 100 },
        { id: "sponsor", label: "Project Sponsor (Name & Role)", type: "text", placeholder: "e.g. Maria Chen, VP Product", maxLength: 100 },
        { id: "objective", label: "Objective / Business Goal", type: "textarea", placeholder: "What outcome are you trying to achieve? Why now?", required: true, maxLength: 1000 },
        { id: "scope", label: "Scope (what's in)", type: "textarea", placeholder: "e.g. Redesign of login, dashboard, billing pages. New auth provider.", maxLength: 1500 },
        { id: "out_of_scope", label: "Out of Scope (what's NOT)", type: "textarea", placeholder: "What you're explicitly excluding, to prevent scope creep.", maxLength: 1000 },
        { id: "success_metrics", label: "Success Metrics / KPIs", type: "textarea", placeholder: "e.g. NPS > 50, login time < 2s, support tickets -30%", maxLength: 800 },
        { id: "duration", label: "Target Duration", type: "select", options: [
          "Under 1 month", "1–3 months", "3–6 months", "6–12 months", "Over 12 months"
        ]},
        { id: "team_size", label: "Team Size", type: "number", placeholder: "5", min: 1, max: 500 },
        { id: "budget_envelope", label: "Approximate Budget Envelope (USD)", type: "number", placeholder: "120000", min: 0, max: 1000000000 },
        { id: "risk_appetite", label: "Risk Appetite", type: "select", options: [
          "Low — must avoid surprises", "Medium — balanced", "High — speed over certainty"
        ]},
        { id: "constraints", label: "Constraints / Non-Negotiables", type: "textarea", placeholder: "e.g. Must ship before Q3. Fixed budget of $120k.", maxLength: 800 }
      ]
    },
    timeline: {
      brief: "A phased timeline with milestones, rendered as a Gantt chart + milestone table.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Mobile App Launch", required: true, maxLength: 100 },
        { id: "start_date", label: "Start Date", type: "date", required: true },
        { id: "end_date", label: "Target End Date", type: "date", required: true, compareTo: "start_date", compareOp: "after" },
        { id: "team_capacity", label: "Team Capacity (FTE)", type: "number", placeholder: "5", min: 1, max: 200 },
        { id: "phases", label: "Known Phases (optional)", type: "textarea", placeholder: "e.g. Discovery, Design, Build, QA, Launch — or leave blank to infer.", maxLength: 800 },
        { id: "deliverables", label: "Major Deliverables / Milestones", type: "textarea", placeholder: "e.g. Beta release, App Store submission, Marketing launch.", maxLength: 1200 },
        { id: "external_dependencies", label: "External Dependencies", type: "textarea", placeholder: "Vendors, partner teams, regulators that affect the schedule.", maxLength: 800 },
        { id: "buffer_strategy", label: "Schedule Buffer Strategy", type: "select", options: [
          "Fixed buffer — 10–15% per phase",
          "Critical-chain buffer — pooled at end",
          "No formal buffer — best-case planning",
          "Iterative — re-baseline each cycle"
        ]}
      ]
    },
    wbs: {
      brief: "A hierarchical breakdown of the project into workstreams, tasks, and sub-tasks with effort estimates.",
      fields: [
        { id: "project_name", label: "Project / Deliverable", type: "text", placeholder: "e.g. Website Relaunch", required: true, maxLength: 100 },
        { id: "scope", label: "What are we building?", type: "textarea", placeholder: "Describe the end deliverable in 2–4 sentences.", required: true, maxLength: 1500 },
        { id: "depth", label: "Breakdown Depth", type: "select", options: [
          "2 levels (workstreams → tasks)",
          "3 levels (workstreams → tasks → subtasks)",
          "4 levels (detailed for execution)"
        ]},
        { id: "estimation_method", label: "Estimation Method", type: "select", options: [
          "Expert judgment",
          "Analogous (similar past projects)",
          "Parametric (per-unit)",
          "Three-point (PERT: O/M/P)",
          "Story points",
          "T-shirt sizing"
        ]},
        { id: "assumed_team_size", label: "Assumed Team Size", type: "number", placeholder: "5", min: 1, max: 200 },
        { id: "known_components", label: "Known Workstreams (optional)", type: "textarea", placeholder: "e.g. Backend, Frontend, Content, Infra — or leave blank to infer.", maxLength: 800 },
        { id: "constraints", label: "Hard Constraints", type: "textarea", placeholder: "Tech stack, vendor lock-in, must-reuse components, etc.", maxLength: 800 }
      ]
    },
    risk_register: {
      brief: "A prioritized risk register — each risk with likelihood, impact, mitigation, owner, and trigger signal.",
      fields: [
        { id: "project_context", label: "Project Context", type: "textarea", placeholder: "Describe the project and its current state in 3–5 sentences.", required: true, maxLength: 2000 },
        { id: "phase", label: "Current Phase", type: "select", options: [
          "Initiation / Planning", "Execution", "Monitoring", "Closing", "Ongoing / BAU"
        ]},
        { id: "industry", label: "Industry / Domain", type: "text", placeholder: "e.g. Healthcare, FinTech, SaaS, Manufacturing", maxLength: 60 },
        { id: "team_size", label: "Team Size", type: "number", placeholder: "5", min: 1, max: 500 },
        { id: "known_risks", label: "Known Concerns (optional)", type: "textarea", placeholder: "Any risks already on your radar — or leave blank to infer.", maxLength: 1500 },
        { id: "appetite", label: "Risk Appetite", type: "select", options: [
          "Low — must avoid surprises",
          "Medium — balanced",
          "High — moving fast, some risk acceptable"
        ]},
        { id: "compliance_context", label: "Compliance / Regulatory Context", type: "textarea", placeholder: "GDPR, HIPAA, SOC2, PCI, etc. that bound the risk landscape.", maxLength: 600 }
      ]
    },
    raci: {
      brief: "A RACI matrix — who's Responsible, Accountable, Consulted, Informed for each activity.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. CRM Migration", required: true, maxLength: 100 },
        { id: "activities", label: "Activities / Decisions", type: "textarea", placeholder: "List key activities, one per line.\ne.g.\nRequirements gathering\nVendor selection\nData migration\nUAT sign-off\nGo-live decision", required: true, maxLength: 2500 },
        { id: "roles", label: "Roles Involved", type: "textarea", placeholder: "List roles (not people).\ne.g.\nProject Manager\nEngineering Lead\nBusiness Sponsor\nEnd User Rep\nQA Lead", required: true, maxLength: 1500 },
        { id: "governance_level", label: "Governance Level", type: "select", options: [
          "Tactical — task-level RACI",
          "Operational — workstream level",
          "Strategic — program / steering committee level"
        ]},
        { id: "phase", label: "Project Phase", type: "select", options: [
          "Initiation", "Planning", "Execution", "Monitoring & Control", "Closing"
        ]}
      ]
    },
    status_report: {
      brief: "A concise weekly status report — traffic-light health, progress, next steps, risks, asks, KPIs.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Payments Platform v2", required: true, maxLength: 100 },
        { id: "report_date", label: "Report Date", type: "date" },
        { id: "audience", label: "Primary Audience", type: "select", options: [
          "Project Sponsor / Steering",
          "Functional managers",
          "Working team",
          "Cross-functional stakeholders",
          "Executives / Board"
        ]},
        { id: "overall_status", label: "Overall Status", type: "select", options: [
          "🟢 Green — on track",
          "🟡 Yellow — at risk, manageable",
          "🔴 Red — off track, escalation needed"
        ]},
        { id: "schedule_status", label: "Schedule Status", type: "select", options: [
          "On / ahead", "1–2 weeks behind", "3–4 weeks behind", ">1 month behind", "Re-baselined"
        ]},
        { id: "budget_status", label: "Budget Status", type: "select", options: [
          "Under budget", "On budget", "Over budget — within tolerance", "Over budget — escalation"
        ]},
        { id: "kpis", label: "KPIs / Metrics Snapshot", type: "textarea", placeholder: "e.g. CPI: 0.95, SPI: 0.88, defects open: 12, story points 32/40", maxLength: 600 },
        { id: "accomplishments", label: "What Got Done This Period", type: "textarea", placeholder: "Bullets. Be specific — 'shipped API v2' not 'made progress'.", required: true, maxLength: 1500 },
        { id: "next_steps", label: "Planned for Next Period", type: "textarea", placeholder: "What's the plan for next week?", maxLength: 1200 },
        { id: "blockers", label: "Blockers / Risks / Asks", type: "textarea", placeholder: "What do you need from stakeholders?", maxLength: 1200 }
      ]
    },
    stakeholder_map: {
      brief: "A stakeholder analysis — power/interest grid, engagement strategy per stakeholder, escalation paths.",
      fields: [
        { id: "project_context", label: "Project Context", type: "textarea", placeholder: "Describe the project and the org it lives in.", required: true, maxLength: 1500 },
        { id: "known_stakeholders", label: "Known Stakeholders", type: "textarea", placeholder: "List with role — e.g.\nMaria Chen, VP Product\nFinance team\nEnd customers\nRegulators", required: true, maxLength: 2000 },
        { id: "sensitivity", label: "Political Sensitivity", type: "select", options: [
          "Low — routine project", "Medium — visible", "High — board-level / cross-org"
        ]},
        { id: "org_size", label: "Organization Size", type: "select", options: [
          "Small (<100)", "Mid (100–1,000)", "Large (1,000–10,000)", "Enterprise (10,000+)", "Cross-organization / partnership"
        ]},
        { id: "primary_change_type", label: "Type of Change", type: "select", options: [
          "Tech-led", "Process-led", "Org / restructure", "Customer-facing", "Regulatory-driven"
        ]},
        { id: "known_blockers", label: "Known Political Dynamics", type: "textarea", placeholder: "Tensions between groups, history of failed projects, turf issues.", maxLength: 1000 }
      ]
    },
    sprint_plan: {
      brief: "An agile sprint plan — goal, committed stories, capacity, risks, definition of done.",
      fields: [
        { id: "team_name", label: "Team / Product", type: "text", placeholder: "e.g. Checkout Squad", required: true, maxLength: 80 },
        { id: "sprint_number", label: "Sprint Number", type: "number", placeholder: "e.g. 23", min: 1, max: 999 },
        { id: "sprint_start", label: "Sprint Start Date", type: "date" },
        { id: "sprint_end", label: "Sprint End Date", type: "date", compareTo: "sprint_start", compareOp: "after" },
        { id: "team_members", label: "Team Member Count", type: "number", placeholder: "e.g. 5", min: 1, max: 30 },
        { id: "average_velocity", label: "Average Velocity (story points)", type: "number", placeholder: "e.g. 32", min: 0, max: 500 },
        { id: "sprint_goal", label: "Sprint Goal", type: "textarea", placeholder: "The single outcome this sprint is committed to.", required: true, maxLength: 400 },
        { id: "backlog", label: "Backlog / Candidate Stories", type: "textarea", placeholder: "Rough list of stories/features being considered.", required: true, maxLength: 2500 },
        { id: "definition_of_done", label: "Definition of Done (optional)", type: "textarea", placeholder: "Code reviewed, tests added, deployed to staging, docs updated, PO acceptance.", maxLength: 600 },
        { id: "constraints", label: "Holidays / Known Absences", type: "textarea", placeholder: "Any capacity hits this sprint.", maxLength: 400 }
      ]
    },
    retro: {
      brief: "A retrospective — structured reflection on what worked, what didn't, and concrete action items.",
      fields: [
        { id: "name", label: "Project / Sprint Name", type: "text", placeholder: "e.g. Q1 Launch Retro", required: true, maxLength: 100 },
        { id: "retro_date", label: "Retrospective Date", type: "date" },
        { id: "team_size", label: "Team Size", type: "number", placeholder: "e.g. 5", min: 1, max: 100 },
        { id: "team_maturity", label: "Team Maturity", type: "select", options: [
          "Forming — new team",
          "Storming — finding norms",
          "Norming — settled rhythm",
          "Performing — high autonomy"
        ]},
        { id: "outcomes", label: "What Happened / Outcomes", type: "textarea", placeholder: "What was delivered, how it went, headline results.", required: true, maxLength: 1500 },
        { id: "format", label: "Retro Format", type: "select", options: [
          "Start / Stop / Continue",
          "What went well / What didn't / Action items",
          "4Ls — Liked / Learned / Lacked / Longed for",
          "Sailboat — Wind / Anchors / Rocks / Island",
          "Mad / Sad / Glad",
          "DAKI — Drop / Add / Keep / Improve"
        ]},
        { id: "tone", label: "Tone", type: "select", options: [
          "Honest & direct — surface real issues",
          "Constructive & balanced",
          "Celebratory — mostly wins, light on critique"
        ]},
        { id: "previous_actions", label: "Previous Action Items (optional)", type: "textarea", placeholder: "Carry-over items from the last retro, with status.", maxLength: 800 }
      ]
    },
    meeting_agenda: {
      brief: "A focused meeting agenda — objective, timed sections, decisions required, pre-reads.",
      fields: [
        { id: "meeting_title", label: "Meeting Title", type: "text", placeholder: "e.g. Q2 Roadmap Review", required: true, maxLength: 100 },
        { id: "meeting_date", label: "Meeting Date & Time", type: "datetime-local" },
        { id: "meeting_type", label: "Meeting Type", type: "select", options: [
          "Status check-in",
          "Decision-making",
          "Planning / kickoff",
          "Working session",
          "Steering committee",
          "Retrospective",
          "All-hands / town hall"
        ]},
        { id: "objective", label: "Objective (one sentence)", type: "textarea", placeholder: "What must be true by the end of this meeting?", required: true, maxLength: 400 },
        { id: "duration", label: "Duration", type: "select", options: [
          "15 min", "30 min", "45 min", "60 min", "90 min", "2+ hours"
        ]},
        { id: "attendees", label: "Attendees & Roles", type: "textarea", placeholder: "Who's in the room and why?", maxLength: 1200 },
        { id: "topics", label: "Topics / Decisions to Cover", type: "textarea", placeholder: "Rough list — the agenda will prioritize and time-box.", maxLength: 1500 },
        { id: "prereads", label: "Pre-Reads (optional)", type: "textarea", placeholder: "Documents attendees should review beforehand.", maxLength: 600 },
        { id: "decision_authority", label: "Decision Authority", type: "select", options: [
          "Consult-only — no decisions made",
          "Recommendation — escalate to sponsor",
          "Decision — group can finalize",
          "Vote / consensus required"
        ]}
      ]
    },
    comms_plan: {
      brief: "A communication plan — who needs what info, when, through what channel, with escalation paths.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. ERP Rollout", required: true, maxLength: 100 },
        { id: "audiences", label: "Audiences", type: "textarea", placeholder: "Who needs to be informed?\ne.g.\nExec sponsors\nEnd users\nSupport team\nCustomers", required: true, maxLength: 1500 },
        { id: "key_messages", label: "Key Messages / Milestones to Communicate", type: "textarea", placeholder: "e.g. Kickoff, training dates, go-live, post-launch support.", maxLength: 1500 },
        { id: "launch_date", label: "Launch / Key Date", type: "date" },
        { id: "duration_months", label: "Campaign Duration (months)", type: "number", placeholder: "e.g. 6", min: 1, max: 60 },
        { id: "program_phase", label: "Program Phase", type: "select", options: [
          "Pre-announcement", "Build-up / Awareness", "Launch", "Adoption / Reinforcement", "Sustain / BAU"
        ]},
        { id: "regulatory_constraints", label: "Regulatory / Legal Constraints", type: "textarea", placeholder: "Disclosure rules, embargoes, customer-comms approval flows.", maxLength: 600 },
        { id: "tone_principles", label: "Tone / Voice Principles", type: "textarea", placeholder: "Plain English, jargon-free, formal, friendly, etc.", maxLength: 400 }
      ]
    },
    budget: {
      brief: "A budget breakdown — categorized costs, contingency, payment schedule, assumptions.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Office Relocation", required: true, maxLength: 100 },
        { id: "total_budget", label: "Total Budget", type: "number", placeholder: "250000", min: 0, max: 1000000000 },
        { id: "currency", label: "Currency", type: "select", options: [
          "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "PKR", "Other"
        ]},
        { id: "scope_summary", label: "Scope Summary", type: "textarea", placeholder: "What needs to be funded? Main cost drivers.", required: true, maxLength: 1500 },
        { id: "start_date", label: "Budget Start Date", type: "date" },
        { id: "end_date", label: "Budget End Date", type: "date", compareTo: "start_date", compareOp: "after" },
        { id: "contingency_pct", label: "Contingency %", type: "number", placeholder: "e.g. 15", min: 0, max: 50 },
        { id: "funding_source", label: "Funding Source", type: "select", options: [
          "Operating budget (CAPEX)",
          "Operating budget (OPEX)",
          "Project-specific allocation",
          "Grant / external funding",
          "Customer-funded",
          "Mixed"
        ]},
        { id: "approval_authority", label: "Approval Authority", type: "text", placeholder: "e.g. CFO / Steering Committee / Sponsor", maxLength: 100 }
      ]
    },
    lessons_learned: {
      brief: "A lessons learned register — what worked, what didn't, and recommendations for future projects.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Q1 Launch", required: true, maxLength: 100 },
        { id: "period", label: "Period Covered", type: "text", placeholder: "e.g. Jan–Mar 2026", maxLength: 60 },
        { id: "objective_recap", label: "Original Objective", type: "textarea", placeholder: "What was this project supposed to achieve?", required: true, maxLength: 800 },
        { id: "outcomes_summary", label: "Outcomes Delivered", type: "textarea", placeholder: "What was actually delivered, vs the original objective?", required: true, maxLength: 1500 },
        { id: "went_well", label: "What Went Well", type: "textarea", placeholder: "Be specific — name the practices, tools, or behaviors.", maxLength: 1500 },
        { id: "went_wrong", label: "What Didn't Go Well", type: "textarea", placeholder: "Honest. Failures, near-misses, friction points.", maxLength: 1500 },
        { id: "team_size", label: "Team Size", type: "number", placeholder: "5", min: 1, max: 500 },
        { id: "contributors", label: "Retro Contributors / Roles", type: "textarea", placeholder: "Who contributed observations to this register?", maxLength: 600 }
      ]
    },
    change_request: {
      brief: "A formal change request for the Change Control Board — impact assessment, options, sign-off.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. CRM Migration", required: true, maxLength: 100 },
        { id: "change_title", label: "Change Title", type: "text", placeholder: "e.g. Add SSO via Okta", required: true, maxLength: 120 },
        { id: "requested_by", label: "Requested By (Role)", type: "text", placeholder: "e.g. Head of IT Security", required: true, maxLength: 100 },
        { id: "request_date", label: "Request Date", type: "date" },
        { id: "description", label: "Change Description", type: "textarea", placeholder: "What is being changed? Be specific.", required: true, maxLength: 1500 },
        { id: "rationale", label: "Rationale / Justification", type: "textarea", placeholder: "Why now? Business driver, defect, regulatory need, opportunity.", required: true, maxLength: 1200 },
        { id: "urgency", label: "Urgency", type: "select", options: [
          "Low — schedule for next cycle",
          "Medium — current cycle",
          "High — within 1–2 weeks",
          "Critical — emergency"
        ]},
        { id: "alternatives", label: "Alternatives Considered", type: "textarea", placeholder: "What other options were evaluated, including 'do nothing'?", maxLength: 1200 },
        { id: "estimated_impact", label: "Known Impacts (scope/cost/schedule)", type: "textarea", placeholder: "What you already know about the impact.", maxLength: 1200 }
      ]
    },
    issue_log: {
      brief: "An issue log distinguishing current open issues from closed ones, with resolution paths.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. ERP Rollout", required: true, maxLength: 100 },
        { id: "project_context", label: "Project Context", type: "textarea", placeholder: "Describe the project and where it is now.", required: true, maxLength: 1500 },
        { id: "phase", label: "Current Phase", type: "select", options: [
          "Initiation / Planning", "Execution", "Monitoring & Control", "Closing", "Post-launch / BAU"
        ]},
        { id: "team_size", label: "Team Size", type: "number", placeholder: "e.g. 8", min: 1, max: 200 },
        { id: "known_issues", label: "Known Open Issues", type: "textarea", placeholder: "List the current issues you're already aware of.", required: true, maxLength: 2500 },
        { id: "recently_resolved", label: "Recently Resolved (optional)", type: "textarea", placeholder: "Issues closed in the last period.", maxLength: 1000 },
        { id: "escalation_path", label: "Escalation Path", type: "text", placeholder: "e.g. PM → Sponsor → Steering Committee", maxLength: 200 }
      ]
    },
    project_closure: {
      brief: "A formal project closure report — outcomes vs charter, performance metrics, lessons, sign-off.",
      fields: [
        { id: "project_name", label: "Project Name", type: "text", placeholder: "e.g. Payments Platform v2", required: true, maxLength: 100 },
        { id: "sponsor", label: "Sponsor", type: "text", placeholder: "e.g. CFO Office", maxLength: 100 },
        { id: "pm_name", label: "Project Manager", type: "text", placeholder: "Your name/role", maxLength: 100 },
        { id: "start_date", label: "Project Start Date", type: "date" },
        { id: "end_date", label: "Project End Date (Actual)", type: "date", compareTo: "start_date", compareOp: "after" },
        { id: "objectives_recap", label: "Original Objectives", type: "textarea", placeholder: "What was the project's original mandate?", required: true, maxLength: 1200 },
        { id: "outcomes_delivered", label: "Outcomes Delivered", type: "textarea", placeholder: "What was actually delivered? Be specific.", required: true, maxLength: 1500 },
        { id: "scope_changes", label: "Scope Changes (added/cut)", type: "textarea", placeholder: "What was added via change requests, what was de-scoped.", maxLength: 1200 },
        { id: "planned_budget", label: "Planned Budget", type: "number", placeholder: "250000", min: 0, max: 1000000000 },
        { id: "actual_budget", label: "Actual Spend", type: "number", placeholder: "263500", min: 0, max: 1000000000 },
        { id: "currency", label: "Currency", type: "select", options: [
          "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "PKR", "Other"
        ]},
        { id: "key_lessons", label: "Top Lessons (optional)", type: "textarea", placeholder: "3–5 bullets — strategic insights worth remembering.", maxLength: 1200 },
        { id: "closure_status", label: "Closure Status", type: "select", options: [
          "Successful — fully delivered",
          "Partially successful — some objectives met",
          "Closed — incomplete delivery",
          "Cancelled — terminated mid-flight"
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
    budget: "Budget",
    lessons_learned: "Lessons Learned",
    change_request: "Change Request",
    issue_log: "Issue Log",
    project_closure: "Closure Report"
  };

  // ===================================================================
  // STATE
  // ===================================================================
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
    artifacts: [],      // list of {id, artifact_type, title, created_at}
    activeArtifact: null, // full artifact when viewing a saved one
    // Source document state: when the user uploads + extracts a doc, we keep
    // its text and metadata so the next /api/artifacts call can forward the
    // doc to the LLM as authoritative project context.
    uploadedDoc: null,        // { name, type, text }
    archiveFilter: '',        // text the user typed into the archive search
  };

  // ===================================================================
  // API CLIENT
  // ===================================================================
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

    const res = await fetch(path, { ...options, headers });

    // handle expired token — before tearing down state, snapshot in-flight
    // form values so the user can resume after re-login instead of losing
    // everything they had typed (audit H8).
    if (res.status === 401 && state.token) {
      snapshotFormForReauth();
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
    refreshHeaderConnectVisibility();
  }

  // Hide the header "🔌 Connect Claude" button when the user is already
  // signed in to the Claude CLI (it would just send them through OAuth again).
  // Shown otherwise so a fresh user has an obvious entry point.
  async function refreshHeaderConnectVisibility() {
    const btn = $('connect-claude-btn');
    if (!btn) return;
    try {
      const { config } = await api('/api/config');
      if (config && config.provider === 'claude-cli') {
        const status = await api('/api/config/cli/status').catch(() => null);
        if (status && status.authenticated) {
          btn.classList.add('hidden');
          return;
        }
      }
      btn.classList.remove('hidden');
    } catch {
      // If we can't fetch config, leave the button visible — fail open.
      btn.classList.remove('hidden');
    }
  }

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  // Capture the in-flight form so it survives a 401 → re-auth round trip.
  // Stored in sessionStorage (not localStorage) on purpose: a real new
  // browser session should start clean.
  function snapshotFormForReauth() {
    try {
      const dyn = document.getElementById('dynamic-fields');
      if (!dyn) return;
      const inputs = {};
      dyn.querySelectorAll('input, textarea, select').forEach(el => {
        if (el.dataset.key) inputs[el.dataset.key] = el.value;
      });
      const typeSel = document.getElementById('gen-type');
      const snapshot = {
        type: typeSel ? typeSel.value : null,
        inputs,
        at: Date.now(),
      };
      sessionStorage.setItem(FORM_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch { /* swallow — re-auth is best-effort */ }
  }

  // Restore the snapshot if one was taken in the last 15 minutes. Called
  // once after a successful login or signup.
  function maybeRestoreFormSnapshot() {
    try {
      const raw = sessionStorage.getItem(FORM_SNAPSHOT_KEY);
      if (!raw) return;
      sessionStorage.removeItem(FORM_SNAPSHOT_KEY);
      const snap = JSON.parse(raw);
      if (!snap || !snap.inputs) return;
      if (Date.now() - (snap.at || 0) > 15 * 60 * 1000) return;
      const typeSel = document.getElementById('gen-type');
      if (snap.type && typeSel && SCHEMAS[snap.type]) {
        typeSel.value = snap.type;
        renderFields();
      }
      Object.entries(snap.inputs).forEach(([k, v]) => {
        const el = document.getElementById('f_' + k);
        if (el && v) {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      toast('Restored your in-progress form');
    } catch { /* ignore */ }
  }

  function logout() {
    state.token = null;
    state.user = null;
    state.artifacts = [];
    state.activeArtifact = null;
    state.uploadedDoc = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    // Restore the header connect button — the next signed-in user shouldn't
    // inherit the previous user's hidden state.
    const headerConnect = $('connect-claude-btn');
    if (headerConnect) headerConnect.classList.remove('hidden');
    // Drop any in-flight OAuth tab handle.
    if (typeof oauthPopup !== 'undefined' && oauthPopup && !oauthPopup.closed) {
      try { oauthPopup.close(); } catch { /* ignore */ }
    }
    if (typeof oauthPopup !== 'undefined') oauthPopup = null;
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
      maybeRestoreFormSnapshot();
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
      maybeRestoreFormSnapshot();
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
  // MOBILE DRAWER (audit H3)
  // Below 960px the sidebar is positioned off-screen and slid in via the
  // hamburger button. The scrim provides a tap-to-dismiss affordance and
  // visually de-emphasizes the workspace while the drawer is open.
  // ===================================================================
  const sidebarEl = $('sidebar');
  const menuToggleBtn = $('menu-toggle');
  const drawerScrim = $('drawer-scrim');

  function openDrawer() {
    if (!sidebarEl) return;
    sidebarEl.classList.add('open');
    if (drawerScrim) drawerScrim.classList.add('open');
    if (menuToggleBtn) menuToggleBtn.setAttribute('aria-expanded', 'true');
  }

  function closeDrawer() {
    if (!sidebarEl) return;
    sidebarEl.classList.remove('open');
    if (drawerScrim) drawerScrim.classList.remove('open');
    if (menuToggleBtn) menuToggleBtn.setAttribute('aria-expanded', 'false');
  }

  // Used by archive-item click handlers so that navigating to an artifact
  // on mobile auto-dismisses the drawer (otherwise the user can't see the
  // content they just selected).
  function closeDrawerIfMobile() {
    if (window.matchMedia('(max-width: 960px)').matches) closeDrawer();
  }

  if (menuToggleBtn) {
    menuToggleBtn.addEventListener('click', () => {
      if (sidebarEl.classList.contains('open')) closeDrawer();
      else openDrawer();
    });
  }
  if (drawerScrim) drawerScrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebarEl?.classList.contains('open')) closeDrawer();
  });

  // ===================================================================
  // ARCHIVE SEARCH (audit H5)
  // ===================================================================
  const archiveSearchInput = $('archive-search-input');
  if (archiveSearchInput) {
    archiveSearchInput.addEventListener('input', () => {
      state.archiveFilter = archiveSearchInput.value;
      renderArchive();
    });
  }

  // ===================================================================
  // PASSWORD SHOW/HIDE TOGGLE (audit M5)
  // The toggle button lives inside .password-wrap and references the input
  // it controls via data-toggle="<input id>".
  // ===================================================================
  document.querySelectorAll('.password-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.toggle;
      const input = document.getElementById(targetId);
      if (!input) return;
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      const useEl = btn.querySelector('use');
      if (useEl) useEl.setAttribute('href', hidden ? '#i-eye-off' : '#i-eye');
    });
  });

  // ===================================================================
  // PASSWORD STRENGTH HINT (audit M4) — signup only.
  // Rough heuristic: length + character class diversity. We don't pretend
  // to score real entropy.
  // ===================================================================
  const signupPwd = $('signup-password');
  const signupStrength = $('signup-password-strength');
  if (signupPwd && signupStrength) {
    signupPwd.addEventListener('input', () => {
      const v = signupPwd.value;
      if (!v) {
        signupStrength.textContent = '8+ characters recommended';
        signupStrength.className = 'password-strength';
        return;
      }
      let score = 0;
      if (v.length >= 6) score++;
      if (v.length >= 10) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/\d/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      let label, cls;
      if (score <= 2) { label = 'Weak — try 10+ chars with mixed case'; cls = 'weak'; }
      else if (score <= 3) { label = 'Fair — add a number or symbol'; cls = 'fair'; }
      else { label = 'Good'; cls = 'good'; }
      signupStrength.textContent = label;
      signupStrength.className = 'password-strength ' + cls;
    });
  }

  // ===================================================================
  // KEYBOARD SHORTCUT HINT next to the Generate button (audit M6).
  // ===================================================================
  const kbdHint = $('kbd-hint');
  if (kbdHint) kbdHint.textContent = `${KBD_MOD}↵`;

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
    'claude-cli': [
      { value: '', label: 'CLI default (recommended)' },
      { value: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
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
    // Show/hide API key vs CLI status panels based on provider
    const apiKeyRow = $('config-api-key-row');
    const cliRow = $('config-cli-row');
    if (provider === 'claude-cli') {
      apiKeyRow.classList.add('hidden');
      cliRow.classList.remove('hidden');
      configTestBtn.textContent = 'Check CLI Status';
      // Reset the OAuth panel to its initial step every time claude-cli is selected
      if (typeof setOAuthStep === 'function') setOAuthStep('connect');
    } else {
      apiKeyRow.classList.remove('hidden');
      cliRow.classList.add('hidden');
      configTestBtn.textContent = 'Test Connection';
    }
  }

  function setCliStatusBadge(state, detail) {
    const badge = $('cli-status-badge');
    const detailEl = $('cli-status-detail');
    const map = {
      unknown:        { text: 'unknown',           color: 'var(--ghost)' },
      checking:       { text: 'checking…',         color: 'var(--cyan)' },
      ok:             { text: '✓ authenticated',   color: 'var(--green)' },
      not_installed:  { text: '✗ not installed',   color: 'var(--red)' },
      not_authed:     { text: '⚠ not logged in',   color: 'var(--amber)' },
      error:          { text: '✗ error',           color: 'var(--red)' },
    };
    const cfg = map[state] || map.unknown;
    badge.textContent = cfg.text;
    badge.style.background = cfg.color;
    badge.style.color = state === 'unknown' || state === 'checking' ? 'var(--ink-deep)' : 'var(--ink-deep)';
    if (detail) detailEl.textContent = detail;
  }

  async function loadConfig() {
    try {
      const { config } = await api('/api/config');
      configProvider.value = config.provider || 'claude';
      updateModelOptions();
      configModel.value = config.model || 'claude-sonnet-4-20250514';
      configApiKey.value = '';
      // If claude-cli is already the active provider, auto-check status so the
      // user sees the current state without having to click the button.
      if (config.provider === 'claude-cli') {
        configTestBtn.click();
      }
    } catch (err) {
      toast('Failed to load config: ' + err.message, 'error');
    }
  }

  $('settings-btn').addEventListener('click', () => {
    // Show Save & Deploy by default each time the modal opens; the CLI status
    // check will re-hide it if it confirms we're already authenticated.
    configSaveBtn.classList.remove('hidden');
    loadConfig();
    settingsModal.classList.remove('hidden');
  });

  // Any change to provider/model/api-key should re-show Save & Deploy, since
  // the user is now diverging from the persisted config and may need to save.
  function markConfigDirty() {
    configSaveBtn.classList.remove('hidden');
  }
  configProvider.addEventListener('change', markConfigDirty);
  configModel.addEventListener('change', markConfigDirty);
  configApiKey.addEventListener('input', markConfigDirty);

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

    if (provider === 'claude-cli') {
      // Different flow: query the backend's CLI health endpoint
      configTestBtn.disabled = true;
      setCliStatusBadge('checking', 'Asking the backend container…');
      configTestStatus.textContent = '';
      try {
        const status = await api('/api/config/cli/status');
        if (status.authenticated) {
          setCliStatusBadge('ok', `Ready. CLI replied: "${(status.response || '').slice(0, 80)}"`);
          configTestStatus.textContent = '✓ CLI ready';
          configTestStatus.style.color = 'var(--green)';
          // Already signed in: hide the Connect button (and the global header
          // Connect Claude button) so we don't prompt re-auth for no reason.
          if (typeof setOAuthStep === 'function') setOAuthStep('done');
          const headerConnect = $('connect-claude-btn');
          if (headerConnect) headerConnect.classList.add('hidden');
          // Already authenticated with claude-cli → there's nothing to save
          // here. Hide Save & Deploy until the user changes something.
          configSaveBtn.classList.add('hidden');
        } else if (!status.installed) {
          setCliStatusBadge('not_installed', status.error || 'Binary not found in container. Rebuild backend.');
          configTestStatus.textContent = '✗ Not installed';
          configTestStatus.style.color = 'var(--red)';
          if (typeof setOAuthStep === 'function') setOAuthStep('connect');
        } else {
          setCliStatusBadge('not_authed', status.error || 'Run `claude /login` inside the backend container.');
          configTestStatus.textContent = '⚠ Not logged in';
          configTestStatus.style.color = 'var(--amber)';
          if (typeof setOAuthStep === 'function') setOAuthStep('connect');
        }
      } catch (err) {
        setCliStatusBadge('error', err.message);
        configTestStatus.textContent = '✗ Check failed';
        configTestStatus.style.color = 'var(--red)';
      } finally {
        configTestBtn.disabled = false;
      }
      return;
    }

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

    if (provider !== 'claude-cli' && !apiKey) {
      toast('API key is required', 'error');
      return;
    }

    configSaveBtn.disabled = true;
    configTestBtn.disabled = true;

    try {
      const body = { provider, model };
      if (provider !== 'claude-cli') body.api_key = apiKey;
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      // No backend restart — the config row is read on every API call, so the
      // change takes effect on the next /api/artifacts request. Don't reload
      // the page; that would silently wipe the user's in-progress form
      // (audit C3).
      toast('Configuration saved');
      settingsModal.classList.add('hidden');
      refreshHeaderConnectVisibility();
    } catch (err) {
      toast('Failed to save config: ' + err.message, 'error');
    } finally {
      configSaveBtn.disabled = false;
      configTestBtn.disabled = false;
    }
  });

  // ===================================================================
  // CLAUDE CLI OAUTH (in-app flow)
  // ===================================================================
  let oauthSessionId = null;
  let oauthPopup = null; // reference to the last opened browser tab, so we can re-focus instead of opening another

  function setOAuthStep(step) {
    const stepConnect = $('oauth-step-connect');
    const stepCode    = $('oauth-step-code');
    const stepDone    = $('oauth-step-done');
    if (!stepConnect) return; // panel not in DOM yet
    [stepConnect, stepCode, stepDone].forEach(el => el && el.classList.add('hidden'));
    if (step === 'connect') stepConnect.classList.remove('hidden');
    else if (step === 'code') stepCode.classList.remove('hidden');
    else if (step === 'done') stepDone.classList.remove('hidden');
  }

  async function startOAuthFlow() {
    const btn = $('oauth-connect-btn');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    setCliStatusBadge('checking', 'Asking Anthropic for the authorization URL…');
    try {
      const { sessionId, url, reused } = await api('/api/config/cli/oauth/start', { method: 'POST', body: '{}' });
      oauthSessionId = sessionId;
      const link = $('oauth-url-link');
      link.href = url;
      link.textContent = url;
      // If we already have an open popup for an active session, focus it
      // instead of opening another. This prevents the user from authorizing
      // in a stale tab whose PKCE no longer matches.
      if (oauthPopup && !oauthPopup.closed) {
        try { oauthPopup.location.href = url; } catch { /* cross-origin after auth — fall through */ }
        try { oauthPopup.focus(); } catch { /* ignore */ }
      } else {
        // Drop `noopener` so we keep a handle and can re-focus / replace on retry.
        oauthPopup = window.open(url, '_blank');
        if (!oauthPopup) toast('Browser blocked the popup — click the URL link in the dialog instead', 'error');
      }
      setOAuthStep('code');
      $('oauth-code-input').focus();
      const banner = reused
        ? 'Reusing your earlier authorization URL (still valid). Authorize in the open tab, then paste the code below.'
        : 'Waiting for you to authorize in the new tab…';
      setCliStatusBadge('checking', banner);
    } catch (err) {
      toast('Connect failed: ' + err.message, 'error');
      setCliStatusBadge('error', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '▸ Connect with Claude';
    }
  }

  async function submitOAuthCode() {
    if (!oauthSessionId) { toast('No active OAuth session', 'error'); return; }
    const code = $('oauth-code-input').value.trim();
    if (!code) { toast('Paste the code from Anthropic first', 'error'); return; }
    const btn = $('oauth-submit-btn');
    const status = $('oauth-submit-status');
    btn.disabled = true;
    btn.textContent = 'Authenticating…';
    status.textContent = '';
    status.style.display = 'none';
    try {
      const model = configModel.value || '';
      await api('/api/config/cli/oauth/submit', {
        method: 'POST',
        body: JSON.stringify({ sessionId: oauthSessionId, code, model }),
      });
      oauthSessionId = null;
      // Connected — close the popup tab if we still have a handle, so the
      // user isn't left with an orphaned Anthropic page.
      if (oauthPopup && !oauthPopup.closed) {
        try { oauthPopup.close(); } catch { /* ignore */ }
      }
      oauthPopup = null;
      setOAuthStep('done');
      setCliStatusBadge('ok', 'Connected.');
      toast('Claude CLI connected — provider set to claude-cli');
      // Now that we're signed in, drop the header reauth button.
      const headerConnect = $('connect-claude-btn');
      if (headerConnect) headerConnect.classList.add('hidden');
      // Refresh /api/config so the next time the modal opens we reflect the new active provider
      setTimeout(() => { settingsModal.classList.add('hidden'); }, 1200);
    } catch (err) {
      status.textContent = '✗ ' + err.message;
      status.style.color = 'var(--red)';
      status.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Authenticate';
    }
  }

  // Wire OAuth buttons (panel exists from page load, hidden until claude-cli is chosen)
  const oauthConnectBtn = $('oauth-connect-btn');
  if (oauthConnectBtn) oauthConnectBtn.addEventListener('click', startOAuthFlow);
  const oauthSubmitBtn = $('oauth-submit-btn');
  if (oauthSubmitBtn) oauthSubmitBtn.addEventListener('click', submitOAuthCode);
  const oauthCodeInput = $('oauth-code-input');
  if (oauthCodeInput) oauthCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitOAuthCode(); }
  });

  // Header "Connect Claude" button: open settings modal with claude-cli pre-selected
  const connectClaudeBtn = $('connect-claude-btn');
  if (connectClaudeBtn) {
    connectClaudeBtn.addEventListener('click', async () => {
      await loadConfig();
      configProvider.value = 'claude-cli';
      updateModelOptions();
      // Reset OAuth UI to step 1 every time the modal opens via this button
      setOAuthStep('connect');
      oauthSessionId = null;
      settingsModal.classList.remove('hidden');
    });
  }

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
      wrap.dataset.fieldId = f.id;

      const lab = document.createElement('label');
      lab.setAttribute('for', 'f_' + f.id);
      const counterMarkup = f.maxLength
        ? ` <span class="char-count" id="cc_${f.id}">0/${f.maxLength}</span>`
        : '';
      lab.innerHTML = f.label + (f.required ? ' <span class="req">*</span>' : '') + counterMarkup;
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
      if (f.maxLength != null) input.maxLength = f.maxLength;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.compareTo) {
        input.dataset.compareTo = f.compareTo;
        input.dataset.compareOp = f.compareOp || 'after';
      }
      wrap.appendChild(input);

      const err = document.createElement('div');
      err.className = 'field-error hidden';
      err.id = 'err_' + f.id;
      wrap.appendChild(err);

      // live counter + auto-clear errors on typing
      if (f.maxLength) {
        const cc = $('cc_' + f.id);
        const updateCounter = () => {
          const len = (input.value || '').length;
          cc.textContent = `${len}/${f.maxLength}`;
          cc.classList.toggle('near-limit', len >= f.maxLength * 0.9);
        };
        input.addEventListener('input', updateCounter);
      }
      input.addEventListener('input', () => clearFieldError(f.id));
      input.addEventListener('change', () => clearFieldError(f.id));

      dynWrap.appendChild(wrap);
    });
  }

  genSelect.addEventListener('change', renderFields);

  function setFieldError(fieldId, message) {
    const wrap = dynWrap.querySelector(`[data-field-id="${fieldId}"]`);
    if (!wrap) return;
    wrap.classList.add('has-error');
    const err = $('err_' + fieldId);
    if (err) {
      err.textContent = message;
      err.classList.remove('hidden');
    }
  }

  function clearFieldError(fieldId) {
    const wrap = dynWrap.querySelector(`[data-field-id="${fieldId}"]`);
    if (!wrap) return;
    wrap.classList.remove('has-error');
    const err = $('err_' + fieldId);
    if (err) {
      err.textContent = '';
      err.classList.add('hidden');
    }
  }

  function clearAllFieldErrors() {
    dynWrap.querySelectorAll('.field.has-error').forEach(w => w.classList.remove('has-error'));
    dynWrap.querySelectorAll('.field-error').forEach(e => {
      e.textContent = '';
      e.classList.add('hidden');
    });
  }

  function validateField(f, value, allValues) {
    if (f.required && !value) return `${f.label} is required.`;
    if (!value) return null;
    if (f.maxLength && value.length > f.maxLength) {
      return `Too long — max ${f.maxLength} characters (${value.length}).`;
    }
    if (f.type === 'number') {
      const n = Number(value);
      if (Number.isNaN(n)) return 'Must be a number.';
      if (f.min != null && n < f.min) return `Must be at least ${f.min}.`;
      if (f.max != null && n > f.max) return `Must be at most ${f.max}.`;
    }
    if ((f.type === 'date' || f.type === 'datetime-local') && f.compareTo) {
      const other = (allValues[f.compareTo] || '').trim();
      if (other) {
        const a = new Date(value);
        const b = new Date(other);
        if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
          const op = f.compareOp || 'after';
          if (op === 'after' && a <= b) return `Must be after the ${f.compareTo.replace(/_/g, ' ')}.`;
          if (op === 'before' && a >= b) return `Must be before the ${f.compareTo.replace(/_/g, ' ')}.`;
        }
      }
    }
    if (f.type === 'date' && f.id === 'report_date') {
      const today = new Date(); today.setHours(23, 59, 59, 999);
      const d = new Date(value);
      if (!Number.isNaN(d.getTime()) && d > today) return 'Report date cannot be in the future.';
    }
    return null;
  }

  function collectInputs() {
    const schema = SCHEMAS[genSelect.value];
    const inputs = {};
    schema.fields.forEach(f => {
      const el = $('f_' + f.id);
      inputs[f.id] = (el.value || '').trim();
    });

    clearAllFieldErrors();
    const errors = [];
    schema.fields.forEach(f => {
      const msg = validateField(f, inputs[f.id], inputs);
      if (msg) {
        setFieldError(f.id, msg);
        errors.push({ id: f.id, label: f.label, msg });
      }
    });

    return { inputs, errors, type: genSelect.value };
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

    // Apply the in-memory archive filter (audit H5). The filter matches
    // title or the human-readable type label, case-insensitive.
    const q = (state.archiveFilter || '').trim().toLowerCase();
    const items = q
      ? state.artifacts.filter(a => {
          const title = (a.title || '').toLowerCase();
          const typeLabel = (TYPE_LABEL[a.artifact_type] || a.artifact_type || '').toLowerCase();
          return title.includes(q) || typeLabel.includes(q);
        })
      : state.artifacts;

    count.textContent = q
      ? `${items.length}/${state.artifacts.length}`
      : `${state.artifacts.length} item${state.artifacts.length === 1 ? '' : 's'}`;

    if (!items.length) {
      list.innerHTML = q
        ? `<div class="archive-empty">No matches.<small>try a different filter →</small></div>`
        : `<div class="archive-empty">No artifacts yet.<small>generate your first one →</small></div>`;
      return;
    }

    // Trash icon SVG reused per row. Kept inline so we don't depend on the
    // sprite being available before this fragment is parsed.
    const trashSvg = `<svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>`;

    list.innerHTML = items.map(a => {
      const revTag = a.revision && a.revision > 1 ? ` · v${a.revision}` : '';
      return `
      <div class="archive-item ${state.activeArtifact?.id === a.id ? 'active' : ''}" data-id="${a.id}">
        <div class="a-type">${TYPE_LABEL[a.artifact_type] || a.artifact_type}${revTag}</div>
        <div class="a-title">${escapeHtml(a.title)}</div>
        <div class="a-date">${formatDate(a.created_at)}</div>
        <button class="a-delete" data-id="${a.id}" title="Delete artifact" aria-label="Delete ${escapeHtml(a.title)}">${trashSvg}</button>
      </div>
    `;
    }).join('');

    list.querySelectorAll('.archive-item').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't open if the click landed on the delete button.
        if (e.target.closest('.a-delete')) return;
        openArtifact(Number(el.dataset.id));
        closeDrawerIfMobile();
      });
    });

    list.querySelectorAll('.a-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.id);
        const target = state.artifacts.find(a => a.id === id);
        const label = target ? `"${target.title}"` : 'this artifact';
        if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
        try {
          await api(`/api/artifacts/${id}`, { method: 'DELETE' });
          state.artifacts = state.artifacts.filter(a => a.id !== id);
          // If we just deleted the artifact currently being viewed, reset
          // the output panel to its empty state so the user isn't left
          // staring at content that no longer exists.
          if (state.activeArtifact?.id === id) {
            state.activeArtifact = null;
            resetOutput();
          }
          renderArchive();
          toast('Artifact deleted');
        } catch (err) {
          toast('Delete failed: ' + err.message, 'error');
        }
      });
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
          if (el) {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
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
    state.uploadedDoc = null;
    renderArchive();
    resetOutput();
    dynWrap.querySelectorAll('input, textarea').forEach(el => el.value = '');
    if (uploadHint) {
      uploadHint.textContent = '';
      uploadHint.style.color = '';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ===================================================================
  // DEPLOY / GENERATE
  // ===================================================================
  const deployBtn = $('deploy-btn');

  async function deploy() {
    const { inputs, errors, type } = collectInputs();
    if (errors.length) {
      const summary = errors.map(e => `${e.label}: ${e.msg}`).join('\n');
      renderError(`Please fix ${errors.length} field${errors.length === 1 ? '' : 's'}:\n${summary}`);
      // scroll to the first error
      const firstWrap = dynWrap.querySelector('.field.has-error');
      if (firstWrap) firstWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    deployBtn.disabled = true;
    dynWrap.classList.add('deploying');
    $('input-status').textContent = 'drafting…';
    hideOutputActions();
    renderThinking();

    try {
      // Forward the uploaded source document iff it matches the currently
      // selected artifact type. If the user switched type after uploading,
      // drop it rather than confuse the model with a doc about something else.
      const docForType =
        state.uploadedDoc && state.uploadedDoc.type === type
          ? state.uploadedDoc.text
          : undefined;

      const { artifact } = await api('/api/artifacts', {
        method: 'POST',
        body: JSON.stringify({
          artifact_type: type,
          title: inferTitle(type, inputs),
          inputs,
          methodology: getMethodology() || undefined,
          source_document: docForType
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
      dynWrap.classList.remove('deploying');
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

  function matchSelectOption(selectEl, value) {
    const raw = String(value).trim();
    if (!raw) return null;
    const opts = Array.from(selectEl.options).map(o => o.value);
    const exact = opts.find(o => o === raw);
    if (exact) return exact;
    const ci = opts.find(o => o.toLowerCase() === raw.toLowerCase());
    if (ci) return ci;
    const lower = raw.toLowerCase();
    const sub = opts.find(o => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
    return sub || null;
  }

  function coerceForInput(inputType, value) {
    if (value == null) return '';
    const s = String(value).trim();
    if (!s) return '';
    if (inputType === 'number') {
      // strip currency symbols, commas, units — keep digits, dot, minus
      const cleaned = s.replace(/[^\d.\-]/g, '');
      return cleaned;
    }
    if (inputType === 'date') {
      // already YYYY-MM-DD?
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      }
      return '';
    }
    if (inputType === 'datetime-local') {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
      }
      return '';
    }
    return s;
  }

  function showDocMismatchDialog({ filename, artifactType, reason }) {
    const modal = $('doc-mismatch-modal');
    if (!modal) return;
    $('doc-mismatch-filename').textContent = filename || 'this document';
    $('doc-mismatch-type').textContent = (TYPE_LABEL[artifactType] || artifactType || 'the selected artifact');
    $('doc-mismatch-reason').textContent = reason || 'It does not look like a project document that fits the selected artifact type.';
    modal.classList.remove('hidden');
  }

  function closeDocMismatchDialog() {
    const modal = $('doc-mismatch-modal');
    if (modal) modal.classList.add('hidden');
  }

  // Wire the mismatch dialog dismiss buttons once (modal stays in the DOM).
  ['doc-mismatch-close', 'doc-mismatch-cancel'].forEach(id => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', closeDocMismatchDialog);
  });
  const docMismatchBackdrop = document.querySelector('#doc-mismatch-modal .modal-backdrop');
  if (docMismatchBackdrop) docMismatchBackdrop.addEventListener('click', closeDocMismatchDialog);
  const docMismatchRetryBtn = $('doc-mismatch-retry');
  if (docMismatchRetryBtn) {
    docMismatchRetryBtn.addEventListener('click', () => {
      closeDocMismatchDialog();
      uploadFileInput.value = '';
      uploadFileInput.click();
    });
  }

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

      const body = await res.json().catch(() => ({}));

      // Document-mismatch path: backend confirmed the doc doesn't fit the
      // selected artifact type. Show a dialog instead of a toast so the user
      // can read the reason and choose to try a different file.
      if (!res.ok) {
        if (res.status === 422 && body && body.error === 'document_mismatch') {
          // Wipe any prior uploaded doc — we don't want a mismatched doc
          // leaking into the next generation.
          state.uploadedDoc = null;
          uploadHint.textContent = `✗ ${file.name} doesn't fit "${TYPE_LABEL[type] || type}"`;
          uploadHint.style.color = 'var(--red)';
          showDocMismatchDialog({
            filename: body.filename || file.name,
            artifactType: body.artifact_type || type,
            reason: body.mismatch_reason,
          });
          return;
        }
        throw new Error((body && body.error) || `Extraction failed (HTTP ${res.status})`);
      }

      const { fields, source_document: sourceDoc } = body;

      // Persist the document text so Generate forwards it to the LLM.
      if (sourceDoc && String(sourceDoc).trim()) {
        state.uploadedDoc = { name: file.name, type, text: String(sourceDoc) };
      } else {
        state.uploadedDoc = null;
      }

      let filled = 0;
      let skipped = 0;
      Object.entries(fields || {}).forEach(([key, value]) => {
        const el = document.getElementById('f_' + key);
        if (!el || value == null || String(value).trim() === '') return;

        let toAssign;
        if (el.tagName === 'SELECT') {
          toAssign = matchSelectOption(el, value);
          if (!toAssign) { skipped++; return; }
        } else {
          toAssign = coerceForInput(el.type, value);
          if (!toAssign) { skipped++; return; }
          // respect maxLength so we don't trip char counters
          if (el.maxLength > 0 && toAssign.length > el.maxLength) {
            toAssign = toAssign.slice(0, el.maxLength);
          }
        }

        el.value = toAssign;
        // fire input + change so char counters and validators update
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      });

      const skippedNote = skipped > 0 ? ` (${skipped} skipped — no good match)` : '';
      const docNote = state.uploadedDoc ? ' · document attached to next generation' : '';
      if (filled === 0) {
        uploadHint.textContent = `⚠ Read ${file.name} but nothing matched the form fields${skippedNote}${docNote}`;
        uploadHint.style.color = state.uploadedDoc ? 'var(--amber)' : 'var(--amber)';
        toast(
          state.uploadedDoc
            ? 'Document attached — fields could not be auto-filled, but Claude will see the document on Generate'
            : 'Document read, but no fields could be auto-filled',
          state.uploadedDoc ? 'success' : 'error'
        );
      } else {
        uploadHint.textContent = `✓ Filled ${filled} field${filled !== 1 ? 's' : ''} from ${file.name}${skippedNote}${docNote}`;
        uploadHint.style.color = 'var(--green)';
        toast(`Auto-filled ${filled} field${filled !== 1 ? 's' : ''} from document`);
      }
    } catch (err) {
      state.uploadedDoc = null;
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

  // Honest loading state. The previous version cycled through a fake list of
  // steps and named a hardcoded model ("Drafting with claude-sonnet-4")
  // regardless of which provider/model the user had selected (audit C2).
  // Now we show generic animated bars + a single neutral line — and we keep
  // the interval id so it can be cleared deterministically (audit M11).
  function clearThinking() {
    if (thinkingInterval !== null) {
      clearInterval(thinkingInterval);
      thinkingInterval = null;
    }
  }

  function renderThinking() {
    clearThinking();
    outputBody.innerHTML = `
      <div class="thinking" role="status" aria-live="polite">
        <span class="bars" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>
        Drafting artifact…
      </div>
    `;
  }

  function renderError(message) {
    clearThinking();
    outputBody.innerHTML = `<div class="err-box" role="alert"><b>Error</b>${escapeHtml(message).replace(/\n/g, '<br>')}</div>`;
    hideOutputActions();
  }

  async function renderOutput(artifact) {
    clearThinking();
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
    loadRevisions(artifact);
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
    const idTag = `A-${String(artifact.id).padStart(3, '0')}`;
    const rev = artifact.revision && artifact.revision > 1
      ? `${idTag} · v${artifact.revision}`
      : idTag;
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

  // Populate the revisions dropdown for the active artifact's chain.
  async function loadRevisions(artifact) {
    const sel = $('revisions-select');
    sel.innerHTML = '';
    sel.classList.add('hidden');
    if (!artifact || !artifact.id) return;
    try {
      const { revisions } = await api(`/api/artifacts/${artifact.id}/revisions`);
      if (!revisions || revisions.length < 2) return;
      sel.innerHTML = revisions.map(r => {
        const label = `v${r.revision}` + (r.revision === 1 ? ' · original' : '');
        const isSelected = r.id === artifact.id ? ' selected' : '';
        return `<option value="${r.id}"${isSelected}>${label}</option>`;
      }).join('');
      sel.classList.remove('hidden');
    } catch (err) {
      console.warn('failed to load revisions', err);
    }
  }

  $('revisions-select').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    if (Number.isInteger(id) && id !== state.activeArtifact?.id) openArtifact(id);
  });

  function showOutputActions() {
    $('copy-btn').classList.remove('hidden');
    $('edit-btn').classList.remove('hidden');
    $('download-btn').classList.remove('hidden');
    $('refine-btn').classList.remove('hidden');
  }

  function hideOutputActions() {
    ['copy-btn', 'edit-btn', 'download-btn', 'refine-btn'].forEach(id => $(id).classList.add('hidden'));
    const sel = $('revisions-select');
    sel.classList.add('hidden');
    sel.innerHTML = '';
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

  // ===================================================================
  // REFINE (revisions)
  // ===================================================================
  const refineModal = $('refine-modal');
  const refineInstructions = $('refine-instructions');
  const refineSubmit = $('refine-submit');

  function openRefine() {
    if (!state.activeArtifact) return;
    const a = state.activeArtifact;
    const label = TYPE_LABEL[a.artifact_type] || a.artifact_type;
    const v = a.revision && a.revision > 1 ? ` · v${a.revision}` : '';
    $('refine-context').textContent = `${label}: ${a.title}${v}`;
    refineInstructions.value = '';
    // Submit stays disabled until the user actually types refinement
    // instructions (audit M9). Avoids the "click submit → toast says you
    // need to type something" race.
    refineSubmit.disabled = true;
    refineModal.classList.remove('hidden');
    setTimeout(() => refineInstructions.focus(), 50);
  }

  function closeRefine() {
    refineModal.classList.add('hidden');
  }

  $('refine-btn').addEventListener('click', openRefine);
  $('refine-close').addEventListener('click', closeRefine);
  $('refine-cancel').addEventListener('click', closeRefine);
  refineModal.querySelector('.modal-backdrop').addEventListener('click', closeRefine);
  refineInstructions.addEventListener('input', () => {
    refineSubmit.disabled = refineInstructions.value.trim().length === 0;
  });

  refineSubmit.addEventListener('click', async () => {
    const instructions = refineInstructions.value.trim();
    if (!instructions) {
      toast('Please describe what to change', 'error');
      return;
    }
    if (!state.activeArtifact) return;

    refineSubmit.disabled = true;
    refineSubmit.textContent = 'Drafting…';
    const sourceId = state.activeArtifact.id;

    try {
      const { artifact } = await api(`/api/artifacts/${sourceId}/revise`, {
        method: 'POST',
        body: JSON.stringify({
          instructions,
          methodology: getMethodology() || undefined
        })
      });
      state.activeArtifact = artifact;
      state.artifacts.unshift({
        id: artifact.id,
        artifact_type: artifact.artifact_type,
        title: artifact.title,
        parent_id: artifact.parent_id,
        revision: artifact.revision,
        created_at: artifact.created_at
      });
      renderArchive();
      await renderOutput(artifact);
      closeRefine();
      toast(`Revision v${artifact.revision} saved`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      refineSubmit.disabled = false;
      refineSubmit.textContent = '▸ Generate Revision';
    }
  });


  // export artifact
  const downloadBtn = $('download-btn');
  // The old implementation overlaid an opacity:0 native <select> on top of
  // the visible button. That was inaccessible for keyboard and screen
  // reader users, and looked unstyled. We now use a proper popover menu
  // composed of <button class="menu-item"> elements (audit M10).
  const downloadMenu = $('download-menu');

  function getSafeName() {
    return (state.activeArtifact?.title || 'artifact')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  function closeDownloadMenu() {
    if (!downloadMenu) return;
    downloadMenu.classList.add('hidden');
    downloadBtn.setAttribute('aria-expanded', 'false');
  }

  downloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = downloadMenu.classList.contains('hidden');
    downloadMenu.classList.toggle('hidden');
    downloadBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });

  // Close the menu on outside click and Escape.
  document.addEventListener('click', (e) => {
    if (!downloadMenu || downloadMenu.classList.contains('hidden')) return;
    if (downloadMenu.contains(e.target) || downloadBtn.contains(e.target)) return;
    closeDownloadMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDownloadMenu();
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
    'budget': ['markdown', 'excel', 'csv', 'generic', 'googlesheets'],
    'lessons_learned': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'googlesheets', 'notion'],
    'change_request': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'jira', 'azure'],
    'issue_log': ['markdown', 'excel', 'csv', 'generic', 'confluence', 'googlesheets', 'jira', 'azure', 'linear'],
    'project_closure': ['markdown', 'excel', 'generic', 'confluence', 'notion']
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

  // Show/hide menu items based on the current artifact type. Items that
  // don't apply (e.g. "Jira Issues" for a retrospective) are hidden via the
  // `hidden` HTML attribute, which CSS turns into `display: none`.
  function updateExportOptions(artifactType) {
    if (!downloadMenu) return;
    const allowedFormats = artifactTypeFormats[artifactType] || Object.keys(formatExtensions);
    downloadMenu.querySelectorAll('.menu-item').forEach(item => {
      const format = item.dataset.format;
      if (allowedFormats.includes(format)) item.removeAttribute('hidden');
      else item.setAttribute('hidden', '');
    });
    // Hide group labels whose entire group is empty.
    downloadMenu.querySelectorAll('.group-label').forEach(label => {
      let sibling = label.nextElementSibling;
      let anyVisible = false;
      while (sibling && !sibling.classList.contains('group-label')) {
        if (sibling.classList.contains('menu-item') && !sibling.hasAttribute('hidden')) {
          anyVisible = true; break;
        }
        sibling = sibling.nextElementSibling;
      }
      label.style.display = anyVisible ? 'block' : 'none';
    });
  }

  async function downloadAs(format) {
    if (!state.activeArtifact) return;
    const safeName = getSafeName() || 'artifact';
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
      toast(`Downloaded as ${format.toUpperCase()}`);
    } catch (err) {
      console.error('Download error:', err);
      toast('Download failed: ' + err.message, 'error');
    } finally {
      downloadBtn.disabled = false;
      closeDownloadMenu();
    }
  }

  if (downloadMenu) {
    downloadMenu.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', () => downloadAs(item.dataset.format));
    });
  }


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
    // Editorial palette — cream / graphite / sepia. Mermaid takes raw hex,
    // not CSS variables, so we mirror the tokens here. Update both this
    // map and styles.css together when the palette changes.
    const themes = {
      light: {
        background: '#F1ECE2',
        primaryColor: '#B54F0A',
        primaryTextColor: '#0C0A09',
        primaryBorderColor: '#B54F0A',
        lineColor: '#A8A29E',
        secondaryColor: '#FEF3EC',
        tertiaryColor: '#FFFFFF',
      },
      dark: {
        background: '#221E1A',
        primaryColor: '#ED8936',
        primaryTextColor: '#FAFAF7',
        primaryBorderColor: '#ED8936',
        lineColor: '#847D75',
        secondaryColor: '#3F2A18',
        tertiaryColor: '#28231F',
      },
      midnight: {
        background: '#F5EFE0',
        primaryColor: '#92400E',
        primaryTextColor: '#2D1F09',
        primaryBorderColor: '#92400E',
        lineColor: '#A18560',
        secondaryColor: '#FDE9C7',
        tertiaryColor: '#FDFBF5',
      }
    };
    try {
      mermaid.initialize({
        startOnLoad: false,
        // "midnight" is sepia (light), so use default theme not dark.
        theme: theme === 'dark' ? 'dark' : 'default',
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
  // VERSION (audit M3)
  // The auth-footer used to hardcode "v0.6.0", which silently drifted on
  // every bump. Now we fetch it from /api/version at boot.
  // ===================================================================
  async function loadVersion() {
    const el = $('app-version');
    if (!el) return;
    try {
      const r = await fetch('/api/version');
      if (!r.ok) return;
      const { version } = await r.json();
      if (version) el.textContent = `v${version}`;
    } catch { /* leave the placeholder; version is non-critical */ }
  }

  // ===================================================================
  // BOOT
  // ===================================================================
  renderFields();
  loadVersion();
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
