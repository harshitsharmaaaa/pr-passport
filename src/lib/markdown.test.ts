import { describe, expect, it } from "bun:test";
import {
  cleanText,
  codeBlockRatio,
  excerpt,
  extractCheckboxes,
  findLineMatch,
  hasConditionalLanguage,
  lineAt,
  parseMarkdown,
  sectionAtLine,
  snippet,
  stripCodeFences,
  truncate,
} from "./markdown";

const DOC = `# Contributing

Intro line.

## Pull request requirements

- Sign every commit off.
- Add tests.

### Nested detail

Nested body with a \`#hashtag\` that is not a heading.

\`\`\`bash
## this is not a heading
- [ ] not a checkbox
\`\`\`

## Review process

Keep changes focused.

## Table of contents

- [Requirements](#requirements)
`;

describe("parseMarkdown", () => {
  it("indexes headings with 1-based line ranges", () => {
    const doc = parseMarkdown("CONTRIBUTING.md", DOC);
    expect(doc.sections.map((section) => section.heading)).toEqual([
      "Contributing",
      "Pull request requirements",
      "Nested detail",
      "Review process",
      "Table of contents",
    ]);
    expect(doc.sections[1]).toMatchObject({ level: 2, startLine: 5 });
    expect(lineAt(doc, 5)).toBe("## Pull request requirements");
  });

  it("ignores headings inside fenced code blocks", () => {
    const doc = parseMarkdown("CONTRIBUTING.md", DOC);
    expect(doc.sections.some((section) => section.heading.includes("not a heading"))).toBe(false);
  });

  it("returns the innermost section for a line", () => {
    const doc = parseMarkdown("CONTRIBUTING.md", DOC);
    const nestedLine = doc.lines.findIndex((line) => line.startsWith("Nested body")) + 1;
    expect(sectionAtLine(doc, nestedLine)?.heading).toBe("Nested detail");
  });

  it("builds a preamble before the first heading", () => {
    const doc = parseMarkdown("x.md", "hello\n\n# Title\n\nbody\n");
    expect(doc.preamble.text.trim()).toBe("hello");
    expect(doc.preamble.startLine).toBe(1);
    expect(doc.preamble.endLine).toBe(2);
  });

  it("handles documents without headings", () => {
    const doc = parseMarkdown("x.md", "just text\n");
    expect(doc.sections).toEqual([]);
    expect(doc.preamble.endLine).toBe(2);
  });
});

describe("text helpers", () => {
  it("strips list markers, emphasis, links, and code ticks", () => {
    expect(cleanText("- **Update** the [`docs/`](https://example.com) now.")).toBe(
      "Update the docs/ now.",
    );
    expect(cleanText("1. Run the tests")).toBe("Run the tests");
    expect(cleanText("> quoted")).toBe("quoted");
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc\u2026");
    expect(truncate("abc", 4)).toBe("abc");
  });

  it("builds excerpts from line ranges", () => {
    const doc = parseMarkdown("x.md", "one\ntwo\nthree\nfour\n");
    expect(excerpt(doc, 2, 3)).toBe("two three");
  });

  it("detects conditional guidance", () => {
    expect(hasConditionalLanguage("Update the docs when a public API changes.")).toBe(true);
    expect(hasConditionalLanguage("Add a changelog entry for user-facing changes.")).toBe(true);
    expect(hasConditionalLanguage("Add tests for any behaviour change.")).toBe(false);
    expect(hasConditionalLanguage("Sign every commit off.")).toBe(false);
  });

  it("strips fenced code blocks for issue-reference scanning", () => {
    expect(stripCodeFences("before\n```\nFixes #1\n```\nafter")).not.toContain("Fixes");
  });

  it("estimates how much of a section is code", () => {
    expect(codeBlockRatio("```bash\nbun test\nbun lint\n```")).toBeGreaterThan(0.5);
    expect(codeBlockRatio("This is a sentence about testing the public API.")).toBe(0);
  });

  it("finds the first matching line outside fences", () => {
    const doc = parseMarkdown("CONTRIBUTING.md", DOC);
    const match = findLineMatch(doc, /Add tests/i);
    expect(match?.line).toBe(8);
  });

  it("creates bounded snippets around a match", () => {
    const value = "x".repeat(200) + "Fixes #12" + "y".repeat(200);
    const result = snippet(value, 200, 20);
    expect(result).toContain("Fixes #12");
    expect(result.startsWith("\u2026")).toBe(true);
  });
});

describe("extractCheckboxes", () => {
  it("parses checked, unchecked, and nested items with line numbers", () => {
    const body = "- [x] Read the guide\n* [ ] Added tests\n  - [X] Signed off\nnot a checkbox";
    expect(extractCheckboxes(body)).toEqual([
      { checked: true, text: "Read the guide", line: 1 },
      { checked: false, text: "Added tests", line: 2 },
      { checked: true, text: "Signed off", line: 3 },
    ]);
  });

  it("returns an empty list when there are no checkboxes", () => {
    expect(extractCheckboxes("plain description")).toEqual([]);
  });
});