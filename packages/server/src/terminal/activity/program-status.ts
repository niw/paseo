// OSC 7501 Program Status Protocol.
// https://www.superlogical.com/rex/docs/build/program-status

export const PROGRAM_STATUS_OSC_CODE = 7501;
export const PROGRAM_STATUS_QUERY = "?";
export const PROGRAM_STATUS_QUERY_REPLY = `\x1b]${PROGRAM_STATUS_OSC_CODE};?\x1b\\`;

const PROGRAM_STATUS_STATES = ["idle", "working", "done", "blocked", "error"] as const;
const PROGRAM_STATUS_BLOCKED_KINDS = ["permission", "question", "auth"] as const;

export type ProgramStatusState = (typeof PROGRAM_STATUS_STATES)[number];
export type ProgramStatusBlockedKind = (typeof PROGRAM_STATUS_BLOCKED_KINDS)[number];

const MAX_SEQUENCE_BYTES = 4096;
const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED_BYTES = 2732;
const MAX_MSG_DECODED_BYTES = 2048;
const MAX_TITLE_ENCODED_BYTES = 256;
const MAX_TITLE_DECODED_BYTES = 192;
const MAX_APP_BYTES = 32;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;
const MAX_RECORDS = 256;
const ROOT_RECORD_ID = "";

const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const PROGRESS_PATTERN = /^\d{1,3}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ProgramStatusRecord {
  id: string;
  state: ProgramStatusState;
  kind?: ProgramStatusBlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export type ProgramStatusReport =
  | { type: "set"; record: ProgramStatusRecord }
  | { type: "clear"; id: string | null };

export type ProgramStatusActivity = "working" | "needs_input" | "finished" | "idle" | null;

class ProgramStatusReportRejected extends Error {}

function isProgramStatusState(value: string): value is ProgramStatusState {
  return (PROGRAM_STATUS_STATES as readonly string[]).includes(value);
}

function isProgramStatusBlockedKind(value: string): value is ProgramStatusBlockedKind {
  return (PROGRAM_STATUS_BLOCKED_KINDS as readonly string[]).includes(value);
}

// C0, DEL, and C1 controls.
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isValidId(id: string): boolean {
  if (byteLength(id) > MAX_ID_BYTES) {
    return false;
  }
  const segments = id.split("/");
  return (
    segments.length <= MAX_ID_DEPTH && segments.every((segment) => ID_SEGMENT_PATTERN.test(segment))
  );
}

function decodeText(encoded: string, maxEncodedBytes: number, maxDecodedBytes: number): string {
  if (encoded.length > maxEncodedBytes || !BASE64_PATTERN.test(encoded)) {
    throw new ProgramStatusReportRejected();
  }
  const unpadded = encoded.replace(/=+$/, "");
  if (
    unpadded.length % 4 === 1 ||
    (encoded.length !== unpadded.length && encoded.length % 4 !== 0)
  ) {
    throw new ProgramStatusReportRejected();
  }
  const bytes = Buffer.from(unpadded, "base64");
  if (bytes.length > maxDecodedBytes) {
    throw new ProgramStatusReportRejected();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProgramStatusReportRejected();
  }
  if (containsControlCharacter(text)) {
    throw new ProgramStatusReportRejected();
  }
  return text;
}

function parsePairs(body: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of body.split(":")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = pair.slice(0, separatorIndex);
    if (byteLength(key) > MAX_KEY_BYTES) {
      throw new ProgramStatusReportRejected();
    }
    pairs.set(key, pair.slice(separatorIndex + 1));
  }
  return pairs;
}

function buildRecord(
  id: string,
  state: ProgramStatusState,
  pairs: Map<string, string>,
): ProgramStatusRecord {
  const record: ProgramStatusRecord = { id, state };

  const kind = pairs.get("kind");
  if (state === "blocked" && kind !== undefined && isProgramStatusBlockedKind(kind)) {
    record.kind = kind;
  }

  const progress = pairs.get("progress");
  if ((state === "working" || state === "blocked") && progress && PROGRESS_PATTERN.test(progress)) {
    const value = Number(progress);
    if (value <= 100) {
      record.progress = value;
    }
  }

  const app = pairs.get("app");
  if (app !== undefined) {
    if (byteLength(app) > MAX_APP_BYTES || containsControlCharacter(app)) {
      throw new ProgramStatusReportRejected();
    }
    if (app.length > 0) {
      record.app = app;
    }
  }

  const title = pairs.get("title");
  if (title !== undefined) {
    record.title = decodeText(title, MAX_TITLE_ENCODED_BYTES, MAX_TITLE_DECODED_BYTES);
  }

  const msg = pairs.get("msg");
  if (msg !== undefined) {
    record.msg = decodeText(msg, MAX_MSG_ENCODED_BYTES, MAX_MSG_DECODED_BYTES);
  }

  return record;
}

/**
 * Parses the OSC 7501 payload that follows `7501;`. Returns null for the feature
 * detection query and for every report the spec says to ignore or discard.
 */
export function parseProgramStatusReport(body: string): ProgramStatusReport | null {
  if (body === PROGRAM_STATUS_QUERY || byteLength(body) > MAX_SEQUENCE_BYTES) {
    return null;
  }
  try {
    const pairs = parsePairs(body);
    const id = pairs.get("id");
    if (id !== undefined && !isValidId(id)) {
      return null;
    }
    const state = pairs.get("state");
    if (state === "clear") {
      return { type: "clear", id: id ?? null };
    }
    if (state === undefined || !isProgramStatusState(state)) {
      return null;
    }
    return { type: "set", record: buildRecord(id ?? ROOT_RECORD_ID, state, pairs) };
  } catch (error) {
    if (error instanceof ProgramStatusReportRejected) {
      return null;
    }
    throw error;
  }
}

function isSameOrDescendant(id: string, ancestorId: string): boolean {
  return id === ancestorId || id.startsWith(`${ancestorId}/`);
}

/**
 * The records one terminal holds. Map insertion order tracks the least recently
 * updated record for eviction.
 */
export class ProgramStatusRecords {
  private readonly records = new Map<string, ProgramStatusRecord>();

  apply(report: ProgramStatusReport): void {
    if (report.type === "clear") {
      if (report.id === null) {
        this.records.clear();
        return;
      }
      for (const id of Array.from(this.records.keys())) {
        if (isSameOrDescendant(id, report.id)) {
          this.records.delete(id);
        }
      }
      return;
    }

    this.records.delete(report.record.id);
    this.records.set(report.record.id, report.record);
    if (this.records.size > MAX_RECORDS) {
      const leastRecentlyUpdatedId = this.records.keys().next().value;
      if (leastRecentlyUpdatedId !== undefined) {
        this.records.delete(leastRecentlyUpdatedId);
      }
    }
  }

  /** Drops working and blocked records, which do not outlive a new shell prompt. */
  dropTransient(): void {
    for (const [id, record] of Array.from(this.records)) {
      if (record.state === "working" || record.state === "blocked") {
        this.records.delete(id);
      }
    }
  }

  clear(): void {
    this.records.clear();
  }

  hasApp(app: string): boolean {
    for (const record of this.records.values()) {
      if (record.app === app) {
        return true;
      }
    }
    return false;
  }

  list(): ProgramStatusRecord[] {
    return Array.from(this.records.values());
  }

  /** The msg of the most recently updated record that decides the activity. */
  describeActivity(activity: ProgramStatusActivity): string | undefined {
    const deciding = this.list().findLast((record) => {
      switch (activity) {
        case "needs_input":
          return record.state === "blocked";
        case "working":
          return record.state === "working";
        case "finished":
          return record.state === "done" || record.state === "error";
        case "idle":
          return record.state === "idle";
        case null:
          return false;
      }
    });
    return deciding?.msg;
  }

  deriveActivity(): ProgramStatusActivity {
    const states = new Set(Array.from(this.records.values(), (record) => record.state));
    if (states.has("blocked")) return "needs_input";
    if (states.has("working")) return "working";
    if (states.has("done") || states.has("error")) return "finished";
    if (states.has("idle")) return "idle";
    return null;
  }
}
