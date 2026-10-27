// Stands in for the interactive Claude Code CLI: reports OSC 7501 program status,
// takes bracketed paste prompts, and writes the transcript. Like Claude Code, it drops
// input that arrives before it is ready, queues a prompt submitted while it works and
// folds it into the running turn, shows a pasted image path as an [Image #N] placeholder,
// moves the queue into the input on Up, stops a turn on
// Escape, then runs the queue or puts the stopped prompt back into the input, and clears
// the input on Ctrl-C. It posts the http hooks --settings names, and /clear starts a new
// session. A prompt that mentions "permission" asks to run a Bash command: the
// PermissionRequest hook's decision or the dialog in the terminal answers it, where Enter
// allows and Escape declines and stops the turn. A denial from the hook stops the turn only
// when it asks to interrupt. Escape twice while idle, then Enter twice, rewinds the
// conversation to before the last prompt, like Claude Code's rewind picker. A prompt that
// mentions "dialog" opens a dialog that reports blocked with a message and no hook, which
// Enter or Escape closes. A prompt that mentions "subagent" runs a Task subagent. Hooks report the --permission-mode, which Shift+Tab cycles.
// FAKE_CLAUDE_LAUNCH_LOG receives each launch's arguments,
// FAKE_CLAUDE_PROJECT_DIR holds the transcripts, FAKE_CLAUDE_VERSION sets what --version
// prints, FAKE_CLAUDE_READY_DELAY_MS delays the first status report, and
// FAKE_CLAUDE_REPLY_DELAY_MS sets how long a reply takes.
export const FAKE_CLAUDE_CLI_SCRIPT = `const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write((process.env.FAKE_CLAUDE_VERSION ?? "2.1.310") + " (Claude Code)\\n");
  process.exit(0);
}
const flag = args.includes("--resume") ? "--resume" : "--session-id";
let sessionId = args[args.indexOf(flag) + 1];
fs.appendFileSync(process.env.FAKE_CLAUDE_LAUNCH_LOG, JSON.stringify(args) + "\\n");
const projectDir = process.env.FAKE_CLAUDE_PROJECT_DIR;
fs.mkdirSync(projectDir, { recursive: true });
let transcript = path.join(projectDir, sessionId + ".jsonl");
const MODES = ["default", "acceptEdits", "plan"];
let permissionMode = args.includes("--permission-mode")
  ? args[args.indexOf("--permission-mode") + 1]
  : "default";
const settings = args.includes("--settings") ? JSON.parse(args[args.indexOf("--settings") + 1]) : {};
async function hook(event, input) {
  let output = {};
  for (const group of settings.hooks?.[event] ?? []) {
    for (const { url, headers = {}, allowedEnvVars = [] } of group.hooks) {
      const resolved = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          value.replace(/\\$\\{?(\\w+)\\}?/g, (_, variable) =>
            allowedEnvVars.includes(variable) ? (process.env[variable] ?? "") : "",
          ),
        ]),
      );
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...resolved },
        body: JSON.stringify({
          session_id: sessionId,
          transcript_path: transcript,
          permission_mode: permissionMode,
          hook_event_name: event,
          ...input,
        }),
      });
      output = await response.json();
    }
  }
  return output;
}
// Records chain through parentUuid, and a rewind continues the chain from an earlier record.
let lastUuid = null;
let promptParents = [];
const append = (entry) => {
  const uuid = crypto.randomUUID();
  fs.appendFileSync(transcript, JSON.stringify({ sessionId, uuid, parentUuid: lastUuid, ...entry }) + "\\n");
  lastUuid = uuid;
};
const status = (state, msg) =>
  process.stdout.write(
    "\\x1b]7501;state=" + state + ":app=claude-code" + (msg ? ":msg=" + Buffer.from(msg).toString("base64") : "") + "\\x1b\\\\",
  );
const ESC = "\\x1b";
const UP = "\\x1b[A";
const SHIFT_TAB = "\\x1b[Z";
const PASTE_START = "\\x1b[200~";
const PASTE_END = "\\x1b[201~";
let ready = false;
let buffer = "";
let input = "";
let queue = [];
let current = null;
let imageCount = 0;
let dialog = null;
let toolUseCount = 0;
let rewind = null;
let lastEscapeAt = 0;

// Like Claude Code, the dialog stays up while the hook waits and the hook keeps waiting
// after the dialog is answered.
async function askPermission() {
  const toolInput = { command: "touch permission.txt" };
  toolUseCount += 1;
  await hook("PreToolUse", { tool_name: "Bash", tool_input: toolInput, tool_use_id: "toolu_" + toolUseCount });
  status("blocked");
  const fromTerminal = new Promise((resolve) => {
    dialog = { resolve };
  });
  const fromHook = hook("PermissionRequest", {
    tool_name: "Bash",
    tool_input: toolInput,
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  }).then((output) => output.hookSpecificOutput?.decision ?? fromTerminal);
  const decision = await Promise.race([fromHook, fromTerminal]);
  dialog = null;
  return decision;
}

async function start(prompt) {
  const turn = { prompt, timer: null };
  current = turn;
  status("working");
  await hook("UserPromptSubmit", { prompt });
  if (current !== turn) {
    return;
  }
  promptParents.push(lastUuid);
  append({ type: "user", message: { content: prompt } });
  if (prompt.includes("dialog")) {
    status("blocked", "choose: retry or edit");
    await new Promise((resolve) => {
      dialog = { resolve };
    });
    dialog = null;
    if (current !== turn) {
      return;
    }
    status("working");
  }
  if (prompt.includes("permission")) {
    const decision = await askPermission();
    if (current !== turn) {
      return;
    }
    status("working");
    if (decision.behavior === "allow") {
      append({ type: "assistant", message: { content: "Allowed " + JSON.stringify(decision.updatedInput ?? {}) } });
    } else {
      append({ type: "assistant", message: { content: "Denied: " + (decision.message ?? "") } });
    }
    if (decision.behavior === "deny" && (decision.interrupt || decision.fromTerminal)) {
      current = null;
      status("idle");
      return;
    }
  }
  const delay = prompt.includes("slow") ? 30000 : Number(process.env.FAKE_CLAUDE_REPLY_DELAY_MS ?? 200);
  turn.timer = prompt.includes("subagent") ? runSubagent(delay) : setTimeout(finish, delay);
}

// Like Claude Code, a Task subagent runs in the background and writes its own transcript and
// meta sidecar under the session's directory. The parent records the Task call, a result that
// says it launched, and a task notification once it finishes.
function runSubagent(delay) {
  toolUseCount += 1;
  const toolUseId = "toolu_" + toolUseCount;
  const agentId = "agent" + toolUseCount;
  const input = { subagent_type: "general-purpose", description: "Look around" };
  append({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Task", input }] },
  });
  const directory = path.join(projectDir, sessionId, "subagents");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "agent-" + agentId + ".meta.json"),
    JSON.stringify({ agentType: "general-purpose", description: "Look around", toolUseId }),
  );
  const sidechain = (text, stopReason) =>
    fs.appendFileSync(
      path.join(directory, "agent-" + agentId + ".jsonl"),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId,
        sessionId,
        uuid: crypto.randomUUID(),
        message: { role: "assistant", content: [{ type: "text", text }], stop_reason: stopReason },
      }) + "\\n",
    );
  append({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: "Async agent launched successfully.\\nagentId: " + agentId },
      ],
    },
    toolUseResult: { isAsync: true, status: "async_launched", agentId },
  });
  sidechain("Subagent working", null);
  return setTimeout(() => {
    sidechain("Subagent done", "end_turn");
    append({
      type: "user",
      message: {
        role: "user",
        content:
          "<task-notification>\\n<task-id>" + agentId + "</task-id>\\n<tool-use-id>" + toolUseId +
          "</tool-use-id>\\n<status>completed</status>\\n</task-notification>",
      },
    });
    finish();
  }, delay);
}

// Each reply reports usage like an API response: 10 input, 100 cache read, 5 output tokens.
function reply(text) {
  append({
    type: "assistant",
    message: {
      id: "msg_" + crypto.randomUUID(),
      model: "claude-opus-5-5",
      content: text,
      usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
    },
  });
}

function finish() {
  reply("Reply to " + current.prompt);
  for (const queued of queue) {
    append({
      type: "attachment",
      attachment: { type: "queued_command", prompt: queued, commandMode: "prompt", origin: { kind: "human" } },
    });
    reply("Reply to " + queued);
  }
  queue = [];
  current = null;
  status("idle");
  void hook("Stop", {});
}

function interrupt() {
  if (!current) {
    return;
  }
  clearTimeout(current.timer);
  const stopped = current.prompt;
  current = null;
  status("idle");
  if (queue.length > 0) {
    const next = queue.join("\\n");
    queue = [];
    void start(next);
  } else {
    input = stopped;
  }
}

function submit() {
  const prompt = input;
  input = "";
  imageCount = 0;
  if (!prompt) {
    return;
  }
  if (prompt === "/clear" && !current) {
    void hook("SessionEnd", { reason: "clear" });
    sessionId = crypto.randomUUID();
    transcript = path.join(projectDir, sessionId + ".jsonl");
    lastUuid = null;
    promptParents = [];
    return;
  }
  if (current) {
    queue.push(prompt);
  } else {
    void start(prompt);
  }
}

function consume() {
  while (buffer) {
    if (buffer.startsWith(PASTE_START)) {
      const end = buffer.indexOf(PASTE_END);
      if (end === -1) {
        return;
      }
      const pasted = buffer.slice(PASTE_START.length, end);
      buffer = buffer.slice(end + PASTE_END.length);
      if (dialog) {
        continue;
      }
      if (/\\.(png|jpe?g|gif|webp)$/.test(pasted) && fs.existsSync(pasted)) {
        imageCount += 1;
        input += "[Image #" + imageCount + "]";
      } else {
        input += pasted;
      }
    } else if (buffer.startsWith(SHIFT_TAB)) {
      buffer = buffer.slice(SHIFT_TAB.length);
      permissionMode = MODES[(MODES.indexOf(permissionMode) + 1) % MODES.length];
    } else if (buffer.startsWith(UP)) {
      buffer = buffer.slice(UP.length);
      if (queue.length > 0) {
        input = queue.join("\\n");
        queue = [];
      }
    } else if (buffer.startsWith(ESC) && buffer[1] === "[") {
      return;
    } else {
      const key = buffer[0];
      buffer = buffer.slice(1);
      if (dialog) {
        if (key === "\\r") {
          dialog.resolve({ behavior: "allow" });
        } else if (key === ESC) {
          dialog.resolve({ behavior: "deny", message: "Declined in the terminal", fromTerminal: true });
        }
      } else if (rewind) {
        if (key === "\\r" && rewind === "picker") {
          rewind = "confirm";
        } else if (key === "\\r") {
          lastUuid = promptParents.pop() ?? null;
          rewind = null;
        } else if (key === ESC) {
          rewind = null;
        }
      } else if (key === ESC && !current && Date.now() - lastEscapeAt < 500) {
        rewind = "picker";
      } else if (key === ESC) {
        lastEscapeAt = Date.now();
        interrupt();
      } else if (key === "\\x03") {
        input = "";
      } else if (key === "\\r") {
        submit();
      } else {
        input += key;
      }
    }
  }
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (!ready) {
    return;
  }
  buffer += chunk.toString("utf8");
  consume();
});
setTimeout(() => {
  ready = true;
  status("idle");
}, Number(process.env.FAKE_CLAUDE_READY_DELAY_MS ?? 0));
`;
