// Prompts for each PM artifact type.
// Keeping these server-side means the client only sends (type, inputs) — not the prompt.

const SYSTEM_PROMPT =
  "You are a senior project manager / PMO expert with 15+ years of experience " +
  "across software, operations, and cross-functional delivery. Be concrete, " +
  "opinionated, and practical. Prefer specifics over generalities. When inputs " +
  "are missing, make reasonable assumptions and flag them — never ask the user " +
  "follow-up questions. Output clean, well-structured markdown only.";

const INSTRUCTIONS = {
  project_plan: `Produce a complete Project Charter using markdown with these sections:

## Executive Summary
2–3 sentences. Reference the sponsor and the business driver.
## Objectives & Success Criteria
Specific, measurable outcomes. If success_metrics inputs are provided, use them verbatim. Map each objective to its success metric.
## Scope
Two subsections: **In Scope** and **Out of Scope** (bulleted). If out_of_scope was provided, expand it into explicit exclusions.
## Deliverables
Numbered list of concrete deliverables.
## Phases & Milestones
A markdown table: Phase | Duration | Key Milestone | Exit Criteria.
## Team & Roles
Roles needed and headcount. If team_size is provided, distribute across roles realistically.
## Governance & Decision-Making
Sponsor, steering committee (if any), CCB threshold (which changes need formal approval), reporting cadence.
## Budget Envelope
If budget_envelope is provided, show a rough split across People / Tools / Vendors / Contingency. Otherwise note "to be sized in budget artifact."
## Top Risks
Top 3–5 risks with one-line mitigation each. Calibrate framing to the risk_appetite input.
## Assumptions
What you're assuming to be true.

Be concrete and practical. If key inputs are missing, make reasonable assumptions and flag them clearly.`,

  timeline: `Produce a phased timeline. Output in this order:

## Overview
2 sentences on the timeline approach.

## Gantt Chart
A mermaid gantt diagram in a \`\`\`mermaid block. Use real dates derived from the start/end dates provided. Include phases and milestones. Example:
\`\`\`mermaid
gantt
    title Project Timeline
    dateFormat YYYY-MM-DD
    section Phase 1
    Task A :a1, 2026-05-01, 14d
    Milestone :milestone, m1, after a1, 0d
\`\`\`

## Milestone Table
Markdown table: Milestone | Target Date | Owner | Dependencies.

## Critical Path Notes
2–4 bullets on the riskiest dependencies in the schedule. If external_dependencies were listed, call out which ones sit on the critical path.

## Buffer & Contingency
1–2 paragraphs reflecting the chosen buffer_strategy. If "Critical-chain", show a pooled buffer line at the end of the Gantt. If "Fixed", note the per-phase reserve. Otherwise explain the trade-off the team is accepting.

## Capacity Sanity Check
If team_capacity is provided, briefly reconcile total estimated effort against (capacity × duration). Flag any over-commitment.`,

  wbs: `Produce a Work Breakdown Structure.

## WBS
A nested markdown list at the requested depth using numbered format:
- **1. Workstream Name**
  - 1.1 Task
    - 1.1.1 Subtask

Cover the full scope. Skip sections that genuinely don't apply.

## WBS Dictionary (top-level only)
A table: ID | Workstream | Deliverable | Owner Role | Estimated Effort.
Effort units must follow the estimation_method (story points, person-days, T-shirt size, PERT-weighted days, etc.).

## Estimation Notes
1 paragraph explaining the estimation_method used and the confidence level. If "Three-point (PERT)", show the formula (O + 4M + P)/6 applied to one workstream as a worked example.

## Notes
2–3 bullets on sequencing or dependencies between workstreams.`,

  risk_register: `Produce a Risk Register.

## Risk Register
A markdown table with these columns: ID | Risk | Category | Likelihood (L/M/H) | Impact (L/M/H) | Score | Mitigation | Owner Role | Trigger Signal.

Generate 8–12 risks. Cover: delivery, technical, people, external/vendor, scope, compliance. Order by Score descending (HxH = 9, HxM = 6, etc.).

## Top 3 — Deep Dive
For the top 3 risks, a short paragraph each: what could go wrong, early warning signs, primary mitigation.

## Watchlist
2–4 lower-severity risks to monitor.

## Compliance & Regulatory Risks
If compliance_context was provided, dedicate a small subsection (1–3 risks) covering compliance-specific exposure (data, audit, certification, statutory deadlines). Otherwise omit.

## Industry Considerations
If industry was provided, include 1–2 risks specific to that domain (e.g. clinical-trial slip in healthcare, AML/KYC change in fintech).`,

  raci: `Produce a RACI matrix.

## RACI Matrix
Markdown table. First column is the activity. Subsequent columns are the roles provided. Each cell contains R, A, C, I, or is blank.

Rules (strict):
- Every row has exactly ONE A (Accountable).
- Every row has at least ONE R (Responsible).
- Don't overload with C's — only list Consulted when their input is genuinely needed.
- Blank cells are fine.

## Legend & Notes
Recap R / A / C / I definitions. Flag 2–3 rows where the assignments are subtle or likely to be debated.

## Decision Rights (governance_level-aware)
A short table: Decision | Decider | Escalation | Authority Limit.
Tone the decisions to the governance_level input (tactical = operational decisions; strategic = budget reallocation, scope shifts, vendor selection).`,

  status_report: `Produce a weekly status report — executive-readable in under 60 seconds.

# {Project Name} — Status Report
**Period:** ...  **Overall:** 🟢/🟡/🔴

## Headline
One sentence summary of where things stand.

## Progress This Period
Bulleted, specific. Completed items only.

## Planned for Next Period
Bulleted, specific.

## Risks & Issues
Table: Item | Severity | Status | Owner | Needed From Sponsor.

## Decisions Needed
Bulleted list of explicit asks with a decision deadline. If none, say "None this week."

## Metrics Snapshot
If kpis input was provided, render those values verbatim in a compact table; otherwise infer 2–4 sensible metrics from context. Always include schedule_status and budget_status as their own row if those inputs were given.

## Audience-Tailoring Note
At the very end, in a single italic line, note the target audience (audience input). This signals whether the report is exec-ready (terse, KPI-led) or working-team detail (granular).`,

  stakeholder_map: `Produce a stakeholder analysis.

## Power / Interest Grid
A mermaid quadrantChart placing each stakeholder:
\`\`\`mermaid
quadrantChart
    title Power / Interest Grid
    x-axis Low Interest --> High Interest
    y-axis Low Power --> High Power
    quadrant-1 Manage Closely
    quadrant-2 Keep Satisfied
    quadrant-3 Monitor
    quadrant-4 Keep Informed
    Maria Chen: [0.8, 0.9]
\`\`\`

## Stakeholder Register
Table: Stakeholder | Role | Power | Interest | Current Stance (Supporter/Neutral/Skeptic) | Engagement Strategy | Cadence.

## Key Watch-Outs
2–4 bullets on political dynamics to plan around. If known_blockers was provided, address each one head-on with a mitigation tactic.

## Change-Type Considerations
1 short paragraph reflecting primary_change_type. For "Org/restructure" emphasize union/HR consultation; for "Customer-facing" emphasize external comms cadence; for "Regulatory-driven" emphasize statutory consultees.`,

  sprint_plan: `Produce an agile sprint plan.

## Sprint Goal
One clear sentence — the single outcome this sprint commits to.

## Committed Stories
Table: ID | Story | Points/Effort | Acceptance Criteria (brief) | Owner.
Select realistic stories from the backlog given capacity; don't over-commit.

## Capacity Check
Short paragraph reconciling committed effort vs available capacity, noting absences.

## Risks & Dependencies
Bulleted, specific.

## Stretch Goals
1–3 items that are not committed but can be pulled in if capacity allows.

## Capacity Calculation
Show the math explicitly: (team_members × working days × focus factor) − absences. If average_velocity is provided, reconcile committed story points against it (e.g., "committing 32 vs 38 historical = 84% — leaves room for unplanned work").

## Definition of Ready / Done
If definition_of_done was provided, restate it as a checklist. Otherwise propose a default 5-item DoD covering code review, tests, deployment, docs, PO acceptance.`,

  retro: `Produce a retrospective in the requested format.

## Summary of the Period
2–4 sentences honestly describing what happened.

## Retro Grid
Use the requested format as section headers with 3–6 specific, non-generic bullets each. Avoid platitudes — prefer concrete observations.

## Action Items
Table: Action | Owner Role | Due | Measurable Outcome.
Generate 4–6 items. Each must be small enough to actually happen next cycle.

## Themes
2–3 sentences naming the underlying patterns — not just individual issues.

## Facilitation Notes (team_maturity-aware)
A short paragraph on how to run this retro given the team's maturity:
- Forming: focus on psychological safety, ground rules, avoid blame.
- Storming: surface conflicts directly but with structure; agree on team norms.
- Norming: focus on optimization opportunities and process refinements.
- Performing: lean retro — short, action-driven, experiment-oriented.

## Carry-Over
If previous_actions was provided, list each item with a status (Done / Partial / Carry / Drop) and one-line rationale.`,

  meeting_agenda: `Produce a focused meeting agenda readable in under 2 minutes.

# {Meeting Title}
**Duration:** ... **Objective:** one sentence.

## Attendees & Roles
Table: Name/Role | Why They're Here.

## Agenda
Numbered list. Each item: **[00:00–00:00]** *Topic* — Lead — Desired outcome (decision / discussion / information).
Time-box strictly to the total duration.

## Pre-Reads
Bulleted list of what attendees should review beforehand.

## Decisions Required
Explicit list of decisions the meeting must produce.

## Parking Lot
Note about what will NOT be discussed here and where those topics will be handled.

## Decision Authority
If decision_authority was provided, restate it explicitly so attendees know whether the meeting can finalize decisions, only recommend, or only consult. This shapes preparation and tone.`,

  comms_plan: `Produce a communication plan.

## Communication Matrix
Table: Audience | Key Message | Channel | Owner | Frequency | Feedback Mechanism.

## Milestone Comms Calendar
Table: Milestone | Target Date | Audiences | Channels | Message Headline.

## Escalation Path
How bad news flows upward and how quickly.

## Tone & Voice Guidelines
3–4 bullets on how the project should sound in writing. If tone_principles input was provided, anchor on it; otherwise derive from program_phase (e.g. early phases = transparent and frequent; sustain phase = brief and operational).

## Regulatory & Approval Constraints
If regulatory_constraints was provided, dedicate a small subsection: which messages need legal/comms sign-off, mandatory disclosures, embargo windows. If none, omit.`,

  lessons_learned: `Produce a Lessons Learned Register suitable for a PMBOK-aligned closeout review.

## Project Recap
2–3 sentences: what was delivered, against what charter, in what timeframe.

## Lessons Learned Table
Markdown table with these columns: ID | Category | Lesson | What Happened | Root Cause | Recommendation | Apply To.
Categories must be one of: Process, People/Team, Technical, Stakeholder, Vendor, Scope, Schedule, Budget, Quality, Risk.
Generate 8–14 lessons. Mix successes and failures (don't only list problems). Use specific, situation-rooted observations — not platitudes like "communicate more."

## Top 3 Lessons — Narrative
For the three highest-impact lessons, a short paragraph each explaining:
- What we observed (specific evidence)
- Why it happened (contributing factors)
- What we'd do differently next time (concrete action)

## Action Items for the Organization
Table: Action | Owner Role | Target Date | Outcome Measure.
4–6 items. Each must outlive this project — i.e., feed into PMO standards, training, templates, or governance.

## Dissemination Plan
2–4 bullets on where this register is stored, who reviews it, and how future projects discover it.`,

  change_request: `Produce a formal Change Request document for review by a Change Control Board (CCB).

# Change Request — {Change Title}
**ID:** CR-{auto-number}  **Date:** ...  **Status:** Submitted

## Change Description
One paragraph: what is being changed and why now.

## Justification
Bulleted: business need, opportunity, defect, regulatory driver — be specific. Tie back to the project charter.

## Options Considered
Table: Option | Description | Pros | Cons | Estimated Cost.
Include a "Do nothing" baseline option.

## Recommended Option
One paragraph naming the recommended option and the reasoning.

## Impact Assessment
Sub-tables for each impact dimension:
- **Scope** — What's added/removed/modified
- **Schedule** — Days impact, affected milestones
- **Cost** — Estimated $ impact, contingency draw
- **Quality** — Risk to acceptance criteria
- **Resources** — Team capacity required
- **Risk** — New risks introduced or mitigated
- **Dependencies** — Other workstreams affected

## CCB Recommendation
PM's recommended decision (Approve / Approve with conditions / Defer / Reject) with one-line reason.

## Revised Baseline (if approved)
Table: Baseline | Before | After.

## Sign-Off
Three rows: Project Sponsor, PM, CCB Chair — with name/role/date placeholders.`,

  issue_log: `Produce an Issue Log distinguishing open issues (current, materialized problems) from closed ones. Issues are NOT risks — they have already happened.

## Issue Log
Markdown table: ID | Issue | Description | Date Raised | Severity (L/M/H/Critical) | Owner | Status | Target Resolution | Resolution / Workaround.
Statuses must be: Open, In Progress, Blocked, Resolved, Closed.
Generate 8–12 issues. Order by Severity then Date Raised.

## Open Issues — Detail
For each Open or Blocked issue with severity ≥ Medium, a short paragraph:
- Impact on the project today
- What's blocking resolution (if applicable)
- Required escalation path

## Aging Snapshot
Table: Age Bucket | # Open | # Critical/High.
Buckets: 0–3 days | 4–7 days | 8–14 days | 15+ days.

## Escalated Issues
Bulleted list of issues that need sponsor or steering-committee attention this week, with the explicit ask.

## Process Notes
2–3 bullets on the issue intake/triage cadence and the difference between issues, risks, and change requests.`,

  project_closure: `Produce a Project Closure Report — the formal artifact that ends a project and releases its resources.

# {Project Name} — Closure Report
**Project End Date:** ...  **Sponsor:** ...  **PM:** ...  **Status:** Closed / Closed-Cancelled

## Executive Summary
3–4 sentences. Was the project successful against its original objectives? Headline outcome.

## Charter Recap vs Outcome
Markdown table: Original Objective | Success Criterion | Achieved? (Y/N/Partial) | Evidence / Notes.

## Scope Performance
- **Delivered:** bulleted list of what was actually produced.
- **De-scoped:** bulleted list of items removed during execution + reason.
- **Added via Change Requests:** bulleted list with CR IDs.

## Schedule Performance
Table: Phase | Planned End | Actual End | Variance (days) | Notes.
Calculate Schedule Performance Index (SPI = EV/PV) if data is available; otherwise note it as N/A and explain.

## Budget Performance
Table: Category | Planned | Actual | Variance | Notes.
Compute Cost Performance Index (CPI = EV/AC) if possible. Flag the largest single variance.

## Quality & Acceptance
- Acceptance criteria met / not met (table).
- Defect summary if applicable.
- Sponsor sign-off status.

## Risks That Materialized
Brief table: Risk | Predicted? (was on register Y/N) | Actual Impact | Mitigation Effectiveness.

## Stakeholder Satisfaction
2–3 bullets summarizing key stakeholder feedback — keep it honest.

## Top 3 Lessons Learned
Reference the Lessons Learned Register (if one exists) and surface the three most strategic insights.

## Resource Release Plan
Table: Resource / Team Member | Released On | Next Assignment / Disposition.

## Outstanding Items
Bulleted: anything not closed (warranties, post-launch support, knowledge transfer, deferred items).

## Sign-Off
Three rows: Sponsor, PM, Steering Committee Chair — with name/role/date placeholders.`,

  budget: `Produce a budget breakdown. Be honest about assumptions.

## Summary
Total + 1-sentence framing.

## Cost Breakdown
Table: Category | Item | Qty / Duration | Unit Cost | Line Total | Notes.
Group by category (People, Software/Tools, Infra, Vendors/Services, Training, Travel, Other). Sum each category.

## Category Rollup
Compact table: Category | Amount | % of Total.

## Contingency
Recommend 10–20% contingency depending on project risk; show the math.

## Assumptions & Exclusions
Bulleted. Use the provided currency (default USD).

## Funding & Approval
If funding_source was provided, briefly explain the funding lifecycle (CAPEX vs OPEX implications, grant reporting, customer-funded billing milestones).
If approval_authority was provided, name them as the formal approver and note the threshold above which CCB approval is required.

## Cash-Flow / Payment Schedule
A short table: Period | Planned Spend | Cumulative | Notes. Cover the project duration in monthly or quarterly buckets. Surface any large lumpy payments (vendor milestones, license renewals).`,
};

const VALID_METHODOLOGIES = ["PMBOK", "Agile", "PRINCE2", "Hybrid"];

function methodologyContext(methodology) {
  if (!methodology || !VALID_METHODOLOGIES.includes(methodology)) return "";
  const guidance = {
    PMBOK: "Use PMBOK terminology (phases, deliverables, work packages, control accounts, EVM metrics, change control board, lessons learned register). Reference process groups (Initiating, Planning, Executing, Monitoring & Controlling, Closing) where relevant.",
    Agile: "Use Agile/Scrum terminology (sprints, increments, backlog, story points, velocity, definition of done, retrospective, ceremonies). Favor empirical control over predictive planning. Treat 'phase' as 'iteration' where appropriate.",
    PRINCE2: "Use PRINCE2 terminology (stages, work packages, tolerances, exceptions, project board, business case, end-stage assessments). Reference the 7 principles, 7 themes, and 7 processes where relevant.",
    Hybrid: "Use a hybrid framing — predictive at the program level (charter, milestones, gates) with adaptive delivery within each workstream (sprints, iterative releases). Map deliverables to both stage gates and increments.",
  };
  return `\nMethodology context: ${methodology}. ${guidance[methodology]}\n`;
}

function buildUserPrompt(artifactType, inputs, methodology) {
  const instruction = INSTRUCTIONS[artifactType];
  if (!instruction) throw new Error(`unknown artifact type: ${artifactType}`);

  const filled = Object.entries(inputs || {})
    .filter(([k, v]) => v && !k.startsWith("_"))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const contextBlock =
    `User-provided context:\n\n` +
    (filled || "(no additional fields — infer reasonable defaults and note them)") +
    methodologyContext(methodology) +
    "\n\n";

  return contextBlock + instruction;
}

function buildRevisePrompt(artifactType, inputs, previousContent, instructions, methodology) {
  const instruction = INSTRUCTIONS[artifactType];
  if (!instruction) throw new Error(`unknown artifact type: ${artifactType}`);

  const filled = Object.entries(inputs || {})
    .filter(([k, v]) => v && !k.startsWith("_"))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  return (
    `You are revising a previously generated artifact based on the user's refinement instructions.\n\n` +
    `Original user-provided context:\n\n` +
    (filled || "(no fields supplied originally)") +
    methodologyContext(methodology) + "\n\n" +
    `Previous artifact (markdown):\n\n` +
    "```markdown\n" + previousContent + "\n```\n\n" +
    `Refinement instructions from the user:\n\n${instructions}\n\n` +
    `Produce a revised artifact that incorporates the instructions while preserving correctness ` +
    `and the structure expected for this artifact type. Do not summarize the changes — output the ` +
    `full revised artifact only.\n\n` +
    `Required structure for this artifact type:\n\n${instruction}`
  );
}

const VALID_TYPES = Object.keys(INSTRUCTIONS);

module.exports = { SYSTEM_PROMPT, buildUserPrompt, buildRevisePrompt, VALID_TYPES, VALID_METHODOLOGIES };
