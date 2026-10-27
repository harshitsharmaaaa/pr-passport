import { writeFileSync } from "node:fs";
import { analyzePullRequest } from "../src/lib/pipeline";

const SAMPLE_URL = "https://github.com/acme/widget-kit/pull/42";
const OUTPUT = new URL("../examples/sample-report.json", import.meta.url);

const report = await analyzePullRequest({ url: SAMPLE_URL, demo: true });
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
  `Wrote examples/sample-report.json (${report.summary.verdict}: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.needsReview} needs review)`,
);