export interface MarkdownSection {
  heading: string;
  level: number;
  /** 1-based line number of the heading. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  body: string;
}

export interface MarkdownDoc {
  path: string;
  content: string;
  lines: string[];
  sections: MarkdownSection[];
  preamble: { text: string; startLine: number; endLine: number };
}

const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * A deliberately small Markdown reader: it only needs headings, line numbers
 * and code-fence awareness so that rule sources can point at real lines.
 */
export function parseMarkdown(path: string, content: string): MarkdownDoc {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const headings: { index: number; level: number; heading: string }[] = [];
  let openFence: "`" | "~" | null = null;

  lines.forEach((line, index) => {
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0];
      if (!marker) return;
      if (openFence === null) {
        openFence = marker === "`" ? "`" : "~";
      } else if (marker === openFence) {
        openFence = null;
      }
      return;
    }
    if (openFence !== null) return;

    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch?.[1] && headingMatch[2]) {
      headings.push({ index, level: headingMatch[1].length, heading: headingMatch[2].trim() });
    }
  });

  const sections: MarkdownSection[] = headings.map((heading, position) => {
    let endIndex = lines.length - 1;
    for (let next = position + 1; next < headings.length; next += 1) {
      const candidate = headings[next];
      if (candidate && candidate.level <= heading.level) {
        endIndex = candidate.index - 1;
        break;
      }
    }
    return {
      heading: heading.heading,
      level: heading.level,
      startLine: heading.index + 1,
      endLine: Math.max(heading.index + 1, endIndex + 1),
      body: lines.slice(heading.index + 1, endIndex + 1).join("\n"),
    };
  });

  const firstHeadingIndex = headings[0]?.index ?? lines.length;
  return {
    path,
    content: normalized,
    lines,
    sections,
    preamble: {
      text: lines.slice(0, firstHeadingIndex).join("\n"),
      startLine: 1,
      endLine: Math.max(1, firstHeadingIndex),
    },
  };
}

export function lineAt(doc: MarkdownDoc, line: number): string {
  return doc.lines[line - 1] ?? "";
}

/** Collapse Markdown noise so a quoted rule reads like a sentence. */
export function cleanText(input: string): string {
  return input
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^\s*>\s*/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function excerpt(
  doc: MarkdownDoc,
  startLine: number,
  endLine: number,
  maxChars = 320,
): string {
  const start = Math.max(1, startLine);
  const end = Math.max(start, endLine);
  const raw = doc.lines.slice(start - 1, end).join("\n");
  return truncate(cleanText(raw), maxChars);
}

/** Find the first line outside a fenced block that matches. */
export function findLineMatch(
  doc: MarkdownDoc,
  pattern: RegExp,
): { line: number; text: string } | null {
  let openFence: "`" | "~" | null = null;
  for (let index = 0; index < doc.lines.length; index += 1) {
    const line = doc.lines[index] ?? "";
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0];
      if (!marker) continue;
      if (openFence === null) openFence = marker === "`" ? "`" : "~";
      else if (marker === openFence) openFence = null;
      continue;
    }
    if (openFence !== null) continue;
    if (pattern.test(line)) {
      return { line: index + 1, text: line };
    }
  }
  return null;
}

export function sectionAtLine(doc: MarkdownDoc, line: number): MarkdownSection | null {
  const matches = doc.sections.filter((section) => line >= section.startLine && line <= section.endLine);
  // Prefer the innermost (deepest) section so a rule quotes its own heading
  // rather than the document title that spans the whole file.
  return matches.sort((a, b) => b.level - a.level)[0] ?? null;
}

/** Remove fenced code so placeholder links such as `#123` are not counted as references. */
export function stripCodeFences(input: string): string {
  return input.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}

export function hasConditionalLanguage(text: string): boolean {
  return /\b(if|when|where|unless|whenever|if applicable|when appropriate|as needed|for user[- ]facing|optional|may|consider)\b/i.test(
    text,
  );
}

export function codeBlockRatio(input: string): number {
  if (!input.trim()) return 0;
  const lines = input.split("\n");
  const fenceLines = lines.filter((line) => FENCE_PATTERN.test(line)).length;
  const inside = lines.filter((line) => /^\s{4,}|^\t/.test(line)).length;
  return Math.min(1, (fenceLines * 3 + inside) / lines.length);
}

export interface CheckboxItem {
  checked: boolean;
  text: string;
  /** 1-based line number in the pull request body string. */
  line: number;
}

const CHECKBOX_PATTERN = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

export function extractCheckboxes(input: string): CheckboxItem[] {
  const items: CheckboxItem[] = [];
  input.replace(/\r\n?/g, "\n").split("\n").forEach((line, index) => {
    const match = CHECKBOX_PATTERN.exec(line);
    if (!match || !match[1] || !match[2]) return;
    items.push({ checked: match[1].toLowerCase() === "x", text: cleanText(match[2]), line: index + 1 });
  });
  return items;
}

/** Turn an issue URL, PR body or commit message into a short quotable snippet. */
export function snippet(input: string, index: number, radius = 120): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(input.length, index + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < input.length ? "…" : "";
  return `${prefix}${cleanText(input.slice(start, end))}${suffix}`;
}