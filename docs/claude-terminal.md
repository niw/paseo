# Claude (Terminal)

`claude-terminal` (Claude (Terminal), disabled by default) drives the interactive Claude Code CLI in a workspace terminal instead of the Agent SDK. The adapter lives in `packages/server/src/server/agent/providers/claude/terminal/`.

It uses only what Claude Code offers any terminal: CLI flags, OSC 7501 program status, hooks passed with `--settings`, MCP, and the transcript. Never write to the user's Claude config dir, and never type a slash command that saves a setting there. `/model` and `/effort` save the choice to the user's `settings.json`.

## Launch

Opening an agent never starts the CLI. The next prompt starts it with `--resume`, or with `--session-id` while no transcript exists. So does the agent tab's "Open terminal", through `agent.terminal.start.request`, which the app offers for agents whose capabilities set `supportsTerminal`. Creating an agent starts the terminal without waiting for it.

Every launch passes the session's settings as flags:

- `--model` and `--effort` for the model and thinking option.
- `--permission-mode`, always. Without it Claude Code uses the user's default mode.
- `--settings`, one JSON object holding the thinking settings and the hooks. Claude Code reads a single `--settings`, so they must share it. Settings passed this way apply to the session only.
- `--mcp-config`, a file with mode 0600 in the session's temporary directory. It holds the MCP servers, including the Paseo server the daemon injects. As an argument, the Paseo server's bearer token would show in the process list.

Switching the model, the thinking option or the mode restarts the CLI with `--resume` and the new flags, once no turn runs.

The persistence metadata drops the injected Paseo server, since the daemon adds it again on every launch.

The terminal carries the agent's `agentId`. The app opens it from the agent tab's menu instead of giving it a tab of its own, and closing that tab leaves the terminal running.

## Prompts

A prompt is pasted with bracketed paste and submitted with Enter. Claude Code drops a paste that arrives before its UI accepts input, and it reports program status once it does, so each prompt waits for the terminal's first OSC 7501 report. Claude Code may first ask in its terminal, such as whether to trust the folder.

An image is written to a file in the session's temporary directory, and its path is pasted before the prompt's text. Claude Code attaches an image when a paste is only its path, and shows it as an `[Image #N]` placeholder.

The transcript's echo of a prompt carries the prompt's `clientMessageId`. Echoes match their prompts by text, ignoring the image placeholders.

A prompt typed in the terminal opens an autonomous turn without a `turnId`, and the manager assigns one.

## Turns

OSC 7501 program status drives the turn. Working opens it, idle after working closes it, and blocked keeps it open. A prompt that never reports working, such as some slash commands, closes after a grace period.

Claude Code writes its last reply after it reports idle, so a turn closes only once the transcript stays quiet.

## Transcript

`ClaudeTranscriptFollower` follows the transcript and converts it with the Claude provider's history conversion. The conversion is append-only as the transcript grows, so each change yields only the items past the ones already yielded.

A rewind in Claude Code keeps the session and its transcript. The next message continues from an earlier record, and the abandoned turns stay in the file as a branch. The conversion keeps the chain that ends at the last message and drops a branch only when it starts with a prompt, because the results of parallel tool calls, progress and other records branch off the chain too. When the conversion no longer starts with the items the follower yielded, the session emits `history_reset`, and the manager rebuilds the timeline from `streamHistory` as it does after a rewind from Paseo. A rewind writes nothing until the next message, so the timeline catches up then.

Subagents write their own transcripts under the session's `subagents/` directory, while the parent's transcript stays quiet. The follower watches that directory and yields `provider_subagent` events: each subagent's new timeline items, and each descriptor change once.

Token usage comes from the `usage` of the assistant records. Claude Code writes one record per content block, each with the whole response's usage, so usage counts once per message ID. The transcript has no cost.

## Hooks

Hooks are `http` hooks in `--settings` that post to a loopback server the provider runs (`terminal/hook-server.ts`). A per-session bearer token authorizes them, and the terminal's environment holds it.

`SessionStart` hooks run only as commands. `/clear` therefore shows up as a new `session_id` on the next hook, and the session then follows the new session's transcript and reports `thread_started`.

Every hook reports `permission_mode`. A mode the user picks in Claude Code, with Shift+Tab or by approving a plan, reaches Paseo as `mode_changed`. Approving a plan returns to the mode from before plan mode.

## Permissions and dialogs

A `PermissionRequest` hook becomes a Paseo permission request, and the hook's answer carries the decision. This covers tools, `AskUserQuestion` and plan approval. Claude Code shows its own dialog while the hook waits, and it keeps waiting after the user answers that dialog, so leaving the blocked state settles the request: working again reads as allowed, idle as declined. A steer that clears pending permissions denies them before it pastes, since the paste would land in the dialog.

Claude Code reports blocked, with what it needs as the message, for every dialog it registers as waiting for the user, such as a paused session or an MCP server asking for input. A blocked state that no permission request explains is one only the terminal can answer. The session posts a warning to the timeline and refuses prompts and steers until it ends, because a paste would land in the dialog and Enter would choose an option. It also asks for `permission` attention with the warning as the notification body: Paseo has no attention reason for other input, and the terminal sends no notifications of its own. The `Notification` hook supplies the message when the report has none.

A dialog Claude Code does not register stays invisible. Its auto mode setup offer is one.

## Catalog and commands

The model catalog skips the Claude provider's model discovery, which starts Claude Code over the Agent SDK. It holds the curated models plus the ones the config dir's `settings.json` names.

Slash commands come without starting the CLI:

- `/clear` and `/compact`, which finish without a picker. Most built-in commands open one or change settings.
- The `commands/` and `skills/` of the config dir and of the project's `.claude`.
- The `skill_listing` attachments in the transcript, which name the skills Claude Code resolved, plugins included. A draft has no transcript, so it lists the files alone.
