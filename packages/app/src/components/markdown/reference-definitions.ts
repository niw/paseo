import type { Definition, Nodes, Root } from "mdast";

/** Repeat the first definition for each label in every independently rendered fragment. */
export function markdownReferenceDefinitions(tree: Root): string {
  const definitions = new Map<string, Definition>();
  function visit(node: Nodes) {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(tree);
  return [...definitions.values()]
    .map((node) => {
      const label = node.identifier.replace(/[\\[\]]/g, "\\$&");
      const url = node.url.replace(/[\\<>]/g, "\\$&");
      const title = node.title ? ` "${node.title.replace(/[\\"]/g, "\\$&")}"` : "";
      return `[${label}]: <${url}>${title}`;
    })
    .join("\n");
}
