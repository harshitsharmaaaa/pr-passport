import type { MarkdownDoc } from "./markdown";
import type { RepoContext, RuleSource, ValidationCommand } from "./types";

const SCRIPT_ORDER = ["test", "lint", "typecheck", "types", "build"] as const;

const RUNNER_PATTERN =
  /^(?:\$ )?(bun|npm|pnpm|yarn|npx|uv|poetry|pytest|cargo|go|make|just|gradle|\.\/gradlew|mvn)\b/;

function scriptCommand(packageManager: NonNullable<RepoContext["packageManager"]>, script: string): string {
  switch (packageManager) {
    case "bun":
      return `bun run ${script}`;
    case "pnpm":
      return `pnpm run ${script}`;
    case "yarn":
      return `yarn run ${script}`;
    case "npm":
      return `npm run ${script}`;
  }
}

function blobUrl(owner: string, repo: string, ref: string, path: string): string {
  return `https://github.com/${owner}/${repo}/blob/${ref}/${path}`;
}

function findTestScript(scripts: Record<string, string>): string | undefined {
  const keys = Object.keys(scripts);
  return (
    keys.find((key) => key === "test") ??
    keys.find((key) => key.startsWith("test:")) ??
    keys.find((key) => key === "tests")
  );
}

function snippetLines(doc: MarkdownDoc): { line: number; command: string }[] {
  const results: { line: number; command: string }[] = [];
  let inFence = false;

  doc.lines.forEach((raw, index) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      inFence = !inFence;
      return;
    }
    if (!inFence) return;

    const command = raw
      .trim()
      .replace(/^\$\s+/, "")
      .replace(/\s+#\s.*$/, "")
      .trim();

    if (!command || command.startsWith("#") || command.length > 140) return;
    if (!RUNNER_PATTERN.test(command)) return;
    // Skip documentation placeholders: `<package>`, `{commit}`, and ellipses.
    // A brief must not hand an agent a command that cannot run as written.
    if (
      command.includes("…") ||
      command.includes("<") ||
      command.includes(">") ||
      command.includes("{") ||
      command.includes("}")
    ) {
      return;
    }
    results.push({ line: index + 1, command });
  });

  return results;
}

/**
 * Derive runnable checks strictly from repository files. When nothing can be
 * derived this returns an empty list and the report says so, rather than
 * inventing a test command.
 */
export function deriveValidationCommands(input: {
  repo: RepoContext;
  docs: MarkdownDoc[];
  guidelineUrls?: Record<string, string>;
  owner: string;
  repoName: string;
  baseSha: string;
}): ValidationCommand[] {
  const commands: ValidationCommand[] = [];
  const seen = new Set<string>();

  const push = (command: string, reason: string, source: RuleSource) => {
    const key = command.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    commands.push({ command: key, reason, source });
  };

  for (const doc of input.docs) {
    for (const { line, command } of snippetLines(doc)) {
      push(command, `Listed in ${doc.path} line ${line}.`, {
        kind: "repository_file",
        label: `${doc.path} line ${line}`,
        path: doc.path,
        url: input.guidelineUrls?.[doc.path],
        lineStart: line,
        lineEnd: line,
      });
    }
  }

  const packageManager = input.repo.packageManager;
  if (input.repo.packageJson && packageManager) {
    const scripts = input.repo.packageJson.scripts;
    const testScript = findTestScript(scripts);
    if (testScript) {
      push(scriptCommand(packageManager, testScript), `Defined as the "${testScript}" script in package.json.`, {
        kind: "github_api",
        label: "package.json scripts",
        path: "package.json",
        url: blobUrl(input.owner, input.repoName, input.baseSha, "package.json"),
      });
    }
    for (const script of SCRIPT_ORDER) {
      if (script === "test" || script === "types") continue;
      if (script === "typecheck" && !scripts.typecheck) {
        if (scripts.types) {
          push(scriptCommand(packageManager, "types"), "Defined as the \"types\" script in package.json.", {
            kind: "github_api",
            label: "package.json scripts",
            path: "package.json",
            url: blobUrl(input.owner, input.repoName, input.baseSha, "package.json"),
          });
        }
        continue;
      }
      if (!scripts[script]) continue;
      push(scriptCommand(packageManager, script), `Defined as the "${script}" script in package.json.`, {
        kind: "github_api",
        label: "package.json scripts",
        path: "package.json",
        url: blobUrl(input.owner, input.repoName, input.baseSha, "package.json"),
      });
    }
  }

  if (input.repo.hasCargo) {
    push("cargo test", "Cargo.toml is present at the base commit.", {
      kind: "github_api",
      label: "Cargo.toml",
      path: "Cargo.toml",
      url: blobUrl(input.owner, input.repoName, input.baseSha, "Cargo.toml"),
    });
  }
  if (input.repo.hasGoMod) {
    push("go test ./...", "go.mod is present at the base commit.", {
      kind: "github_api",
      label: "go.mod",
      path: "go.mod",
      url: blobUrl(input.owner, input.repoName, input.baseSha, "go.mod"),
    });
  }
  if (input.repo.hasPyproject) {
    push("pytest", "pyproject.toml is present; confirm this is the project's configured test runner.", {
      kind: "github_api",
      label: "pyproject.toml",
      path: "pyproject.toml",
      url: blobUrl(input.owner, input.repoName, input.baseSha, "pyproject.toml"),
    });
  }
  if (input.repo.hasMakefile) {
    push("make test", "A Makefile is present; confirm it defines a test target before running this.", {
      kind: "github_api",
      label: "Makefile",
      path: "Makefile",
      url: blobUrl(input.owner, input.repoName, input.baseSha, "Makefile"),
    });
  }

  return commands.slice(0, 8);
}