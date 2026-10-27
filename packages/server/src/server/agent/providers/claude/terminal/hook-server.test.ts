import pino from "pino";
import { describe, expect, test } from "vitest";
import { ClaudeHookServer, type ClaudeHookInput } from "./hook-server.js";

function post(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("ClaudeHookServer", () => {
  test("hands each hook input to the handler its token names and returns its answer", async () => {
    const server = new ClaudeHookServer(pino({ level: "silent" }));
    const received: ClaudeHookInput[] = [];
    const registration = await server.register(async (input) => {
      received.push(input);
      return { continue: true };
    });
    const other = await server.register(async () => ({}));
    expect(other.url).toBe(registration.url);
    expect(new URL(registration.url).hostname).toBe("127.0.0.1");

    const input = { hook_event_name: "Stop", session_id: "session-1", extra: 1 };
    const response = await post(registration.url, registration.token, input);
    await expect(response.json()).resolves.toEqual({ continue: true });
    expect(received).toEqual([input]);

    expect((await post(registration.url, "wrong", input)).status).toBe(403);
    expect((await post(registration.url, registration.token, { session_id: "x" })).status).toBe(
      400,
    );

    registration.unregister();
    expect((await post(other.url, registration.token, input)).status).toBe(403);
    other.unregister();

    const again = await server.register(async () => ({ reopened: true }));
    await expect((await post(again.url, again.token, input)).json()).resolves.toEqual({
      reopened: true,
    });
    again.unregister();
  });
});
