import { repoIssueTimeline, pullRequest } from "./lib/github.mjs";
import { closesSource } from "./lib/payouts.mjs";

const repoName = "MultiAgency/near-agencies";
const source = `${repoName}#167`;
const events = await repoIssueTimeline(repoName, 167);
let why = null;
for (const e of events.filter(e => e.event === "cross-referenced" && e.source?.issue?.pull_request)) {
  const pr = await pullRequest(e.source.issue.pull_request.html_url);
  if (!closesSource(pr, source)) {
    console.log(`cross-reference from ${pr.html_url} (state=${pr.state}, merged=${pr.merged}) does not close ${source}: holds nothing`);
    continue;
  }
  if (pr.state === "open") { why = `an open pull request (${pr.html_url}) already closes it`; break; }
  if (pr.merged) { why = `a merged pull request (${pr.html_url}) already settles it`; break; }
}
console.log(why ? `decide: ${source} would be skipped: ${why}` : `decide: ${source} is eligible (no referencing pull request closes it)`);
