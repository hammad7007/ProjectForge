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
2–3 sentences.
## Objectives & Success Criteria
Specific, measurable outcomes.
## Scope
Two subsections: **In Scope** and **Out of Scope** (bulleted).
## Deliverables
Numbered list of concrete deliverables.
## Phases & Milestones
A markdown table: Phase | Duration | Key Milestone | Exit Criteria.
## Team & Roles
Roles needed and headcount.
## Top Risks
Top 3–5 risks with one-line mitigation each.
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
2–4 bullets on the riskiest dependencies in the schedule.`,

  wbs: `Produce a Work Breakdown Structure.

## WBS
A nested markdown list at the requested depth using numbered format:
- **1. Workstream Name**
  - 1.1 Task
    - 1.1.1 Subtask

Cover the full scope. Skip sections that genuinely don't apply.

## WBS Dictionary (top-level only)
A table: ID | Workstream | Deliverable | Owner Role.

## Notes
2–3 bullets on sequencing or dependencies between workstreams.`,

  risk_register: `Produce a Risk Register.

## Risk Register
A markdown table with these columns: ID | Risk | Category | Likelihood (L/M/H) | Impact (L/M/H) | Score | Mitigation | Owner Role | Trigger Signal.

Generate 8–12 risks. Cover: delivery, technical, people, external/vendor, scope, compliance. Order by Score descending (HxH = 9, HxM = 6, etc.).

## Top 3 — Deep Dive
For the top 3 risks, a short paragraph each: what could go wrong, early warning signs, primary mitigation.

## Watchlist
2–4 lower-severity risks to monitor.`,

  raci: `Produce a RACI matrix.

## RACI Matrix
Markdown table. First column is the activity. Subsequent columns are the roles provided. Each cell contains R, A, C, I, or is blank.

Rules (strict):
- Every row has exactly ONE A (Accountable).
- Every row has at least ONE R (Responsible).
- Don't overload with C's — only list Consulted when their input is genuinely needed.
- Blank cells are fine.

## Legend & Notes
Recap R / A / C / I definitions. Flag 2–3 rows where the assignments are subtle or likely to be debated.`,

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
If any KPIs are implied by context, include 2–4 in a compact table. Otherwise omit.`,

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
2–4 bullets on political dynamics to plan around.`,

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
1–3 items that are not committed but can be pulled in if capacity allows.`,

  retro: `Produce a retrospective in the requested format.

## Summary of the Period
2–4 sentences honestly describing what happened.

## Retro Grid
Use the requested format as section headers with 3–6 specific, non-generic bullets each. Avoid platitudes — prefer concrete observations.

## Action Items
Table: Action | Owner Role | Due | Measurable Outcome.
Generate 4–6 items. Each must be small enough to actually happen next cycle.

## Themes
2–3 sentences naming the underlying patterns — not just individual issues.`,

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
Note about what will NOT be discussed here and where those topics will be handled.`,

  comms_plan: `Produce a communication plan.

## Communication Matrix
Table: Audience | Key Message | Channel | Owner | Frequency | Feedback Mechanism.

## Milestone Comms Calendar
Table: Milestone | Target Date | Audiences | Channels | Message Headline.

## Escalation Path
How bad news flows upward and how quickly.

## Tone & Voice Guidelines
3–4 bullets on how the project should sound in writing.`,

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
Bulleted. Use the provided currency (default USD).`,
};

function buildUserPrompt(artifactType, inputs) {
  const instruction = INSTRUCTIONS[artifactType];
  if (!instruction) throw new Error(`unknown artifact type: ${artifactType}`);

  const filled = Object.entries(inputs || {})
    .filter(([k, v]) => v && !k.startsWith("_"))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const contextBlock =
    `User-provided context:\n\n` +
    (filled || "(no additional fields — infer reasonable defaults and note them)") +
    "\n\n";

  return contextBlock + instruction;
}

const VALID_TYPES = Object.keys(INSTRUCTIONS);

module.exports = { SYSTEM_PROMPT, buildUserPrompt, VALID_TYPES };
