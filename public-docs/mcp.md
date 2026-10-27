---
title: MCP reference
description: Reference for the Paseo tools agents use to manage agents, workspaces, scripts, terminals, and schedules.
nav: MCP reference
order: 34
category: Orchestration
---

# MCP reference

[Enable Paseo tools](/docs/orchestration#get-started) to give agents this catalog. Ask for an outcome in natural language, or use the tool interfaces below.

## Configuration

| Setting                       | Default | Purpose                                            |
| ----------------------------- | ------- | -------------------------------------------------- |
| `daemon.mcp.enabled`          | `true`  | Run the MCP server.                                |
| `daemon.mcp.injectIntoAgents` | `false` | Give agents launched by Paseo access to its tools. |

Depending on the provider, Paseo delivers tools through its native tool interface or MCP. The capabilities are the same. Start a new agent or reload an existing one after changing injection settings.

## Limit Paseo tools by provider

Use provider policies when different agent profiles should receive different Paseo tools. Enable
tool injection globally, then add `paseoTools` to the exact provider IDs you launch:

```json
{
  "$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "daemon": {
    "mcp": {
      "enabled": true,
      "injectIntoAgents": true
    }
  },
  "agents": {
    "providers": {
      "codex-lead": {
        "extends": "codex",
        "label": "Codex Lead"
      },
      "codex-worker": {
        "extends": "codex",
        "label": "Codex Worker",
        "paseoTools": {
          "disabledTools": ["create_agent", "send_agent_prompt", "kill_agent"]
        }
      },
      "codex-isolated": {
        "extends": "codex",
        "label": "Codex Isolated",
        "paseoTools": {
          "enabled": false
        }
      }
    }
  }
}
```

Run `paseo reload` after editing `~/.paseo/config.json`, then start a new agent or reload an
existing one. A running session keeps the catalog it received at launch.

Omitting `paseoTools` enables the complete catalog. Set `enabled` to `false` to remove the catalog,
or list exact tool IDs in `disabledTools` to remove selected tools. Custom profiles do not inherit
this policy from `extends`; configure each custom provider ID separately.

Browser tools still require browser tools to be enabled and a connected browser host. The
voice-only `speak` tool is separate from this policy.

This setting limits the catalog presented to an agent. It is not a security boundary for an agent
that can access the host through a shell.

## MCP gateway

The MCP gateway is an MCP server that drives agents on several daemons. It is not the Paseo daemon and runs no agents. It connects to each daemon as an ordinary client, the way the app or CLI does, so it works with any daemon you can reach with `--host`, including over the relay with a pairing URL. Run it on any machine, such as a small server that agents on other machines can reach.

Add the daemons it may reach. `add` connects once to pin each daemon's server ID:

```sh
paseo mcp host add 'https://app.paseo.sh/#offer=...' --label laptop
paseo mcp host add 'ssh://deploy@build-box' --label build-box
paseo mcp host ls
```

Connections are saved in `<home>/mcp-gateway.json` with mode `0600`. They are credentials: anyone who can read the file can reach those daemons with the authority of the connection.

A running gateway picks up hosts you add or remove without a restart. It rereads the file when a caller lists hosts or names a server ID it does not know, so the next `list_hosts` after `paseo mcp host add` shows the new host.

Every gateway tool but `list_hosts` takes a `serverId` from `list_hosts`; there is no default host. Besides the [tools](#tools) agents get, the gateway serves what a remote caller would otherwise need a shell on the host for: git status, diffs, commits, pushes and pull requests through the checkout tools, and `list_directory` and `read_file`. Paths are absolute on the host. Tools that share a name with an agent tool behave like it, with these differences:

- `create_agent` needs an existing `workspaceId` and an explicit provider/model.
- The gateway delivers no finish notifications. Call `wait_for_agent`, which returns `timeout` while the agent is still working.
- `kill_agent` is not available; use `archive_agent`.
- `create_terminal` needs a `workspaceId`, and `send_terminal_keys` encodes keys for the default input mode.
- `create_schedule` takes either `provider` and `cwd` to start a new agent per run, or `agentId` to prompt an existing agent. Heartbeats are not available.

| Permission          | Tools                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.read`    | `list_projects`, `list_workspaces`, `list_workspace_scripts`, `list_agents`, `get_agent_status`, `get_agent_activity`, `wait_for_agent`, `list_pending_permissions`, `list_terminals`, `capture_terminal`, `get_checkout_status`, `get_checkout_diff`, `get_pull_request_status`, `list_directory`, `read_file`                        |
| `workspace.write`   | `create_agent`, `send_agent_prompt`, `update_agent`, `set_agent_mode`, `cancel_agent`, `archive_agent`, `respond_to_permission`, `start_workspace_script`, `stop_workspace_script`, `create_terminal`, `send_terminal_keys`, `kill_terminal`, `commit_changes`, `pull_changes`, `push_changes`, `switch_branch`, `create_pull_request` |
| `workspace.manage`  | `create_workspace`, `rename_workspace`, `archive_workspace`                                                                                                                                                                                                                                                                            |
| `automation.manage` | `create_schedule`, `update_schedule`, `list_schedules`, `inspect_schedule`, `schedule_logs`, `run_schedule_once`, `pause_schedule`, `resume_schedule`, `delete_schedule`                                                                                                                                                               |
| `daemon.read`       | `list_providers`, `list_models`, `list_profiles`, `inspect_provider`                                                                                                                                                                                                                                                                   |

`list_hosts` needs no permission. The permissions apply to HTTP callers; `paseo mcp serve` (stdio) gets every tool.

Each tool carries MCP annotations. Read tools are marked read-only, and tools that cancel, archive, kill or delete are marked destructive, so a client can approve reads automatically and ask before the rest.

The full tool list costs several thousand tokens of context. To serve fewer tools, list them with `paseo mcp serve --tools list_agents,create_agent` or in the URL, `https://<hostname>/mcp/agents?tools=list_agents,create_agent`. `list_hosts` is always included, and an unknown name is an error.

### Exec mode

`paseo mcp serve --mode exec`, or `?mode=exec` in the URL, serves every tool through one tool, `paseo`. Its definition costs a few hundred tokens instead of several thousand. The agent sends one command per call:

| Command  | Arguments                 | Result                                                     |
| -------- | ------------------------- | ---------------------------------------------------------- |
| `tools`  |                           | Every tool's name, title and effect                        |
| `search` | `query`                   | Tools whose name, title or description contains every word |
| `info`   | `tool`                    | The tool's description and JSON input schema               |
| `call`   | `tool`, `args`, `confirm` | The tool's result                                          |

A destructive tool runs only with `confirm: true`. Permissions, `hosts` and `?tools=` apply as in the default mode. Use exec mode with clients that load every tool definition up front. A client that loads tool schemas on demand, such as Claude Code, can keep the default mode and approve tools one by one.

### Serve agents on other machines

Remote agents reach the gateway over HTTP behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/). Access authenticates the caller. The gateway verifies the JWT Access attaches to each request and decides what the caller may do. Add an `http` section to `mcp-gateway.json`:

```json
{
  "hosts": [
    {
      "serverId": "<server ID>",
      "label": "laptop",
      "connection": "https://app.paseo.sh/#offer=..."
    }
  ],
  "http": {
    "listen": "127.0.0.1:6769",
    "cloudflareAccess": {
      "teamDomain": "example.cloudflareaccess.com",
      "aud": ["<Access application audience tag>"]
    },
    "principals": [
      { "email": "you@example.com", "permissions": ["workspace.read", "workspace.write"] },
      {
        "commonName": "<service token client ID>",
        "permissions": ["workspace.read"],
        "hosts": ["<server ID>"]
      }
    ]
  }
}
```

1. Create an Access application for the public hostname and copy its audience tag into `aud`.
2. Point the cloudflared ingress rule for that hostname at the `listen` address.
3. Run `paseo mcp daemon start` to keep the gateway running in the background, or `paseo mcp daemon run` to run it in the foreground. `paseo mcp daemon status` shows its listener and log, and `paseo mcp daemon stop` stops it. The log, `<home>/mcp-gateway.log`, rotates at 10 MB and keeps three files, like `daemon.log`. A home runs one HTTP gateway at a time.
4. Configure the remote agent's MCP server URL as `https://<hostname>/mcp/agents`.

The listener serves only `/mcp/agents`, the same path as the daemon's Agent MCP, and rejects any request without a valid `Cf-Access-Jwt-Assertion` header. An identity Access lets through but `principals` does not list gets `403`. Restart the gateway (`paseo mcp daemon restart`) after changing the `http` section. A principal that names an unknown host or reaches no tool stops it from starting.

Each principal's `permissions` decide which tools it sees, following the table above, and `hosts` limits which daemons it reaches; omit `hosts` for every daemon. A host outside the list looks unknown to the caller. Each daemon also limits the gateway to the authority of its saved connection.

### Serve one local agent

`paseo mcp serve` serves the MCP client that launched it over stdin and stdout, with every tool on every host. Use it in an MCP client configuration on the gateway machine:

```json
{ "command": "paseo", "args": ["mcp", "serve"] }
```

## Mental model

Workspaces decide where work happens; agent parentage decides who owns the work.

- An agent that calls `create_agent` without a `workspaceId` gets a subagent in its own workspace.
- Passing a `workspaceId` places that subagent in another workspace without detaching it from its parent.
- A top-level MCP caller without a workspace gets a new local workspace.
- Create a workspace first when you need worktree isolation, a specific branch, or a pull request checkout.

MCP does not expose an agent-detach tool. Detaching is a manual user action in the app or CLI.

## Tools

### Agents

| Tool                 | Function                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_agent`       | Create an agent, optionally placing it in an existing workspace with `workspaceId`. Use `initialPrompt` to start work; returns without waiting for completion. |
| `send_agent_prompt`  | Send a prompt using `agentId` and `prompt`; returns without waiting for completion.                                                                            |
| `get_agent_status`   | Return the latest snapshot for an agent.                                                                                                                       |
| `list_agents`        | List recent agents as compact metadata; `includeBackground: true` includes background work.                                                                    |
| `cancel_agent`       | Abort an agent's current run but keep the agent alive.                                                                                                         |
| `archive_agent`      | Soft-delete an agent and remove it from the active list.                                                                                                       |
| `kill_agent`         | Terminate an agent session permanently.                                                                                                                        |
| `update_agent`       | Update an agent name, labels, or runtime settings such as mode/model/thinking/features.                                                                        |
| `get_agent_activity` | Return recent agent timeline entries as a curated summary.                                                                                                     |
| `set_agent_mode`     | Switch an agent's session mode.                                                                                                                                |

Paseo agents receive finish, error, and permission notifications by default; set `notifyOnFinish: false` to disable them. External MCP clients use `get_agent_status` and `get_agent_activity` to check results.

### Workspaces

| Tool                | Function                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_workspace`  | Create a local or worktree-isolated workspace. Worktrees can branch off, check out a branch, or a PR. `background: true` hides it from default lists and the sidebar while preserving history and access by ID. Omission inherits the calling agent’s workspace setting, or defaults to false without a caller. |
| `list_workspaces`   | List active workspaces and their directories and isolation. Use `includeBackground: true` to include background workspaces.                                                                                                                                                                                     |
| `rename_workspace`  | Change the user-visible name of the current or specified workspace.                                                                                                                                                                                                                                             |
| `archive_workspace` | Archive a workspace and the sessions it owns.                                                                                                                                                                                                                                                                   |

For worktree isolation, `create_workspace` accepts the same useful choices as the app: branch off from a base, check out an existing branch, or check out a pull request. The worktree remains an implementation detail of the workspace lifecycle.

### Workspace scripts

These tools manage scripts configured in a workspace's `paseo.json`. Each requires an explicit `workspaceId`; start and stop also require the configured `scriptName`.

| Tool                     | Function                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `list_workspace_scripts` | List configured scripts with lifecycle, terminal, port, proxy URL, and health metadata. |
| `start_workspace_script` | Start a configured script through Paseo's managed launcher.                             |
| `stop_workspace_script`  | Stop a running script through its supervised terminal.                                  |

See [Git worktrees](/docs/worktrees#scripts-and-services) for `paseo.json` configuration.

### Terminals

| Tool                 | Function                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `list_terminals`     | List terminal sessions for one working directory or all working directories. |
| `create_terminal`    | Create a terminal session for a working directory.                           |
| `kill_terminal`      | Kill a terminal session.                                                     |
| `capture_terminal`   | Capture plain-text output from a terminal session.                           |
| `send_terminal_keys` | Send text or special key tokens to a terminal session.                       |

### Schedules and heartbeats

Both use the same cron engine, but they have deliberately different interfaces.

| Tool                | Function                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| `create_schedule`   | Create a cron schedule that starts a new agent for each run.                 |
| `list_schedules`    | List new-agent schedules managed by the daemon.                              |
| `inspect_schedule`  | Inspect a schedule and its run history.                                      |
| `pause_schedule`    | Pause an active schedule.                                                    |
| `resume_schedule`   | Resume a paused schedule.                                                    |
| `update_schedule`   | Change a schedule's cron, prompt, agent settings, limits, or other settings. |
| `schedule_logs`     | Return recent runs and output for a schedule.                                |
| `run_schedule_once` | Start one new-agent schedule run without changing its cron.                  |
| `delete_schedule`   | Delete a new-agent schedule permanently.                                     |
| `create_heartbeat`  | Send a recurring cron-backed prompt into the current agent.                  |
| `delete_heartbeat`  | Delete one of the current agent's heartbeats.                                |

MCP heartbeats are ephemeral: create or delete them. To change one, delete it and create a replacement. Pause, resume, update, inspect, logs, and run-once apply to new-agent schedules only.

New-agent run workspaces are archived when each run ends by default. `create_schedule` and `update_schedule` do not expose **Archive on finish** (`archiveOnFinish`); [change the option in the app](/docs/schedules#keep-run-workspaces) to keep subsequent run workspaces active.

### Agent profiles

| Tool            | Function                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `list_profiles` | Return the host's saved agent profiles, including their notes and launch settings. Returns an empty list when none are configured. |

Before delegating, read each profile's `notes` and choose the profile the user named or the one that fits the task. See [Agent profiles](/docs/agent-profiles) for setup and example notes.

`create_agent` has no profile parameter and requires a `provider/model` pair. If the profile has no model, call `list_models` for its provider and choose an available model for the task before launching. Apply the chosen profile's values to the launch request:

| Profile field                   | `create_agent` field                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `provider` and optional `model` | `provider` as `provider/model`, using the saved or discovered model ID      |
| `modeId`                        | `settings.modeId`                                                           |
| `thinkingOptionId`              | `settings.thinkingOptionId`                                                 |
| `featureValues`                 | `settings.features`                                                         |
| `notes`                         | Selection guidance for the orchestrator; supply the task in `initialPrompt` |

Omit absent optional settings. If no profile fits, use provider discovery to choose available settings.

### Providers

| Tool               | Function                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `list_providers`   | List configured agent providers, availability, and modes.         |
| `list_models`      | List models for an agent provider.                                |
| `inspect_provider` | Inspect compact provider capabilities and draft feature settings. |

### Permissions

| Tool                       | Function                                          |
| -------------------------- | ------------------------------------------------- |
| `list_pending_permissions` | Return pending permission requests across agents. |
| `respond_to_permission`    | Approve or deny a pending permission request.     |

### Browser

Browser automation is opt-in and adds tools for opening tabs, reading pages, clicking, typing, and taking screenshots. See the [Browser tools reference](/docs/browser-tools).

### Voice

| Tool    | Function                                                                                  |
| ------- | ----------------------------------------------------------------------------------------- |
| `speak` | Speak text through daemon-managed voice output. Available only in voice-enabled sessions. |
