# Terminal Activity Indicators

Paseo surfaces terminal activity as a tab indicator (the same "running" dot used by agents).

## Current state

Terminal activity is source-agnostic plumbing. `TerminalActivityTracker` holds the current per-terminal state and emits transitions to the manager, worker protocol, websocket subscription, app buckets, dots, and notifications.

The tracker defaults to unknown (`null`). Two producers feed it:

- Programs that speak the OSC 7501 Program Status Protocol report status in the terminal output stream. See [Program status reporting](#program-status-reporting).
- Agent hook commands report coarse activity to the daemon's local `/api/terminal-activity` endpoint. See [Hook reporting](#hook-reporting).

## Architecture

```
TerminalSession
  ├── TerminalActivityTracker               one per session
  │     ├── set(state)                      records the latest state
  │     └── onChange(snapshot, previous)    fires only on resolved-state transitions
  │
  └── onActivityChange({ activity, previous })   subscribed in TerminalManager
        ├── emits terminalsChanged          terminal list/tab indicators only
        └── subscribeTerminalActivity       per-transition stream for notification policy
        └── subscribeTerminalWorkspaceContributionChanged  workspace status rollup only
```

`TerminalActivityTracker` is the single stateful object per session. It holds `{ state, changedAt }`, starts at unknown (`null`), and fires `onChange` only when the state actually changes.

Terminal directory snapshots (`terminalsChanged`) and workspace contribution changes are separate concerns. A title-only change produces a terminal list snapshot but never touches workspace descriptors. A transition that changes the derived workspace bucket (e.g. idle -> working, working -> idle, attention cleared) emits both a terminal list snapshot and a server-internal `TerminalWorkspaceContributionChanged` event, which Session consumes to invalidate every active workspace sharing the owning workspace's `cwd`.

### Transitions carry their own history

Each `onChange` delivers both the new snapshot and the `previous` one (`{ state, changedAt }`). The transition flows unchanged up through `TerminalSession.onActivityChange` (as `{ activity, previous }`), the worker protocol's `terminalActivityChange` event, and the manager-level `subscribeTerminalActivity(listener)` stream (`{ terminalId, name, cwd, activity, previous }`).

The daemon consumes these transitions, not snapshots. When a transition moves from `working` to `idle`, the tracker records finished attention, so the terminal shows the same green finished dot as an idle agent that needs review. The websocket layer also fires a "Terminal finished" attention notification. A terminal that exits while still working emits no turn-end notification. A terminal that carries an `agentId` fires no terminal notifications, because its agent notifies for it.

Terminal list visibility is `workspaceId`-scoped: a terminal belongs to the workspace that created it, and same-`cwd` sibling workspaces do not see it in their terminal lists. Terminal status routing starts from that owning workspace, uses the owning workspace's `cwd`, then fans the status bucket out to every active workspace with the same `cwd`.

Path-prefix routing is only a legacy fallback for unowned terminal activity contribution. If a live terminal has no `workspaceId`, the daemon resolves the deepest active parent workspace from the terminal `cwd`, then fans status out to active same-`cwd` siblings of that owner. That fallback contributes status, but it does not make the terminal visible in workspace-scoped terminal lists.

## Program status reporting

The terminal worker's headless xterm parses [OSC 7501](https://www.superlogical.com/rex/docs/build/program-status) (`packages/server/src/terminal/activity/program-status.ts`). It needs no agent config: the program reports through the pty, so it also works over SSH and inside containers.

Claude Code sends `OSC 7501 ; ?` at startup and reports status only when the terminal replies. The daemon answers that query itself, as it does for DA1 and the color queries.

Each terminal holds the spec's per-id records and derives one activity from them: any `blocked` record is `needs_input`, then any `working` record is `working`, then any `done` or `error` record is finished attention, then `idle`. The tracker applies that derived activity only when it changes, so a hook-only terminal never sees it.

The `msg` of the latest record that decides the activity rides on the transition as `statusMessage`, and the terminal attention notification appends it to the body (`bash: approve Bash: npm test`). It stays inside the daemon. The app receives it only as notification text, so no protocol field carries it.

Program status differs from hooks in one place. A program reports unseen results as `done`, so `idle` after `working` is plain idle with no finished attention. Claude Code reports `idle` when the user interrupts a turn, so an interrupt key leaves program status activity alone: Claude Code keeps working after Escape when it runs a prompt queued during the turn, and it sends no new report while its state stays the same.

Working and blocked records end at the next shell prompt, which is the shell integration's OSC 633 `A`. Do not use OSC 133 `A` for this: Claude Code emits it inside its own UI to mark turns. RIS removes every record.

### Agent session

A program status report from `app=claude-code`, or a shell prompt, makes the terminal look up the Claude Code session running in it (`packages/server/src/terminal/agent-session/claude.ts`). Claude Code writes `<config dir>/sessions/<pid>.json` for every running process and rewrites it after `/clear` or `/resume`. The terminal matches those files against the pty process and its descendants and reports the result as the optional `agentSession` on terminal info. The app uses it for the terminal tab's "Copy resume command".

- The session file is internal to Claude Code. Anything unexpected reads as no session, never as an error.
- The outermost Claude process wins, so a Claude that a tool starts inside another Claude does not replace the one the user is talking to.
- Claude Code can report status before it writes its session file, so a miss while it reports retries a few times.
- A Claude Code that inherits another session's variables, such as `CLAUDE_CODE_CHILD_SESSION`, acts as a child session and writes no session file. Terminals drop `CLAUDE_PARENT_SESSION_ENV_KEYS` (`packages/server/src/server/agent/providers/claude/parent-session-env.ts`) from the daemon environment, which matters when the daemon starts from inside Claude Code.
- Terminals whose programs never report as `claude-code` never run `ps`. Windows is not supported yet.

## Hook reporting

Terminals receive four environment variables when the daemon creates the shell:

- `PASEO_TERMINAL_ID`
- `PASEO_ACTIVITY_TOKEN`
- `PASEO_TERMINAL_ACTIVITY_URL`
- `PASEO_HOOK_CLI` — absolute path to the current `paseo` CLI executable.

The generated shell command uses `PASEO_HOOK_CLI` to run the current CLI. `paseo hooks <agent> <event>` then reads the terminal id, token, and activity URL, asks the agent hook provider registry to resolve the event to a coarse activity state, and silently posts `{ terminalId, token, state }` to the activity URL. Missing env, unsupported agents/events, malformed hook input, and daemon/network failures are no-ops so agent hooks never break the user's terminal session.

Claude hook mapping:

- `UserPromptSubmit` → `running`
- `Stop`, `StopFailure`, `SessionEnd` → `idle`
- `Notification` with `notification_type` equal to `idle_prompt` → `needs-input`

Claude does not run `Stop` when the user interrupts a turn. A standalone Ctrl-C or Escape input
while terminal activity is working clears the activity without finished attention. The same
fallback applies to every hooked terminal agent; exact input matching excludes escape sequences and
pasted content, while later provider idle events remain authoritative.

Codex hook mapping:

- `UserPromptSubmit` → `running`
- `PreToolUse`, `PostToolUse` → `running`
- `PermissionRequest` → `needs-input`
- `Stop` → `idle`

OpenCode uses a server plugin instead of command hooks. Both generations discover the same global plugin file. Their loaders select separate entrypoints: OpenCode 1 calls `server()` with `{ type, properties }` bus events; OpenCode 2 calls `setup()` and subscribes to decoded `{ type, data }` events. Do not share their status mapping: V1 publishes `session.status` snapshots, while V2 publishes `session.execution.*` transitions.

| OpenCode event                                              | Generation | Activity    |
| ----------------------------------------------------------- | ---------- | ----------- |
| `session.status` with `busy` or `retry`                     | 1          | running     |
| `session.status` with `idle`                                | 1          | idle        |
| `session.execution.started`                                 | 2          | running     |
| `session.execution.succeeded`, `.failed`, or `.interrupted` | 2          | idle        |
| `permission.asked`                                          | Both       | needs-input |
| `permission.replied`                                        | Both       | running     |

The plugin translates both event contracts into the existing Paseo hook events. OpenCode 2 disposes its event subscription when the plugin unloads.

The daemon maps hook states onto terminal activity like an agent lifecycle plus unread attention: `running` → `state: working`, `idle` → `state: idle`, and `needs-input` → `state: idle` with `attentionReason: needs_input`. A `working` → `idle` transition records `state: idle` with `attentionReason: finished` until the user focuses that terminal; plain idle terminals still contribute no workspace status.

## Focus clearing

Client heartbeats include the focused terminal id. When a visible client focuses a terminal with an `attentionReason`, the daemon clears the attention and leaves the terminal idle. A program that still reports blocked keeps its `needs_input`: the dialog is still open, and Claude (Terminal) reads leaving it as the user's answer. Focusing an agent does the same for the terminals that carry its `agentId`, such as the one [Claude (Terminal)](claude-terminal.md) drives, because the app shows that terminal only on request. Plain idle terminal activity does not contribute to workspace status, so a workspace whose only attention source was that terminal rolls up from `needs_input` or `attention` back to `done`.

### Agent hook installation

Installing hooks edits the user's real agent config files, so it is opt-in. The daemon setting
`enableTerminalAgentHooks` (persisted under `daemon.enableTerminalAgentHooks`, default `false`)
gates installation. It is surfaced in the app under a host's **Terminals** settings as "Enable
terminal agent hooks" — "Get notifications and status from terminal agents. This installs hooks in
your agent config files." `applyTerminalAgentHookSetting` reconciles the installed hooks with the
setting: at startup it installs only when enabled; toggling the setting live installs on enable and
removes Paseo's marker-matched hooks on disable. `paseo hooks` keeps working regardless — the gate
only controls whether the daemon writes hooks into agent configs, not whether the CLI can post
activity when the env is present.

When enabled, Paseo installs provider hooks globally:

- Claude hooks are written to `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR/settings.json` when that override is set).
- Codex hooks are written to `~/.codex/hooks.json` (or `CODEX_HOME/hooks.json` when that override is set). Codex supports a native `commandWindows`, so each Paseo hook includes both POSIX and Windows commands. Non-managed Codex hooks are trust-gated by Codex; users may see Codex's hook review prompt before the hook runs.
- OpenCode gets a self-contained plugin at `$XDG_CONFIG_HOME/opencode/plugins/paseo-terminal-activity.js` (or `~/.config/opencode/plugins/paseo-terminal-activity.js` when XDG is unset; `OPENCODE_CONFIG_DIR` still wins when set).

Installation is marker-based/idempotent for config hooks and exact-file/idempotent for the OpenCode plugin. Paseo preserves user hooks, removes only its own marker-matched command hooks, and leaves hooks installed across daemon shutdown. Outside a Paseo terminal they are inert because the command or plugin is gated on `PASEO_TERMINAL_ID`.

Provider variation lives in `AGENT_HOOK_PROVIDERS`: provider id, installed events, config install metadata, and runtime event-to-activity resolution. The daemon calls `installRegisteredAgentHooks()` once; the CLI calls `resolveHookActivity(provider, event, input)`. Adding a provider should add one provider entry and register it in `AGENT_HOOK_PROVIDERS`, without editing the generic CLI command or daemon bootstrap.

The installed hook command keeps the config portable and resolves the CLI at runtime:

```sh
[ -n "$PASEO_TERMINAL_ID" ] && "${PASEO_HOOK_CLI:-paseo}" hooks claude <event>
```

Codex also receives the Windows equivalent:

```bat
if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" hooks codex <event>) else (paseo hooks codex <event>))
```

The daemon resolves the current CLI through `PASEO_CLI` when its launcher supplies one, or through the npm package shim for standalone installs. Terminal setup exposes that resolved executable to hooks as `PASEO_HOOK_CLI`; desktop and other daemon launchers do not know about the hook-specific variable. The generated command falls back to bare `paseo` if the hook env is missing and no-ops outside Paseo terminals because the `PASEO_TERMINAL_ID` gate remains first. Paseo also prepends the resolved CLI directory to each terminal `PATH` as a secondary fallback. All other behavior lives in `paseo hooks`: read the env, map the event, POST activity, and no-op/fail-open when anything is missing or unavailable.

If config installation fails, daemon startup and terminal spawn continue without terminal activity hooks.
