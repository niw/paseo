import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentSlashCommand } from "../../../agent-sdk-types.js";
import { classifyClaudeSlashCommand } from "../agent.js";

// NOTE: Most of Claude Code's own commands open pickers or change settings in its
// terminal, so only the ones that finish without one are offered.
const BUILT_IN_COMMANDS: AgentSlashCommand[] = [
  { name: "clear", description: "Start a new conversation", argumentHint: "" },
  {
    name: "compact",
    description: "Summarize the conversation to free context",
    argumentHint: "[instructions]",
  },
];

interface MarkdownCommand {
  frontmatter: Record<string, unknown>;
  /** The frontmatter's text, for values YAML reads differently than Claude Code. */
  frontmatterText: string;
  body: string;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseMarkdownCommand(content: string): MarkdownCommand {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { frontmatter: {}, frontmatterText: "", body: content };
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch {
    frontmatter = {};
  }
  return {
    frontmatter:
      typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter)
        ? (frontmatter as Record<string, unknown>)
        : {},
    frontmatterText: match[1] ?? "",
    body: content.slice(match[0].length),
  };
}

// NOTE: An argument hint such as `[path]` or `[a] [b]` is YAML for a list or invalid YAML,
// and Claude Code shows it as written, so it is read from its line. Invalid YAML also leaves
// the other fields to be read from their lines.
function readLine(frontmatterText: string, key: string): string {
  const value = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(frontmatterText)?.[1]?.trim() ?? "";
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? ""
  );
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

// A command in a subdirectory is namespaced by the directory, such as frontend:test.
async function readCommandsDirectory(directory: string): Promise<AgentSlashCommand[]> {
  const commands: AgentSlashCommand[] = [];
  for (const file of await listFiles(directory)) {
    const { frontmatter, frontmatterText, body } = parseMarkdownCommand(
      await readFile(file, "utf8"),
    );
    commands.push({
      name: relative(directory, file).replace(/\.md$/, "").split(sep).join(":"),
      description:
        readString(frontmatter.description) ||
        readLine(frontmatterText, "description") ||
        firstLine(body),
      argumentHint: readLine(frontmatterText, "argument-hint"),
    });
  }
  return commands;
}

async function readSkillsDirectory(directory: string): Promise<AgentSlashCommand[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const skills: AgentSlashCommand[] = [];
  for (const name of names) {
    let content: string;
    try {
      content = await readFile(join(directory, name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const { frontmatter, frontmatterText } = parseMarkdownCommand(content);
    if (frontmatter["user-invocable"] === false) {
      continue;
    }
    skills.push({
      name: readString(frontmatter.name) || readLine(frontmatterText, "name") || name,
      description: readString(frontmatter.description) || readLine(frontmatterText, "description"),
      argumentHint: readLine(frontmatterText, "argument-hint"),
    });
  }
  return skills;
}

/**
 * The skills Claude Code resolved for a session, plugins included, from the skill_listing
 * attachments it writes to the transcript.
 */
export async function readClaudeTranscriptSkills(
  transcriptPath: string,
): Promise<AgentSlashCommand[]> {
  let content: string;
  try {
    content = await readFile(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const skills: AgentSlashCommand[] = [];
  for (const line of content.split("\n")) {
    if (!line.includes('"skill_listing"')) {
      continue;
    }
    let record: { attachment?: { type?: unknown; names?: unknown; content?: unknown } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const attachment = record.attachment;
    if (attachment?.type !== "skill_listing" || !Array.isArray(attachment.names)) {
      continue;
    }
    const listing = typeof attachment.content === "string" ? attachment.content.split("\n") : [];
    for (const name of attachment.names) {
      if (typeof name !== "string") {
        continue;
      }
      const prefix = `- ${name}: `;
      const described = listing.find((entry) => entry.startsWith(prefix));
      skills.push({
        name,
        description: described ? described.slice(prefix.length).trim() : "",
        argumentHint: "",
      });
    }
  }
  return skills;
}

/**
 * The slash commands Claude Code offers in a directory: the built-in ones Paseo can send,
 * the commands and skills of the user's config dir and the project, and the skills a
 * session's transcript lists. A later source fills in what an earlier one left empty.
 */
export async function listClaudeTerminalCommands(input: {
  configDir: string;
  cwd: string;
  transcriptPath?: string;
}): Promise<AgentSlashCommand[]> {
  const projectDir = join(input.cwd, ".claude");
  const sources = await Promise.all([
    readCommandsDirectory(join(input.configDir, "commands")),
    readSkillsDirectory(join(input.configDir, "skills")),
    readCommandsDirectory(join(projectDir, "commands")),
    readSkillsDirectory(join(projectDir, "skills")),
    input.transcriptPath ? readClaudeTranscriptSkills(input.transcriptPath) : [],
  ]);
  const commands = new Map<string, AgentSlashCommand>();
  for (const command of [...BUILT_IN_COMMANDS, ...sources.flat()]) {
    const existing = commands.get(command.name);
    commands.set(command.name, {
      name: command.name,
      description: existing?.description || command.description,
      argumentHint: existing?.argumentHint || command.argumentHint,
      kind: classifyClaudeSlashCommand(command.name),
    });
  }
  return Array.from(commands.values()).sort((a, b) => a.name.localeCompare(b.name));
}
