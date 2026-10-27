import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listClaudeTerminalCommands } from "./commands.js";

function writeFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

describe("listClaudeTerminalCommands", () => {
  let tempRoot: string;
  let configDir: string;
  let cwd: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-terminal-commands-"));
    configDir = path.join(tempRoot, "config");
    cwd = path.join(tempRoot, "repo");
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("lists built-in commands with the config dir's and the project's", async () => {
    writeFile(
      path.join(configDir, "commands", "review.md"),
      "---\ndescription: Review the diff\nargument-hint: [path]\n---\nReview $ARGUMENTS\n",
    );
    writeFile(path.join(cwd, ".claude", "commands", "frontend", "test.md"), "# Run the tests\n");
    writeFile(
      path.join(cwd, ".claude", "commands", "deploy.md"),
      "---\ndescription: Deploy it\nargument-hint: [env] [version]\n---\n",
    );
    writeFile(
      path.join(configDir, "skills", "notes", "SKILL.md"),
      "---\nname: notes\ndescription: Take notes\n---\nBody\n",
    );
    writeFile(
      path.join(cwd, ".claude", "skills", "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: Only for Claude\nuser-invocable: false\n---\n",
    );

    const commands = await listClaudeTerminalCommands({ configDir, cwd });

    expect(commands.map((command) => command.name)).toEqual([
      "clear",
      "compact",
      "deploy",
      "frontend:test",
      "notes",
      "review",
    ]);
    expect(commands).toContainEqual({
      name: "review",
      description: "Review the diff",
      argumentHint: "[path]",
      kind: "skill",
    });
    expect(commands).toContainEqual(
      expect.objectContaining({ name: "frontend:test", description: "Run the tests" }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "deploy",
        description: "Deploy it",
        argumentHint: "[env] [version]",
      }),
    );
    expect(commands).toContainEqual(expect.objectContaining({ name: "clear", kind: "command" }));
  });

  test("adds the skills the session's transcript lists", async () => {
    const transcriptPath = path.join(tempRoot, "session.jsonl");
    writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { content: "skill_listing" } })}\n${JSON.stringify(
        {
          type: "attachment",
          attachment: {
            type: "skill_listing",
            names: ["plugin:helper", "init"],
            content:
              "- plugin:helper: Help with plugins\nmore detail\n- init: Initialize CLAUDE.md",
          },
        },
      )}\n`,
    );

    const commands = await listClaudeTerminalCommands({ configDir, cwd, transcriptPath });

    expect(commands).toContainEqual({
      name: "plugin:helper",
      description: "Help with plugins",
      argumentHint: "",
      kind: "skill",
    });
    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "init",
        description: "Initialize CLAUDE.md",
        kind: "command",
      }),
    );
  });
});
