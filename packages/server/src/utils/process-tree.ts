import { execCommand } from "./spawn.js";

const PROCESS_LIST_TIMEOUT_MS = 2000;

export interface ProcessTableEntry {
  pid: number;
  parentPid: number;
}

export type ListProcesses = () => Promise<ProcessTableEntry[]>;

export function parseProcessTable(output: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) {
      entries.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
    }
  }
  return entries;
}

/** Lists every process with ps. POSIX only. */
export async function listProcesses(): Promise<ProcessTableEntry[]> {
  const { stdout } = await execCommand("ps", ["-A", "-o", "pid=,ppid="], {
    envMode: "internal",
    timeout: PROCESS_LIST_TIMEOUT_MS,
  });
  return parseProcessTable(stdout);
}

/** `rootPid` followed by its descendants in breadth-first order. */
export function collectProcessTreePids(entries: ProcessTableEntry[], rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.parentPid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.parentPid, children);
  }
  const pids = [rootPid];
  const visited = new Set<number>(pids);
  for (let index = 0; index < pids.length; index += 1) {
    for (const child of childrenByParent.get(pids[index]) ?? []) {
      if (!visited.has(child)) {
        visited.add(child);
        pids.push(child);
      }
    }
  }
  return pids;
}
