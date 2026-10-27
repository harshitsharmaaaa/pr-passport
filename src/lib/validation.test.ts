import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "./markdown";
import { deriveValidationCommands } from "./validation";
import { BASE_SHA, makeRepo } from "./test-support";

function docs(source: string) {
  return [parseMarkdown("CONTRIBUTING.md", source)];
}

const base = {
  owner: "acme",
  repoName: "widget-kit",
  baseSha: BASE_SHA,
  guidelineUrls: { "CONTRIBUTING.md": "https://github.com/acme/widget-kit/blob/main/CONTRIBUTING.md" },
};

describe("deriveValidationCommands", () => {
  it("uses package.json scripts and the detected package manager", () => {
    const commands = deriveValidationCommands({
      ...base,
      repo: makeRepo(),
      docs: [],
    });
    expect(commands.map((command) => command.command)).toEqual([
      "bun run test",
      "bun run lint",
      "bun run typecheck",
    ]);
    expect(commands[0]?.source.path).toBe("package.json");
    expect(commands[0]?.reason).toContain('"test"');
  });

  it("uses pnpm when that is the project's package manager", () => {
    const commands = deriveValidationCommands({
      ...base,
      repo: makeRepo({
        packageManager: "pnpm",
        packageJson: {
          raw: "{}",
          scripts: { test: "vitest" },
          packageManager: "pnpm@9.0.0",
        },
      }),
      docs: [],
    });
    expect(commands.map((command) => command.command)).toEqual(["pnpm run test"]);
  });

  it("reads commands from guideline code fences with line numbers", () => {
    const commands = deriveValidationCommands({
      ...base,
      repo: makeRepo(),
      docs: docs(`# Contributing

Run these:

\`\`\`bash
$ bun run test
bun run lint # check style
npm install <package>
npm i https://pkg.pr.new/vitest@{commit}
\`\`\`
`),
    });
    const values = commands.map((command) => command.command);
    expect(values[0]).toBe("bun run test");
    expect(values[1]).toBe("bun run lint");
    expect(values).not.toContain("npm install <package>");
    expect(values).not.toContain("npm i https://pkg.pr.new/vitest@{commit}");
    expect(commands[0]?.source.lineStart).toBeGreaterThan(0);
    expect(commands[0]?.reason).toContain("CONTRIBUTING.md line");
  });

  it("deduplicates commands that appear in both the guide and package.json", () => {
    const commands = deriveValidationCommands({
      ...base,
      repo: makeRepo(),
      docs: docs("```bash\nbun run test\n```"),
    });
    expect(commands.filter((command) => command.command === "bun run test")).toHaveLength(1);
  });

  it("derives language commands only from files that exist", () => {
    const cargo = deriveValidationCommands({
      ...base,
      repo: makeRepo({ packageJson: undefined, packageManager: undefined, hasCargo: true }),
      docs: [],
    });
    expect(cargo.map((command) => command.command)).toEqual(["cargo test"]);

    const go = deriveValidationCommands({
      ...base,
      repo: makeRepo({ packageJson: undefined, packageManager: undefined, hasGoMod: true }),
      docs: [],
    });
    expect(go.map((command) => command.command)).toEqual(["go test ./..."]);

    const python = deriveValidationCommands({
      ...base,
      repo: makeRepo({ packageJson: undefined, packageManager: undefined, hasPyproject: true }),
      docs: [],
    });
    expect(python.map((command) => command.command)).toEqual(["pytest"]);
    expect(python[0]?.reason).toContain("confirm");
  });

  it("suggests make test only when a Makefile exists", () => {
    const commands = deriveValidationCommands({
      ...base,
      repo: makeRepo({ packageJson: undefined, packageManager: undefined, hasMakefile: true }),
      docs: [],
    });
    expect(commands.map((command) => command.command)).toEqual(["make test"]);
  });

  it("returns an empty list rather than guessing", () => {
    const commands = deriveValidationCommands({
      ...base,
      repo: makeRepo({ packageJson: undefined, packageManager: undefined }),
      docs: [],
    });
    expect(commands).toEqual([]);
  });

  it("caps the number of suggestions", () => {
    const many = Array.from({ length: 12 }, (_, index) => `bun run task-${index}`).join("\n");
    const commands = deriveValidationCommands({
      ...base,
      repo: makeRepo(),
      docs: docs(`Run:\n\n\`\`\`bash\n${many}\n\`\`\``),
    });
    expect(commands.length).toBeLessThanOrEqual(8);
  });
});