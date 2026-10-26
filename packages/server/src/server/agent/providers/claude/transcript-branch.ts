/** The fields of a transcript record that place it in the conversation tree. */
export interface ClaudeTranscriptNode {
  type?: unknown;
  message?: { content?: unknown };
  uuid?: unknown;
  parentUuid?: unknown;
  logicalParentUuid?: unknown;
  isSidechain?: unknown;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isConversationRecord(node: ClaudeTranscriptNode): boolean {
  return (node.type === "user" || node.type === "assistant") && node.isSidechain !== true;
}

function isPrompt(node: ClaudeTranscriptNode): boolean {
  const content = node.message?.content;
  return (
    node.type === "user" &&
    node.isSidechain !== true &&
    !(Array.isArray(content) && content.some((block) => block?.type === "tool_result"))
  );
}

/**
 * Which records of a transcript belong to its current conversation.
 *
 * NOTE: Rewinding in Claude Code keeps the transcript and the session, and the next message
 * continues from an earlier record, so the abandoned turns stay in the file as a branch.
 * Like Claude Code, the current conversation is the chain that ends at the last message.
 * Only a branch that starts with a prompt is abandoned: the results of parallel tool calls,
 * progress, attachments and other records also hang off the chain, and a compaction boundary
 * links to the chain before it through logicalParentUuid.
 */
export function selectClaudeCurrentBranch(nodes: readonly ClaudeTranscriptNode[]): boolean[] {
  const keep = nodes.map(() => true);
  const parentOf = (node: ClaudeTranscriptNode) =>
    readId(node.parentUuid) ?? readId(node.logicalParentUuid);
  const childrenOf = new Map<string, number[]>();
  const indexOf = new Map<string, number>();
  nodes.forEach((node, index) => {
    const id = readId(node.uuid);
    if (id) indexOf.set(id, index);
    const parent = parentOf(node);
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), index]);
  });

  let leaf = -1;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (isConversationRecord(nodes[index]!) && readId(nodes[index]!.uuid)) {
      leaf = index;
      break;
    }
  }
  if (leaf === -1) return keep;

  const current = new Set<number>();
  for (let index: number | undefined = leaf; index !== undefined && !current.has(index); ) {
    current.add(index);
    const parent = parentOf(nodes[index]!);
    index = parent ? indexOf.get(parent) : undefined;
  }

  const subtree = (root: number): number[] => {
    const found: number[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const index = pending.pop()!;
      found.push(index);
      const id = readId(nodes[index]!.uuid);
      if (id) pending.push(...(childrenOf.get(id) ?? []));
    }
    return found;
  };
  for (const index of current) {
    const id = readId(nodes[index]!.uuid);
    for (const child of (id && childrenOf.get(id)) || []) {
      if (current.has(child) || !isPrompt(nodes[child]!)) continue;
      for (const member of subtree(child)) keep[member] = false;
    }
  }
  return keep;
}
