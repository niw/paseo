import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Paragraph } from "mdast";
import { isAbsolutePath } from "@/utils/path";
import { markdownReferenceDefinitions } from "../reference-definitions";

const START = "\uE200";
const PREFIX = `${START}visualize\uE202`;
const END = "\uE201";
export const VISUALIZE_WIDE_WIDTH = 1024;

export interface VisualizeReference {
  path: string;
  mode?: "wide";
  title?: string;
}

interface VisualizeLine {
  start: number;
  end: number;
  reference: VisualizeReference | null;
}

type VisualizeSegment =
  | { kind: "markdown"; offset: number; source: string }
  | { kind: "visualize"; offset: number; reference: VisualizeReference };

function parseReference(line: string): VisualizeReference | null {
  if (!line.startsWith(PREFIX) || !line.endsWith(END)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(PREFIX.length, -END.length));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !("path" in value)) return null;
  const { path } = value;
  const mode = "mode" in value ? value.mode : undefined;
  const title = "title" in value ? value.title : undefined;
  if (typeof path !== "string" || !isAbsolutePath(path) || !/\.html$/i.test(path)) return null;
  if (mode !== undefined && mode !== "wide") return null;
  if (title !== undefined && typeof title !== "string") return null;
  return { path, mode, title };
}

function isInsideInlineCode(node: Nodes, offset: number): boolean {
  if (node.type === "inlineCode") {
    return node.position!.start.offset! <= offset && offset < node.position!.end.offset!;
  }
  return "children" in node && node.children.some((child) => isInsideInlineCode(child, offset));
}

function findReferenceLines(
  source: string,
  paragraph: Paragraph,
  streaming: boolean,
): VisualizeLine[] {
  const start = paragraph.position!.start.offset!;
  const end = paragraph.position!.end.offset!;
  const lines: VisualizeLine[] = [];
  // Include the line's indentation and terminator. Adjacent prose can share this paragraph.
  const lineStart = start - paragraph.position!.start.column + 1;
  const paragraphSource = source.slice(lineStart, end);
  for (const match of paragraphSource.matchAll(/^ {0,3}\uE200[^\r\n]*/gm)) {
    const offset = lineStart + match.index;
    const rawLine = match[0];
    const line = rawLine.trim();
    const markerOffset = offset + rawLine.indexOf(START);
    if (markerOffset < start || isInsideInlineCode(paragraph, markerOffset)) continue;
    let lineEnd = offset + rawLine.length;
    if (source[lineEnd] === "\r") lineEnd++;
    if (source[lineEnd] === "\n") lineEnd++;
    const unfinished = streaming && lineEnd === source.length && !/[\r\n]$/.test(source);
    if (unfinished && (PREFIX.startsWith(line) || line.startsWith(PREFIX))) {
      lines.push({ start: offset, end: lineEnd, reference: null });
      continue;
    }
    const reference = parseReference(line);
    if (reference) lines.push({ start: offset, end: lineEnd, reference });
  }
  return lines;
}

export function splitVisualizeMarkdown(
  source: string,
  streaming: boolean,
): VisualizeSegment[] | null {
  if (!source.includes(START)) return null;
  const tree = fromMarkdown(source);
  const lines = tree.children.flatMap((node) =>
    node.type === "paragraph" ? findReferenceLines(source, node, streaming) : [],
  );
  if (lines.length === 0) return null;
  const definitions = markdownReferenceDefinitions(tree);
  const fragments: VisualizeSegment[] = [];
  function appendMarkdown(start: number, end: number) {
    const text = source.slice(start, end);
    if (!text.trim()) return;
    const markdown = definitions ? `${definitions}\n\n${text}` : text;
    fragments.push({ kind: "markdown", offset: start, source: markdown });
  }
  let cursor = 0;
  for (const line of lines) {
    appendMarkdown(cursor, line.start);
    if (line.reference) {
      fragments.push({ kind: "visualize", offset: line.start, reference: line.reference });
    }
    cursor = line.end;
  }
  appendMarkdown(cursor, source.length);
  return fragments;
}

export function hasWideVisualize(source: string): boolean {
  if (!source.includes(PREFIX)) return false;
  return (
    splitVisualizeMarkdown(source, false)?.some(
      (segment) => segment.kind === "visualize" && segment.reference.mode === "wide",
    ) ?? false
  );
}
