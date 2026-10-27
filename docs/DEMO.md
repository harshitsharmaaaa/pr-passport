# PR Passport demo runbook

A reproducible 1–3 minute walkthrough that shows what PR Passport does, using
bundled fixtures only. Once dependencies are installed, the demo needs no GitHub
token, no inference credentials, and no network access.

The demo answers one question: **can a pull request be checked against the
repository's own contribution rules, with evidence, without inventing
results?** It shows a hard failure, a human-review item, the difference between
deterministic and recorded findings, and the remediation brief handed to Alan.

## What is real and what is a fixture

| Element | Source in demo mode |
| --- | --- |
| URL parsing, rule extraction, deterministic checks, report assembly, remediation brief | Real code paths, identical to a live run |
| Pull request, changed files, commits, CI results, `CONTRIBUTING.md`, PR template, `package.json` | Bundled fixtures in `src/lib/demo/fixtures.ts` |
| The two free-form findings ("Design notes", "Review process") | A recorded sample response replayed through the real schema and evidence validation (`src/lib/demo/recorded.ts`) |
| GitHub API calls | None |
| Model calls | None |

Demo mode is disclosed in four places: the amber **Demo data** badge in the
report header, the banner above the report ("Repository, pull request and CI
data come from bundled fixtures, not GitHub. Model findings are a recorded
sample; no inference endpoint was called."), the first entry under
**Limitations**, and the remediation brief (`Report mode: demo (bundled
fixtures)`).

## Prerequisites

- Bun 1.4+ (the Docker image uses the same runtime).
- No `.env.local` is needed. Do not set `DEMO_MODE` for this flow: the demo
  buttons pass the flag per request, which is what makes the demo badge appear.

```sh
bun install
bun run dev
```

Open <http://localhost:3000>.

## The 3-minute script

Total time is about 90 seconds of clicking plus talking. Every observation below
is produced by the current fixtures; the numbers are asserted by
`src/lib/demo/fixtures.test.ts`, so if a number changes, the test fails.

### 0:00 — Frame the problem (15s)

Say: "A pull request can be perfectly good code and still break a repository's
own rules — missing DCO sign-off, no test for a behaviour change, an unchecked
template. Reviewers discover that by hand, after the fact."

### 0:15 — Load the failing sample (15s)

Click **Sample: failing PR** under "Try a fixture".

What the audience sees:

1. The URL field fills with `https://github.com/acme/widget-kit/pull/42`.
2. A **demo mode** pill appears next to the fixture buttons.
3. A status panel appears immediately: "Reading the pull request, guidelines,
   and checks…" with a progress bar. It resolves as soon as the request
   completes because no network call is made; on a cold `next dev` server the
   first request can take a few seconds while Next compiles the route, which is
   compilation, not analysis.

Point out that this is the same status state a live analysis shows. If it
flashes past, throttle the browser network in DevTools to see it; do not add an
artificial delay to the app.

### 0:30 — Read the verdict and the demo disclosure (20s)

What the audience sees:

- Amber banner: **Demo report.** "Repository, pull request and CI data come
  from bundled fixtures, not GitHub. Model findings are a recorded sample; no
  inference endpoint was called."
- **Demo data** badge next to the repository name.
- Verdict stamp **FAIL**, with `3 pass · 7 fail · 2 review`.
- Headline: "7 requirements failed. Fix them before requesting review."
- Header stats: 15 changed files, +1204 / −152, 2 commits, 1 guideline file.

Say: "The disclosure is part of the product, not the slide deck. Nothing here
claims to be a live GitHub result."

### 0:50 — A concrete failure with a rule source and evidence (30s)

Scroll to **Failed requirements** and open the first card, **Developer
Certificate of Origin sign-off**.

What the audience sees:

- Status pill **FAIL** and origin pill **Deterministic check**.
- The requirement text taken from the repository: "Sign every commit off with
  `git commit -s`; each commit needs a `Signed-off-by:` trailer certifying the
  Developer Certificate of Origin (DCO)."
- **Rule source**: `CONTRIBUTING.md:7`, with the quoted sentence and an **Open
  file** link.
- **Evidence**: `Commit 3d2b1a0` and `Commit 8f3c1d9`, each with a commit link.
- **Suggested action**: update the pull request and re-run PR Passport.

Say: "Every failed finding carries the rule that requires it and the fact from
this pull request that decided it. No rule is invented, and no missing data is
treated as a pass."

If you want a second deterministic example, the **Required checks pass** card
shows the CI rule with `unit tests (ubuntu-latest)` as failing evidence, and the
**Tests for behaviour changes** card cites five changed source files (from the
15 changed files) with no test file among them.

### 1:20 — A separate human-review item (20s)

Scroll to **Needs human review** (2 items: **Changelog entry**,
**Documentation updates**).

What the audience sees:

- Status pill **NEEDS REVIEW**, origin **Deterministic check**.
- The requirement is conditional: "Add a changelog entry under `## Unreleased`
  in `CHANGELOG.md` for user-facing changes" / "Update the documentation in
  `docs/` when a public API changes."
- The rationale says the guideline is conditional, so it was surfaced for human
  review rather than treated as a hard failure.

Say: "The code refuses to turn an ambiguous guideline into a hard failure. It
says what a human has to decide, and the remediation brief repeats that as an
action item rather than a fix."

### 1:40 — Deterministic versus recorded findings (20s)

Scroll back up to the two cards tagged **Recorded sample** — "Review process"
and "Design notes".

What the audience sees:

- Origin pill **Recorded sample** with a confidence percentage (90% and 82%).
- Same rule-source block (`CONTRIBUTING.md:18`, `CONTRIBUTING.md:14`) and the
  same evidence layout as deterministic findings.
- In the right column, the **Model** card reads **Recorded demo sample**,
  `recorded:qwen2.5-coder-32b-instruct`, 0 rejected, with the note about what
  the recorded run could see.

Say: "Two different engines. Deterministic rules are mechanical. Free-form
guidance is interpreted by a model, and in this demo the model output is
recorded, not generated live. Both go through the same schema and evidence
validation, and both are labelled with their origin, so the audience is never
left guessing which is which."

### 2:00 — The Alan-ready remediation brief (30s)

Scroll to **Alan-ready remediation brief**.

What the audience sees, in order:

1. `## Pull request` — title, URL, author, branch, `Report mode: demo (bundled
   fixtures)`, and the diff totals.
2. `## Definition of done` — seven `Fix:` checkboxes plus two `A human
   confirms:` checkboxes.
3. `## Failed requirements` — for each: requirement, rule source with line and
   quoted excerpt, why it failed, evidence, suggested action, files to inspect.
4. `## Needs human review` — the two conditional items, with "Do not guess and
   do not mark it resolved."
5. `## Suggested files to inspect` — `CONTRIBUTING.md`, the PR template, and the
   five cited source files.
6. `## Validation commands` — `bun install`, `bun run lint`, `bun run test`,
   `bun run typecheck`, `bun run build`, each with the repository file it came
   from.
7. `## Constraints` — no merging, no pushing, no invented rules, no claiming an
   unrun check passed.
8. `## Known limitations of this report` — the demo disclosure again.

Say: "This is the handoff. It is generated from the report only, contains no
credentials, and forbids the agent from inventing rules or results."

### 2:30 — Hand off to Alan and validate

1. Click **Copy** (or **Download .md**).
2. In Alan, create a task and paste the brief as the instructions.
3. Read the brief's own constraint: if the agent cannot write to the
   contributor's branch, it must prepare a patch and instructions instead of
   pushing.
4. Because `acme/widget-kit` is a fixture and does not exist, do **not** ask
   Alan to push a fix to it. In this demo the handoff shows the task boundary:
   the brief is bounded, sourced, and forbidden from inventing rules or
   claiming an unrun check passed.
5. Validation is the brief's own command list, run from the PR Passport
   repository root:

```sh
bun install
bun run lint
bun run test
bun run typecheck
bun run build
```

6. Re-run the failing sample. It still returns **FAIL** with the same 3 / 7 / 2
   counts. That is the honest result: the fixture is immutable, so the demo
   proves the report is reproducible, not that the fictional pull request was
   fixed.

Point out that the validation commands were derived from `package.json` and the
`CONTRIBUTING.md` code fence, not invented by the model. In a live run the same
brief goes to the contributor's real branch, and the re-run reflects the new
commits. PR Passport itself never writes to GitHub.

### 3:00 — Optional control: the clean sample (20s)

Click **Sample: clean PR**.

What the audience sees: verdict **PASS**, `12 pass · 0 fail · 0 review`, the
same demo disclosure, and a remediation brief whose **Failed requirements**
section says "None. Do not invent work to fill this section."

Say: "The demo is not tuned to fail. The clean sample passes because every
evaluated requirement passed, and the brief refuses to manufacture work."

## Reproducing the checked-in sample

`examples/sample-report.json` is generated from the failing fixture, not
hand-written. Regenerate and verify it with:

```sh
bun run demo:sample   # rewrite examples/sample-report.json from the fixture
bun run demo:check    # fixture consistency + offline + sample-report drift tests
bun run verify        # typecheck, lint, full test suite
```

`src/lib/demo/fixtures.test.ts` asserts, among other things:

- PR totals, changed-file counts, and commit counts match the fixture lists, and
  the head commit is the last commit;
- CI totals equal passing + failing + pending, and check URLs belong to the PR;
- every bundled repository file appears in the repository listing with a real
  byte size, and `package.json` matches the parsed manifest;
- every free-form rule the pipeline will ask about has exactly one recorded
  finding, and every recorded evidence reference resolves;
- every quoted guideline excerpt actually appears in the bundled file;
- the report contains a hard failure, a human-review item, and a recorded
  finding, and the summary counts match the findings list;
- the analysis makes zero `fetch` calls and works with no credentials in the
  environment;
- a fresh run of the failing fixture equals `examples/sample-report.json`
  (ignoring `generatedAt` and `timings`).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Demo mode only has fixtures for the sample pull requests." | You typed a URL instead of clicking a sample button, or `demo` was not sent. Use the buttons, or turn demo mode off for a real URL. |
| The amber demo banner is missing | `DEMO_MODE=on` in `.env.local` forces demo data for every request, but the per-request flag is what the buttons set. Remove `DEMO_MODE` and click a sample. |
| Numbers differ from this runbook | Run `bun run demo:check`. A fixture or recorded finding changed without updating the sample report; regenerate with `bun run demo:sample`. |
| The report shows "Not evaluated" free-form rules | The recorded interpreter was not used (for example `interpreter: null` in a custom run). The demo buttons always use the recorded run. |

## What this demo does not claim

- It does not call GitHub, and it does not call a model.
- It does not claim the fixture repository (`acme/widget-kit`) exists.
- It does not claim the recorded findings were produced live for this run.
- It does not merge, push, or execute repository code.
