# Alan workflow example: PR Passport gate + remediation

This is an example Alan workflow that uses PR Passport as the compliance gate
for every pull request in a repository, then hands the remediation brief to an
Alan task when something fails. It is illustrative — adapt the triggers and
steps to your Alan workspace.

## What it does

1. **Watch** — a GitHub trigger fires when a pull request is opened or updated
   on a repository PR Passport monitors.
2. **Analyze** — the workflow calls the PR Passport API and stores the report.
3. **Decide** — branch on `report.summary.verdict`:
   - `pass` → label the PR `pr-passport: pass` and stop.
   - `needs_review` → label `pr-passport: review` and comment the findings that
     need a human decision.
   - `fail` → label `pr-passport: fail`, comment a short summary, and start a
     remediation task.
4. **Remediate** — the remediation task receives `report.remediationPrompt` as
   its instructions. The brief already contains the failed requirements, rule
   sources, evidence, files to inspect, validation commands, and constraints,
   so the task needs no extra context.

## Workflow sketch

```json
{
  "name": "PR Passport gate",
  "triggers": [
    {
      "type": "github.pull_request",
      "events": ["opened", "synchronize"],
      "repository": "your-org/your-repo"
    }
  ],
  "steps": [
    {
      "id": "analyze",
      "type": "http.request",
      "method": "POST",
      "url": "${env.PR_PASSPORT_URL}/api/analyze",
      "headers": { "Content-Type": "application/json" },
      "body": {
        "url": "${trigger.pull_request.html_url}"
      }
    },
    {
      "id": "branch",
      "type": "switch",
      "on": "${steps.analyze.report.summary.verdict}"
    },
    {
      "id": "remediate",
      "type": "alan.task",
      "when": "${steps.branch.value == 'fail'}",
      "title": "Fix PR Passport findings: ${trigger.pull_request.title}",
      "instructions": "${steps.analyze.report.remediationPrompt}",
      "constraints": [
        "Work on the contributor's branch only",
        "Do not merge, push to the base branch, or execute repository code",
        "Re-run PR Passport after pushing and report the new verdict"
      ]
    }
  ]
}
```

## Why the brief works as task instructions

The remediation brief is written to be pasted into an agent verbatim:

- every failed requirement includes the **rule source** (`CONTRIBUTING.md:42`)
  and the **evidence** (commit shas, changed files, description excerpts);
- validation commands are derived from the repository's own files
  (`package.json` scripts, guideline code fences) or explicitly absent;
- the **Constraints** section forbids inventing rules, claiming unrun checks,
  merging, and pushing to someone else's branch;
- the **Known limitations** section is included so the agent does not treat
  missing data as a pass.

## Operating notes

- Set `PR_PASSPORT_URL` to a deployment that can reach the GitHub API; a
  `GITHUB_TOKEN` there raises the rate limit above 60 requests/hour.
- Keep `demo: false` (the default) for real analyses; the demo flag exists for
  showcasing without credentials.
- If the report has `summary.verdict: "needs_review"`, resist the urge to
  auto-resolve those findings — that is exactly what PR Passport declines to
  decide for you.
