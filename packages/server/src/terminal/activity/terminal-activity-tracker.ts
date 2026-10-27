import type {
  TerminalActivityAttentionReason,
  TerminalActivityState,
} from "@getpaseo/protocol/terminal-activity";
import type { ProgramStatusActivity } from "./program-status.js";

export interface TerminalActivitySnapshot {
  state: TerminalActivityState | null;
  attentionReason: TerminalActivityAttentionReason | null;
  changedAt: number;
}

/** `statusMessage` explains a change that program status caused. */
export type TerminalActivityChangeListener = (
  snapshot: TerminalActivitySnapshot,
  previous: TerminalActivitySnapshot,
  statusMessage?: string,
) => void;

export class TerminalActivityTracker {
  // unknown != idle: a plain shell, or a terminal whose agent was killed, has no dot or rollup.
  private resolvedState: TerminalActivityState | null = null;
  private attentionReason: TerminalActivityAttentionReason | null = null;
  private changedAt = Date.now();

  private readonly changeListeners = new Set<TerminalActivityChangeListener>();

  set(state: TerminalActivityState): void {
    if (state === "idle" && this.resolvedState === "working") {
      this.setState("idle", "finished");
      return;
    }

    if (state === "idle" && this.attentionReason === "finished") {
      return;
    }

    this.setState(
      state === "attention" ? "idle" : state,
      state === "attention" ? "needs_input" : null,
    );
  }

  clear(): void {
    this.setState(null, null);
  }

  clearAttention(): boolean {
    if (!this.attentionReason) {
      return false;
    }
    this.setState("idle", null);
    return true;
  }

  /**
   * Applies activity derived from OSC 7501 program status. Programs report unseen
   * results as `done`, so `idle` after `working` is not finished attention.
   * Finished attention stays until the user focuses the terminal.
   */
  applyProgramActivity(activity: ProgramStatusActivity, statusMessage?: string): void {
    switch (activity) {
      case "working":
        this.setState("working", null, statusMessage);
        return;
      case "needs_input":
        this.setState("idle", "needs_input", statusMessage);
        return;
      case "finished":
        this.setState("idle", "finished", statusMessage);
        return;
      case "idle":
      case null: {
        const keepsFinished = this.attentionReason === "finished";
        this.setState(
          keepsFinished || activity === "idle" ? "idle" : null,
          keepsFinished ? "finished" : null,
          statusMessage,
        );
        return;
      }
    }
  }

  interrupt(): void {
    if (this.resolvedState !== "working") {
      return;
    }
    this.setState(null, null);
  }

  private setState(
    state: TerminalActivityState | null,
    attentionReason: TerminalActivityAttentionReason | null,
    statusMessage?: string,
  ): void {
    if (state === this.resolvedState && attentionReason === this.attentionReason) {
      return;
    }

    const previous = this.getSnapshot();
    this.resolvedState = state;
    this.attentionReason = attentionReason;
    this.changedAt = Date.now();

    const snapshot = this.getSnapshot();
    for (const listener of Array.from(this.changeListeners)) {
      listener(snapshot, previous, statusMessage);
    }
  }

  onChange(listener: TerminalActivityChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  getSnapshot(): TerminalActivitySnapshot {
    return {
      state: this.resolvedState,
      attentionReason: this.attentionReason,
      changedAt: this.changedAt,
    };
  }

  dispose(): void {
    this.changeListeners.clear();
  }
}
