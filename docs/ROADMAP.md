# Dev Crew roadmap

Planned enhancements for our fork (`Joeamuthan-dev/dev-crew`), agreed on 2026-11-21. Each phase
ships as its own `feature/<name>` branch and pull request into `main`. Effort is a rough size:
**S** = a day or less, **M** = a few days, **L** = a week or more.

Phase 0 goes first because later phases depend on it. After that, the order is a suggestion.

| # | Phase | Branch | Effort | Depends on |
|---|---|---|---|---|
| 0 | Foundations: safe API, clean agent environment, run data | `feature/foundations` | S | none |
| 1 | Run limits and ETA before starting | `feature/run-limits-eta` | M | 0 |
| 2 | Role handoffs | `feature/handoffs` | L | 0 |
| 3 | Housekeeping and pruning | `feature/housekeeping` | M | 0 |
| 4 | Simpler configuration: setup wizard and editors | `feature/config-ui` | M | 0 |
| 5 | Settings page | `feature/settings` | M | 4 |
| 6 | Dashboard redesign: cleaner UI, motion, better 3D | `feature/dashboard-v2` | L | 5 |
| 7 | Cost analytics page | `feature/cost-analytics` | M | 0 |
| 8 | New roles: PR Conflict Fixer and Code Reviewer | `feature/new-roles` | L | 2, 4 |
| 9 | Graphify integration, only if it measurably saves tokens | `feature/graphify` | M | 7 |

---

## 0. Foundations (do first) — done on `feature/foundations`

These come from the code review and make the later phases safe and measurable.

- **Reject requests from other websites.** `server.mjs` accepted any POST and parsed the body as
  JSON whatever its content type, so a web page could probably queue a task on
  `localhost:4610`. Done in `lib/guard.mjs`: the Host must be localhost (stops DNS rebinding),
  any Origin must be the dashboard's own, state changes need an `X-Dev-Crew` header (a custom
  header forces a CORS preflight, which the server never approves, so it does the job a
  per-session token would), and request bodies must be JSON.
- **Control the environment agents get.** `runClaude` passed all of `process.env` to agents.
  Done: when Dev Crew runs inside a Claude session, `agentEnv()` drops that session's
  `CLAUDE_*` / `ANTHROPIC_*` variables (keeping `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
  `CLAUDE_CONFIG_DIR`). `settings.inheritClaudeEnv: true` turns this off. A plain `npm start`
  works, so `data/start-devcrew.ps1` is no longer needed.
- **Record full run data.** A run only kept `costUsd` and `turns`. Done: every task and report
  now keeps a `runs` list (time, kind, model, ok, cost, turns, wall and API time, input / output
  / cache tokens) plus running totals in `tokens` and `wallMs`.
- **Tests:** `npm test` runs `node:test` unit tests for the guard, the environment filter and the
  run statistics.

## 1. Run limits and ETA before starting — done on `feature/run-limits-eta`

Built as planned, in `lib/limits.mjs` (pure and unit tested). One deviation: the 80% warning is
for the time limit only. Claude Code reports cost only when a run ends, so the per-task cost limit
is enforced by Claude Code itself (`--max-budget-usd`) with no live warning. The daily limit warns
at 80% in the top bar. Also added: a GitHub Actions workflow running `npm test` on Node 20 and 22.

**Goal:** before a task starts you see an estimate (how long, how much it costs), and every run
stops at a limit you set.

- **Estimate in the Assign dialog.** Show expected duration, cost and turns, based on past runs
  of the same role, mode, project and model: the median, plus a range from the 25th to 75th
  percentile. With fewer than 5 past runs, fall back to defaults per mode and model and label
  the estimate "rough".
- **Queue ETA.** Show when each queued task should start and finish, given `maxConcurrent` and
  the estimates for what's ahead of it.
- **Limits, in order of precedence (task, then role, then project, then app):**
  - **Cost per task:** passed to Claude Code as `--max-budget-usd` (this CLI supports it).
  - **Wall-clock timeout:** enforced by the server, which uses the existing `kill()`.
  - **Daily spend limit:** once reached, new tasks wait in the queue until the next day or until
    you raise the limit.
  - **Warning at 80%** of a limit, shown live in the task log.
- **When a limit stops a task**, it's marked `stopped (limit)`, not failed, and **Continue**
  resumes the session with a new allowance.

## 2. Role handoffs — done on `feature/handoffs`

Built as planned, in `lib/handoffs.mjs` (pure and unit tested), with the "Plan it first" option in
the Assign dialog. Notes: a plan has at most 8 steps and may only depend on earlier steps (so it
cannot loop); a task can propose at most 3 handoffs and never to its own role. A task blocked by a
dependency goes back in the queue once that dependency is done. Queue ETAs do not yet account for
dependencies (a waiting task shows "waits for …" instead of a time).

**Goal:** when one role finishes and another role is needed, the work is handed over and the
next role starts. This only happens when it's needed.

- **Handoff block in reports.** Add an optional `## Handoff` section to the task report: a JSON
  list of `{ role, mode, title, details, reason }`. It's parsed the same way stand-up
  suggestions already are (`parseReport`).
- **Linked tasks.** Each task gets `parentId` and `dependsOn`. A change-task handoff starts from
  the previous task's **branch**, so Backend → QA → Reviewer build on the same work.
- **Handoff policy (setting, per project):**
  - `ask` (default): the handoff appears as a card. You click **Start** to queue it.
  - `auto`: it's queued automatically, within the limits from phase 1.
  - `off`.
- **Architect plans.** For a feature request, the Architect writes a plan whose steps become
  linked tasks with dependencies. A task waits until the tasks it depends on are done.
- **Guards:** at most 5 handoffs in a chain. A role can't hand off to itself twice in a row.
  Every handoff is shown in a **pipeline view** (parent → children, with status).

## 3. Housekeeping and pruning — done on `feature/housekeeping`

Built as planned: `lib/housekeeping.mjs` decides (pure, unit tested), `lib/cleanup.mjs` gathers git
facts and acts, re-checking each step. Testing found and fixed two real issues: paths of the same
folder written differently on Windows (8.3 short names, case, slashes) made live worktrees look like
orphans, so paths are now compared in canonical form and a folder with uncommitted work is never
treated as an orphan; and branches checked out in another Dev Crew copy's worktree are now kept.
Log compression was dropped: logs are moved to `data/archive/logs/` instead.

**Goal:** Dev Crew cleans up what's no longer needed, and always shows what it will remove first.

- **Worktrees:** remove the worktree of a finished task after N days, or as soon as its branch is
  merged. The branch itself is kept.
- **Agent branches:** delete local `agent/*` branches only when they are fully merged into their
  base, or when you have discarded them. Never delete a branch that has unpushed commits
  without asking you.
- **Tasks and logs:** move tasks older than N days to `data/archive/YYYY-MM.json`, and delete
  their log files or compress them into an archive. This caps `state.json` (today tasks grow
  without any limit).
- **Temporary files:** clear `data/tmp` when the server starts.
- **Prune button and schedule:** a **Prune** button always shows a preview first ("12
  worktrees, 9 branches, 140 MB"). A weekly automatic prune can be switched on in Settings.

## 4. Simpler configuration — done on `feature/config-ui`

Built: `lib/detect.mjs` (stack and role detection, context draft; local and free, unit tested),
`lib/configfile.mjs` (validated, backed-up, atomic writes; unit tested), the Add project wizard
with a folder browser, the project editor (roles on/off, repo, model, notes per role, handoffs,
limits, extra commands) and the people editor. Unused roles are hidden everywhere and agents are
told the project has no such role. Not done: the optional Haiku pass to polish the drafted
context (the local draft from the docs worked well on DataEz, so it was not needed yet).

**Goal:** no hand-editing of JSON for normal use.

- **Add-project wizard:**
  1. Pick a folder.
  2. Dev Crew finds the git repos in it and detects the stack (`*.csproj`, `package.json`,
     `Dockerfile`, `azure-pipelines.yml`, Terraform, and so on).
  3. It drafts the stack and context. With your OK, a quick Haiku run reads the README and docs
     to improve the draft.
  4. You choose which roles the project uses and set the repo for each role.
- **Editors in the UI** for projects, roles, role notes, allowed commands and people. They save
  to `crew.config.local.json`, keep a backup of the previous version and reload without a
  restart. They also check for errors (unknown repo, invalid id) as you type.
- **Unused roles:** roles a project doesn't use are hidden from the office and the dialogs, for
  example Frontend for DataEz.

## 5. Settings page — done on `feature/settings`

Built as planned, with `lib/settings.mjs` (form validation and merge, secret masking; unit
tested). Accent colour and density were left for the dashboard redesign (phase 6), which will
add its own appearance options. The 3D office now honours motion (reduced: agents stay seated;
off: nothing moves) and quality (pixel ratio, shadows, antialiasing), and there is a 2D office.

One page for app-wide controls. It's stored in `crew.config.local.json` under `settings`.

- **Appearance:** theme (light, dark or system), accent colour, density.
- **Motion and 3D:** motion level (full, reduced, off), 3D quality (low, medium, high), or a 2D
  view instead of the 3D office.
- **Agents:** default model, how many agents run at once, the limits from phase 1, the handoff
  policy from phase 2.
- **Schedule:** stand-up on or off, time, weekdays only.
- **Housekeeping:** how long to keep data, and the automatic prune from phase 3.
- **Integrations:** monday.com token and boards. Later: GitHub, Azure DevOps and Teams
  notifications.
- **Permissions:** a read-only view of what each role is allowed and blocked from running.

## 6. Dashboard redesign — 3D campus done on `feature/office-v2`

Done (part 1, the office): the 3D office is now a campus: a glass stand-up room with a round
table and a holographic globe (orbiting project lights), project floors with a back wall, sign,
live whiteboard, dual-monitor desks showing each person's state, plants, printer, bookshelf and
cooler, and one big café & lounge that free people from every project walk to (coffee counter,
café tables, plants everywhere, sofas, bean bags, and a play area with ping-pong and foosball).
A first version had a separate cafeteria, cricket ground and garden; one shared place keeps the
crews together and the campus compact. Workers have emoji heads coloured by state (green free, red busy, amber review, purple needs
attention), confetti when a task finishes, an office cat, and the overlay panels fold away.
Still to do (part 2, the rest of the dashboard): the design system, transitions for drawers and
pages, animated numbers, and the accessibility pass below.

**Goal:** a cleaner, calmer interface with purposeful motion and a better 3D office.

- **Design system:** colour, spacing and type tokens; one style for each component (cards,
  pills, buttons, drawers); a consistent layout across Office, Today, Projects, Tasks, Costs and
  Settings.
- **Motion:** drawers and cards move with easing; page changes have short transitions; numbers
  animate when they change. Everything honours the motion setting and
  `prefers-reduced-motion`.
- **3D office** (`public/office3d.js`):
  - softer lighting and shadows, with materials based on the theme;
  - smoother camera paths, and easing between agent states (walking, sitting, typing, waving);
  - a clear visual state per agent (working, waiting for review, blocked, over budget);
  - handoffs shown visually, with an agent walking a "ticket" over to the next desk;
  - faster rendering: shared geometry for repeated objects, fewer draw calls, and a frame cap
    when the tab is hidden.
- **Stand-up hub (the centre globe).** Today it's a plain wireframe ball on a beige disc.
  - Replace it with a glowing holographic globe that rotates slowly, with one orbiting ring per
    project, coloured by its latest stand-up health (green, amber, red).
  - The globe pulses while a stand-up is being written. Small particles travel from each floor
    to the hub when a report is filed.
  - A round stand-up table around it, with a seat per role, where agents gather when a stand-up
    runs.
  - A clearer label that shows the next stand-up time or "off", replacing the floating pill.
- **Office infrastructure:**
  - walls or low glass partitions with a door, a carpet zone under the desks and floor tiles
    elsewhere;
  - better desks: dual monitors that show the agent's state (code scrolling while working, a
    tick when done, a red alert when failed), keyboards, mugs, desk lamps and cable trays;
  - ceiling lights or pendant lamps that dim when the floor is idle;
  - a whiteboard or wall screen per floor showing the project's open tasks and health;
  - a meeting corner with a sofa and table, used for handoffs and reviews;
  - the project name on a wall sign, not only as a floating label.
- **Plants:** a varied set (tall floor plants, small desk succulents, hanging plants, planter
  boxes along partitions) that sway gently. Plant swaying is turned off when motion is
  reduced.
- **Fun items** (decoration that also reflects state where it can):
  - a coffee machine and kitchen corner: idle agents go for coffee, and steam rises while the
    machine runs;
  - a ping-pong or foosball table: idle agents play when nobody has work;
  - a bookshelf, a server rack with blinking lights (blinking faster while agents run builds),
    a clock showing local time, framed posters, and an office cat or dog that wanders
    between the desks;
  - a small celebration (confetti, a high-five) when a task finishes or a review is approved;
  - a "focus" lamp on a desk while that agent is working, and a "need review" flag on the desk
    when a branch is waiting for you.
- **Layout fix:** the "The office" and "Live" panels currently cover part of the hub and the
  floor. Make them collapsible, place them so they don't overlap the scene, and let the camera
  frame the visible area around them.
- **Accessibility:** full keyboard navigation and visible focus, contrast at WCAG AA, and a 2D
  list view that holds the same information as the 3D office.

## 7. Cost analytics page

A separate **Costs** page, built from the run data recorded in phase 0.

- **Charts:**
  - spend per day, week and month;
  - spend by project, by role and by model;
  - cost per task, set against whether the task succeeded or failed;
  - tokens split into input, output and cache, with the cache hit rate;
  - estimated cost versus actual cost (how accurate the phase 1 estimates are);
  - daily spend against the daily limit.
- **Tables:** the most expensive tasks, cost per finished task, and the share of spend on failed
  or cancelled runs.
- **Filters and export:** filter by date range, project, role and model. Export the data as CSV.
- **Charts library:** use a small charting library vendored into `public/vendor` (as three.js is
  today), so there's still no build step.

## 8. New roles: PR Conflict Fixer and Code Reviewer

First, move roles into config, so they're data instead of being hard-coded in `roles.mjs`. The
six current roles become the defaults, and you can add custom roles. The office gets one desk per
active role.

- **PR Conflict Fixer** (`conflicts`)
  - **Input:** a branch or PR, plus the branch it targets.
  - **Steps:** in its own worktree, merge the target branch in, resolve the conflicts, then run
    the build and tests and commit.
  - **Permissions:** this is the only role allowed to run `git merge` and `git merge --abort`,
    and only inside its worktree. It still can never push.
  - **Output:** the conflicts it resolved, the choice it made for each one, and test results.
- **Code Reviewer** (`reviewer`), for team code review
  - **Input:** any branch or PR. That includes agent branches (it's the reviewer step in the
    phase 2 handoffs) and branches written by people.
  - **Output:** findings with file and line, a severity, and a verdict (approve, approve with
    notes, or request changes).
  - **Posting:** the reviewer can post its findings to the PR with `gh`, only when you click
    **Post review**.
- **Pull request hosts:** GitHub first. Azure DevOps and Bitbucket follow, because DataEz's
  pipelines are on Azure DevOps.

## 9. Graphify integration (only if it measurably saves tokens)

**Goal:** fewer tokens per task, without losing quality. Build it only if the numbers show it
helps.

1. **Measure first.** Using the phase 7 data, run the same set of investigate tasks on DataEz
   with and without graph context. Compare tokens, cost and answer quality.
2. **If it helps:**
   - Add a per-project option, `knowledgeGraph: on | off`.
   - Keep the graph current with `graphify update`. Updating code costs nothing because it uses
     no LLM. Run it after merges or nightly.
   - Give agents the graph through `graphify-mcp` (with `--mcp-config` and `--strict-mcp-config`)
     and allow its tools. Alternatively, include a short summary of `GRAPH_REPORT.md` in the
     system prompt.
3. **If it doesn't help**, drop it and record why in this file.

---

## Open questions

1. **Handoff default:** `ask` (you approve every handoff) or `auto` within limits?
2. **Retention:** how long to keep finished worktrees and old tasks? (Proposal: 7 days and 30 days.)
3. **Reviewer posting:** should the Code Reviewer ever post to a PR automatically, or only on
   click? (Proposal: only on click.)
4. **PR host for DataEz:** GitHub, Azure DevOps or Bitbucket? This decides the integration
   after GitHub.
5. **Dashboard look:** do you have a reference style, or should we propose two directions to
   choose from?
