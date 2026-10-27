import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalAgentSession } from "@getpaseo/protocol/messages";
import { TerminalAgentSessionTracker } from "./terminal-agent-session-tracker.js";

const SESSION: TerminalAgentSession = { provider: "claude", sessionId: "session-1" };

interface Harness {
  tracker: TerminalAgentSessionTracker;
  changes: Array<string | null>;
  lookups: () => number;
  setReporting: (reporting: boolean) => void;
  setSession: (session: TerminalAgentSession | null) => void;
}

function createHarness(): Harness {
  let reporting = false;
  let session: TerminalAgentSession | null = null;
  let lookupCount = 0;
  const tracker = new TerminalAgentSessionTracker({
    isAgentReporting: () => reporting,
    findAgentSession: () => {
      lookupCount += 1;
      return Promise.resolve(session);
    },
  });
  const changes: Array<string | null> = [];
  tracker.onChange((agentSession) => changes.push(agentSession?.sessionId ?? null));
  return {
    tracker,
    changes,
    lookups: () => lookupCount,
    setReporting: (next) => {
      reporting = next;
    },
    setSession: (next) => {
      session = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalAgentSessionTracker", () => {
  it("never looks up a session while no agent reports", async () => {
    const harness = createHarness();

    harness.tracker.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.lookups()).toBe(0);
    expect(harness.tracker.get()).toBeNull();
  });

  it("debounces refreshes into one lookup", async () => {
    const harness = createHarness();
    harness.setReporting(true);
    harness.setSession(SESSION);

    harness.tracker.scheduleRefresh();
    harness.tracker.scheduleRefresh();
    harness.tracker.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.lookups()).toBe(1);
    expect(harness.tracker.get()).toEqual(SESSION);
    expect(harness.changes).toEqual(["session-1"]);
  });

  it("keeps looking while the agent reports before recording its session", async () => {
    const harness = createHarness();
    harness.setReporting(true);

    harness.tracker.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1000);
    harness.setSession(SESSION);
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.lookups()).toBe(3);
    expect(harness.tracker.get()).toEqual(SESSION);
  });

  it("stops retrying after five misses", async () => {
    const harness = createHarness();
    harness.setReporting(true);

    harness.tracker.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.lookups()).toBe(6);
  });

  it("clears the session once the agent stops reporting and its process is gone", async () => {
    const harness = createHarness();
    harness.setReporting(true);
    harness.setSession(SESSION);
    harness.tracker.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(250);

    harness.setReporting(false);
    harness.setSession(null);
    harness.tracker.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.tracker.get()).toBeNull();
    expect(harness.changes).toEqual(["session-1", null]);
  });

  it("does nothing after dispose", async () => {
    const harness = createHarness();
    harness.setReporting(true);
    harness.setSession(SESSION);

    harness.tracker.scheduleRefresh();
    harness.tracker.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.lookups()).toBe(0);
    expect(harness.changes).toEqual([]);
  });
});
