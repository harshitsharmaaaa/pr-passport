import type { GuidelinesBundle } from "../guidelines";
import type { MarkdownDoc, MarkdownSection } from "../markdown";
import {
  cleanText,
  codeBlockRatio,
  excerpt,
  extractCheckboxes,
  hasConditionalLanguage,
  lineAt,
  sectionAtLine,
  truncate,
} from "../markdown";
import type { CiSummary, RuleSource } from "../types";

export type RuleKind =
  | "signed_off_by"
  | "linked_issue"
  | "conventional_title"
  | "changelog_updated"
  | "tests_added"
  | "docs_updated"
  | "template_checklist"
  | "pr_description"
  | "branch_naming"
  | "pr_size_limit"
  | "ci_green"
  | "merge_conflicts"
  | "freeform";

export type RuleOrigin = "guideline" | "template" | "platform";

export interface RuleSpec {
  id: string;
  kind: RuleKind;
  title: string;
  requirement: string;
  source: RuleSource;
  conditional: boolean;
  origin: RuleOrigin;
  params?: {
    maxChanges?: number;
    branchPrefix?: string;
    allowedPrefixes?: string[];
  };
}

export const DEFAULT_TITLE_PREFIXES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

const REQUIREMENT_LANGUAGE =
  /\b(must|should|shall|required?|please|ensure|make sure|always|never|do not|don't|avoid|need to|have to)\b/i;

const IMPERATIVE_LANGUAGE =
  /\b(add|include|update|run|follow|use|keep|split|reference|link|sign|write|open|describe|check)\b/i;

function isRequirementLine(text: string, heading: string): boolean {
  if (REQUIREMENT_LANGUAGE.test(text)) return true;
  if (/\b(checklist|requirements?|rules?|guidelines?|expectations?|before you (start|submit))\b/i.test(heading)) {
    return true;
  }
  return IMPERATIVE_LANGUAGE.test(text) && /\b(please|every|each|any|all|your|the pull request)\b/i.test(text);
}

function backtickedTokens(text: string): string[] {
  return Array.from(text.matchAll(/`([^`\n]{1,60})`/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function detectAllowedPrefixes(text: string): string[] | undefined {
  const tokens = backtickedTokens(text)
    .map((token) => token.replace(/:$/, "").toLowerCase())
    .filter((token) => /^[a-z][a-z0-9-]{1,20}$/.test(token));
  if (tokens.length >= 2) return Array.from(new Set(tokens));
  return undefined;
}

function detectSizeLimit(text: string): number | undefined {
  const match =
    /(?:under|below|fewer than|less than|no more than|max(?:imum)?(?: of)?|limit(?: of)?)\s*`?(\d{2,5})`?\s*(?:changed\s+)?(?:lines|line|loc)\b/i.exec(
      text,
    ) ?? /(\d{2,5})\s*(?:changed\s+)?(?:lines|loc)\s*(?:or fewer|max(?:imum)?|limit)/i.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function detectBranchPrefix(text: string): string | undefined {
  const glob = /([a-z][a-z0-9._-]*\/\*)/i.exec(text);
  if (glob?.[1]) return glob[1].replace(/\*$/, "");
  const trailing = backtickedTokens(text).find((token) => /^[a-z][a-z0-9._-]*\/$/.test(token));
  return trailing;
}

interface Detector {
  kind: RuleKind;
  title: string;
  pattern: RegExp;
  /** Strong patterns are specific enough to stand on their own. */
  strong?: boolean;
  build?: (text: string) => Partial<RuleSpec> & { title?: string };
}

const DETECTORS: Detector[] = [
  {
    kind: "signed_off_by",
    title: "Developer Certificate of Origin sign-off",
    pattern: /(signed-off-by|developer certificate of origin|\bDCO\b)/i,
    strong: true,
  },
  {
    kind: "linked_issue",
    title: "Linked issue",
    pattern:
      /(?:reference|link|cite|mention|open|file)s?\s+(?:an?\s+)?(?:existing\s+)?issue|issue\s+(?:number|reference|link)|\b(?:fixes|closes|resolves|refs?)\s+#|`(?:fixes|closes|resolves)\s+#/i,
    strong: true,
  },
  {
    kind: "conventional_title",
    title: "Pull request title format",
    pattern:
      /(conventional commits?|commit message (?:format|convention|style)|title (?:format|prefix|convention)|prefix(?:ed)?\s+(?:your\s+|the\s+)?(?:commit|pr|pull request)|semantic (?:commit|pr))/i,
    build: (text) => {
      const allowedPrefixes = detectAllowedPrefixes(text);
      return allowedPrefixes ? { params: { allowedPrefixes } } : {};
    },
  },
  {
    kind: "changelog_updated",
    title: "Changelog entry",
    pattern: /(changelog|changes\.md|changeset|release notes)/i,
  },
  {
    kind: "tests_added",
    title: "Tests for behaviour changes",
    pattern:
      /(?:add|include|update|write|provide)s?\s+(?:new\s+|the\s+)?(?:unit\s+|integration\s+|regression\s+)?tests?|test coverage|\btests? (?:are|is) required\b|\btests? (?:must|should)\b|with (?:the\s+)?tests\b/i,
  },
  {
    kind: "docs_updated",
    title: "Documentation updates",
    pattern: /(?:update|document|add)s?\s+(?:the\s+)?(?:docs|documentation|readme)|documentation (?:update|change)/i,
  },
  {
    kind: "branch_naming",
    title: "Branch naming",
    pattern:
      /branch(?:es)?\s+(?:names?|named|naming|must|should|prefixed)|name (?:your |the )?branch(?:es)?|branch (?:prefix|convention)/i,
    build: (text) => {
      const branchPrefix = detectBranchPrefix(text);
      return branchPrefix ? { params: { branchPrefix } } : {};
    },
  },
  {
    kind: "pr_size_limit",
    title: "Pull request size limit",
    pattern:
      /(?:under|below|fewer than|less than|no more than|max(?:imum)?(?: of)?|limit(?: of)?)\s*`?\d{2,5}`?\s*(?:changed\s+)?(?:lines|line|loc)\b|\d{2,5}\s*(?:changed\s+)?(?:lines|loc)\s*(?:or fewer|max(?:imum)?|limit)/i,
    build: (text) => {
      const maxChanges = detectSizeLimit(text);
      return maxChanges ? { params: { maxChanges }, title: `Pull request size limit (${maxChanges} changed lines)` } : {};
    },
  },
  {
    kind: "ci_green",
    title: "Continuous integration must pass",
    pattern:
      /(?:all\s+)?checks?\s+(?:must|should|need to)\s+(?:be\s+)?(?:green|pass)|ci\s+(?:must|should|needs to)\s+(?:be\s+)?(?:green|pass)|continuous integration (?:must|should)/i,
  },
];

function sourceFor(
  doc: MarkdownDoc,
  line: number,
  urls: Record<string, string>,
): RuleSource {
  const section = sectionAtLine(doc, line);
  const source: RuleSource = {
    kind: "repository_file",
    label: `${doc.path}${section ? ` § ${section.heading}` : ""}`,
    path: doc.path,
    lineStart: line,
    lineEnd: line,
  };
  const url = urls[doc.path];
  if (url) source.url = url;
  const text = excerpt(doc, line, line, 320);
  if (text) source.excerpt = text;
  return source;
}

function findDetectorLine(
  doc: MarkdownDoc,
  detector: Detector,
): { line: number; text: string; heading: string; conditional: boolean } | null {
  let openFence: "`" | "~" | null = null;
  for (let index = 0; index < doc.lines.length; index += 1) {
    const line = doc.lines[index] ?? "";
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1]?.[0];
      if (!marker) continue;
      if (openFence === null) openFence = marker === "`" ? "`" : "~";
      else if (marker === openFence) openFence = null;
      continue;
    }
    if (openFence !== null) continue;
    if (!detector.pattern.test(line)) continue;

    const section = sectionAtLine(doc, index + 1);
    const heading = section?.heading ?? "";
    const text = cleanText(line);
    if (!detector.strong && !isRequirementLine(text, heading)) continue;
    if (text.length < 12) continue;

    return {
      line: index + 1,
      text,
      heading,
      conditional: hasConditionalLanguage(text),
    };
  }
  return null;
}

/**
 * Extract machine-checkable requirements from the repository's own guidelines.
 * Each spec keeps the exact file, line and sentence that justifies it.
 */
export function extractGuidelineRules(
  docs: MarkdownDoc[],
  urls: Record<string, string> = {},
): RuleSpec[] {
  const specs: RuleSpec[] = [];
  const seen = new Set<RuleKind>();

  for (const doc of docs) {
    for (const detector of DETECTORS) {
      if (seen.has(detector.kind)) continue;
      const match = findDetectorLine(doc, detector);
      if (!match) continue;

      const built = detector.build?.(lineAt(doc, match.line)) ?? {};
      if (detector.kind === "pr_size_limit" && !built.params?.maxChanges) continue;
      if (detector.kind === "branch_naming" && !built.params?.branchPrefix) {
        // The guideline mentions branch naming without a usable prefix. Keep
        // the rule so it can be surfaced as unverifiable instead of guessed.
      }

      const requirement = truncate(match.text, 280);
      const source = sourceFor(doc, match.line, urls);
      source.label = `${doc.path}${match.heading ? ` § ${match.heading}` : ""}`;

      specs.push({
        id: `rule-${detector.kind}`,
        kind: detector.kind,
        title: built.title ?? detector.title,
        requirement,
        source,
        conditional: match.conditional,
        origin: "guideline",
        params: built.params,
      });
      seen.add(detector.kind);
    }
  }

  return specs;
}

function templateSource(bundle: GuidelinesBundle): RuleSource | null {
  const template = bundle.template;
  if (!template) return null;
  return {
    kind: "repository_file",
    label: `${template.path} § pull request template`,
    path: template.path,
    url: template.url,
  };
}

/** Checklist and description requirements implied by a pull request template. */
export function extractTemplateRules(bundle: GuidelinesBundle): RuleSpec[] {
  const template = bundle.template;
  const doc = bundle.templateDoc;
  const source = templateSource(bundle);
  if (!template || !doc || !source) return [];

  const specs: RuleSpec[] = [];
  const checkboxes = extractCheckboxes(template.content);

  if (checkboxes.length > 0) {
    const first = checkboxes[0];
    const last = checkboxes[checkboxes.length - 1];
    specs.push({
      id: "rule-template-checklist",
      kind: "template_checklist",
      title: "Pull request template checklist",
      requirement: `Complete every checklist item in ${template.path}.`,
      source: {
        ...source,
        lineStart: first?.line,
        lineEnd: last?.line,
        excerpt: truncate(cleanText(checkboxes.map((item) => `- [ ] ${item.text}`).join(" ")), 320),
      },
      conditional: false,
      origin: "template",
    });
  }

  const firstText = doc.lines.find((line) => cleanText(line).length > 20 && !line.trim().startsWith("#"));
  if (firstText) {
    const lineNumber = doc.lines.indexOf(firstText) + 1;
    specs.push({
      id: "rule-pr-description",
      kind: "pr_description",
      title: "Completed pull request description",
      requirement: `Describe the change using the prompts in ${template.path}.`,
      source: {
        ...source,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        excerpt: truncate(cleanText(firstText), 280),
      },
      conditional: false,
      origin: "template",
    });
  }

  return specs;
}

export interface PlatformRuleContext {
  prUrl: string;
  headSha: string;
  ci: CiSummary;
}

export function platformRuleSpecs(context: PlatformRuleContext): RuleSpec[] {
  const specs: RuleSpec[] = [
    {
      id: "rule-merge-conflicts",
      kind: "merge_conflicts",
      title: "No merge conflicts",
      requirement: "The pull request must be mergeable into its base branch.",
      source: {
        kind: "github_api",
        label: "GitHub pull request mergeability",
        url: context.prUrl,
      },
      conditional: false,
      origin: "platform",
    },
  ];

  if (context.ci.available && context.ci.state !== "none") {
    specs.push({
      id: "rule-ci-green",
      kind: "ci_green",
      title: "Required checks pass",
      requirement: "All reported CI checks for the head commit must pass.",
      source: {
        kind: "github_api",
        label: `GitHub checks for ${context.headSha.slice(0, 7)}`,
        url: context.ci.sourceUrl ?? `${context.prUrl}/checks`,
      },
      conditional: false,
      origin: "platform",
    });
  }

  return specs;
}

const FREEFORM_EXCLUDED_HEADINGS =
  /(table of contents|code of conduct|licen[cs]e|security policy|changelog|release notes|questions|contact|acknowledg|credits|maintainers|thanks)/i;

const FREEFORM_PREFERRED_HEADINGS =
  /(before|process|review|design|communication|expectation|checklist|style|rule|guideline|requirement|testing|documentation)/i;

/**
 * Free-form guidance that cannot be verified programmatically. Only sections
 * that are not already covered by a deterministic rule are selected.
 */
export function extractFreeformRules(
  bundle: GuidelinesBundle,
  deterministic: RuleSpec[],
): RuleSpec[] {
  const usedLines = new Map<string, number[]>();
  for (const spec of deterministic) {
    if (spec.source.path && spec.source.lineStart) {
      const list = usedLines.get(spec.source.path) ?? [];
      list.push(spec.source.lineStart);
      usedLines.set(spec.source.path, list);
    }
  }

  interface Candidate {
    doc: MarkdownDoc;
    section: MarkdownSection;
    score: number;
  }
  const candidates: Candidate[] = [];

  for (const doc of bundle.docs) {
    for (const section of doc.sections) {
      if (section.level < 2 || section.level > 4) continue;
      if (FREEFORM_EXCLUDED_HEADINGS.test(section.heading)) continue;
      const body = cleanText(section.body);
      if (body.length < 80 || body.length > 1600) continue;
      if (codeBlockRatio(section.body) > 0.35) continue;
      if (!REQUIREMENT_LANGUAGE.test(body) && !IMPERATIVE_LANGUAGE.test(body)) continue;

      const blocked = (usedLines.get(doc.path) ?? []).some(
        (line) => line >= section.startLine && line <= section.endLine,
      );
      if (blocked) continue;

      let score = 0;
      if (FREEFORM_PREFERRED_HEADINGS.test(section.heading)) score += 2;
      score += Math.min(3, (body.match(/\b(must|should|ensure|avoid|do not|don't|never|always)\b/gi) ?? []).length);
      candidates.push({ doc, section, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.section.startLine - b.section.startLine);

  const urls: Record<string, string> = {};
  for (const file of bundle.files) urls[file.path] = file.url;

  return candidates.slice(0, 4).map(({ doc, section }) => {
    const slug = doc.path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return {
      id: `freeform-${slug}-${section.startLine}`,
      kind: "freeform",
      title: section.heading,
      requirement: truncate(cleanText(section.body), 400),
      source: {
        kind: "repository_file" as const,
        label: `${doc.path} § ${section.heading}`,
        path: doc.path,
        url: urls[doc.path],
        lineStart: section.startLine,
        lineEnd: Math.min(section.endLine, section.startLine + 12),
        excerpt: excerpt(doc, section.startLine, Math.min(section.endLine, section.startLine + 6), 400),
      },
      conditional: hasConditionalLanguage(section.body),
      origin: "guideline" as const,
    };
  });
}

export function isFreeformRule(spec: RuleSpec): boolean {
  return spec.kind === "freeform";
}

export interface RuleBundle {
  deterministic: RuleSpec[];
  freeform: RuleSpec[];
}

/** Combine guideline, template and platform rules into one deduplicated set. */
export function buildRuleSpecs(bundle: GuidelinesBundle, context: PlatformRuleContext): RuleBundle {
  const urls: Record<string, string> = {};
  for (const file of bundle.files) urls[file.path] = file.url;

  const guideline = extractGuidelineRules(bundle.docs, urls);
  const template = extractTemplateRules(bundle);
  const combined = [...guideline, ...template];
  const platform = platformRuleSpecs(context).filter(
    (spec) => !combined.some((existing) => existing.kind === spec.kind),
  );
  const deterministic = [...combined, ...platform];
  const freeform = extractFreeformRules(bundle, deterministic);
  return { deterministic, freeform };
}