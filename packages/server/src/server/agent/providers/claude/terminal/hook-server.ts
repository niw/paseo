import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";

/** The terminal environment variable holding a session's hook token. */
export const CLAUDE_HOOK_TOKEN_ENV = "PASEO_CLAUDE_HOOK_TOKEN";

const MAX_HOOK_INPUT_BYTES = 16 * 1024 * 1024;

const ClaudeHookInputSchema = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string(),
  })
  .passthrough();

export type ClaudeHookInput = z.infer<typeof ClaudeHookInputSchema>;

/** The JSON a hook answers Claude Code with. An empty object leaves Claude Code as it is. */
export type ClaudeHookOutput = Record<string, unknown>;

export type ClaudeHookHandler = (input: ClaudeHookInput) => Promise<ClaudeHookOutput>;

export interface ClaudeHookEvent {
  name: string;
  /** How long Claude Code waits for the answer. Claude Code's own default applies without it. */
  timeoutSeconds?: number;
}

export interface ClaudeHookRegistration {
  url: string;
  token: string;
  unregister: () => void;
}

interface ListeningServer {
  server: Server;
  url: string;
}

/**
 * The `--settings` hooks that make Claude Code post each event's input to the hook server.
 * The token stays in the terminal's environment, so it never shows in the process arguments.
 */
export function claudeHookSettings(
  url: string,
  events: readonly ClaudeHookEvent[],
): { hooks: Record<string, unknown[]> } {
  const hook = {
    type: "http",
    url,
    headers: { Authorization: `Bearer $${CLAUDE_HOOK_TOKEN_ENV}` },
    allowedEnvVars: [CLAUDE_HOOK_TOKEN_ENV],
  };
  return {
    hooks: Object.fromEntries(
      events.map((event) => [
        event.name,
        [{ hooks: [event.timeoutSeconds ? { ...hook, timeout: event.timeoutSeconds } : hook] }],
      ]),
    ),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HOOK_INPUT_BYTES) {
        reject(new Error("Hook input is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Receives the hooks of the Claude Code sessions that run in Paseo terminals. Claude Code
 * posts each hook's input to a loopback URL, and the session's bearer token picks the
 * handler. It listens only while a session is registered.
 */
export class ClaudeHookServer {
  private readonly logger: Logger;
  private readonly handlers = new Map<string, ClaudeHookHandler>();
  private listening: Promise<ListeningServer> | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async register(handler: ClaudeHookHandler): Promise<ClaudeHookRegistration> {
    const token = randomBytes(32).toString("base64url");
    this.handlers.set(token, handler);
    this.listening ??= this.listen();
    try {
      const { url } = await this.listening;
      return { url, token, unregister: () => this.unregister(token) };
    } catch (error) {
      this.unregister(token);
      throw error;
    }
  }

  private unregister(token: string): void {
    if (!this.handlers.delete(token) || this.handlers.size > 0 || !this.listening) {
      return;
    }
    const listening = this.listening;
    this.listening = null;
    void listening.then(({ server }) => server.close()).catch(() => undefined);
  }

  private listen(): Promise<ListeningServer> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.respond(request, response);
      });
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ server, url: `http://127.0.0.1:${port}/hooks` });
      });
    });
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { status, output } = await this.handleRequest(request);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(output));
  }

  private async handleRequest(
    request: IncomingMessage,
  ): Promise<{ status: number; output: ClaudeHookOutput }> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const handler = token ? this.handlers.get(token) : undefined;
    if (request.method !== "POST" || !handler) {
      request.resume();
      return { status: 403, output: {} };
    }
    let input: ClaudeHookInput;
    try {
      input = ClaudeHookInputSchema.parse(JSON.parse(await readBody(request)));
    } catch {
      return { status: 400, output: {} };
    }
    try {
      return { status: 200, output: await handler(input) };
    } catch (error) {
      this.logger.warn({ err: error, event: input.hook_event_name }, "Claude Code hook failed");
      return { status: 200, output: {} };
    }
  }
}
