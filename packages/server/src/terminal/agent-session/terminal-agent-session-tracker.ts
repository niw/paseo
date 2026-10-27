import type { TerminalAgentSession } from "@getpaseo/protocol/messages";

const REFRESH_DEBOUNCE_MS = 250;
const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 5;

export interface TerminalAgentSessionTrackerOptions {
  /** Whether an agent reports program status in the terminal right now. */
  isAgentReporting: () => boolean;
  findAgentSession: () => Promise<TerminalAgentSession | null>;
}

function isSameAgentSession(
  left: TerminalAgentSession | null,
  right: TerminalAgentSession | null,
): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId;
}

/**
 * The agent session running in one terminal. It looks the session up only while an
 * agent reports program status, or to notice that a known session went away, so
 * terminals running other programs never pay for the lookup.
 */
export class TerminalAgentSessionTracker {
  private readonly options: TerminalAgentSessionTrackerOptions;
  private agentSession: TerminalAgentSession | null = null;
  private readonly changeListeners = new Set<(agentSession: TerminalAgentSession | null) => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshRunning = false;
  private refreshPending = false;
  private retries = 0;
  private disposed = false;

  constructor(options: TerminalAgentSessionTrackerOptions) {
    this.options = options;
  }

  get(): TerminalAgentSession | null {
    return this.agentSession;
  }

  onChange(listener: (agentSession: TerminalAgentSession | null) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  scheduleRefresh(delayMs = REFRESH_DEBOUNCE_MS): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.changeListeners.clear();
  }

  private async refresh(): Promise<void> {
    if (this.refreshRunning) {
      this.refreshPending = true;
      return;
    }
    this.refreshRunning = true;
    try {
      do {
        this.refreshPending = false;
        await this.refreshOnce();
      } while (this.refreshPending && !this.disposed);
    } finally {
      this.refreshRunning = false;
    }
  }

  private async refreshOnce(): Promise<void> {
    const agentReporting = this.options.isAgentReporting();
    if (!agentReporting && this.agentSession === null) {
      this.retries = 0;
      return;
    }
    const nextAgentSession = await this.options.findAgentSession();
    if (this.disposed) {
      return;
    }
    // NOTE: An agent can report status before it records its session, such as
    // Claude Code writing its session file, so keep looking for a while.
    if (nextAgentSession === null && agentReporting && this.retries < MAX_RETRIES) {
      this.retries += 1;
      this.scheduleRefresh(RETRY_DELAY_MS);
    } else if (nextAgentSession !== null) {
      this.retries = 0;
    }
    this.set(nextAgentSession);
  }

  private set(nextAgentSession: TerminalAgentSession | null): void {
    if (isSameAgentSession(this.agentSession, nextAgentSession)) {
      return;
    }
    this.agentSession = nextAgentSession;
    for (const listener of Array.from(this.changeListeners)) {
      try {
        listener(nextAgentSession);
      } catch {
        // no-op
      }
    }
  }
}
