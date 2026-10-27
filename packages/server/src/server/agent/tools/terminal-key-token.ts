import { encodeTerminalKeyInput } from "@getpaseo/protocol/terminal-key-input";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";

export interface TerminalKeyTokenInput {
  key: string;
  literal: boolean;
  /** Recent terminal output. Its mode switches decide how keys such as arrows are encoded. */
  preamble: string;
}

/**
 * Turns a send_terminal_keys token such as Enter, C-r or S-Tab into terminal
 * input. Anything that is not a key token is sent unchanged.
 */
export function resolveTerminalKeyToken({ key, literal, preamble }: TerminalKeyTokenInput): string {
  if (literal) {
    return key;
  }

  const match = /^((?:[CMS]-)*)(.+)$/.exec(key);
  if (!match) {
    return key;
  }
  const [, modifiers, token] = match;
  const aliases: Record<string, string> = {
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    BSpace: "Backspace",
    Space: " ",
  };
  const inputMode = new TerminalInputModeTracker();
  inputMode.feed(preamble);
  const encodedKey = Object.hasOwn(aliases, token) ? aliases[token] : token;
  return (
    encodeTerminalKeyInput(
      {
        key: encodedKey,
        ctrl: modifiers.includes("C-"),
        alt: modifiers.includes("M-"),
        shift: modifiers.includes("S-"),
      },
      { inputMode: inputMode.getState() },
    ) || key
  );
}
