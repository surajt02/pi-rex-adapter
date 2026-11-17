<h1><img src="https://raw.githubusercontent.com/xiangsam/pi-rex-adapter/main/assets/pi-rex-adapter.png" width="48" height="48" alt="Pi + Rex logo" align="absmiddle"> pi-rex-adapter</h1>

**English** | [简体中文](https://github.com/xiangsam/pi-rex-adapter/blob/main/README.zh-CN.md)

**Give your Pi tasks room to run.**

Send a code review to another Pi agent. Explore a side question beside your main conversation. Let a long build finish in the background. pi-rex-adapter gives each task a place in Rex—and brings the results back when they are ready.

- **Full Pi subagents.** Delegate work to interactive Pi sessions in dedicated tabs. Get results automatically, then step into a session whenever you want to continue the conversation.
- **A conversation on the side.** `/btw` opens an independent Pi beside your main chat. Only the conclusions you choose to return enter the main conversation.
- **Background jobs that report back.** `/bg` runs long shell commands, delivers their exit code and output, and closes the pane after delivery.
- **A compact view of active work.** One line per agent: its goal in a few words, elapsed time, and token count. Pipelines group their steps under one heading. History, logs, and controls stay available in a single overlay.

Built to stay out of the way: native Pi tools remain available, user-adjusted layouts are respected, and monitoring stops when no tasks need it. Configuration is just two settings: UI language and panes per tab.

## Installation

Requires **Pi 1.4+**, **Node.js 22.19+**, and Rex with support for `window new/split --json --shell=none --focus=false` `block inspect --json`, `block call … process` (including `last_exit`), and `events -s … --json` (terminal exits and block closure).

Run inside a Rex terminal:

```sh
pi install npm:pi-rex-adapter
# Run /reload in an existing Pi session, or restart Pi.
```

You can also install from GitHub:

```sh
pi install git:github.com/xiangsam/pi-rex-adapter
```

Or try it for one session:

```sh
pi -e git:github.com/xiangsam/pi-rex-adapter
```

The parent Pi must run inside Rex. The adapter uses `REX_SESSION` and `REX_BLOCK` to target the parent block, regardless of which pane currently has focus. If `rex` is not on `PATH`, it checks the standard macOS Rex and Rex Beta application locations; `PI_REX_BIN` can specify the executable. Child sessions use the current Pi entry point unless `PI_REX_PI_BIN` is set.

Parent and child processes must share the same machine and filesystem. Remote Rex hosts are not supported.

## Quick start

```text
/btw What would we gain by making this module event-driven?
/rex-agent Review the authentication module. Report risks and relevant files without making changes.
/bg npm test
/rex-tasks
```

| Command | What it does |
| --- | --- |
| `/btw <question>` | Opens or reuses a side conversation to the right of the main Pi |
| `/btw` | Focuses the existing side conversation |
| `/rex-agent <task>` | Starts an interactive Pi subagent in an Agents tab |
| `/bg <command>` | Starts a background shell job as a minimized chip |
| `/rex-tasks` | Opens the task manager overlay |

The main agent can also launch and manage tasks through structured tools. Completion arrives automatically; it does not need to poll for results.

**Closing policy:** shell jobs close after their results are delivered; the main agent closes completed subagents after reviewing them; BTW conversations stay open.

## Configuration

The setting is optional:

```json
{
  "language": "en"
}
```

- **Global:** `~/.pi/agent/rex.json`, or `rex.json` inside `PI_CODING_AGENT_DIR` when that variable is set.
- **Project:** `.pi/rex.json` in the current working directory. Project fields override global fields.

| Setting | Default | Behavior |
| --- | --- | --- |
| `language` | `"en"` | `"en"` or `"zh"`. Covers the **main agent's overview**, including titles, task states and counts, plus overlays, action feedback and child-session notices. |

For example, `{"language":"zh"}` in the project file changes the UI language, and `{}` leaves it at the default. The former `panesPerTab` setting is gone: agents grew into one grid tab and background jobs became chips, so nothing is paged any more and the key is now reported as unknown.

Settings are read at startup, session switches, and `/reload`. No default file is created and no configuration watcher is added. Reload an existing child Pi separately to update its UI language. Children launched into another checkout through `cwd` still read their parent project's configuration. Invalid settings report their source and fall back to inherited or default values; other valid fields still apply.

Language settings leave task text, agent answers, logs, underlying errors, and structured status values intact. They do not set the model's response language. Tool names, slash commands, and their descriptions remain in English.

Placement follows the tool the main agent chose: a job becomes a chip, an agent joins the grid tab, and BTW keeps its own reusable pane beside the parent. Manually added panes are never touched. The sections below describe each of them.

## Side conversations

`/btw <question>` opens a full interactive Pi in the **right half of the parent block**, keeping focus on the main conversation by default. Click the pane, run `/btw` without a question, or choose **Focus task** in `/rex-tasks` to enter it.

New side sessions are named `BTW · <name>` and show their original topic in one muted line above the editor. After an answer, the footer says “Answer ready · optionally share with /btw-return”. Sharing is optional: normal answers create no parent return message. An explicit return changes the footer to “Conclusion queued · ready to continue”.

The conversation has its own Pi session. By default it inherits the parent's model, thinking level, and a text snapshot of the current branch: up to 48,000 recent characters, including summaries but excluding images, thinking, and tool output. This is a text snapshot, not a complete Pi session clone.

Further `/btw <question>` calls reuse the same conversation and history. Questions go through a file inbox into Pi's input API; no terminal keystrokes are simulated. Questions arriving while the child is busy are combined when it becomes idle. The original context snapshot is retained, so include any newer background in the question itself.

An input is acknowledged only after it appears in the child's Pi session. Pi's input API returns no asynchronous confirmation, so an unconfirmed input is retained rather than repeatedly resent while authentication or input handlers may still be running. After 10 seconds, the child status line shows a notice. Fix the model, authentication, or input error, then run `/reload` in the child to retry.

To send a conclusion back, run this **inside the side conversation**:

```text
/btw-return
/btw-return Use option B. Change the cache layer first and leave the rest for later.
```

Without arguments, it returns the last assistant answer. With arguments, it returns only that text. The conversation stays open and can return more conclusions later; ordinary answers are not automatically sent to the parent.

BTW enables only `read,grep,find,ls` by default and disables MCP. This is a tool selection, not a security sandbox. Files are not automatically merged. To change the existing conversation's `cwd` or model, close it before creating another. A normally exited but retained BTW block is closed and replaced when a new question is submitted.

## Interactive subagents

Subagents launch with Pi's `--approve` flag, trusting project-local files for that run so a new `cwd` does not wait for a folder-trust prompt. This includes project configuration and extensions; it does not save a permanent trust decision. The flag applies to delegated agents started through `subagent` or `/rex-agent`.

`/rex-agent` starts a **full interactive Pi**, without `--print`, in an Agents tab. Every settled turn returns its answer to the parent. The Pi session remains open, so you can focus it and continue the conversation; later turns produce separate reports.

New agent sessions are named `Agent · <name>`, which Pi includes in its terminal title. A single muted line shows the original assignment above the editor; the footer distinguishes starting, running, failed, interrupted, and “Result queued · awaiting parent review”. Queued means the report has been written for the parent, not that the parent has already received or reviewed it. These hints follow the configured UI language and never append messages to the conversation. Pi 1.4's own program-status reporter continues to handle Rex working/blocked/done/error states; the adapter does not override it or add a status polling loop.

After reviewing a completed handoff, the main agent should promptly call `rex_finish` unless it needs another turn from that agent. Files, results, and Pi session records remain available after closing, so the parent's integration or testing can continue afterward; there is no need to keep the pane open until the overall task ends. This is a tool/notification instruction, not enforced automatic closure or a repeated reminder. The tool requires a completed task with an idle or exited process. It will not finish an active task or a BTW conversation. Failed or interrupted tasks stay available for diagnosis or follow-up; after reviewing them, use `rex_control({id, action: "close"})` to explicitly close them. Closing is a main-agent action, not a child that exits itself.

Child sessions do not register this adapter's delegation tools. Tasks share a working directory unless the main agent supplies another `cwd`. For parallel writers, prepare separate checkouts and pass their paths explicitly. The adapter does not create worktrees or manage role packs, model fallbacks, or persistent specialists.

If no name is supplied, the task's first line becomes a short, readable name.

## Background shell jobs

`/bg` runs `/bin/sh -c` in its own terminal block, floated aside and minimized into a chip so the main pane keeps its size, using the parent's working directory by default and closed stdin.

The pane immediately shows the task name, working directory, and complete submitted command, including multiline commands. Live output follows; when the command exits, a short summary shows its outcome, exit code or signal, and elapsed time. A silent command is explicitly marked as producing no output. Headings use muted blue and follow the configured UI language. These display lines are separate from `output.log` and the result sent to the parent.

The shell runner identifies itself as `app=shell` (not Pi), sets a terminal title, and reports working/done/error states through [Rex's program status protocol](https://www.superlogical.com/rex/docs/build/program-status), so Rex can display the task state without polling. Cancellation reports idle. Output remains available in Rex's scrollback while the pane is open; closing after result delivery follows the same policy as before.

Shell output is still captured through pipes to preserve full logs and process-group cancellation. Python receives `PYTHONUNBUFFERED=1` by default so ordinary `print()` output appears promptly; an existing value is preserved. Other programs may need their own flush/progress options when stdout is not a TTY. Output redirected by the command to another file is not automatically tailed.

Full stdout and stderr are written to `output.log` and displayed in the block. Both destinations apply backpressure; a write failure stops the shell and attempts to record the failure. When the command exits, the parent receives its exit code, the last 16,000 characters of output, and the artifact path. A long-running server reports completion only when it exits.

The command process exits when it finishes. The adapter closes its block once the parent session has durably received the result, including nonzero exits. Merely queuing a notification does not count as delivery. If the parent is offline, the block is retained until the parent resumes and receives the result. Logs and task records remain available afterward.

Use this for commands you choose to start in the background. **The adapter does not take over an already-running native `bash` command or implement Ctrl+B/timeout-based backgrounding.** It does not rerun an existing command to make it a background task.

## Launches in the transcript

A delegated launch is a row in the conversation, not a JSON blob. `subagent` shows one agent; `pipeline` shows its header and every step beneath it:

```
● Pipeline · dot cycle check · 2/2 done (ctrl+o to expand)
  ├ ● List overview exports (scout)
      ⎿ Done · deepseek-v4.1-flash · 2 turns · 1 tool use · 3.0k token · 6s
  └ ● Check export usage (scout)
      ⎿ Done · deepseek-v4.1-flash · 2 turns · 1 tool use · 6.7k token · 12s
```

A single agent has no header of its own, because its glyph already carries the state:

```
✳ Review plan vs code (reviewer) (ctrl+o to expand)
  ⎿ Running · mimo-v2.6-pro · 8 turns · 11 tool uses · 41.2k token
```

The glyph is the same dot cycle as the rest of the UI, and it really does spin: a running row repaints on its own every 170 ms, so a child that is thinking silently still looks alive. It settles into a filled green dot when the agent finished, red when it failed or was interrupted, and stays hollow for a step that has not started. The `⎿` line carries the state word, the model, how many turns and tool calls the child has taken, its current token count, and — once it finishes — how long it ran. Those numbers are read from the child's own session file, and the row repaints itself when they change, so a long chain updates in place instead of freezing at "Running". A step that has not launched says `Waiting for the previous step` rather than showing zeros, and a step a failed chain never reached says `Skipped`, because there is no previous step left to wait for. A count that was never measured is left blank rather than shown as `0 token`.

Below 90 columns the model name is dropped to keep the numbers.

`ctrl+o` expands each agent to **the whole report**, and the row keeps working while it is open:

```
● Pipeline · row render check · 2/2 done (ctrl+o to collapse)
  └ ● Check formatter boundaries (reviewer)
      ⎿ Done · mimo-v2.6-pro · 2 turns · 2 tool uses · 21.0k token · 1m 07s
        read src/columns.mjs · read README.md · +1 more
        All 8 formatter claims in README.md are TRUE.
        Minutes below an hour · src/columns.mjs:46–48 · TRUE
        Switches to Nh NNm past an hour · :50,52 · TRUE
        Clamps at 99h+ · :51 · TRUE
```

The first line under `⎿` is what the child actually ran: the tools it called with the file or command each one touched, deduplicated, paths shortened against the directory the child ran in, as many as fit on one line and `+N more` for the rest. That line is why the row is worth expanding — the numbers say how much work happened, this says *what* happened.

The report itself is markdown, and markdown at terminal width is mostly pipes, so it is flattened before it is drawn: table rows become `cell · cell · cell`, the `|---|` rules are dropped, backticks and heading marks go with them. Text wraps to the pane with a hanging indent instead of being clipped at the right edge, so a table row keeps its verdict column instead of losing half of it. Nothing is hidden behind a "… more lines" count, because there is no second expansion to reach it with. The one exception is the parent's 4000-character cap on a stored report; when a row hits it, the row says `… report truncated at 4000 characters` rather than stopping mid-sentence as if that were the end.

## Task overview and controls

Above the parent's editor, the list shows every Agent and Shell task whose pane is still open, so a completed agent awaiting review and a stuck or failed pane stay visible until you close them. BTW conversations live in their own split and never appear here. When nothing is open, the list disappears. History is retained.

Each step occupies one line:

```
   ◆ reload safety · 1/3
   ├ ● scout       Read chain persistence            1m 07s · ↓  8.6k tokens
   ├ ✳ planner     Plan reload recovery              6m 12s · ↓ 12.4k tokens
   └ ○ reviewer    Review plan vs code
   ● worker        Write probe script                   41s · ↓  3.1k tokens
```

A pipeline is one block under its ◆ heading, with `done/total` steps and a step that has not launched yet shown as `○`. Agents outside a pipeline keep a blank gutter and start two columns left, because the connector glyph is what marks membership; their goal starts in the same column as a pipeline step's goal. State is carried by the glyph and its colour — spinner for running, filled for done, red for failed or interrupted, `○` for queued — never by a word. Each line ends with the elapsed time and the child's current token count, both right-aligned in fixed-width columns, so the figures line up and are never pushed off the line by a long goal. Time switches to `1h 42m` past an hour and clamps at `99h+`; token counts stay at most five characters (`8.6k`, `104k`, `1.0M`).

Terminal width is respected: goals are truncated only when they genuinely cannot fit, and the figures keep their columns. Terminal control characters are stripped. At most ten rows appear; the task manager holds the rest.

`/rex-tasks` is the single management entry point. It opens a native Pi overlay, up to 84 columns wide, with an opaque blue-grey background, border, padding, and a highlighted selection. Closing it restores the underlying page.

- Use arrow keys and Enter to select; Esc goes back one level (details/error → task menu → task list → close). Lists, details, and logs support PageUp/PageDown. Repeated `/rex-tasks` invocations do not stack task managers.
- Task menus contain details, logs, focus, interrupt, finish, and close actions. Returning from details or logs preserves the task menu; returning to the list preserves the selection and scroll position. Errors return to the same menu.
- The first list entry toggles the main-page overview. This preference is saved per parent Pi session.
- Closed tasks retain their results and logs. BTW conversations remain manageable here.
- Completed, open agents show **Completed · awaiting delivery** or **Delivered · awaiting close**. Delivery requires a persisted parent-session receipt matching the latest turn; merely queuing a message or delivering an earlier turn does not count. Delivery does not confirm review. Task menus and details explain this distinction. These labels follow the UI language and refresh when you reopen or navigate the overlay, without extra timers or model wakeups. A completed agent stays in the main-page list until its pane is closed, because closing it is what you do next.
- An uncertain launch without a block ID does not offer unusable focus or close actions. After checking Rex and verifying that the resource is absent and the related process has stopped, use **Confirm resource removed…** to repair the record. This does not send a close or kill command. A connection failure alone is not evidence that a resource is gone.
- Queries, details, and action errors stay in overlays. Creating a task gives brief status-bar feedback instead of a JSON dump in the main conversation.

Only `/btw`, `/bg`, `/rex-agent`, and `/rex-tasks` are registered in the parent. The child also has `/btw-return`. Separate panel, overview, focus, interrupt, close, and log slash commands are consolidated into the overlay.

The overview reflects the child's last reported activity. Opening it does not inspect every Rex block. Failed automatic shell cleanup is shown in the task manager and retried in the background. Cleanup runs in a separate serial queue; model turn boundaries never wait for Rex CLI calls or disk scans.

## Tools for the main agent

| Tool | Parameters and behavior |
| --- | --- |
| `subagent` | `task,label`; optional `agent,name,cwd,model,fork`. Starts an interactive Pi with automatic reports; the launch appears in the transcript with live state, turns, tool uses and tokens. `label` is required and must be six words or fewer: it is the goal shown in the parent list. `agent` picks a role from `~/.pi/agent/agents/*.md`. |
| `btw` | The same optional fields; omit `task` to focus, or supply a question to reuse the right-side conversation. Reports are explicit. |
| `pipeline` | `steps[]` of `{agent,task,label,model}`, plus optional `title,cwd,model,fork`. Runs the steps in order, one pane each, and delivers one combined report. Every step needs a label of six words or fewer. |
| `bg_run` | `command`; optional `name,cwd`. Starts a shell job with automatic completion delivery. |
| `bg_logs` | `id`. Reads the last 16 KB of shell output. A missing log returns `logAvailable:false` and a note; agent/BTW results are available through `rex_tasks`. |
| `bg_kill` | `id`. Closes an owned shell block. |
| `rex_finish` | `id`. Closes a completed, idle or exited task after review; retains records. |
| `rex_tasks` | Optional `id` queries one owned task; omit it to list all. Always returns an array. Includes task, process, and block states and the actual window. Failed inspection reports `unverified` with the reason. |
| `rex_control` | `id,action`, where action is `focus`, `interrupt`, or `close`. |

`fork:false` omits the parent snapshot. `interrupt` sends Escape to Pi and interrupts only its current turn, leaving the interactive session open. Use `bg_kill` or `close` to stop a shell job. Control tools accept only full task UUIDs owned by the current parent session, not arbitrary Rex block IDs.

Inside Rex, launch tools and `rex_finish` are exposed directly by default. Diagnostic, log, and control tools use Pi's deferred discovery. If neither `tool_search` nor `codemode` is active, necessary controls are exposed directly while tasks need attention. A non-Rex session with no owned tasks gains no default tool declarations or system-prompt rules. Native Pi tools are unchanged.

## Workspace and layout

A **Rex session** groups the workspace. A **window/tab** groups attention. A **pane** is a position in that layout, while a terminal **block** hosts a process. A **Pi session** stores a conversation. Multiple Pi sessions can share a Rex workspace without sharing conversation context or isolating file changes.

```text
Current Rex session (selected by the user)
├─ Main tab: main Pi | BTW
├─ Agents · <parent Pi ID>: one grid tab holding every agent
│    2 agents      3 agents      4 agents      5 agents
│    ┌────┬────┐   ┌──┬──┬──┐    ┌────┬────┐   ┌────┬────┐
│    │ 1  │ 2  │   │1 │2 │3 │    │ 1  │ 2  │   │ 1  │ 2  │
│    └────┴────┘   └──┴──┴──┘    ├────┼────┤   ├────┼────┤
│                                │ 3  │ 4  │   │3 │4 │5 │
│                                └────┴────┘   └──┴──┴──┘
└─ chips: each background job, minimized into the corner
```

- Agents never page into an `Agents 2` tab. One, two and three agents are columns; from four the tab becomes a grid of rows of equal panes, with the spare panes in the lower rows, so five reads as two above three. The grid is chosen from the tab's size in pixels, because a wide window wants wide rows and a square one wants square cells.
- The agent tab is rearranged on each launch: panes are detached and placed back in reading order, so the newcomer takes the last cell and the panes already there keep their order. Panes resize whenever the grid shape changes; a crowded tab is read by zooming a single pane rather than by opening more tabs.
- A background job never takes a pane from what the user is reading: its block is created inside its own floating layer in the parent's window and minimized at once, so no pane is ever resized, not even for a frame. What remains is one chip in the corner. If Rex refuses that layer, the job is split in beside the parent pane and floated away instead, which costs a brief resize of that pane. Jobs stack down the right side, three at a time, so a chip that is popped open lands where it will not cover the prompt. Popping one keeps it open until it is minimized again, and the block keeps running while minimized, so output is never lost; when the job's block closes, its chip goes with it.
- Agents and Jobs have separate groups, owned by a parent Pi session. Titles include a short parent ID. Different parents do not reuse one another's task panes. The main tab and Rex session are not renamed; Rex sessions are not automatically created.
- Layout creation and closing are serialized per parent, and the grid rearrangement runs under the same lock. Group membership is restored from task records after `/reload`.
- A job's chip stays until its block closes: keeping the log of an undelivered result keeps the chip, and delivering it closes both. An empty Agents tab is not deleted automatically because users may have added content.
- Blocks the user moves out of the Agents tab stay where they are and are not counted, so the grid is built from the panes still in that tab; it never grows beside a block the user moved away. A chip the user moves, resizes or leaves open is likewise left alone. Moving a block does not change ownership, result delivery, or control permissions, and manually added panes are not rearranged.
- Clicking a row in the list above the prompt jumps to that task's pane; when the pane lives in another window, the app is asked to show that window first, because focusing a pane only moves the session's active window and would otherwise change nothing on screen.
- Another Pi session can put its own panes and chips in the same Rex session. None of them are counted, moved or covered: the grid only arranges this parent's agent panes and skips rearranging entirely while a pane it does not own is in the tab, and a chip avoids any slot a floating layer already covers, whichever parent created it.
- When selecting a layout or reusing BTW, an exact Rex response that a direct Pi block is missing marks the task closed and allows creation to continue. If no exit code remains, the process outcome is explicitly unknown; existing answers are retained. Legacy runner tasks still require a valid exit record before automatic retirement. Connection failures, missing sessions, and uncertain creations stop creation in that group; manually verified removal can be recorded through the task manager's recovery action.

`rex_tasks` separates `taskState`, `processState`, and `blockState`. An answered agent can be `completed / idle / open`; a finished shell job can be `completed / exited / open`. Task and process states come from the last activity and exit records. Block state comes from the current Rex inspection, or `unverified` if inspection fails. Confirmed closed records always report `closed`, including when a close races with inspection.

`resultAvailable` says whether `result.json` exists. A task with only an exit record still exposes its cancellation or exit reason and retained logs; a successful result is not invented. The footer counts only active Agent and Shell tasks.

Control responses use the same derived task state as `rex_tasks`. Successful closes and confirmed resource removal also save that outcome in `run.json`; repeating a close repairs an older closed record's stale status. While a task remains open, `run.json` is a lifecycle manifest, not a live status feed: query `rex_tasks` to combine activity, result, and exit records. Historical records are not rewritten in a background migration.

Existing tabs are not automatically migrated. Older BTW children need `/reload` to support question delivery, or can be closed and recreated. Multiple independent parent processes controlling the same Pi session are not supported; the layout lock covers one Pi process and its reloads.

## Delivery and recovery

```text
Parent Pi → task record → Rex block → Pi (Agent / BTW)
    │                         └────→ shell runner → shell
    ↑
    └── batched results ← completion / optional return files
        process exits   ← Rex events / recovery inspection
```

Agent and BTW panes start Pi directly. A short-lived `env` invocation sets the task directory and PATH, then replaces itself with Pi; there is no adapter Node supervisor in these panes. Pi owns its terminal title and native `app=pi` status. Shell keeps its runner for full logs, terminal output, backpressure, and process-group cancellation. Existing children keep their launch architecture until closed and recreated.

While direct Pi panes exist, the parent maintains one Rex event subscription per Rex session. Terminal exit events persist `exit.json`; block closure updates the task record. Initial subscription, newly added tasks, and reconnection reconcile `process.last_exit`, with recovery queries serialized per session. This does not add a recurring process polling loop or block model boundaries. Reload/session shutdown releases the subscription without closing children; reconnection uses bounded backoff.

If a direct Pi block disappeared while the parent was offline and Rex no longer has its exit status, recovery records `closed` with `exit.unknown=true` and an explanatory error. It retains a previously completed idle handoff; an unfinished task becomes `exited`, without inventing success or leaving it running forever. A retained block's known exit code is recovered normally. BTW exit events update history only; conclusions still require `/btw-return`.

The parent collects results in a local inbox. While it is working, `turn_end` or `agent_before_settle` combines ready results into one custom message and requests a continuation. It does not wait for the entire task to become idle or queue a separate follow-up per result. While idle, it collects results for 300 ms before waking the agent once.

Messages are not forced into an in-progress model response or tool execution. Pending results do not immediately restart a parent that the user aborted; they can be received on the next user-started run. Multi-turn reports carry ordering information and are delivered in order after recovery. Older reports without that information fall back to file modification time.

Startup makes one recovery discovery. A session with no tasks to monitor creates no task directory, watcher, or timer. Active monitoring uses relevant file events and a five-second reconciliation interval, ignoring log-content changes. Closed tasks whose results have been delivered leave monitoring; history is loaded when requested. Unchanged overview content is not redrawn. Model boundaries consume already-collected results without waiting for scans.

Artifacts are stored under the parent's Pi session directory at `rex-adapter/<parent-session-id>/<task-id>/`, with private permissions. They include task text, snapshots, child sessions, logs, and exit records.

Reloading or reopening the same parent session discovers pending results and deduplicates them against persisted message receipts, including older single-receipt records. Switching sessions does not deliver old task results into a new parent. Returning to the original parent permits delivery. Exiting the parent does not close its blocks; results wait for that parent to resume.

Cancellation is checked after queued layout work and before resource operations, and is passed to CLI subprocesses. Cancelling before a creation request is sent prevents a new block. Once a request has been sent, cancellation, timeout, or an invalid acknowledgment produces an `uncertain` record rather than an automatic retry that could duplicate work.

An `uncertain` record has no block ID, so there is nothing to inspect and no process to watch — which is why it is the one state nothing else can settle. A pipeline does not wait on it: two minutes after such a step was created, the step is reported as failed (`The step never reported: its launch was never verified…`) and the chain ends, with the rest of the steps unstarted. The run itself is left as it is, still listed as unverified, because a connection failure never proves that no process started. Closing it is then your call, through the task manager.

Repeated or concurrent closes are idempotent. A task completed before closing keeps its outcome; an exit caused by closing an active task is classified as cancelled, with signal or startup errors retained. Records are not automatically deleted, and long-running jobs can keep growing their full logs.

On POSIX, shell jobs have an isolated process group. The runner forwards termination signals to the group and escalates after two seconds if necessary. Processes that deliberately leave that group are outside this guarantee. For shell and legacy runner tasks, SIGKILL, a Rex crash, or power loss may prevent exit records from being written, leaving the last state stale. Direct Pi recovery requires Rex to be reachable; transport errors never prove that a block was removed. Missing records never imply success. Ordinary reloads deduplicate delivery; crash windows do not provide transactional exactly-once guarantees.

Children use the Rex environment and the parent's `PATH`, without copying the parent's entire environment or temporary credentials. Model authentication should be available through the child's normal Pi configuration. Commands, agents, and project extensions run with the current user's permissions.

## Development and verification

```sh
npm test
npm run check
npm pack --dry-run
```

The regression suite covers CLI arguments, context snapshots, interactive Pi startup, real shell success and failure, bounded result payloads, batching and deduplication, ownership, cancellation, close races, layout overflow and restoration, BTW reuse and input confirmation, task overlays, cleanup after delivery, and manual recovery. It also covers slow-terminal backpressure, log failures, process-group termination, configuration precedence, language switching, and configurable pane limits. Registration has been checked with the Pi 1.4.0 extension loader.

A real Rex shell smoke test verifies the command header, title, native working/done status, stdout/stderr, and Python output arriving before process exit, with display text excluded from retained logs. An isolated real Rex test also verifies direct Agent/BTW startup in English and Chinese, native Pi identity, startup failure, block closure, and recovery of exits and removed panes after the parent reconnects. Broader layout and focus scenarios still need end-to-end verification. Suggested smoke tests inside Rex:

1. `/bg printf hello`: a minimized chip appears in the corner while the parent pane keeps its size; receive `exit=0` and `hello`, then see the chip disappear after delivery.
2. `/bg sleep 5; echo done; exit 7`: continue working while the job runs, then receive the nonzero exit.
3. Open a BTW conversation: verify the right-side split and retained main focus; return a conclusion with `/btw-return`.
4. Reload the parent while jobs run: receive each result once after completion. Repeat a close and verify that it is harmless.
5. Finish several jobs together: receive a batch instead of a separate model turn for every result.
6. Launch four agents, then three shell jobs: verify the agents form columns and then a 2x2 grid in one tab, while every job becomes its own minimized chip and the parent pane is unchanged.
7. Ask another BTW question: verify that the same conversation is reused and bare `/btw` focuses it.
8. Verify that finishing an idle agent preserves its result and that its task, process, and block states remain distinct.
9. Check that finished tasks leave the overview but remain in history. Shell panes close after delivery; agents wait for the main agent to finish them.
10. Click a job's overview row while its chip is minimized: verify the chip pops open at its slot and the click never terminates the job.
11. Change the UI language, then reload: verify the main overview and future launches while preserving existing layouts.

## Publishing releases

Pushing a `v*` tag triggers [the release workflow](.github/workflows/publish.yml). It checks that the tag matches `package.json`, runs syntax checks and the test suite, creates a GitHub Release with generated notes, then publishes to npm with provenance. Versions such as `0.2.0-beta.1` automatically become GitHub pre-releases and use npm's `next` tag; stable versions use `latest`. Both operations run in the same workflow: a release created using `GITHUB_TOKEN` does not trigger another release workflow.

One-time maintainer setup: in the npm package's **Settings → Trusted Publisher**, select **GitHub Actions** and enter:

| Field | Value |
| --- | --- |
| Organization or user | `xiangsam` |
| Repository | `pi-rex-adapter` |
| Workflow filename | `publish.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable direct publishing with `npm publish` |

This uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/); no `NPM_TOKEN` secret is needed. The npm-side configuration must be saved before the first automated release.

For each release, update `package.json` to a new, unpublished version, commit the changes, and push the matching tag from a Git clone. For example, with version `0.1.1` already committed:

```sh
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

Check **Actions → Release and publish to npm** for the result. There is no need to create a Release manually. Branch pushes and Release edits do not publish npm. The tag must point to a commit containing this workflow and the matching package version; pushing a tag does not change the version for you.

If npm publication fails, the GitHub Release may already exist. Fix the cause and rerun the failed workflow; it reuses the existing Release. npm versions cannot be overwritten: if publication already succeeded, use a new version for further changes. README changes reach npm with the next package version.

## Acknowledgments

Inspired by [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) for independent agents, non-blocking delegation, and result delivery, and [pi-background-tasks](https://github.com/SakikoTogawa233/pi-background-tasks) for persistent task records and completion notifications. Rex supplies the workspace, layout, and process hosts. This is an independent implementation, with no source copied from those projects; it does not reproduce their entire feature sets.

Rex CLI behavior is based on the installed `rex __internal skill` and `rex split --help`. See the [Rex documentation](https://www.superlogical.com/rex/docs) for its workspace concepts.

## License

[MIT](./LICENSE)
