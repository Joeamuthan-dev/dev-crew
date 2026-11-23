# Dev-crew

Multiple AI agents: a developer crew for each of your projects.

A crew of six AI engineers for each of your projects: **Solutions Architect, Frontend, Backend,
Database, QA / Test, and DevOps & Cloud**. Assign them tasks each day, and each morning get a
stand-up per project: what got done, what's blocked, the risks, and suggested tasks you can
assign in one click.

Every agent is a headless [Claude Code](https://claude.com/claude-code) session running on your
machine with your own Claude login. Nothing is hosted anywhere.

## How it keeps your repos safe

- **Agents never touch your checkout.** A "Make changes" task gets its own **git worktree** and a
  new branch, `agent/<role>/<date>-<title>`, created from the branch you pick. Your working copy,
  its branch and its uncommitted files are left alone.
- **Agents commit. They never push, merge, rebase, reset or switch branches.** You review the
  branch, then push it yourself. The task panel gives you the exact commands.
- **"Investigate & report" tasks are read-only.** The agent can read files, search and run
  read-only git commands. It cannot edit anything.
- **Locked-down tools.** Agents may run build, test and lint commands for common stacks (npm,
  pnpm, yarn, dotnet, maven, gradle, pytest, go, cargo, terraform fmt/validate, and so on).
  Anything else is refused automatically and shown in the task log. `git push`,
  `terraform apply`, `kubectl`, `rm -rf` and similar are always denied.
- The server only listens on `127.0.0.1`, and only the dashboard can drive it: requests must be
  made to `localhost`, come from the dashboard's own origin, carry an `X-Dev-Crew` header to
  change anything, and send JSON. Other web pages you visit cannot queue tasks.
- If you start Dev Crew from inside a Claude session (the Claude desktop app or a Claude Code
  terminal), that session's `CLAUDE_*` / `ANTHROPIC_*` variables are not passed to the agents, so
  they use your own `claude` login. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
  `CLAUDE_CONFIG_DIR` are kept. Set `"inheritClaudeEnv": true` in `settings` to pass everything.

## Set up on your work laptop

You need **Node 20+**, **git**, and **Claude Code** logged in:

```powershell
npm install -g @anthropic-ai/claude-code
claude          # log in once, then exit
```

Copy this `dev-crew` folder to the laptop, set `settings.workspace` (the folder that holds your
projects) and run `npm start`. Then press **+ Add project** in the sidebar: pick a folder and Dev
Crew finds its git repos, detects the stack (.NET and its packages, Node frameworks, Java, Python,
Go, Docker, pipelines, Terraform, migrations…), suggests which roles the project needs and drafts
its context from the README or an overview doc. Check the suggestions and save. **Edit project**
on a project's page changes it later, and **People** at the bottom of the sidebar edits who to ask.

Everything is saved to **`crew.config.local.json`** (yours; it wins over the shipped
`crew.config.json`). Each save is validated first, and the previous version is kept in
`data/config-backups` (the last 10). You can still edit the file by hand; it looks like this:

```json
{
  "settings": {
    "workspace": "C:/Work",
    "model": "sonnet",
    "maxConcurrent": 2,
    "dailyReport": { "enabled": true, "at": "09:00", "weekdaysOnly": true }
  },
  "projects": [
    {
      "id": "billing",
      "name": "Billing Platform",
      "folder": "billing",
      "stack": "Angular 17, .NET 8 API, Azure SQL, AKS via Azure DevOps pipelines",
      "context": "Invoicing for enterprise customers. Release train every second Tuesday.",
      "roles": {
        "frontend": { "repo": "billing-web", "notes": "Use the shared design system in libs/ui." },
        "backend":  { "repo": "billing-api" },
        "database": { "repo": "billing-api", "notes": "Migrations are EF Core, in src/Data/Migrations." },
        "devops":   { "repo": "billing-infra", "model": "opus" }
      },
      "allowCommands": ["npm run e2e"]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `workspace` | The folder that holds your project folders. |
| `folder` | The project's folder inside the workspace (or an absolute path). Every git repo inside it, up to two levels deep, is found automatically. You can also list them: `"repos": [{"name": "web", "path": "src/web"}]`. |
| `stack`, `context` | Read by every agent before every task. Be specific: this is what makes the answers yours. |
| `roles.<role>.repo` | The repo this role usually works in (it's preselected when you assign). |
| `roles.<role>.notes` | Standing instructions for that role on that project. |
| `roles.<role>.model` | `sonnet`, `opus` or `haiku` for that role (a task can still override it). |
| `allowCommands` | Extra command prefixes the agents may run in that project. |
| `activeRoles` | The roles the project uses (default: all six). The others get no desk, are left out of the dialogs, and agents are told the project has no such role, so they never hand work to it. |
| `handoffs`, `limits` | Per-project overrides of the app settings (see *Handoffs and plans* and *Estimates and limits*). |

Role ids: `architect`, `frontend`, `backend`, `database`, `qa`, `devops`.

Then:

```powershell
npm run doctor    # checks Node, git, Claude Code, and that every project folder and repo is found
npm start         # → http://localhost:4610
```

To try it with no repos, `npm run demo` creates five sample projects in `demo-workspace/`, which is
what the shipped `crew.config.json` points at.

## The office

The dashboard opens on a 3D office campus:

- **The stand-up room** in the middle: a glass room with a round table, green chairs and a
  holographic globe with one orbiting light per project in its stand-up health colour. It spins
  faster and pulses while a stand-up is being written, and free crew members gather round the
  table.
- **One floor per project** around it: desks with dual monitors (code scrolling while working, a
  tick when a branch waits for review, a warning when a task failed), the project's sign and a
  whiteboard with its queued, running and review work as sticky notes, plants, a printer, a
  bookshelf, a water cooler, a wall clock with your local time, and a server rack whose lights
  blink faster while the crew is running. Every desk has a **focus lamp** that lights up while
  its owner works, and a **flag** that goes up when a branch waits for your review (amber) or the
  last task failed (purple). Roles a project does not use get no desk.
- **Handoffs you can see:** when a task hands work to another role, or a plan starts its steps,
  the person who finished picks up a ticket, walks it over to the next desk and hands it over;
  the receiver waves.
- **Each floor also has** a meeting corner by the way in (two armchairs and a coffee table, where
  free teammates sit and chat), pendant lights over the desks that brighten while anyone on the
  floor is working and dim when the floor is idle, and plants hanging from the back wall.
- **One big café & lounge** where free people from every project meet: a coffee counter, café
  tables under pendant lamps, plants everywhere (trees in big pots, planter boxes, a tree with a
  round bench), sofas and bean bags, and a small play area where two people play a ping-pong
  rally or a game of foosball. The coffee machine steams, more while people are at the counter.
  An office cat wanders about.

Every crew member has an **emoji head** that shows how they are doing, and a shirt in their
role's colour:

| Head | Means |
|---|---|
| 🟢 green, smiling | free: goes to the café & lounge, visits teammates |
| 🔴 red, focused | busy: working, or has work queued, so stays at the desk |
| 🟠 amber | a branch is waiting for your review |
| 🟣 purple, dizzy | needs attention: the last task failed or is blocked |

When a task finishes there is a little burst of confetti. **Click someone**: the camera flies to
them, they turn and wave, and a card shows what they are doing, their monday.com tickets and the
person to ask. **Click a floor** to open that project; click the stand-up room for the Today
overview. Drag to pan, scroll to zoom, double-click (or **Fit**) to see the whole campus. The
legend and the Live panel fold away with their **–** button. Settings → Appearance controls
motion (reduced keeps everyone at their desks, off stops everything), 3D quality and a simple 2D
view.

**Keyboard.** Everything works without a mouse: Tab shows a clear focus ring, the first Tab offers
**Skip to content**, Enter opens a feed row or an office name tag (the camera flies to that
person), Escape closes the task panel and focus returns to where you were. Ctrl+K jumps to "Who
should I ask?". Drawers, dialogs, page changes and counters animate briefly; Settings → Motion or
your system's "reduce motion" setting turns that off.

**Alerts.** When something needs you, Dev Crew says so with what happened and buttons to act on it:
a branch ready for review (**Review**, **Ask the Code Reviewer**), a plan ready (**Start plan**), a
suggested handoff (**Start handoff**), a task that failed, stopped at a limit or made no changes, and
refused commands. While you are looking at Dev Crew they appear at the top right; while it is in the
background they can come as system notifications, whose buttons work without opening the page.
Turn them on and pick the events in Settings → General → Alerts (saved per browser; keep a Dev
Crew tab open, minimised is fine). Embedded browsers may not allow system notifications; Chrome and
Edge do.

**Full-width view.** The ☰ button at the top left (or Ctrl+B) hides the side menu, so the office
and every page use the whole window; press it again to bring the menu back. The browser remembers
your choice. On a phone-sized window the same button slides the menu in over the page.

**Look.** The dashboard uses a "liquid glass" style (`public/glass.css`, layered over
`public/style.css`): frosted, translucent panels over a soft colour wash, the system font, pill
buttons, segmented controls and floating sheets, in light and dark. Text stays at WCAG AA
contrast. If your operating system is set to reduce transparency, the panels turn solid.

## Handoffs and plans

**Handoffs.** When an agent finishes and another role must act for the work to be complete (new
code that needs tests, a schema change the backend must use, a change that needs a pipeline
update), its report can propose a handoff: which role, what to do, and why. Agents are told to do
this only when it is genuinely needed, never to their own role, and at most three per task.

- The next task builds on the previous one: a **change** task starts from the previous task's
  branch; an **investigation** reads the previous task's worktree, so a reviewer or QA sees the
  new, unmerged work.
- Policy, set in `settings.handoffs` or per project (`projects[].handoffs`):
  `"ask"` (default: the handoff shows in the task panel and you press **Start**), `"auto"` (it is
  queued straight away, within your limits) or `"off"` (agents are not asked for handoffs).
- Chains stop at five tasks deep; after that you assign the next step yourself.

**Plans.** Tick **Plan it first** in the Assign dialog and describe a feature. The Solutions
Architect breaks it into up to eight linked tasks for the crew, each with the steps it depends
on. Review the plan in the task panel and press **Start plan** (or it starts by itself with
`"auto"`). A step waits until the steps it depends on are done, and builds on their branch when it
changes the same repo. If a step fails, is cancelled or stops at a limit, the steps after it show
as **Blocked**, and go back in the queue once it is done (for example after **Continue**).

The task panel's **Chain** section shows where a task came from and what came after it.

## Roles

Each role is written as a senior specialist with about ten years in the job: how they work, what
"done" means for them, what they never do, and the traps they avoid (`lib/roles.mjs`). Knowledge
about your own code goes in each role's notes in **Edit project** (for example, which tests work,
where conflicts usually happen, the security debt to keep in view).

Every project gets eight seats: Solutions Architect, Frontend, Backend, Database, QA / Test,
DevOps & Cloud, and two that work on branches and pull requests:

- **Code Reviewer** reviews any branch (yours, a teammate's or a crew branch) against its base,
  read-only. Pick it in the Assign dialog and give the branch, what to compare with (default
  `main`) and, optionally, the pull request number, or press **Ask the Code Reviewer to review
  this branch** under a finished change task. It is also a handoff target, so Backend → QA →
  Reviewer works. The task panel shows its verdict (looks good, comments, changes requested) and
  findings by file and line, most severe first. **Post on the pull request** posts them with the
  GitHub CLI (`gh pr review`), from your own GitHub login, only when you click it.
- **Conflict Fixer** brings a pull request branch up to date. Give the branch to fix and the one
  to merge in (for example `origin/main`; Dev Crew fetches first). It makes its own branch from
  yours, merges, resolves the conflicts keeping both sides' intent, then builds and tests. It is
  the only role allowed to run `git merge` (and `git merge --abort` when a conflict needs a
  person); it still cannot push. Your branch is never touched: the task panel gives the command to
  move the pull request branch to the fixed one. A merge left half-finished shows as failed.

**Custom roles.** Add a top-level `"roles"` list to `crew.config.local.json` to add your own
seats or change a built-in one (only the fields you give change), then restart:

```json
"roles": [
  { "id": "security", "name": "Security Engineer", "short": "SEC", "color": "#e11d48",
    "defaultMode": "analyze", "focus": "Threat models, auth, secrets, dependency risk.",
    "prompt": "You are the Security Engineer for this project. ..." },
  { "id": "qa", "name": "Test Lead" }
]
```

New roles are on for every project unless the project lists `activeRoles`; turn them on or off
in **Edit project**. The office adds a desk per role (desks get closer together as the crew
grows), and Settings → Roles lists them all.

## Housekeeping

Press **Housekeeping** at the bottom of the sidebar. It shows what can go and why, before
anything is removed; **Clean up** then does exactly that:

- **Worktrees** of finished tasks: after `worktreeDays` (7), or as soon as the task's branch is
  merged. The branch itself stays.
- **Agent branches** (`agent/*`): deleted only when every commit on them is already in the branch
  they started from (locally or on `origin`), so nothing is lost. Unmerged branches are listed as
  kept, with how many commits are only on them.
- **Old tasks and stand-ups**: after `taskDays` (30) they move to `data/archive/YYYY-MM.json`, with
  their logs in `data/archive/logs/`. Archived, not deleted.
- **Leftover worktree folders** that no task owns, and temp files from interrupted runs.

Never touched: anything a queued, running or blocked task builds on; a worktree with uncommitted
changes; a branch checked out anywhere (including another Dev Crew copy's worktree). Every step is
checked again right before it runs.

```json
"housekeeping": { "worktreeDays": 7, "taskDays": 30, "auto": false }
```

`"auto": true` runs the cleanup by itself once a week.

## monday.com tickets

Each project can point at its monday.com board. A column on the board says which crew role a
ticket belongs to (default column name **Agent**, with values like *Backend*, *QA*, *DevOps*,
*Frontend*, *Database*, *Architect*). Click an agent in the office and the card shows their tickets.
**Work on it** turns a ticket into a task: the agent reads the ticket, its columns and its
latest updates. When the task is done, **Post report** adds the agent's summary as an update on
the ticket. Nothing is written to monday.com unless you press a button that says so.

1. In monday.com: your avatar → **Developers** → **My access tokens** → copy the token.
2. Set it as an environment variable before `npm start` (keeps it out of files):
   ```powershell
   setx MONDAY_API_TOKEN "your-token"     # once; open a new terminal afterwards
   ```
   or put it in `crew.config.local.json` under `settings.monday.token`.
3. In each project, add the board id (the number in the board's URL) and your column names:
   ```json
   "monday": { "boardId": "1234567890", "roleColumn": "Agent", "peopleColumn": "Owner", "statusColumn": "Status" }
   ```

Until a token and board are set, every project shows demo tickets, marked *demo*.

## Who should I ask?

Type a question in the search box at the top (or press **Ctrl+K**):
*"who do I ask backend questions in inventory service"*, *"database inventory"*,
*"terraform"*, *"who handles the pipeline for internal tools"*. The best person pops up with
why they match, their hours, their tickets, and buttons to **email** them, **chat in Teams**,
or **assign them a ticket** (an existing one on the board, or a new one created for them).
In the office, the camera also walks over to that team's desk and pins their name there.

People come from the `people` list in the config, and from whoever is on tickets in the
board's People column (matched by role). Add your staff and contractors:

```json
"people": [
  { "name": "Ravi Menon", "company": "Bluepeak Consulting", "contractor": true, "title": "Senior .NET developer",
    "email": "ravi@bluepeak.example", "teams": "ravi@bluepeak.example", "hours": "Mon–Fri, 9:00–17:30 IST",
    "projects": ["inventory"], "roles": ["backend"], "skills": [".NET 8", "EF Core"] }
]
```

`projects: ["*"]` means every project. To assign monday tickets to someone, they must be a
member or guest on your monday.com account (matched by email, then by name).

## Your day

1. **Morning.** At 09:00 (weekdays), each project gets a stand-up written by its crew lead. It
   covers health (on track / watch / at risk), each role's updates, risks, decisions needed from
   you, and suggested tasks. Open **Today** for all five projects at once, and press **Assign**
   on a suggestion to hand it out.
2. **Assign.** Press **+ Assign task**, pick the project, the role, *Make changes* or
   *Investigate & report*, the repo and the branch to start from. Tick "Keep open" to hand out
   several in a row. Up to `maxConcurrent` agents work at once; the rest queue.
3. **Watch.** The crew page shows who is working on what, live. Click a task to see the agent's
   activity log as it happens.
4. **Review.** Finished change tasks show up under *Ready for your review*, with the commits, the
   diff stats and copy-ready `git log` / `git diff` / `git push` commands.
5. **Follow up.** Type into the task panel ("the test is wrong, …", "also handle X", "continue").
   The agent resumes the same session on the same branch, with everything it already knows.
6. **Tidy.** *Remove worktree* deletes the working folder but keeps the branch.

**Run stand-up** (per project) or **Run all stand-ups** gives you one whenever you want. The
first start doesn't fire a stand-up; the schedule starts the next morning. If the laptop was
off at 09:00, the stand-up runs as soon as Dev Crew starts that day.

## Settings

**Settings** in the sidebar holds the app-wide options, in tabs, with a **Find a setting** box that
searches all of them. Everything is saved to `crew.config.local.json` (validated, with the
previous version kept) and applies straight away; only a new port needs a restart.

- **General:** default and stand-up models, agents at a time, limits (cost and time per run, daily
  spend, when to warn), handoffs, the daily stand-up, housekeeping.
- **Crew & roles:** every role as a card. **Edit** changes its name, colour, tag, whether it
  usually reads or changes code, and its instructions; **Reset to built-in** undoes your changes.
  **Add a role** creates your own (for example a Security Engineer). Each role saves on its own.
- **Permissions:** extra commands agents may run in every project, as chips you add or remove, with
  ready-made sets per stack (.NET, Node, Python, Java, Go, Docker). The built-in list and the
  always-refused list are shown; deleting, pushing, merging, downloading and chained commands can
  never be allowed.
- **Integrations:** a status light for Claude Code, Git, the GitHub CLI (and whether it is signed
  in), monday.com (and whether the token works) and graphify, with **Check again**; the monday.com
  token and API version; and **your integrations** (below).

### Adding integrations

Settings → Integrations → **+ Add integration** connects a new tool. Pick a starting point (Azure
DevOps, GitHub, a Playwright browser, PostgreSQL read-only, Slack, Microsoft Teams, a JSON webhook,
or a custom MCP server started by a command or reached by URL), then adjust it:

- **Tools for agents** (MCP servers): the command and arguments or the URL, environment variables or
  headers for tokens, the tools allowed (blank allows all), notes for the agents (when and how to use
  it), which roles and projects get it, and whether read-only tasks (investigations, reviews) get it
  too. Agents are told which tools they have; each run gets only the ones for its project, role and
  kind of task. On Windows, `npx`-style servers are started through `cmd /c`.
- **Notifications** (webhooks): Slack, Teams or JSON; tell you when a branch is ready for review, a
  plan is ready, a task failed or stopped, or any task finished. Plain `http://` is allowed only for
  localhost.
- **Test** starts the server and lists its tools (or sends a test message) before or after saving.
  **Turn off** keeps it without using it. Tokens, headers and webhook URLs are stored in the local
  config and never sent back to the browser.

Tools reach real systems: prefer read-only access, test systems and tokens with few rights.
- **Appearance:** theme, motion, 3D quality, and the simple 2D office.
- **Advanced:** port, workspace folder, Claude command, permission mode, strict MCP, passing a
  parent Claude session's variables through; the list of backups with **Restore**, and **Export** /
  **Import** of the whole setup (export leaves out the monday.com token; import keeps this
  machine's).

Per project, **Edit project** also sets a cost and time limit for each role, and the monday.com
board (picked from the boards your token can see).

## Keep it running

The stand-ups only happen while the server runs. To start it automatically when you log in to
Windows:

```powershell
schtasks /create /tn "Dev Crew" /sc onlogon /tr "cmd /c cd /d C:\path\to\dev-crew && node server.mjs"
```

## Cost

Each task and stand-up is a Claude Code run, billed to your Claude plan (or API key). The top bar
shows today's cost as Claude Code reports it. Sonnet is the default. Pick **Haiku** in the assign
dialog for quick chores and **Opus** for hard ones. A stand-up is usually a few cents to a few
tens of cents.

### The Costs page

**Costs** in the sidebar shows what the crew spent, from the cost, tokens and time every task
and stand-up records (archived tasks included). Pick a range (7, 30 or 90 days, this month, all
time) and narrow it to a project, role or model:

- **Spend** for the range, runs, cost per finished task, cache hit rate (share of prompt tokens
  read from cache: higher is cheaper), what was spent on failed or stopped work, and how often
  the Estimate ETA range was right.
- **Spend per day** with your daily limit marked; hover a day for its spend and runs, or open the
  table view.
- Spend **by project, by role and by model**, and the **token mix** (input, output, cache read,
  cache write).
- The **most expensive tasks** (click one to open it) and **estimate vs actual** for recent tasks.
- **Export CSV**: one row per run (time, project, role, model, cost, turns, seconds, tokens).

Costs are the API-equivalent figures Claude Code reports; on a subscription plan they show
relative usage rather than an invoice.

### Estimates and limits

Type the task in the Assign dialog and press **Estimate ETA** for an approximate time and cost
for that task, when it would start given the queue, and when it should be done. The estimate uses,
in order: past tasks with similar wording (three or more), past runs by that role on that project
(five or more), then by that role, then of that kind. Without history it uses a rough default,
scaled by what the wording suggests ("fix typo" is small; "refactor all services" is big), and
says so. Editing the task greys the estimate out until you check again. Queued and running tasks
show their ETA in the task lists.

Every run stays inside limits. Set defaults in `settings.limits`, and override them per project
(`projects[].limits`), per role (`projects[].roles.<role>.limits`) or per task in the dialog:

```json
"limits": { "taskBudgetUsd": 2, "taskTimeoutMin": 30, "dailyBudgetUsd": 20, "warnAt": 0.8 }
```

| Limit | What happens |
|---|---|
| `taskBudgetUsd` | Passed to Claude Code as `--max-budget-usd`; the run stops when it is reached. |
| `taskTimeoutMin` | The server stops the run, with a warning in the log at `warnAt` (80%). |
| `dailyBudgetUsd` | Once today's spend reaches it, queued runs wait until tomorrow or until you raise it. The top bar turns amber at 80% and red when reached. |

`0` means no limit. A run stopped by a limit is marked **Stopped**, not failed. **Continue**
resumes the same Claude session on the same branch, so it picks up from its last step instead of
starting again; the task panel lets you raise the limit that was hit (it suggests double) first.

## Files

```
server.mjs          queue, scheduler, API, live events
lib/roles.mjs       the built-in roles, custom roles from the config
lib/review.mjs      the Code Reviewer's verdict and findings, and posting them with gh
lib/graph.mjs       knowledge-graph context from graphify (digest or graph tools)
lib/integrations.mjs  tools and notifications added in Settings (MCP servers, webhooks)
scripts/graph-trial.mjs  measures a knowledge graph: the same questions with and without it
lib/prompts.mjs     task, report and stand-up prompts
lib/claude.mjs      runs `claude -p`, and the allow/deny tool lists
lib/git.mjs         worktrees, branch summaries, repo activity
lib/config.mjs      reads the config and discovers repos
public/             the dashboard (plain HTML/CSS/JS, no build step; glass.css is the theme)
public/office3d.js  the 3D office (three.js, bundled in public/vendor, MIT licence)
data/               tasks, stand-ups, logs, worktrees (created at runtime)
```

## Before you use it at work

Agents send the code they read to Anthropic's API through Claude Code. Check that your
organisation allows Claude Code on these repositories, and use the account (Claude for
Work / Enterprise, or the API key) your organisation approves.
