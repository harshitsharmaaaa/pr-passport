import type { MarkdownDoc } from "./markdown";
import { parseMarkdown } from "./markdown";
import type { GuidelineSummary, PullRequestSource } from "./types";

export const CONTRIBUTING_CANDIDATES = [
  ".github/CONTRIBUTING.md",
  "CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "docs/contributing.md",
  "docs/contributing/index.md",
  "contributing.md",
] as const;

export const TEMPLATE_CANDIDATES = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
] as const;

export interface GuidelineFile {
  path: string;
  content: string;
  url: string;
  truncated: boolean;
  lineCount: number;
}

export interface GuidelinesBundle {
  files: GuidelineFile[];
  docs: MarkdownDoc[];
  template?: GuidelineFile;
  templateDoc?: MarkdownDoc;
  missing: string[];
  unavailable: { path: string; reason: string }[];
}

const MAX_GUIDELINE_CHARS = 60_000;

function blobUrl(owner: string, repo: string, ref: string, path: string): string {
  return `https://github.com/${owner}/${repo}/blob/${ref}/${path}`;
}

function toFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  content: string,
): GuidelineFile {
  const truncated = content.length > MAX_GUIDELINE_CHARS;
  const body = truncated ? content.slice(0, MAX_GUIDELINE_CHARS) : content;
  return {
    path,
    content: body,
    url: blobUrl(owner, repo, ref, path),
    truncated,
    lineCount: body.replace(/\r\n?/g, "\n").split("\n").length,
  };
}

/**
 * Read the repository's own contribution instructions at the pull request's
 * base commit. Missing files are recorded, never invented.
 */
export async function loadGuidelines(
  source: PullRequestSource,
  owner: string,
  repo: string,
  baseSha: string,
): Promise<GuidelinesBundle> {
  const missing: string[] = [];
  const unavailable: { path: string; reason: string }[] = [];
  const files: GuidelineFile[] = [];

  let contributing: GuidelineFile | undefined;
  for (const path of CONTRIBUTING_CANDIDATES) {
    try {
      const content = await source.readRepositoryFile(owner, repo, path, baseSha);
      if (content && content.trim()) {
        contributing = toFile(owner, repo, baseSha, path, content);
        break;
      }
      missing.push(path);
    } catch (error) {
      unavailable.push({ path, reason: reasonFor(error) });
    }
  }
  if (contributing) files.push(contributing);

  let template: GuidelineFile | undefined;
  for (const path of TEMPLATE_CANDIDATES) {
    try {
      const content = await source.readRepositoryFile(owner, repo, path, baseSha);
      if (content && content.trim()) {
        template = toFile(owner, repo, baseSha, path, content);
        break;
      }
      missing.push(path);
    } catch (error) {
      unavailable.push({ path, reason: reasonFor(error) });
    }
  }

  const docs = files.map((file) => parseMarkdown(file.path, file.content));
  const templateDoc = template ? parseMarkdown(template.path, template.content) : undefined;

  return {
    files,
    docs,
    template,
    templateDoc,
    missing,
    unavailable,
  };
}

function reasonFor(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "GitHub returned an error while reading this file.";
}

export function summarizeGuidelines(bundle: GuidelinesBundle): GuidelineSummary[] {
  return bundle.files.map((file) => ({
    path: file.path,
    url: file.url,
    truncated: file.truncated,
    lineCount: file.lineCount,
  }));
}