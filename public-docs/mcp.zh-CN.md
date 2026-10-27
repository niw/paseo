---
title: MCP 参考
description: Agent 用来管理 Agent、工作区、脚本、终端和定时任务的 Paseo 工具参考。
nav: MCP 参考
---

# MCP 参考 {#mcp-reference}

[启用 Paseo 工具](/docs/orchestration#get-started)，让 Agent 获得这套工具目录。用自然语言说明想要的结果，或者使用下面的工具接口。

## 配置 {#configuration}

| 设置                          | 默认值  | 用途                                     |
| ----------------------------- | ------- | ---------------------------------------- |
| `daemon.mcp.enabled`          | `true`  | 运行 MCP 服务器。                        |
| `daemon.mcp.injectIntoAgents` | `false` | 让 Paseo 启动的 Agent 可以使用它的工具。 |

根据 Provider 的不同，Paseo 通过其原生工具接口或 MCP 提供工具，能力是相同的。修改注入设置后，请启动新的 Agent 或重新加载已有的 Agent。

## 按 Provider 限制 Paseo 工具 {#limit-paseo-tools-by-provider}

当不同的 Agent 配置应获得不同的 Paseo 工具时，请使用 Provider 策略。先全局启用工具注入，然后在你启动所用的确切 Provider ID 上添加 `paseoTools`：

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

编辑 `~/.paseo/config.json` 后运行 `paseo reload`，然后启动新的 Agent 或重新加载已有的 Agent。正在运行的会话保留它启动时得到的工具目录。

省略 `paseoTools` 会启用完整的工具目录。把 `enabled` 设为 `false` 会移除整个目录，在 `disabledTools` 中列出确切的工具 ID 则只移除所选的工具。自定义配置不会从 `extends` 继承这一策略；请为每个自定义 Provider ID 分别配置。

浏览器工具仍然需要启用浏览器工具并连接一个浏览器主机。仅用于语音的 `speak` 工具不受此策略控制。

这项设置限制的是呈现给 Agent 的工具目录。对于可以通过 shell 访问主机的 Agent，它不是安全边界。

## MCP 网关 {#mcp-gateway}

MCP 网关是一个可以驱动多个 daemon 上 Agent 的 MCP 服务器。它不是 Paseo daemon，也不运行 Agent。它像应用或 CLI 一样，以普通客户端的身份连接每个 daemon，因此任何能用 `--host` 访问的 daemon 都可以使用，包括通过配对 URL 经由中继连接的 daemon。它可以运行在任何机器上，例如一台其他机器上的 Agent 能够访问的小型服务器。

添加它可以访问的 daemon。`add` 会连接一次，以固定每个 daemon 的 server ID：

```sh
paseo mcp host add 'https://app.paseo.sh/#offer=...' --label laptop
paseo mcp host add 'ssh://deploy@build-box' --label build-box
paseo mcp host ls
```

连接保存在 `<home>/mcp-gateway.json` 中，权限为 `0600`。这些连接就是凭据：任何能读取该文件的人，都能以该连接的权限访问对应的 daemon。

正在运行的网关无需重启即可识别新增或移除的主机。当调用方列出主机，或指定了网关不认识的 server ID 时，网关会重新读取该文件，因此执行 `paseo mcp host add` 后，下一次 `list_hosts` 就会显示新主机。

除 `list_hosts` 外，每个网关工具都需要来自 `list_hosts` 的 `serverId`，没有默认主机。除了提供给 Agent 的[工具](#tools)，网关还提供远程调用方原本需要在主机上使用 shell 才能完成的操作：通过 checkout 工具查看 git 状态和差异、提交、推送和创建 Pull Request，以及 `list_directory` 和 `read_file`。路径是主机上的绝对路径。与 Agent 工具同名的工具行为相同，区别如下：

- `create_agent` 需要已有的 `workspaceId` 和明确的 provider/model。
- 网关不发送完成通知。请调用 `wait_for_agent`，Agent 仍在工作时它会返回 `timeout`。
- 不提供 `kill_agent`；请使用 `archive_agent`。
- `create_terminal` 需要 `workspaceId`，`send_terminal_keys` 按默认输入模式编码按键。
- `create_schedule` 接受 `provider` 和 `cwd`（每次运行启动一个新 Agent），或者 `agentId`（向已有 Agent 发送提示）。不提供 heartbeat。

| 权限                | 工具                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.read`    | `list_projects`、`list_workspaces`、`list_workspace_scripts`、`list_agents`、`get_agent_status`、`get_agent_activity`、`wait_for_agent`、`list_pending_permissions`、`list_terminals`、`capture_terminal`、`get_checkout_status`、`get_checkout_diff`、`get_pull_request_status`、`list_directory`、`read_file`                        |
| `workspace.write`   | `create_agent`、`send_agent_prompt`、`update_agent`、`set_agent_mode`、`cancel_agent`、`archive_agent`、`respond_to_permission`、`start_workspace_script`、`stop_workspace_script`、`create_terminal`、`send_terminal_keys`、`kill_terminal`、`commit_changes`、`pull_changes`、`push_changes`、`switch_branch`、`create_pull_request` |
| `workspace.manage`  | `create_workspace`、`rename_workspace`、`archive_workspace`                                                                                                                                                                                                                                                                            |
| `automation.manage` | `create_schedule`、`update_schedule`、`list_schedules`、`inspect_schedule`、`schedule_logs`、`run_schedule_once`、`pause_schedule`、`resume_schedule`、`delete_schedule`                                                                                                                                                               |
| `daemon.read`       | `list_providers`、`list_models`、`list_profiles`、`inspect_provider`                                                                                                                                                                                                                                                                   |

`list_hosts` 不需要任何权限。这些权限适用于 HTTP 调用方；`paseo mcp serve`（stdio）可以使用全部工具。

每个工具都带有 MCP annotation。读取类工具标记为只读，取消、归档、终止或删除类工具标记为破坏性，因此客户端可以自动批准读取操作，并在其他操作前询问。

完整的工具列表会占用数千个 token 的上下文。如果只想提供部分工具，可以用 `paseo mcp serve --tools list_agents,create_agent` 指定，或在 URL 中写成 `https://<hostname>/mcp/agents?tools=list_agents,create_agent`。`list_hosts` 总会包含在内，未知的名称会报错。

### Exec 模式 {#exec-mode}

`paseo mcp serve --mode exec`，或在 URL 中写 `?mode=exec`，会通过一个名为 `paseo` 的工具提供全部工具。它的定义只占几百个 token，而不是几千个。Agent 每次调用发送一条命令：

| 命令     | 参数                      | 结果                                   |
| -------- | ------------------------- | -------------------------------------- |
| `tools`  |                           | 所有工具的名称、标题和作用             |
| `search` | `query`                   | 名称、标题或描述中包含所有关键词的工具 |
| `info`   | `tool`                    | 该工具的描述和 JSON 输入 schema        |
| `call`   | `tool`、`args`、`confirm` | 该工具的结果                           |

破坏性工具只有在 `confirm: true` 时才会运行。权限、`hosts` 和 `?tools=` 的作用与默认模式相同。对于一开始就加载全部工具定义的客户端，请使用 exec 模式。按需加载工具 schema 的客户端（例如 Claude Code）可以保留默认模式，逐个批准工具。

### 为其他机器上的 Agent 提供服务 {#serve-agents-on-other-machines}

远程 Agent 通过 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) 后面的 HTTP 访问网关。Access 负责认证调用方。网关验证 Access 附加到每个请求上的 JWT，并决定调用方可以做什么。在 `mcp-gateway.json` 中添加 `http` 部分：

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

1. 为公开主机名创建一个 Access 应用，并把它的 audience tag 复制到 `aud`。
2. 把该主机名的 cloudflared ingress 规则指向 `listen` 地址。
3. 运行 `paseo mcp daemon start` 让网关在后台持续运行，或运行 `paseo mcp daemon run` 在前台运行。`paseo mcp daemon status` 显示它的监听地址和日志，`paseo mcp daemon stop` 停止它。日志 `<home>/mcp-gateway.log` 与 `daemon.log` 一样，在 10 MB 时轮转并保留三个文件。一个 home 同时只运行一个 HTTP 网关。
4. 把远程 Agent 的 MCP 服务器 URL 配置为 `https://<hostname>/mcp/agents`。

监听器只提供 `/mcp/agents`（与 daemon 的 Agent MCP 路径相同），并拒绝任何没有有效 `Cf-Access-Jwt-Assertion` 请求头的请求。Access 放行但 `principals` 中没有列出的身份会得到 `403`。修改 `http` 部分后请重启网关（`paseo mcp daemon restart`）。如果某个 principal 指定了未知主机，或者无法使用任何工具，网关将无法启动。

每个 principal 的 `permissions` 按上表决定它能看到哪些工具，`hosts` 限制它能访问哪些 daemon；省略 `hosts` 表示可以访问所有 daemon。不在列表中的主机对调用方来说就像不存在一样。每个 daemon 也会把网关限制在其已保存连接的权限范围内。

### 为一个本地 Agent 提供服务 {#serve-one-local-agent}

`paseo mcp serve` 通过 stdin 和 stdout 为启动它的 MCP 客户端提供服务，可以在所有主机上使用全部工具。在网关所在机器的 MCP 客户端配置中这样使用：

```json
{ "command": "paseo", "args": ["mcp", "serve"] }
```

## 心智模型 {#mental-model}

工作区决定工作在哪里进行；Agent 的父子关系决定工作归谁所有。

- 不带 `workspaceId` 调用 `create_agent` 的 Agent，会在它自己的工作区中得到一个子 Agent。
- 传入 `workspaceId` 会把子 Agent 放到另一个工作区，但不会让它脱离父 Agent。
- 没有工作区的顶层 MCP 调用方会得到一个新的本地工作区。
- 需要 worktree 隔离、特定分支或 Pull Request 检出时，请先创建工作区。

MCP 不提供解除 Agent 父子关系的工具。解除关系是用户在应用或 CLI 中手动执行的操作。

## 工具 {#tools}

### Agent {#agents}

| 工具                 | 功能                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `create_agent`       | 创建 Agent，可用 `workspaceId` 把它放到已有的工作区。用 `initialPrompt` 开始工作；不等待完成就返回。 |
| `send_agent_prompt`  | 用 `agentId` 和 `prompt` 发送提示词；不等待完成就返回。                                              |
| `get_agent_status`   | 返回 Agent 的最新快照。                                                                              |
| `list_agents`        | 以精简元数据列出最近的 Agent；`includeBackground: true` 会包含后台工作。                             |
| `cancel_agent`       | 中止 Agent 当前的运行，但保留该 Agent。                                                              |
| `archive_agent`      | 软删除 Agent，并把它从活动列表中移除。                                                               |
| `kill_agent`         | 永久终止 Agent 会话。                                                                                |
| `update_agent`       | 更新 Agent 的名称、标签或运行时设置，例如模式、模型、思考选项和功能。                                |
| `get_agent_activity` | 以整理后的摘要返回 Agent 最近的时间线条目。                                                          |
| `set_agent_mode`     | 切换 Agent 的会话模式。                                                                              |

Paseo Agent 默认会收到完成、错误和权限通知；设置 `notifyOnFinish: false` 可以关闭它们。外部 MCP 客户端使用 `get_agent_status` 和 `get_agent_activity` 查看结果。

### 工作区 {#workspaces}

| 工具                | 功能                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_workspace`  | 创建本地工作区或使用 worktree 隔离的工作区。worktree 可以从某个分支分出、检出一个分支或一个 PR。`background: true` 会把它从默认列表和侧边栏中隐藏，同时保留历史记录和按 ID 访问。省略时继承调用方 Agent 工作区的设置；没有调用方时默认为 false。 |
| `list_workspaces`   | 列出活动的工作区及其目录和隔离方式。使用 `includeBackground: true` 可以包含后台工作区。                                                                                                                                                          |
| `rename_workspace`  | 修改当前或指定工作区在界面上显示的名称。                                                                                                                                                                                                         |
| `archive_workspace` | 归档工作区及其拥有的会话。                                                                                                                                                                                                                       |

对于 worktree 隔离，`create_workspace` 接受与应用中相同的常用选择：从某个基础分支分出、检出一个已有分支，或检出一个 Pull Request。worktree 仍然是工作区生命周期的实现细节。

### 工作区脚本 {#workspace-scripts}

这些工具管理在工作区的 `paseo.json` 中配置的脚本。每个工具都需要显式的 `workspaceId`；启动和停止还需要已配置的 `scriptName`。

| 工具                     | 功能                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `list_workspace_scripts` | 列出已配置的脚本及其生命周期、终端、端口、代理 URL 和健康状态元数据。 |
| `start_workspace_script` | 通过 Paseo 的托管启动器启动已配置的脚本。                             |
| `stop_workspace_script`  | 通过受监管的终端停止正在运行的脚本。                                  |

`paseo.json` 的配置见 [Git worktree](/docs/worktrees#scripts-and-services)。

### 终端 {#terminals}

| 工具                 | 功能                                       |
| -------------------- | ------------------------------------------ |
| `list_terminals`     | 列出某个工作目录或所有工作目录的终端会话。 |
| `create_terminal`    | 为某个工作目录创建终端会话。               |
| `kill_terminal`      | 结束终端会话。                             |
| `capture_terminal`   | 捕获终端会话的纯文本输出。                 |
| `send_terminal_keys` | 向终端会话发送文本或特殊按键标记。         |

### 定时任务与 heartbeat {#schedules-and-heartbeats}

两者使用相同的 cron 引擎，但接口有意设计得不同。

| 工具                | 功能                                                      |
| ------------------- | --------------------------------------------------------- |
| `create_schedule`   | 创建一个 cron 定时任务，每次运行都启动一个新的 Agent。    |
| `list_schedules`    | 列出 daemon 管理的新建 Agent 定时任务。                   |
| `inspect_schedule`  | 查看定时任务及其运行历史。                                |
| `pause_schedule`    | 暂停一个活动的定时任务。                                  |
| `resume_schedule`   | 恢复一个已暂停的定时任务。                                |
| `update_schedule`   | 修改定时任务的 cron、提示词、Agent 设置、限制或其他设置。 |
| `schedule_logs`     | 返回定时任务最近的运行及输出。                            |
| `run_schedule_once` | 启动一次新建 Agent 的定时任务运行，不改变它的 cron。      |
| `delete_schedule`   | 永久删除一个新建 Agent 的定时任务。                       |
| `create_heartbeat`  | 向当前 Agent 发送一段由 cron 驱动的周期性提示词。         |
| `delete_heartbeat`  | 删除当前 Agent 的某个 heartbeat。                         |

MCP heartbeat 是临时的：只能创建或删除。要修改一个 heartbeat，请删除它并创建一个替代的。暂停、恢复、更新、查看、日志和单次运行只适用于新建 Agent 的定时任务。

默认情况下，新建 Agent 的定时任务每次运行结束时都会归档其工作区。`create_schedule` 和 `update_schedule` 不提供 **Archive on finish**（`archiveOnFinish`）；要让之后的运行工作区保持活跃，请[在应用中修改该选项](/docs/schedules#keep-run-workspaces)。

### Agent 配置 {#agent-profiles}

| 工具            | 功能                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| `list_profiles` | 返回主机上保存的 Agent 配置，包括它们的说明和启动设置。没有配置时返回空列表。 |

委派之前，请阅读每个配置的 `notes`，选择用户指定的配置或适合该任务的配置。设置方法和说明示例见 [Agent 配置](/docs/agent-profiles)。

`create_agent` 没有配置参数，并且需要 `provider/model` 组合。如果配置中没有模型，请先对其 Provider 调用 `list_models`，为任务选择一个可用的模型再启动。把所选配置的值应用到启动请求中：

| 配置字段                    | `create_agent` 字段                                            |
| --------------------------- | -------------------------------------------------------------- |
| `provider` 和可选的 `model` | `provider`，格式为 `provider/model`，使用保存的或发现的模型 ID |
| `modeId`                    | `settings.modeId`                                              |
| `thinkingOptionId`          | `settings.thinkingOptionId`                                    |
| `featureValues`             | `settings.features`                                            |
| `notes`                     | 供编排者选择时参考；任务放在 `initialPrompt` 中                |

省略不存在的可选设置。如果没有合适的配置，请用 Provider 发现来选择可用的设置。

### Provider {#providers}

| 工具               | 功能                                        |
| ------------------ | ------------------------------------------- |
| `list_providers`   | 列出已配置的 Agent Provider、可用性和模式。 |
| `list_models`      | 列出某个 Agent Provider 的模型。            |
| `inspect_provider` | 查看精简的 Provider 能力和草稿功能设置。    |

### 权限 {#permissions}

| 工具                       | 功能                                |
| -------------------------- | ----------------------------------- |
| `list_pending_permissions` | 返回所有 Agent 中待处理的权限请求。 |
| `respond_to_permission`    | 批准或拒绝一个待处理的权限请求。    |

### 浏览器 {#browser}

浏览器自动化需要主动开启，它会添加用于打开标签页、读取页面、点击、输入和截图的工具。见[浏览器工具参考](/docs/browser-tools)。

### 语音 {#voice}

| 工具    | 功能                                                           |
| ------- | -------------------------------------------------------------- |
| `speak` | 通过 daemon 管理的语音输出朗读文本。仅在启用语音的会话中可用。 |
