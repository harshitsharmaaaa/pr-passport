import { describe, expect, it } from "bun:test";
import { makeCi, makeGuidelines, HEAD_SHA } from "../test-support";
import {
  buildRuleSpecs,
  extractFreeformRules,
  extractGuidelineRules,
  extractTemplateRules,
  platformRuleSpecs,
} from "./spec";

const CONTRIBUTING = `# Contributing

## Pull request requirements

- Sign every commit with \`git commit -s\` and a \`Signed-off-by:\` trailer (DCO).
- Reference the issue in the description, for example \`Fixes #12\`.
- Use Conventional Commits in the pull request title (\`feat:\`, \`fix:\`, \`docs:\`).
- Add or update tests for any behaviour change.
- Update the documentation in \`docs/\` when a public API changes.
- Add a changelog entry in \`CHANGELOG.md\` for user-facing changes.

## Design notes

If your change adds a new public API, describe the design and the trade-offs in the pull request description so reviewers can evaluate it.

## Review process

Keep pull requests focused: a reviewer must be able to understand the change in one sitting. Split unrelated refactors into separate pull requests.

## Local checks

Run the same checks CI runs before opening a pull request:

\`\`\`bash
bun install
bun run lint
bun run test
\`\`\`
`;

const URLS = { "CONTRIBUTING.md": "https://github.com/acme/widget-kit/blob/main/CONTRIBUTING.md" };

const PLATFORM_CONTEXT = {
  prUrl: "https://github.com/acme/widget-kit/pull/42",
  headSha: HEAD_SHA,
  ci: makeCi(),
};

const PLATFORM_CONTEXT_NO_CI = {
  ...PLATFORM_CONTEXT,
  ci: makeCi({ state: "none", total: 0, successful: 0 }),
};

describe("extractGuidelineRules", () => {
  const bundle = makeGuidelines(CONTRIBUTING);
  const specs = extractGuidelineRules(bundle.docs, URLS);

  it("extracts every machine-checkable rule from the guidelines", () => {
    expect(specs.map((spec) => spec.kind as string).sort()).toEqual(
      [
        "changelog_updated",
        "conventional_title",
        "docs_updated",
        "linked_issue",
        "signed_off_by",
        "tests_added",
      ].sort(),
    );
  });

  it("keeps the exact file, line, and excerpt for each rule", () => {
    const dco = specs.find((spec) => spec.kind === "signed_off_by");
    expect(dco?.source).toMatchObject({
      kind: "repository_file",
      path: "CONTRIBUTING.md",
      lineStart: 5,
    });
    expect(dco?.source.excerpt).toContain("Signed-off-by");
    expect(dco?.source.url).toContain("CONTRIBUTING.md");
    expect(dco?.source.label).toContain("Pull request requirements");
  });

  it("marks only conditional guidance as conditional", () => {
    const byKind = Object.fromEntries(specs.map((spec) => [spec.kind, spec]));
    expect(byKind.docs_updated?.conditional).toBe(true);
    expect(byKind.changelog_updated?.conditional).toBe(true);
    expect(byKind.signed_off_by?.conditional).toBe(false);
    expect(byKind.tests_added?.conditional).toBe(false);
    expect(byKind.conventional_title?.conditional).toBe(false);
  });

  it("uses the prefixes the repository documents", () => {
    const title = specs.find((spec) => spec.kind === "conventional_title");
    expect(title?.params?.allowedPrefixes).toEqual(["feat", "fix", "docs"]);
  });

  it("does not extract rules from a document without requirements", () => {
    const prose = makeGuidelines("# Contributing\n\nThanks for reading. The changelog lives in releases.\n");
    expect(extractGuidelineRules(prose.docs, {})).toEqual([]);
  });

  it("extracts an explicit pull request size limit", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- Keep pull requests under 400 changed lines.\n",
    );
    const size = extractGuidelineRules(doc.docs, {}).find((spec) => spec.kind === "pr_size_limit");
    expect(size?.params?.maxChanges).toBe(400);
    expect(size?.title).toContain("400");
  });

  it("does not invent a size limit without a number", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- Keep pull requests small and focused.\n",
    );
    expect(extractGuidelineRules(doc.docs, {}).some((spec) => spec.kind === "pr_size_limit")).toBe(
      false,
    );
  });

  it("extracts a documented branch prefix", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- Name branches with the `feat/*` prefix.\n",
    );
    const branch = extractGuidelineRules(doc.docs, {}).find((spec) => spec.kind === "branch_naming");
    expect(branch?.params?.branchPrefix).toBe("feat/");
  });

  it("keeps branch naming with no usable prefix so it can be surfaced as unverifiable", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- Use a descriptive branch name and a descriptive title.\n",
    );
    const branch = extractGuidelineRules(doc.docs, {}).find((spec) => spec.kind === "branch_naming");
    expect(branch).toBeDefined();
    expect(branch?.params?.branchPrefix).toBeUndefined();
  });

  it("does not turn a passing mention of the changelog into a rule", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Release process\n\nThe changelog is generated from release notes.\n",
    );
    expect(
      extractGuidelineRules(doc.docs, {}).some((spec) => spec.kind === "changelog_updated"),
    ).toBe(false);
  });

  it("does not turn a commit-message convention into PR title or changelog rules", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- Commit messages must follow the commit message convention so that changelogs can be automatically generated.\n",
    );
    const kinds = extractGuidelineRules(doc.docs, {}).map((spec) => spec.kind as string);
    expect(kinds).not.toContain("conventional_title");
    expect(kinds).not.toContain("changelog_updated");
  });

  it("recognizes a title rule phrased with the PR after the convention name", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- PR titles must follow Conventional Commits (`feat:`, `fix:`).\n",
    );
    const title = extractGuidelineRules(doc.docs, {}).find(
      (spec) => spec.kind === "conventional_title",
    );
    expect(title).toBeDefined();
    expect(title?.params?.allowedPrefixes).toEqual(["feat", "fix"]);
  });

  it("recognizes a changeset requirement as a changelog requirement", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- Add a changeset for every user-facing change.\n",
    );
    expect(
      extractGuidelineRules(doc.docs, {}).some((spec) => spec.kind === "changelog_updated"),
    ).toBe(true);
  });
});

describe("extractTemplateRules", () => {
  const template = `## Summary

<!-- Describe the change and why it is needed. -->

## Checklist

- [ ] I have read the contributing guide
- [ ] I have added tests for my changes
`;
  const bundle = makeGuidelines(CONTRIBUTING, template);
  const specs = extractTemplateRules(bundle);

  it("creates a checklist rule and a description rule", () => {
    expect(specs.map((spec) => spec.kind)).toEqual(["template_checklist", "pr_description"]);
  });

  it("points the checklist rule at the template's checkbox lines", () => {
    const checklist = specs[0];
    expect(checklist?.source.path).toBe(".github/PULL_REQUEST_TEMPLATE.md");
    expect(checklist?.source.lineStart).toBeGreaterThan(0);
    expect(checklist?.source.excerpt).toContain("read the contributing guide");
  });

  it("returns nothing when there is no template", () => {
    expect(extractTemplateRules(makeGuidelines(CONTRIBUTING))).toEqual([]);
  });
});

describe("platformRuleSpecs", () => {
  it("always checks mergeability and adds CI when checks exist", () => {
    const specs = platformRuleSpecs(PLATFORM_CONTEXT);
    expect(specs.map((spec) => spec.kind)).toEqual(["merge_conflicts", "ci_green"]);
    expect(specs[1]?.source.url).toContain("/checks");
  });

  it("does not add a CI rule when no checks were reported", () => {
    const specs = platformRuleSpecs(PLATFORM_CONTEXT_NO_CI);
    expect(specs.map((spec) => spec.kind)).toEqual(["merge_conflicts"]);
  });

  it("does not duplicate a CI rule that already exists in the guidelines", () => {
    const bundle = makeGuidelines(
      "# Contributing\n\n## Pull request requirements\n\n- All checks must pass before review.\n",
    );
    const { deterministic } = buildRuleSpecs(bundle, PLATFORM_CONTEXT);
    const ciRules = deterministic.filter((spec) => spec.kind === "ci_green");
    expect(ciRules).toHaveLength(1);
    expect(ciRules[0]?.origin).toBe("guideline");
  });
});

describe("extractFreeformRules", () => {
  const bundle = makeGuidelines(CONTRIBUTING);
  const { deterministic } = buildRuleSpecs(bundle, PLATFORM_CONTEXT);
  const freeform = extractFreeformRules(bundle, deterministic);

  it("selects free-form sections that are not covered deterministically", () => {
    const titles = freeform.map((spec) => spec.title);
    expect(titles).toContain("Review process");
    expect(titles).toContain("Design notes");
    expect(titles).not.toContain("Pull request requirements");
    expect(titles).not.toContain("Local checks");
  });

  it("gives each free-form rule a stable id and a source range", () => {
    for (const spec of freeform) {
      expect(spec.kind).toBe("freeform");
      expect(spec.id).toMatch(/^freeform-/);
      expect(spec.source.path).toBe("CONTRIBUTING.md");
      expect(spec.source.lineStart).toBeGreaterThan(0);
      expect(spec.requirement.length).toBeGreaterThan(40);
    }
  });

  it("skips sections without requirement or imperative language", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Background\n\nThis section describes how the project started and who maintains it today.\n",
    );
    const rules = extractFreeformRules(doc, []);
    expect(rules.some((spec) => spec.title === "Background")).toBe(false);
  });

  it("skips excluded headings such as security and licensing", () => {
    const doc = makeGuidelines(
      "# Contributing\n\n## Security policy\n\nYou must report vulnerabilities privately to the maintainers and never open a public issue.\n",
    );
    expect(extractFreeformRules(doc, [])).toEqual([]);
  });

  it("caps the number of free-form rules", () => {
    const many = Array.from(
      { length: 9 },
      (_, index) =>
        `## Topic ${index}\n\nYou must follow the process described here and ensure your change is reviewed by a maintainer before merging.`,
    ).join("\n\n");
    const doc = makeGuidelines(`# Contributing\n\n${many}\n`);
    expect(extractFreeformRules(doc, []).length).toBeLessThanOrEqual(4);
  });
});