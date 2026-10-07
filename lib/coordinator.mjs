// MultiAgency coordinator, run by the agency bot next to the demo server:
//
//   promote  a blocked seat becomes ready once every seat it depends on closes
//   claim    the first valid `/claim` comment on a ready seat wins: the bot
//            assigns the claimant, swaps ready -> in-progress, and names the
//            roster account the payout will go to; invalid claims get a reason,
//            and so do claims beaten to the win or made on a seat already taken
//            a native GitHub assignment on a ready seat is a claim too: same
//            eligibility checks, the first eligible assignee wins, and every
//            other assignee is unassigned with a refused-claim reason
//   release  a claim returns to ready when CLAIM_TTL_HOURS pass from its
//            "Claimed by" record or the latest change request, with no handoff
//            that passes the checks since (#166)
//   close    a seat closes once its claimant's handoff (the latest since any
//            change request) passes the checks payouts make; a failing or
//            unreadable one is answered once with the reason, and editing it
//            asks again. Contributors need no write access. A revision's close
//            is announced to its reviewer on the review seat
//   tidy     a closed seat loses `ready`, `blocked` and `in-progress`: seat labels describe open work
//   guard    writes only the bot or an owner may make are guarded: a gate
//            label (`agent-eligible`, `human-only`) a stranger set or removed
//            is put back the way it was, and a task or job epic a stranger
//            closed is reopened, each with a comment naming them; claims and
//            GitHub assignments made while a gate label stands as a stranger
//            set it are refused
//   join     a join request posted on the board (lib/onboarding.mjs) is
//            verified against its author and the chain and labelled
//            roster-verified or refused. An owner's `/admit` on a verified
//            request checks it again, pays the account's USDC registration if
//            it has none (REGISTRAR_ACCOUNT), and adds the member at once
//            (lib/roster.mjs); the request is then answered and closed. With
//            REGISTRY_URL and REGISTRY_TOKEN set, the verified member is also
//            written to the shared member registry — a refused or failed
//            write is reported on the request, the admission stays local. A
//            member's request that keeps their account, kind and operator
//            only updates what they declare (name, skills) and applies at once
//   settle   a closed engagement epic — completed, or cancelled without
//            completion — drops its `blocked` label, and its `## Team`
//            checklist ticks each seat that closed with a handoff
//   approve  an owner's `/approve` on a job without a team takes a team
//            draft, checks it (lib/team.mjs) and creates the tasks; anyone
//            else's command, or a draft that fails the checks, is answered
//            with the reason. Bare, it takes the latest ```team-draft the
//            bot or an owner posted before it (a stranger's is skipped, not
//            refused); with a link to a comment — however written — that
//            exact draft, which must sit on this job, unedited since the
//            command — and a stranger's unedited since it was posted, since
//            an edit could postdate the owner's read. Owners have
//            admin or maintain permission on the board
//   pay      once every task of a job has closed with a handoff that passes
//            the payout checks, file one DAO Transfer proposal per task as
//            PROPOSER_ACCOUNT (a key that can only add proposals), reusing any
//            already on chain; a task more than one live proposal pays is
//            flagged once, for the extras' rejection, and the job's approval
//            page refuses to approve while they stand; record each payment an
//            approver votes through, and close the job when all are paid. A
//            job that fails the checks is answered once with the reason. Every
//            PAYOUT_SWEEP_MS
//   changes  when the reviewer of an open seat posts "Changes requested…" on
//            that seat or on a seat it depends on, the reviewed seat reopens
//            with a ```changes block its worker picks up, and its claimant
//            re-delivers. With TYPESAFE_API_KEY set, each reviewer comment is
//            also judged by Jev in shadow (lib/judge.mjs), for comparison only
//   job      an issue carrying a ```job-request block opens a job with no
//            deposit, when its author may: an owner, or an active member of
//            team internal — but never an agent, whoever they are (the
//            roster's kind, and the board's own bot by name, only ever
//            refuse). The bot opens the job itself, through lib/epic.mjs, so
//            its ```engagement block is bot-authored; its tasks can only be
//            volunteer work. Anything else — another author, a malformed
//            block, a repository the intake does not accept — is answered
//            once with the reason and closed as not planned
//   auto     an issue in a registry repository (agents/claude-worker/repos.mjs)
//            carrying `ready-for-agent` opens a job by itself, when the label
//            was applied by an owner or an active member of team internal —
//            the same rule a ```job-request author passes, judged from the
//            issue's own label events. An issue a pull request already
//            addresses opens nothing: its timeline names a cross-referencing
//            pull request, whoever opened it, whose body closes the issue
//            (closesSource, lib/payouts.mjs) and that stands open or has
//            already merged; a pull request that merely mentions the issue
//            holds nothing. The job assembles its fixed one-task team at once
//            (volunteer, agent-eligible, the issue's repo), and the task
//            closes when the claimant's pull request merges, closeIfPaid
//            completing the job. When the source issue closes another way —
//            someone else's pull request merged first, or a hand close — and
//            the task stands undelivered, the sweep supersedes the job by
//            itself: the task is told once, the task and the job close as not
//            planned, and the claimant's own open pull request hears the same,
//            its close left to its author or an owner. At most AUTO_JOBS_MAX
//            auto jobs stand open, the oldest labelled issue first. An auto
//            job has no review seat to route a change request, so when
//            ai-review's ledger on the task's pull request still holds an
//            Important open at the delivered head, the sweep reopens the task
//            itself with the ```changes block its worker revises on — at
//            most three ai-review rounds, then a person decides (#116). An
//            owner's or a team internal member's "Changes requested" comment
//            on the task, after its handoff, is routed the same way, and
//            never counts toward the three (#165).
//            Every AUTO_JOBS_SWEEP_MS
//
// Claims are marked processed with a reaction from the bot, so each comment is
// answered once however often the coordinator runs.
import { botLogin, comment, epicIssues, fence, fenced, github, isOwner, isTrusted, issue, issueLastEditedAt, me, orgTeamMember, pullRequest, pullRepo, repoComment, repoComments, repoIssue, repoIssueTimeline, repoIssues, repoRemoveLabel } from "./github.mjs";
import { loadEngagement, settleEpic } from "./engagement-state.mjs";
import { judgeHealth, shadowJudge } from "./judge.mjs";
import { closeIfPaid, closesSource, deliveredProblem, flagDuplicateProposals, payoutAuditCapped, payoutProblem, proposePayouts, recordApprovals } from "./payouts.mjs";
import { ADMITTED_PREFIX, ensureUsdcRegistration, joinRequest, verifyJoinRequest } from "./onboarding.mjs";
import { admit, byGithub, isProfileUpdate, putMember } from "./roster.mjs";
import { auditClosedEpics, closeVerified, labelGateProblem, restoreGateLabels } from "./guard.mjs";
import { comments, dependencyProblem, eligibility, handoffProblem, isClaim, openSeats, selfReviewProblem, swapLabel, unreadableHandoff } from "./seats.mjs";
import { LEDGER_MARK, ledgerOf, openImportants } from "./ledger.mjs";
import { freshCode, invalidBrief } from "./engagements.mjs";
import { createEpic } from "./epic.mjs";
import { assembleTeam, isVolunteer, teamProblem } from "./team.mjs";
import { REPOS } from "../agents/claude-worker/repos.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://demo.multiagency.ai";
const CLAIM_TTL_MS = Number(process.env.CLAIM_TTL_HOURS ?? "24") * 3600_000;
const INTERVAL_MS = 20_000;
const STALE_CYCLES = 6;
const STUCK_MS = 10 * 60_000;
// Paying reads every task of a job and the chain, so it runs less often than a
// cycle; the gap also lets a proposal whose reply was lost land before the
// next sweep looks for it on chain.
const PAYOUT_SWEEP_MS = 2 * 60_000;
// The guard sweep (gate labels, job epics closed by hand) runs at this pace,
// not every cycle: it reads each open seat's events, which would multiply the
// cycle's read budget otherwise. A stranger's gate-label change is caught at
// claim time regardless (labelGateProblem), so the sweep only has to restore
// what nobody is claiming against.
const GUARD_SWEEP_MS = Number(process.env.GUARD_SWEEP_MS ?? "120000");
// The first guard sweep after a (re)start looks back this far for job epics
// closed in the gap, then only at what changed since the last sweep.
const EPIC_AUDIT_LOOKBACK_MS = 24 * 3600_000;
// The auto-job sweep (registry issues labelled `ready-for-agent`) runs at its
// own pace, not every cycle: it reads each labelled issue's timeline, and a
// burst of labels must not multiply that into every cycle. Its cap keeps a
// burst from flooding the board with jobs nobody is working yet.
const AUTO_JOBS_SWEEP_MS = Number(process.env.AUTO_JOBS_SWEEP_MS ?? "120000");
// A typo'd cap must not take the cap off: not a positive number reads as the
// owner's default (the way idleAfterMs reads IDLE_AFTER_HOURS).
const AUTO_JOBS_MAX = (() => {
  const cap = Number(process.env.AUTO_JOBS_MAX ?? "2");
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 2;
})();

export function startCoordinator() {
  health.started_at = new Date().toISOString();
  setInterval(() => cycle(), INTERVAL_MS);
  // Self-healing: a cycle stuck past STUCK_MS exits the process, and the host's
  // restart-on-failure policy (Railway: ON_FAILURE) brings it back. Cycles that
  // fail quickly (GitHub down, a bad token) do not: a restart cannot fix those,
  // and restarting in a loop would take the site down. /api/health reports them.
  setInterval(() => {
    if (!coordinatorStuck()) return;
    console.error(`coordinator: a cycle has been running since ${health.cycle_started_at}; exiting so the host restarts it`);
    process.exit(1);
  }, INTERVAL_MS);
}

// One cycle at a time: a second would repeat the first one's comments. Every
// request a cycle makes is time-bounded, so a cycle always ends.
const health = { started_at: null, cycles: 0, cycle_started_at: null, last_completed_at: null, last_error: null };
let running = false;

// Tasks the treasury approved a payment for more than once, reported by
// /api/health: recovering the extra transfer needs a person, so an entry
// stays for the process's life and the sweep finds it again after a restart.
const paidTwice = new Map();
function markPaidTwice(jobNumber, { issue, proposals }) {
  const key = `${jobNumber}#${issue}`;
  if (!paidTwice.has(key)) paidTwice.set(key, { job: jobNumber, task: issue, proposals, at: new Date().toISOString() });
}

export const coordinatorHealth = () => ({ ...health, running, interval_ms: INTERVAL_MS, judge: judgeHealth(), paid_twice: [...paidTwice.values()], payout_audit_capped: payoutAuditCapped(), auto_jobs: autoJobsHealth() });

/** A cycle that has not finished after STUCK_MS is stuck; every request in it is time-bounded. */
export const coordinatorStuck = (now = Date.now()) => running && now - Date.parse(health.cycle_started_at) > STUCK_MS;

/** Stale after six cycles without success, counted from start until the first one completes. */
export const coordinatorStale = (now = Date.now()) =>
  now - Date.parse(health.last_completed_at ?? health.started_at ?? new Date(now).toISOString()) > STALE_CYCLES * INTERVAL_MS;

export async function cycle(run = async () => coordinate(await me())) {
  if (running) return false;
  running = true;
  health.cycle_started_at = new Date().toISOString();
  try {
    await run();
    health.cycles += 1;
    health.last_completed_at = new Date().toISOString();
  } catch (error) {
    health.last_error = { at: new Date().toISOString(), message: error.message };
    console.error(`coordinator: ${error.message}`);
  } finally {
    running = false;
  }
  return true;
}

async function coordinate(bot) {
  const seats = await openSeats();
  await guardBoard(seats);
  for (const seat of seats) {
    if (seat.labels.includes("blocked") && seat.assignees.length === 0) await promote(seat);
    else if (seat.labels.includes("ready")) {
      if (seat.assignees.length === 0) await settleClaims(seat, bot);
      else await settleAssignments(seat);
    }
    else if (seat.labels.includes("in-progress")) {
      // A taken seat refuses its pending claims; with no assignee the seat is
      // mid-release (or stuck), and its claims wait until it is ready again.
      if (seat.assignees.length) await settleClaims(seat, bot);
      await routeChangeRequests(seat, bot);
      if (await closeIfHandedOff(seat, bot)) continue;
      await releaseIfStale(seat);
    }
  }
  await approveTeams(bot);
  await settlePayouts(bot);
  await clearClosedSeats();
  const open = await github("GET", "/issues?state=open&per_page=100");
  await settleJoinRequests(bot, open);
  await settleJobRequests(bot, open);
  await settleAutoJobs();
  await settleAutoJobRounds();
  await settleAutoChangeRequests();
  await settleClosedEpics();
}

// The board writes only the bot or an owner may make, guarded: gate labels a
// stranger set are restored, and job epics a stranger closed are reopened.
// Runs at its own pace (GUARD_SWEEP_MS): restoring a gate label races /claim,
// but the claim path checks the label's latest labeled event itself, so the
// sweep only backs the claim path up.
let guardedAt = 0;
let epicsAuditedSince = null;
async function guardBoard(seats) {
  if (Date.now() - guardedAt < GUARD_SWEEP_MS) return;
  guardedAt = Date.now();
  for (const seat of seats) await restoreGateLabels(seat);
  const since = epicsAuditedSince ?? new Date(Date.now() - EPIC_AUDIT_LOOKBACK_MS).toISOString();
  const startedAt = new Date().toISOString();
  await auditClosedEpics(since);
  // The watermark moves only once the audit has run: a failed pass leaves it,
  // so the epics of its window are audited again instead of skipped.
  epicsAuditedSince = startedAt;
}

// `blocked` on an epic means waiting on seats, so it cannot outlive the epic
// itself. The sweep settles any closed epic that still wears the label —
// cancelled by hand, or closed before settling existed, included.
async function settleClosedEpics() {
  const closed = await github("GET", "/issues?labels=engagement,blocked&state=closed&per_page=100");
  for (const epic of closed.filter(i => !i.pull_request)) {
    // Settle only a close the bot or an owner made: a stranger's reopens
    // untouched (closeVerified), and the epic waits to close properly.
    if (!await closeVerified(epic.number, epic.closed_at, "job")) continue;
    const patch = await settleEpic(epic.number);
    if (patch) console.log(`coordinator: #${epic.number} settled (${Object.keys(patch).join(", ")})`);
  }
}

// The change requests the coordinator routed onto a seat. Anyone can comment,
// so a ```changes block from anyone else is ignored.
export async function routedRequests(thread) {
  const routed = [];
  for (const c of thread) if (fenced(c.body, "changes") && await isTrusted(c.user.login)) routed.push(c);
  return routed;
}

/**
 * The claimant's latest handoff since the last round, readable or not, unless
 * the coordinator has answered it as it stands: its reply links the handoff,
 * and editing the handoff after the reply asks again.
 */
export function pendingHandoff(thread, claimants, since, bot) {
  const latest = thread.slice(since + 1).findLast(c =>
    claimants.includes(c.user.login) && (fenced(c.body, "handoff") || unreadableHandoff(c.body)));
  if (!latest) return null;
  const answered = thread.some(c => c.user.login === bot && c.body.includes(latest.html_url) && c.created_at >= latest.updated_at);
  return answered ? null : latest;
}

export async function closeIfHandedOff(seat, bot) {
  const thread = await comments(seat.number);
  const requests = await routedRequests(thread);
  const since = requests.length ? thread.indexOf(requests.at(-1)) : -1;
  const handoff = pendingHandoff(thread, seat.assignees, since, bot);
  if (!handoff) return false;
  const block = fenced(handoff.body, "handoff");
  const problem = block ? await handoffProblem(block, byGithub(handoff.user.login)) : unreadableHandoff(handoff.body);
  if (problem) {
    const login = handoff.user.login;
    await comment(seat.number, `@${login}, [this handoff](${handoff.html_url}) can't close the task: ${problem}. Edit it, or post a corrected one; ${SITE_URL}/#/status/${login} prepares one that passes.`);
    return false;
  }
  // An auto job's task closes when its pull request merges (settleAutoJobs),
  // never on the handoff alone: the issue stays open until then, and so does
  // the seat building it. Its handoff is still answered when it cannot be
  // read, exactly as any other seat's is.
  if (seat.terms?.source) return false;
  await react(handoff, "+1");
  await github("PATCH", `/issues/${seat.number}`, { state: "closed", state_reason: "completed" });
  console.log(`coordinator: #${seat.number} closed on @${handoff.user.login}'s handoff`);
  if (requests.length) await announceRevision(seat, requests, handoff);
  return true;
}

// A revision closes a reopened seat; the reviewer who asked for it hears so on
// the review seat, whatever tooling the contributor uses.
async function announceRevision(seat, requests, handoff) {
  const { review, body } = revisionNotice(seat.number, requests, handoff);
  await comment(review, body);
}

/** The review seat to tell, and what to tell it, when revision N of a seat closes. */
export function revisionNotice(number, thread, handoff) {
  const requests = thread.filter(c => fenced(c.body, "changes"));
  const { review, requested_by } = fenced(requests.at(-1).body, "changes");
  const work = fenced(handoff.body, "handoff").deliverable?.url ?? handoff.html_url;
  return { review, body: `@${requested_by}, round ${requests.length + 1} of #${number} is in: ${work}. It passed the handoff checks: sign it off here, or ask for another round.` };
}

async function clearClosedSeats() {
  for (const label of ["in-progress", "ready", "blocked"]) {
    const closed = await github("GET", `/issues?state=closed&labels=${label}&per_page=100`);
    for (const seat of closed.filter(i => !i.pull_request && fenced(i.body, "terms"))) {
      await github("DELETE", `/issues/${seat.number}/labels/${label}`);
      console.log(`coordinator: #${seat.number} closed, ${label} cleared`);
    }
  }
}

async function settleJoinRequests(bot, open) {
  for (const request of (open ?? await github("GET", "/issues?state=open&per_page=100")).filter(i => !i.pull_request && joinRequest(i.body))) {
    const author = request.user.login;
    const labels = request.labels.map(label => label.name);
    if (labels.includes("roster-verified")) {
      await admitOnRequest(request, bot);
      // Live means the deployed roster holds this request, not just the login:
      // a re-registration already has an entry before the owner's change lands.
      const listed = byGithub(author);
      if (listed?.proof !== request.html_url) continue;
      await comment(request.number, `@${author} is on the MultiAgency roster, paid to \`${listed.nearAccount}\`. The tasks you can claim now, and what to do next: ${SITE_URL}/#/status/${author}`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "completed" });
      console.log(`coordinator: join #${request.number} completed for ${author}`);
      continue;
    }
    // Age is judged at posting time, so the verdict does not depend on when it runs.
    const { builder, refusal } = await verifyJoinRequest(joinRequest(request.body), { author, now: new Date(request.created_at), issue: request.number });
    if (refusal) {
      await comment(request.number, `This join request can't be accepted: ${refusal}. Sign a new one at the demo's Join page or with \`node roster.mjs join\`, and open a new issue.`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "not_planned" });
      console.log(`coordinator: join #${request.number} refused: ${refusal}`);
      continue;
    }
    await github("POST", `/issues/${request.number}/labels`, { labels: ["roster-verified"] });
    if (isProfileUpdate(byGithub(author), builder)) {
      const admitted = admit({ ...builder, proof: request.html_url });
      const registry = await writeAdmittedMember(builder, request, admitted.admittedAt);
      await comment(request.number, `@${author}'s roster entry is updated: ${builder.name}, ${builder.skills.join(", ")}. Same account and kind, so no owner approval is needed.${registryNote(request, registry)} What's next: ${SITE_URL}/#/status/${author}`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "completed" });
      console.log(`coordinator: join #${request.number} updated ${author}'s entry`);
      continue;
    }
    await comment(request.number, `Verified: the signature is from a key that controls the NEAR account, and @${author} posted it. A MultiAgency owner admits it by commenting \`/admit\` here; this issue then closes.`);
    console.log(`coordinator: join #${request.number} verified for ${author}`);
  }
}

export const isAdmission = comment => /^\/admit\b/i.test(comment.body.trim());

/**
 * The shared registry learns every admission the board verified — an owner's
 * /admit, and a member's own verified profile update — so every environment
 * sees the same members. A no-op without REGISTRY_URL and REGISTRY_TOKEN. The
 * admission already stands on this board's roster, so a refused or failed
 * write loses nothing: it is reported here, with the registry's own message,
 * and /api/health carries it (putMember retries 5xx first). scripts/
 * registry-backfill.mjs is the repair path for a write that never landed.
 */
async function writeAdmittedMember(builder, request, admittedAt) {
  // One admission, one stamp: the registry write carries the admittedAt the
  // board's own store recorded (admit() returns the record it stamped), so
  // the two copies — and the backfill, and the registry-read merge — agree.
  return putMember(builder, { proof: request.html_url, admittedAt });
}

/** What the join issue hears about the registry write: nothing unless it failed. */
function registryNote(request, registry) {
  return registry?.problem ? ` The shared registry did not take the write: ${registry.problem}. @${request.user.login} is on this board's roster all the same; an owner can write the registry again with \`scripts/registry-backfill.mjs\`.` : "";
}

async function admitOnRequest(request, bot) {
  for (const command of (await comments(request.number)).filter(isAdmission)) {
    if (await answered(command, bot)) continue;
    const owner = command.user.login;
    const { builder, refusal } = !(await isOwner(owner)) ? { refusal: "only a MultiAgency owner can admit a member" }
      // Judged at posting time, as when it was verified.
      : await verifyJoinRequest(joinRequest(request.body), { author: request.user.login, now: new Date(request.created_at), issue: request.number });
    if (refusal) {
      await react(command, "-1");
      await comment(request.number, `@${owner}, not admitted: ${refusal}.`);
      continue;
    }
    // Registration first: if it fails, the command stays unanswered and the next cycle retries it.
    const usdc = await ensureUsdcRegistration(builder.nearAccount);
    const admitted = admit({ ...builder, proof: request.html_url });
    const registry = await writeAdmittedMember(builder, request, admitted.admittedAt);
    await react(command, "+1");
    const note = usdc.registered ? ` MultiAgency registered \`${builder.nearAccount}\` for testnet USDC, so payouts can reach it.` : usdc.problem ? ` Before a payout: ${usdc.problem}.` : "";
    await comment(request.number, `${ADMITTED_PREFIX} by @${owner}.${note}${registryNote(request, registry)}`);
    console.log(`coordinator: join #${request.number} admitted by ${owner}${usdc.registered ? " (USDC registered)" : ""}`);
    return;
  }
}

export const isChangeRequest = c => /^\**changes requested/i.test(c.body.trim()) && !fenced(c.body, "changes");

// --- jobs opened from the board ----------------------------------------------

// A board issue whose body carries this block asks for a job with no deposit;
// only who may ask differs from Hire. Recognized by the fence itself, the way
// a ```team-draft comment is: fenced() reads what it holds.
export const isJobRequest = body => Boolean(body?.includes("```job-request\n"));

// The team that gates the board path: its active members may open a job with
// no deposit. Agents sit in no team (owner decision, 2026-10-05): the
// roster's kind refuses, and the board's own bot by name — neither grants.
const INTERNAL_TEAM = "internal";

/**
 * Why @login may not open a job from the board, or null. Only people open
 * jobs, so the agent checks come first and refuse whoever they catch: a
 * roster record of kind "agent", and the board's own bot by name. The grant
 * is then an owner's, or team internal's. A team read that fails for any
 * other reason than GitHub's own 404 fails closed: only owners pass the
 * grant, and the reason says so on the request.
 */
export async function jobRequestRefusal(author) {
  if (byGithub(author)?.kind === "agent") return `@${author} is on the roster as an agent, and only people open jobs`;
  if (author === await botLogin()) return `@${author} is MultiAgency's own agent, and only people open jobs`;
  if (await isOwner(author)) return null;
  const internal = await orgTeamMember(INTERNAL_TEAM, author).then(
    member => ({ member }),
    error => ({ problem: error.message }),
  );
  if (internal.member) return null;
  if (internal.problem) return `team ${INTERNAL_TEAM} could not be read, so only owners can open a job (${shortReason(internal.problem)})`;
  return `only a MultiAgency owner or an active member of team ${INTERNAL_TEAM} can open a job`;
}

// A GitHub error message carries the response's status and body; the reason
// the board reads needs neither.
const shortReason = message => /: (\d{3}) /.exec(message)?.[1] ? `GitHub answered ${/: (\d{3}) /.exec(message)[1]}` : "GitHub could not be reached";

/** The brief a request carries, its ```job-request fence stripped. */
export function briefOf(body) {
  return (body ?? "").replace(/```job-request\n[\s\S]*?\n```/, "").trim();
}

/**
 * What a request asks for, or why it cannot be taken: the block must be an
 * object, and the title (the issue's), the brief (the body without the
 * fence) and the optional repo answer to the intake's own rules
 * (lib/engagements.mjs invalidBrief) — a board job looks like any other.
 */
export function jobRequestSpec(request) {
  const block = fenced(request.body, "job-request");
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return { problem: "its ```job-request block is not a JSON object" };
  }
  const brief = briefOf(request.body);
  const problem = invalidBrief({ title: request.title, brief, repo: block.repo });
  return problem ? { problem } : { title: request.title, brief, ...(block.repo ? { repo: block.repo } : {}) };
}

// The bot's two answers to a request (see above): the job's link holds for
// good, while a refusal holds only while its reason does.
const refusalMark = "no job was opened from this request";
const openMark = "your job is open with no deposit";

// One request at a time, in the list's order; each is closed by its handling,
// so a later cycle reads none of it again. An epic that GitHub refuses leaves
// the request open and unanswered, for the next cycle to try once more.
export async function settleJobRequests(bot, open) {
  // A job's own epic can carry a ```job-request fence — in a brief planted
  // before the intake refused it, say — and the sweep asks for jobs, it does
  // not eat them: an epic wears the `engagement` label (the bot's own, or the
  // one an owner opened by hand, lib/recover.mjs), a request never does.
  for (const request of open.filter(i => !i.pull_request && isJobRequest(i.body)
    && !(i.labels ?? []).some(l => l.name === "engagement"))) {
    const author = request.user.login;
    const spec = jobRequestSpec(request);
    const refusal = spec.problem ?? await jobRequestRefusal(author);
    // Handled once, the way claims are: the bot's own answer marks the
    // request taken care of, so a cycle that races its close closes it again
    // without a second answer. The two answers hold differently: a job's
    // link holds for good, while a refusal holds only while its reason does —
    // an author who fixes their request and reopens it is checked again.
    const thread = await comments(request.number);
    const answered = thread.find(c => c.user.login === bot && c.body.includes(openMark));
    // A refusal holds only while its reason does: the same reason closes the
    // reopened request again without a second comment, a new one is answered.
    const refusedBefore = refusal
      ? thread.some(c => c.user.login === bot && c.body.includes(`${refusalMark}: ${refusal}.`))
      : false;
    if (answered || refusedBefore) {
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: refusal && !answered ? "not_planned" : "completed" });
      continue;
    }
    // An epic whose block records this request stands in for an answer that
    // never landed: answer from it instead of opening a second job.
    const opened = (await epicIssues(request.created_at))
      .find(epic => epic.user?.login === bot && fenced(epic.body, "engagement")?.request === request.number);
    if (opened) {
      try {
        await comment(request.number, `@${author}, your job is open with no deposit: ${opened.html_url}. Propose its tasks in a \`\`\`team-draft there; an owner approves them with \`/approve\`.`);
      } catch (error) {
        console.error(`coordinator: job request #${request.number} could not be answered: ${error.message}`);
        continue;
      }
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "completed" });
      continue;
    }
    if (refusal) {
      await comment(request.number, `@${author}, no job was opened from this request: ${refusal}.`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "not_planned" });
      console.log(`coordinator: job request #${request.number} refused (${refusal})`);
      continue;
    }
    let epic;
    try {
      epic = await createEpic({
        code: freshCode(),
        title: spec.title,
        brief: spec.brief,
        channel: "board",
        request: request.number,
        ...(spec.repo ? { repo: spec.repo } : {}),
        deposit: { amount: "0", org: author },
      });
    } catch (error) {
      // Nothing said, nothing closed: the next cycle opens the job instead.
      console.error(`coordinator: job request #${request.number} could not open its job: ${error.message}`);
      continue;
    }
    try {
      await comment(request.number, `@${author}, your job is open with no deposit: ${epic.html_url}. Propose its tasks in a \`\`\`team-draft there; an owner approves them with \`/approve\`.`);
    } catch (error) {
      // The job stands and its block records this request: the next cycle
      // answers from the epic (see above) instead of opening a second one.
      console.error(`coordinator: job request #${request.number} could not be answered: ${error.message}`);
      continue;
    }
    await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "completed" });
    console.log(`coordinator: job request #${request.number} opened ${epic.html_url} for @${author}`);
  }
}

// --- jobs opened from registry issues (auto) ---------------------------------

// An issue in a registry repository (agents/claude-worker/repos.mjs) labelled
// `ready-for-agent` opens a job by itself (#123): near-agencies building
// itself through its own board, a worker claiming and building it, and the
// merge finishing it. Whoever applied the label passes the same rule a
// ```job-request author passes, judged from the issue's own label events; the
// issue's body becomes the brief, through the intake's own rules; the job
// assembles its fixed one-task team at once; and the task closes when the
// claimant's pull request merges, whereupon closeIfPaid completes the job.
const AUTO_LABEL = "ready-for-agent";
const GOOD_FIRST_ISSUE = "good first issue";

// What the last auto-job sweep did, for /api/health: when it ran, what it
// opened, and each issue it skipped with the reason; then what the revision
// sweep on the same pace did — the ai-review rounds it posted, and the tasks
// that hit their cap (#159).
const autoJobs = { last_run_at: null, opened: 0, skipped: [], review_rounds: 0, review_capped: 0 };
export const autoJobsHealth = () => ({ ...autoJobs, skipped: [...autoJobs.skipped] });
// A burst of labels names every skip it causes, but health carries a bounded
// slice of them: the first ones, which are the oldest labelled issues.
const AUTO_JOBS_SKIPPED_MAX = 25;

let autoJobsAt = 0;
export async function settleAutoJobs({ now = Date.now() } = {}) {
  if (now - autoJobsAt < AUTO_JOBS_SWEEP_MS) return;
  autoJobsAt = now;
  autoJobs.last_run_at = new Date().toISOString();
  autoJobs.opened = 0;
  autoJobs.skipped = [];
  const bot = await botLogin();
  const skip = (source, why) => {
    if (autoJobs.skipped.length < AUTO_JOBS_SKIPPED_MAX) autoJobs.skipped.push({ issue: source, why });
    console.log(`coordinator: no auto job for ${source}: ${why}`);
  };
  // Open auto jobs count against the cap, and their tasks close here first:
  // a task whose handoff's pull request stands merged closes as the bot, and
  // settlePayouts' closeIfPaid then completes the job through the volunteer
  // path — the completion comment says no payouts were made, because none
  // were.
  const open = (await github("GET", "/issues?labels=engagement&state=open&per_page=100"))
    .filter(i => !i.pull_request && i.user?.login === bot && fenced(i.body, "engagement")?.source);
  for (const epic of open) await settleSourceIssue(epic);
  // A job that stands is finished, whatever else has happened to its issue
  // since: a pull request that references it now (the claimant's own, a
  // minute after the job opens) must not hide it from the retry of the
  // writes finishAutoJob owes, the `good first issue` removal among them
  // (#167). The checks below decide whether a job opens, not whether one that
  // already stands is finished.
  const standing = new Map(open.map(epic => [fenced(epic.body, "engagement").source, epic]));
  // Who may open is judged per candidate, from the issue's own timeline; the
  // eligible ones then compete for the slots left under the cap, the oldest
  // labelled issue first.
  const eligible = [];
  for (const repoName of Object.keys(REPOS)) {
    let labelled;
    try {
      labelled = await repoIssues(repoName, `state=open&labels=${AUTO_LABEL}&per_page=100`);
    } catch (error) {
      console.error(`coordinator: ${repoName}'s ${AUTO_LABEL} issues could not be read: ${error.message}`);
      continue;
    }
    for (const listed of labelled.filter(i => !i.pull_request)) {
      const source = `${repoName}#${listed.number}`;
      if (standing.has(source)) {
        skip(source, "a job already stands for it");
        try {
          await finishAutoJob(standing.get(source), listed, repoName);
        } catch (error) {
          console.error(`coordinator: the auto job for ${source} could not be finished: ${error.message}`);
        }
        continue;
      }
      if ((listed.assignees ?? []).length) { skip(source, "someone is already assigned to it"); continue; }
      let events;
      try {
        events = await repoIssueTimeline(repoName, listed.number);
      } catch (error) {
        skip(source, `its timeline could not be read (${shortReason(error.message)})`);
        continue;
      }
      const referenced = await referencedPullProblem(events, source);
      if (referenced) { skip(source, referenced); continue; }
      // The label's latest application decides: whoever applied it passes the
      // same rule a ```job-request author passes, so an outsider's or an
      // agent's label opens nothing. Nothing indexed yet, nothing opens — the
      // next sweep reads the issue's events again.
      const applied = events.filter(e => e.event === "labeled" && e.label?.name === AUTO_LABEL).at(-1);
      const refusal = !applied ? "the label's application is not indexed yet"
        : await editedSince(events, repoName, listed.number, applied.created_at)
          ?? await jobRequestRefusal(applied.actor?.login);
      if (refusal) { skip(source, refusal); continue; }
      eligible.push({ listed, repo: repoName, source, org: applied.actor.login, labelledAt: applied.created_at });
    }
  }
  eligible.sort((a, b) => a.labelledAt.localeCompare(b.labelledAt) || a.source.localeCompare(b.source));
  let slots = Math.max(0, AUTO_JOBS_MAX - open.length);
  for (const { listed, repo: repoName, source, org } of eligible) {
    // The list was read at the sweep's start, and an owner may have taken the
    // work themselves, or withdrawn the label, since: re-read the issue
    // before anything below acts on it, the way promote re-reads its seat
    // before labelling it ready. The brief and the task are built from this
    // re-read, never from the list's older copy.
    let live;
    try {
      live = await repoIssue(repoName, listed.number);
    } catch (error) {
      console.error(`coordinator: ${source} could not be re-read: ${error.message}`);
      continue;
    }
    if ((live.assignees ?? []).length) { skip(source, "someone is already assigned to it"); continue; }
    if (!(live.labels ?? []).some(l => l.name === AUTO_LABEL)) { skip(source, `its ${AUTO_LABEL} label is gone`); continue; }
    // A job is opened once per issue, however often the coordinator restarts:
    // its ```engagement block records the source, and the sweep finds the job
    // there again instead of opening a second one.
    const opened = (await epicIssues(live.created_at))
      .find(epic => epic.user?.login === bot && fenced(epic.body, "engagement")?.source === source);
    if (opened) {
      skip(source, "a job already stands for it");
      if (opened.state === "open") {
        try {
          await finishAutoJob(opened, live, repoName);
        } catch (error) {
          console.error(`coordinator: the auto job for ${source} could not be finished: ${error.message}`);
        }
      }
      continue;
    }
    if (slots <= 0) { skip(source, `at most ${AUTO_JOBS_MAX} auto jobs stand open at once`); continue; }
    const brief = `${live.body ?? ""}\n\nOpened for [#${live.number}](${live.html_url}).`;
    const problem = invalidBrief({ title: live.title, brief, repo: repoName });
    if (problem) { skip(source, problem); continue; }
    let epic;
    try {
      epic = await createEpic({
        code: freshCode(),
        title: live.title,
        brief,
        channel: "board",
        repo: repoName,
        source,
        deposit: { amount: "0", org },
      });
    } catch (error) {
      // Nothing said, nothing recorded: the next sweep opens the job instead.
      console.error(`coordinator: the auto job for ${source} could not open: ${error.message}`);
      continue;
    }
    try {
      await finishAutoJob(epic, live, repoName);
    } catch (error) {
      // The job stands and its block records the source: the next sweep
      // assembles the team or answers the issue there, the way a lost comment
      // or a failed assemble is always finished (finishAutoJob).
      console.error(`coordinator: the auto job ${epic.html_url} could not be finished: ${error.message}`);
    }
    slots -= 1;
    autoJobs.opened += 1;
    console.log(`coordinator: auto job ${epic.html_url} opened for ${source}`);
  }
}

// The label vouches for the issue as it stood when it was applied: a body or
// title edited since — by its author, whoever they are — is checked again
// only once the label is applied again. GitHub's events record no body edit,
// so that edit is judged from the issue's own lastEditedAt; a title's rename
// is an event, and is judged from the same trail. A read that fails fails
// closed, as an unreadable team does.
async function editedSince(events, repoName, number, appliedAt) {
  if (events.some(e => e.event === "renamed" && Date.parse(e.created_at) > Date.parse(appliedAt))) {
    return "its title changed after the label was applied";
  }
  let editedAt;
  try {
    editedAt = await issueLastEditedAt(repoName, number);
  } catch (error) {
    return `its edits could not be read (${shortReason(error.message)})`;
  }
  return editedAt && Date.parse(editedAt) > Date.parse(appliedAt) ? "its body changed after the label was applied" : null;
}

// Why the issue must wait because the work already exists, or null: a pull
// request that cross-references it — an event of the issue's timeline,
// whichever repository and whichever author the pull request comes from —
// counts only when its body closes the issue (closesSource, lib/payouts.mjs),
// a GitHub closing keyword naming it, with or without its repository. One
// that still stands open closes the issue when it merges, and one that has
// already merged has settled it or stands in its way; either way the issue
// wants no auto job under it. A mention that does not close the issue holds
// nothing, whatever else the pull request does, and neither does a pull
// request closed without merging. An unreadable one fails closed, as an
// unreadable team does.
async function referencedPullProblem(events, source) {
  for (const e of events.filter(e => e.event === "cross-referenced" && e.source?.issue?.pull_request)) {
    let pr;
    try {
      pr = await pullRequest(e.source.issue.html_url);
    } catch (error) {
      return `a pull request that may close it could not be read (${shortReason(error.message)})`;
    }
    if (!closesSource(pr, source)) continue;
    if (pr.state === "open") return `an open pull request (${pr.html_url}) already closes it`;
    if (pr.merged) return `a merged pull request (${pr.html_url}) already settles it`;
  }
  return null;
}

// The fixed team an auto job carries, with no `/approve`: one skill:code
// task, volunteer (amount 0), agent-eligible, its terms naming the issue's
// repository through the job's ```engagement block. Bigger work still goes
// through a team draft and an owner's `/approve`.
function autoTeamSpec(listed, repoName) {
  const source = `${repoName}#${listed.number}`;
  return {
    key: "build",
    title: listed.title,
    body: [
      `Build [${source}](${listed.html_url}) in \`${repoName}\`.`,
      "",
      `Put \`Closes ${source}\` in your pull request's body, against \`${REPOS[repoName].base}\`: when it merges, this task closes, and the issue closes with it.`,
    ].join("\n"),
    amount: "0",
    labels: ["skill:code", "agent-eligible"],
  };
}

// The two writes that finish an auto job, each retried however many sweeps
// later it takes: the fixed team assembled at once, and the answer on the
// source issue, said once. A job whose epic landed but whose assemble or
// comment never did is finished here on a later sweep — found by its source,
// never opened twice.
async function finishAutoJob(epic, listed, repoName) {
  if (!fenced(epic.body, "team")) {
    const spec = autoTeamSpec(listed, repoName);
    const problem = teamProblem(epic, [spec]);
    if (problem) throw new Error(problem);
    await assembleTeam(epic, [spec]);
  }
  const bot = await botLogin();
  const said = (await repoComments(repoName, listed.number))
    .some(c => c.user.login === bot && c.body.includes(epic.html_url));
  if (!said) {
    await repoComment(repoName, listed.number,
      `A job opened for this issue with no deposit: ${epic.html_url}. Its one task is open to claim there; when the claimant's pull request merges, the task and this issue close with it.`);
  }
  // The issue is the board's work now: left labelled `good first issue`, it
  // invites an outside contributor to build it too, and the two pull requests
  // race (#119: #137 and #136). The label leaves with the job's making; a
  // removal that fails costs only the invitation's retraction, and the next
  // sweep reads the labels again.
  if ((listed.labels ?? []).some(l => l.name === GOOD_FIRST_ISSUE)) {
    try {
      await repoRemoveLabel(repoName, listed.number, GOOD_FIRST_ISSUE);
    } catch (error) {
      console.error(`coordinator: ${repoName}#${listed.number}'s ${GOOD_FIRST_ISSUE} label could not be removed: ${error.message}`);
    }
  }
}

// One open auto job, per sweep, settled by its source issue's state. The
// claimant's own merged pull request closes the task the normal way — done,
// completed, the job completing after it through closeIfPaid. A source issue
// that closed another way — someone else's pull request merged first, or a
// hand close — over an undelivered task is the race the board lost (#119):
// the sweep supersedes the job itself. An open source issue holds the task
// open, and a read that fails holds every decision: nothing is closed on
// data the sweep could not see.
async function settleSourceIssue(epic) {
  let job;
  try {
    job = await loadEngagement(epic.number);
  } catch (error) {
    console.error(`coordinator: auto job #${epic.number} could not be read: ${error.message}`);
    return;
  }
  const source = job.engagement.source;
  if (!source) return;
  const [sourceRepo, sourceNumber] = source.split("#");
  let liveIssue;
  try {
    liveIssue = await repoIssue(sourceRepo, Number(sourceNumber));
  } catch (error) {
    console.error(`coordinator: ${source} could not be re-read: ${error.message}`);
    return;
  }
  // The merge itself must have closed the source issue: GitHub closes a
  // linked issue when its pull request merges into the default branch, and
  // the issue's state is not rewritten by a later body edit the way the
  // pull request's is. An issue still open holds the task open.
  if (liveIssue.state !== "closed") return;
  let done = false;
  let unreadable = false;
  for (const m of job.members.filter(m => isVolunteer(m) && m.skills?.includes("skill:code") && m.handoff)) {
    let problem;
    try {
      problem = await deliveredProblem(m);
    } catch (error) {
      // One unreadable pull request must not stop the sweep for the rest:
      // the task waits, and the next sweep reads it again.
      console.error(`coordinator: #${m.issue}'s delivery could not be read: ${error.message}`);
      unreadable = true;
      continue;
    }
    if (problem) continue;
    done = true;
    // A task an earlier sweep already closed needs no closing again; the job
    // it belongs to completes through closeIfPaid.
    if (m.state !== "open") continue;
    // The close first: a comment that never lands loses only the explanation,
    // where a comment that lands before a failed close would be repeated by
    // every sweep that finds the task still open.
    try {
      await github("PATCH", `/issues/${m.issue}`, { state: "closed", state_reason: "completed" });
    } catch (error) {
      console.error(`coordinator: #${m.issue} could not be closed: ${error.message}`);
      continue;
    }
    try {
      await comment(m.issue, `${m.claimedBy.map(login => `@${login}`).join(", ")}, the pull request your handoff links is merged, so this task is done.`);
    } catch (error) {
      console.error(`coordinator: #${m.issue} could not be answered: ${error.message}`);
    }
    console.log(`coordinator: #${m.issue} closed on its merged pull request (auto job #${job.number})`);
  }
  if (done || unreadable) return;
  await supersedeAutoJob(job, source, sourceRepo, Number(sourceNumber));
}

// The mark every supersede comment carries, on the task and on a claimant's
// pull request alike: a restart finds its own earlier comment by it, however
// long it ran, and says nothing again.
const SUPERSEDED_MARK = "**Superseded:**";

// The board losing the race, cleaned up after itself: the source issue closed
// — someone else's pull request merged first, or a hand close — while this
// job's task stood undelivered. As the bot: the task hears it is superseded
// once and closes with the job as not planned (nothing was delivered on the
// board, so nothing is paid), and each open pull request of the task's
// claimant that references the issue hears the same, its close left to its
// author or an owner. A timeline the sweep cannot read holds all of it: the
// comments owe their readers what settled the issue, and the next sweep reads
// it again.
async function supersedeAutoJob(job, source, sourceRepo, sourceNumber) {
  let events;
  try {
    events = await repoIssueTimeline(sourceRepo, sourceNumber);
  } catch (error) {
    console.error(`coordinator: ${source}'s timeline could not be read: ${error.message}`);
    return;
  }
  // Every pull request GitHub links to the issue, whoever opened it — read
  // completely, or nothing is decided: one unreadable reference could be the
  // claimant's own merged pull request, the one fact that holds a supersede.
  const referencing = [];
  for (const e of events.filter(e => e.event === "cross-referenced" && e.source?.issue?.pull_request)) {
    try {
      referencing.push(await pullRequest(e.source.issue.html_url));
    } catch (error) {
      console.error(`coordinator: a pull request referencing ${source} could not be read: ${error.message}`);
      return;
    }
  }
  // What settled the issue, for the comments: the newest merged pull request
  // that references it, else whoever closed it. The reads above are complete
  // by here, so the citation never misses the pull request that matters.
  const merged = referencing.filter(pr => pr.merged).at(-1);
  const closer = events.findLast(e => e.event === "closed" && e.actor?.login)?.actor.login;
  const settled = merged
    ? `settled by pull request ${merged.html_url}`
    : closer ? `closed by @${closer}, with no pull request merged` : "closed";
  const tasks = job.members.map(m => `[${m.url.replace("https://github.com/", "").replace(/\/issues\/(\d+)$/, "#$1")}](${m.url})`).join(", ");
  const bot = await botLogin();
  const claimants = [...new Set(job.members.flatMap(m => m.claimedBy ?? []))];
  // The claimant's own merged pull request is the normal merge path, handoff
  // or not yet: a branch-mode worker's auto-merge closes the source issue
  // before its handoff lands, and the task waits for that handoff rather
  // than hearing a supersede. Someone else's merged pull request holds
  // nothing here — that is the race the sweep supersedes.
  if (referencing.some(pr => pr.merged
    && claimants.some(login => login.toLowerCase() === pr.user?.login?.toLowerCase()))) return;
  // The close first, the way a delivered task closes: a comment that never
  // lands loses only its explanation, where one that lands before a failed
  // close would be said again by every sweep that finds the task open.
  let stranded = false;
  for (const m of job.members.filter(m => m.state === "open")) {
    try {
      await github("PATCH", `/issues/${m.issue}`, { state: "closed", state_reason: "not_planned" });
    } catch (error) {
      console.error(`coordinator: #${m.issue} could not be closed as superseded: ${error.message}`);
      stranded = true;
      continue;
    }
    const claims = (m.claimedBy ?? []).map(login => `@${login}`).join(", ");
    const body = `${SUPERSEDED_MARK} ${claims ? `${claims}, ` : ""}${source}, the issue this task builds, is closed — ${settled}. Nothing was delivered through this task, so it and its job close as not planned: nothing is paid.`;
    try {
      const said = (await comments(m.issue)).some(c => c.user.login === bot && c.body.includes(SUPERSEDED_MARK));
      if (!said) await comment(m.issue, body);
    } catch (error) {
      console.error(`coordinator: #${m.issue} could not be answered: ${error.message}`);
    }
    console.log(`coordinator: #${m.issue} closed as superseded (auto job #${job.number})`);
  }
  // The job closes only once every open task of it closed: a close GitHub
  // refused is tried again on the next sweep, since a job closed over a
  // stranded open task is never revisited.
  if (stranded) return;
  try {
    await github("PATCH", `/issues/${job.number}`, { state: "closed", state_reason: "not_planned" });
    console.log(`coordinator: auto job #${job.number} closed as superseded (${source})`);
  } catch (error) {
    console.error(`coordinator: auto job #${job.number} could not be closed: ${error.message}`);
  }
  for (const pr of referencing.filter(pr => pr.state === "open"
    && claimants.some(login => login.toLowerCase() === pr.user?.login?.toLowerCase()))) {
    // The pull request's own repository and number, from its URL as GitHub
    // writes it: the comment lands where its author reads it.
    const [, owner, name, inNumber] = pr.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/) ?? [];
    const inRepo = `${owner}/${name}`;
    try {
      const said = (await repoComments(inRepo, Number(inNumber))).some(c => c.user.login === bot && c.body.includes(SUPERSEDED_MARK));
      if (said) continue;
      await repoComment(inRepo, Number(inNumber),
        `${SUPERSEDED_MARK} @${pr.user.login}, ${source}, the issue this pull request targets, is closed — ${settled}. The board task it was delivering (${tasks}) closed with its job as not planned; closing this pull request is left to its author or an owner.`);
      console.log(`coordinator: ${pr.html_url} told its task is superseded (auto job #${job.number})`);
    } catch (error) {
      console.error(`coordinator: ${pr.html_url} could not be answered: ${error.message}`);
    }
  }
}

// --- revision rounds an auto task owes ai-review -----------------------------

// Who ai-review posts as (its workflow's own token), how many rounds its
// findings may open on one task before a person decides (#116), and the
// fixed first words of the comment that says the cap stands — the mark a
// restart finds its own earlier cap comment by.
const AI_REVIEW = "github-actions[bot]";
const AI_REVIEW_ROUNDS_MAX = 3;
const AI_REVIEW_CAPPED = "ai-review still finds Important issues after 3 rounds";
const PULL_LINK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
// A pull-request URL split the way its reads need it: owner, name, number,
// exactly as the handoff wrote them — GitHub reads a repository at any case,
// and the thread's id is the case the writer used.
const PULL_PARTS = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

let autoJobRoundsAt = 0;

/**
 * The revision sweep for auto-job tasks (#159): an auto job has one task and
 * no review seat, so routeChangeRequests has nobody to route from and only
 * the sweep can send its pull request back. At the auto-job sweep's pace it
 * takes every open task a ```terms.source marks as an auto job's — in
 * progress, with an assignee whose handoff links an open pull request — and
 * where ai-review's ledger holds an Important open at the head the worker
 * delivered, posts the ```changes block the worker already revises on
 * (agents/claude-worker/trust.mjs), once per head. A task that arrived at its
 * fourth round hears, once, that a person decides now. Writes the plan
 * planAutoJobRounds decided; nothing else.
 */
export async function settleAutoJobRounds({ now = Date.now() } = {}) {
  if (now - autoJobRoundsAt < AUTO_JOBS_SWEEP_MS) return;
  autoJobRoundsAt = now;
  autoJobs.review_rounds = 0;
  autoJobs.review_capped = 0;
  for (const due of (await planAutoJobRounds()).filter(d => d.action !== "none")) {
    // The list was read at the sweep's start; a merge, a release or an
    // owner's close since decides over a stale copy: re-read before the
    // first visible effect, the way promote re-reads its seat.
    let live;
    try {
      live = await issue(due.task);
    } catch (error) {
      console.error(`coordinator: #${due.task} could not be re-read for its ai-review round: ${error.message}`);
      continue;
    }
    if (live.state !== "open" || !(live.assignees ?? []).some(a => due.assignees.includes(a.login))) continue;
    try {
      await comment(due.task, due.action === "cap" ? cappedBody(due) : roundBody(due));
    } catch (error) {
      console.error(`coordinator: #${due.task} could not be reopened for ai-review: ${error.message}`);
      continue;
    }
    if (due.action === "round") autoJobs.review_rounds += 1;
    else autoJobs.review_capped += 1;
    console.log(`coordinator: #${due.task} ${due.action === "cap" ? "hit the ai-review cap" : `reopened for ai-review round ${due.round}`} (${due.pr})`);
  }
}

/**
 * What every open auto-job task waits on from ai-review, decided only: the
 * plan settleAutoJobRounds writes, for scripts/review-rounds.mjs to report
 * and the tests to read. Each decision carries the task, its pull request
 * and head, the rounds already posted, and — when one is due — the findings
 * that ask for it and the summary comment to cite; action "none" carries why
 * it is not.
 */
export async function planAutoJobRounds() {
  const decisions = [];
  for (const seat of (await openSeats()).filter(seat => seat.terms?.source
    && seat.labels.includes("in-progress") && seat.assignees.length)) {
    try {
      decisions.push(await autoJobRound(seat));
    } catch (error) {
      decisions.push({ task: seat.number, action: "none", why: `its round could not be decided (${shortReason(error.message)})` });
    }
  }
  return decisions;
}

// The decision one auto task waits on. Reads, in order of what can stop it
// cheapest: the task's thread for the delivery handoff, the pull request that
// handoff links, that pull request's ledger. A read that fails decides
// nothing this sweep — the next one reads again.
async function autoJobRound(seat) {
  const decision = { task: seat.number, task_url: seat.url, source: seat.terms.source, assignees: seat.assignees, action: "none" };
  const mine = new Set(seat.assignees.map(login => login.toLowerCase()));
  const bot = String(await botLogin() ?? "").toLowerCase();
  const thread = await comments(seat.number);
  // The delivery as its claimant handed it off: the latest ```handoff by an
  // assignee. A code task's links open with the pull request that delivers
  // into the terms' repository — another link is a citation (lib/handoff.mjs).
  const handoff = thread.findLast(c => mine.has(c.user.login?.toLowerCase()) && fenced(c.body, "handoff"));
  const links = handoffPulls(seat, handoff);
  if (!handoff || !links.length) return { ...decision, why: handoff ? "the handoff links no open pull request of the task's repository" : "no handoff stands yet" };

  // The ai-review rounds the coordinator already owes this task: its own
  // ```changes blocks saying so (the worker credits the coordinator's alone,
  // trust.mjs), each naming the head it reopened.
  const rounds = thread.filter(c => c.user.login?.toLowerCase() === bot
    && fenced(c.body, "changes")?.requested_by === "ai-review");
  for (const url of links) {
    let pr;
    try {
      pr = await pullRequest(url);
    } catch (error) {
      return { ...decision, pr: url, why: `its pull request could not be read (${shortReason(error.message)})` };
    }
    // Merged or closed, the work is settled or withdrawn: nothing to revise.
    if (pr.state !== "open") continue;
    const head = pr.head?.sha;
    if (!head) return { ...decision, pr: url, why: "its pull request names no head sha" };
    let summaries;
    try {
      const [, owner, name, inNumber] = url.match(PULL_PARTS);
      summaries = await repoComments(`${owner}/${name}`, Number(inNumber));
    } catch (error) {
      return { ...decision, pr: url, head, why: `its pull request's comments could not be read (${shortReason(error.message)})` };
    }
    // The latest ledger github-actions[bot] left, parsed in one place
    // (lib/ledger.mjs): none yet — a fork's review waits on /review — or one
    // that does not parse, reads as none. A ledger for an older head is a
    // push being reviewed.
    const summary = summaries.findLast(c => c.user.login?.toLowerCase() === AI_REVIEW && c.body.includes(LEDGER_MARK));
    const ledger = summary ? ledgerOf(summary.body) : null;
    if (!ledger) return { ...decision, pr: url, head, why: "its pull request carries no ai-review ledger yet (a fork's review waits on /review)" };
    if (ledger.sha.toLowerCase() !== head.toLowerCase()) {
      return { ...decision, pr: url, head, ledger_sha: ledger.sha, why: "ai-review last saw an older head; a push is being reviewed" };
    }
    const findings = openImportants(ledger).map(findingLine);
    if (!findings.length) return { ...decision, pr: url, head, rounds: rounds.length, why: "ai-review leaves no Important open" };
    const heads = new Set(rounds.map(c => fenced(c.body, "changes")?.head?.toLowerCase()));
    if (heads.has(head.toLowerCase())) {
      return { ...decision, pr: url, head, rounds: rounds.length, findings, why: `round ${rounds.length} already stands at this head` };
    }
    // Once capped, always capped for this task: the comment said a person
    // decides, and no sweep says it again.
    if (thread.some(c => c.user.login?.toLowerCase() === bot && c.body.startsWith(AI_REVIEW_CAPPED))) {
      return { ...decision, pr: url, head, rounds: rounds.length, findings, why: "the cap stands; a person decides" };
    }
    if (rounds.length >= AI_REVIEW_ROUNDS_MAX) {
      return { ...decision, pr: url, head, rounds: rounds.length, findings, summary: summary.html_url, action: "cap" };
    }
    return { ...decision, pr: url, head, rounds: rounds.length, findings, summary: summary.html_url, action: "round", round: rounds.length + 1 };
  }
  return { ...decision, why: "its pull request stands merged or closed" };
}

// The pull requests a code task's handoff links into the task's repository,
// deduplicated: the delivery both the ai-review sweep and a person's request
// for another round name.
function handoffPulls(seat, handoff) {
  const repo = (seat.terms.repo ?? "").toLowerCase();
  return [...new Set(handoff ? fenced(handoff.body, "handoff")?.links ?? [] : [])]
    .filter(url => PULL_LINK.test(url) && (!repo || pullRepo(url) === repo));
}

/** One finding as the round quotes it: `F1 path:line: gist`. */
const findingLine = f => `${f.id ?? "F?"} ${f.path ?? "?"}:${f.line ?? 0}: ${f.gist ?? ""}`;

/** The round the worker revises on: the same shape routeChangeRequests posts
 * for a reviewer's request, asked by ai-review and citing its summary. */
function roundBody(due) {
  return [
    `**Changes requested** by ai-review on ${due.pr} at ${due.head.slice(0, 7)}. This task is reopened for another round by ${due.assignees.map(login => `@${login}`).join(", ")}.`,
    "",
    ...due.findings.map(line => `> ${line}`),
    "",
    fence("changes", { pr: due.pr, head: due.head, request: due.summary, requested_by: "ai-review" }),
  ].join("\n");
}

// --- a person's request for another round on an auto task (#165) ------------

/**
 * An auto job has no review seat, so routeChangeRequests has nobody to route
 * a person's "Changes requested" from, and the worker revises only on the
 * coordinator's own ```changes block (agents/claude-worker/trust.mjs). This
 * sweep routes it: on an open, in-progress auto-job task, a comment starting
 * "Changes requested" — written after the handoff whose pull request it is
 * about — by an owner or an active member of team internal becomes the same
 * round a review seat's request does, naming that pull request, quoted, and
 * marked seen so it is routed once. Anyone else's is ignored with no reply,
 * and an unreadable team holds the request for the next sweep. These rounds
 * carry their requester's login, so ai-review's limit of three, which counts
 * only `requested_by: "ai-review"`, never counts them.
 */
export async function settleAutoChangeRequests() {
  const bot = await botLogin();
  for (const seat of (await openSeats()).filter(seat => seat.terms?.source
    && seat.labels.includes("in-progress") && seat.assignees.length)) {
    try {
      await routePersonRequests(seat, bot);
    } catch (error) {
      console.error(`coordinator: #${seat.number}'s change requests could not be routed: ${error.message}`);
    }
  }
}

async function routePersonRequests(seat, bot) {
  const mine = new Set(seat.assignees.map(login => login.toLowerCase()));
  const thread = await comments(seat.number);
  const delivered = thread.findLastIndex(c => mine.has(c.user.login?.toLowerCase()) && fenced(c.body, "handoff"));
  if (delivered === -1) return;
  const pr = handoffPulls(seat, thread[delivered])[0];
  if (!pr) return;
  for (const request of thread.slice(delivered + 1).filter(isChangeRequest)) {
    if (await answered(request, bot)) continue;
    if (!await mayRequestRound(request.user.login)) continue;
    // The request may be the owner's mid-sweep edit away from the task's
    // state: re-read before the first visible effect.
    const live = await issue(seat.number);
    if (live.state !== "open" || !(live.assignees ?? []).length) return;
    await comment(seat.number, [
      `**Changes requested** by @${request.user.login} on ${pr}. This task is reopened for another round by ${live.assignees.map(a => `@${a.login}`).join(", ")}.`,
      "",
      request.body.trim().split("\n").map(line => `> ${line}`).join("\n"),
      "",
      fence("changes", { pr, request: request.html_url, requested_by: request.user.login }),
    ].join("\n"));
    await react(request, "eyes");
    console.log(`coordinator: routed ${request.user.login}'s changes to auto task #${seat.number}`);
  }
}

// Who may ask an auto task's worker for another round: an owner or an active
// member of team internal, the people jobRequestRefusal lets open the job. A
// team read that fails fails closed for this sweep and is read again.
async function mayRequestRound(login) {
  if (await isOwner(login)) return true;
  try {
    return await orgTeamMember(INTERNAL_TEAM, login);
  } catch (error) {
    console.error(`coordinator: team ${INTERNAL_TEAM} could not be read for @${login}'s change request: ${shortReason(error.message)}`);
    return false;
  }
}

/** What the cap says, once: the rounds did not converge (#116). */
const cappedBody = due => `${AI_REVIEW_CAPPED} at ${due.head.slice(0, 7)}; a person decides whether to merge, fix or close ${due.pr}.`;

async function routeChangeRequests(reviewSeat, bot) {
  if (reviewSeat.dependsOn.length === 0 || reviewSeat.assignees.length === 0) return;
  const reviewers = new Set(reviewSeat.assignees.filter(login => login !== bot));
  // Every reviewer comment is also judged in shadow (lib/judge.mjs); only the regex routes.
  const requestsOn = async n => {
    const said = (await comments(n)).filter(c => reviewers.has(c.user.login));
    for (const c of said) await shadowJudge(c, isChangeRequest(c));
    return said.filter(isChangeRequest);
  };
  const onReview = await requestsOn(reviewSeat.number);
  for (const n of reviewSeat.dependsOn) {
    const onSeat = await requestsOn(n);
    for (const request of [...onReview, ...onSeat]) {
      if (await answered(request, bot)) continue;
      const reviewed = await issue(n);
      if (reviewed.state === "closed") {
        await github("PATCH", `/issues/${n}`, { state: "open" });
        await swapLabel(n, "ready", "in-progress");
      }
      await comment(n, [
        `**Changes requested** by @${request.user.login}, reviewing in #${reviewSeat.number}. This task is reopened for another round by ${reviewed.assignees.map(a => `@${a.login}`).join(", ")}.`,
        "",
        request.body.trim().split("\n").map(line => `> ${line}`).join("\n"),
        "",
        fence("changes", { review: reviewSeat.number, requested_by: request.user.login, request: request.html_url }),
      ].join("\n"));
      await react(request, "eyes");
      console.log(`coordinator: routed changes from #${reviewSeat.number} to #${n}`);
    }
  }
}

async function promote(seat) {
  if (seat.dependsOn.length === 0) return;
  const parents = await Promise.all(seat.dependsOn.map(n => issue(n)));
  if (parents.some(p => p.state !== "closed")) return;
  // A task closed by hand counts as done, so before the closed parents unblock
  // this seat, each close is checked: one a stranger made reopens (closeVerified)
  // and the seat stays blocked until it is delivered properly.
  for (const parent of parents) {
    if (!await closeVerified(parent.number, parent.closed_at)) return;
  }
  // The open list was read at the top of the cycle, and an owner closing the
  // seat since — a replacement, a withdrawal — wins the race only against the
  // label write. Re-read the seat before its first visible effect, so a closed
  // seat is not labelled ready with a claim invitation nobody can answer.
  const live = await issue(seat.number);
  if (live.state !== "open") return;
  await swapLabel(seat.number, "blocked", "ready");
  await comment(seat.number, `Dependencies ${seat.dependsOn.map(n => `#${n}`).join(", ")} are done. This task is open: comment \`/claim\` to take it.`);
  console.log(`coordinator: #${seat.number} ready`);
}

// A refusal because the claimant isn't on the roster (eligibility()'s first
// check) is a newcomer's dead end otherwise: nothing else on the task says
// where to join. eligibility()'s own reason stays unchanged for its other
// readers (/api/tasks, lib/status.mjs) — only the coordinator's comment grows
// the pointer.
const withJoinHint = refusal => refusal === "not on the MultiAgency roster"
  ? `${refusal}. Join first at ${SITE_URL}/#/join (how it works: ${SITE_URL}/skill.md), then claim again`
  : refusal;

async function settleClaims(seat, bot) {
  let accepted = null;
  // The gate label's provenance is read once per settle pass: restoring the
  // label races /claim, so a claim made while a stranger set it is refused.
  let gate;
  const gateProblem = () => (gate === undefined ? (gate = labelGateProblem(seat)) : gate);
  for (const claim of (await comments(seat.number)).filter(isClaim)) {
    if (await answered(claim, bot)) continue;
    // The claimant's own repeat claims — the win this pass, a win the
    // assignee list already shows, or a re-claim while working — are the win
    // already announced: mark them processed, never refuse or re-announce.
    if (claim.user.login === accepted || seat.assignees.includes(claim.user.login)) {
      await react(claim, "+1");
      continue;
    }
    const builder = byGithub(claim.user.login);
    const refusal = eligibility(seat, builder)
      ?? await gateProblem()
      ?? await dependencyProblem(seat)
      ?? await selfReviewProblem(seat, claim.user.login)
      ?? (accepted ? `@${accepted} claimed it first` : null)
      ?? (seat.assignees.length ? `this task is already claimed by @${seat.assignees[0]}` : null);
    if (refusal) {
      await react(claim, "-1");
      await comment(seat.number, `@${claim.user.login} can't claim this task: ${withJoinHint(refusal)}.`);
      continue;
    }
    accepted = claim.user.login;
    await github("POST", `/issues/${seat.number}/assignees`, { assignees: [claim.user.login] });
    await swapLabel(seat.number, "ready", "in-progress");
    await react(claim, "+1");
    await comment(seat.number, claimed(claim.user.login, seat, builder));
    console.log(`coordinator: #${seat.number} claimed by ${claim.user.login}`);
  }
}

// A native GitHub assignment (the assign button) on a `ready` seat counts as a
// claim by that assignee, checked against the roster exactly like a /claim.
// Only the first eligible assignee stays on the seat: an ineligible one, or an
// eligible one beaten to it, is refused and removed, since payouts name the
// account of whichever assignee is left. The coordinator itself assigns no one
// else: settling a /claim swaps the label to in-progress in the same pass, so
// a `ready` seat that still has assignees was assigned on GitHub.
export async function assignmentClaims(seat) {
  const decided = await Promise.all(seat.assignees.map(async login => {
    const builder = byGithub(login);
    return { login, builder, refusal: eligibility(seat, builder) ?? await dependencyProblem(seat) ?? await selfReviewProblem(seat, login) };
  }));
  const accepted = decided.find(claim => !claim.refusal) ?? null;
  const refused = decided.flatMap(claim => {
    if (claim.refusal) return [claim];
    if (claim === accepted) return [];
    return [{ ...claim, refusal: `@${accepted.login} claimed it first` }];
  });
  return { accepted, refused };
}

async function settleAssignments(seat) {
  // A native assignment is a claim: made while the gate label it relies on
  // stands as a stranger set it, it is refused like any other.
  const gate = await labelGateProblem(seat);
  const { accepted, refused } = await assignmentClaims(seat);
  for (const claim of gate
    ? [...(accepted ? [{ ...accepted, refusal: gate }] : []), ...refused.map(c => ({ ...c, refusal: c.refusal ?? gate }))]
    : refused) {
    await github("DELETE", `/issues/${seat.number}/assignees`, { assignees: [claim.login] });
    await comment(seat.number, `@${claim.login} can't claim this task: ${withJoinHint(claim.refusal)}.`);
    console.log(`coordinator: #${seat.number} refused ${claim.login}: ${claim.refusal}`);
  }
  if (gate || !accepted) return;
  await swapLabel(seat.number, "ready", "in-progress");
  await comment(seat.number, claimed(accepted.login, seat, accepted.builder));
  console.log(`coordinator: #${seat.number} claimed by ${accepted.login} (GitHub assignment)`);
}

// The reply a win gets. A volunteer task is not paid, so its reply says
// nothing about payment; `Claimed by @…` starts both, since the board reads it.
export const claimed = (login, seat, builder) => isVolunteer(seat.terms)
  ? `Claimed by @${login}. When it is delivered, ${SITE_URL}/#/status/${login} prepares your handoff.`
  : `Claimed by @${login}. Once the work is signed off, ${Number(seat.terms.amount) / 1e6} USDC is paid to \`${builder.nearAccount}\`. ` +
    `When it is delivered, ${SITE_URL}/#/status/${login} prepares your handoff.`;

// A claim is released when CLAIM_TTL_HOURS have passed since the later of the
// coordinator's latest "Claimed by @…" record (a /claim and a GitHub
// assignment both leave one) and its latest ```changes block, so a revision
// round restarts the clock; no other comment moves it. The issue's own
// updated_at is the clock only for a claim with no record, since any comment
// moves it (#166). A review seat's reviewer is waiting on someone else's
// round, so its clock also restarts when the round is routed to the work seat
// it reviews (a ```changes block naming this seat) and when the round's
// arrival is announced on it. Only a handoff by an assignee, posted after the
// latest round, that passes the checks holds the claim: a refused one holds
// nothing, nor one whose deliverable can never be read.
async function releaseIfStale(seat) {
  const { release } = await releaseDecision(seat);
  if (!release) return;
  for (const login of seat.assignees) {
    await github("DELETE", `/issues/${seat.number}/assignees`, { assignees: [login] });
  }
  await swapLabel(seat.number, "in-progress", "ready");
  await comment(seat.number, `No handoff after ${CLAIM_TTL_MS / 3600_000} hours, so this task is open again. Comment \`/claim\` to take it.`);
  console.log(`coordinator: #${seat.number} released`);
}

/**
 * What the release sweep decides for one claimed task, decided only — it
 * writes nothing, so a read-only run against the real board can show it:
 * `release`, why, and `since`, the time its clock started (ms).
 */
export async function releaseDecision(seat, { now = Date.now() } = {}) {
  const thread = await comments(seat.number);
  const requests = await routedRequests(thread);
  const round = requests.at(-1);
  const record = await claimRecord(thread);
  let since = Math.max(
    Date.parse(record?.created_at ?? seat.updatedAt),
    round ? Date.parse(round.created_at) : 0,
  );
  // A time that does not parse decides nothing: NaN compares false against the
  // limit, and the claim would otherwise be released at once.
  if (!Number.isFinite(since)) return { release: false, why: "its start time cannot be read", since };
  if (now - since < CLAIM_TTL_MS) return { release: false, why: "claimed or sent back within the limit", since };
  // The reads below are only made for a claim already past the limit.
  since = Math.max(since, await reviewRoundAt(seat, thread, now));
  if (now - since < CLAIM_TTL_MS) return { release: false, why: "its review round is under way", since };
  if (await holdingHandoff(seat, thread.slice(round ? thread.indexOf(round) + 1 : 0))) {
    return { release: false, why: "a handoff that passes the checks holds it", since };
  }
  return { release: true, why: "past the limit with no handoff that passes", since };
}

// The latest sign that a review seat's reviewer is waiting on a revision
// round, as a time (0 for none): a ```changes block the coordinator routed to
// a seat this one reviews, and the "round N is in" notice it posts here when
// that round closes. A seat that reviews nothing has neither. A read that
// fails counts as now: nothing is released on data the sweep could not see.
async function reviewRoundAt(seat, thread, now) {
  let latest = 0;
  const note = c => { latest = Math.max(latest, Date.parse(c.created_at)); };
  try {
    for (const c of thread) {
      if (/^@[\w-]+, round \d+ of #\d+ is in:/.test(c.body.trim()) && await isTrusted(c.user.login)) note(c);
    }
    for (const n of seat.dependsOn) {
      for (const c of await comments(n)) {
        if (fenced(c.body, "changes")?.review === seat.number && await isTrusted(c.user.login)) note(c);
      }
    }
  } catch (error) {
    console.error(`coordinator: #${seat.number}'s review rounds could not be read for release: ${shortReason(error.message)}`);
    return now;
  }
  return latest;
}

// The latest "Claimed by @…" comment the bot or an owner wrote: a stranger's
// look-alike moves nothing.
async function claimRecord(thread) {
  for (const c of [...thread].reverse()) {
    if (/^Claimed by @/.test(c.body.trim()) && await isTrusted(c.user.login)) return c;
  }
  return null;
}

// An error that retrying will not mend: a link that is no comment's, or an
// answer in GitHub's 4xx other than its "try later" ones. GitHub also says
// "try later" with a 403 whose body names the rate limit (primary or
// secondary), which passes with time like a 429.
const permanentError = error => {
  if (error instanceof TypeError) return true;
  const status = /: (\d{3}) /.exec(error.message)?.[1];
  if (!status || !status.startsWith("4") || status === "408" || status === "429") return false;
  return !(status === "403" && /rate limit|abuse/i.test(error.message));
};

// Whether an assignee's handoff among these comments passes the checks that
// would close the task (handoffProblem), the latest first. A check that fails
// for now holds the claim until the next sweep reads again; one that can
// never complete — a malformed deliverable link, a deleted comment — holds
// nothing, or a claimant could keep a task forever with a link nobody can read.
async function holdingHandoff(seat, thread) {
  for (const c of [...thread].reverse()) {
    if (!seat.assignees.includes(c.user.login)) continue;
    const block = fenced(c.body, "handoff");
    if (!block) continue;
    try {
      if (!await handoffProblem(block, byGithub(c.user.login))) return true;
    } catch (error) {
      console.error(`coordinator: #${seat.number}'s handoff could not be checked for release: ${shortReason(error.message)}`);
      if (!permanentError(error)) return true;
    }
  }
  return false;
}

export const isApproval = comment => /^\/approve\b/i.test(comment.body.trim());

/**
 * The latest team draft posted before this command by a trusted author (the
 * bot or an owner): a later one was not what the owner saw, and a stranger's
 * is not one the owner was shown — skipped, not refused, so a trusted draft
 * still counts after it. `trusted` holds the logins already resolved as such.
 */
export function draftFor(thread, command, trusted) {
  const draft = thread
    .slice(0, thread.indexOf(command))
    .filter(c => trusted.has(c.user.login) && c.body.includes("```team-draft\n"))
    .at(-1);
  return draft && { comment: draft, issues: fenced(draft.body, "team-draft")?.issues ?? null };
}

/**
 * The team draft a `/approve` names by linking its comment, instead of taking
 * the latest trusted one. Any author is allowed here: the owner named it. The
 * link counts however it is written — any host or scheme, a fork, or a bare
 * `#issuecomment-` fragment — because an owner who names a draft must not be
 * answered with another one: what cannot be resolved is refused, never the
 * bare behaviour. It must point at a comment on this job that holds a team
 * draft, posted before the command and unedited since — the owner approved
 * what they could read — and a stranger's draft must also be unedited since
 * it was posted: an edit could postdate the owner's read, and only a repost
 * shows a fresh version. Other trailing text names nothing, and keeps the
 * bare behaviour.
 */
export function namedDraft(thread, command, number, trusted) {
  const link = /(?:issues|pull)\/(\d+)#issuecomment-(\d+)/i.exec(command.body);
  const fragment = link ? null : /#issuecomment-(\d+)/.exec(command.body);
  if (!link && !fragment) return null;
  const before = command.created_at;
  if (link && Number(link[1]) !== number) return { refusal: "the comment you linked is not on this job" };
  const draft = thread.find(c => c.id === Number(link ? link[2] : fragment[1]));
  if (!draft) return { refusal: "the comment you linked is not on this job" };
  if (!draft.body.includes("```team-draft\n")) {
    return { refusal: `the [comment you linked](${draft.html_url}) holds no team draft` };
  }
  if (draft.created_at > before) return { refusal: `the [team draft](${draft.html_url}) was posted after the command` };
  if (draft.updated_at > before) return { refusal: `the [team draft](${draft.html_url}) was edited after the command` };
  if (draft.updated_at > draft.created_at && !trusted.has(draft.user.login)) {
    return { refusal: `the [team draft](${draft.html_url}) was edited after it was posted, and its author is not the bot or an owner` };
  }
  return { draft: { comment: draft, issues: fenced(draft.body, "team-draft")?.issues ?? null } };
}

async function approveTeams(bot) {
  const jobs = await github("GET", "/issues?labels=engagement&state=open&per_page=100");
  for (const job of jobs.filter(j => !j.pull_request && !fenced(j.body, "team"))) {
    const thread = await comments(job.number);
    const commands = thread.filter(isApproval);
    if (!commands.length) continue;
    // Who drafts counts: resolve trust for the thread's draft authors once.
    const trusted = new Set();
    for (const posting of thread.filter(c => c.body.includes("```team-draft\n"))) {
      if (await isTrusted(posting.user.login)) trusted.add(posting.user.login);
    }
    for (const command of commands) {
      if (await answered(command, bot)) continue;
      const owner = command.user.login;
      const named = namedDraft(thread, command, job.number, trusted);
      const draft = named ? named.draft : draftFor(thread, command, trusted);
      const refusal = !(await isOwner(owner)) ? "only a MultiAgency owner can approve a team"
        : named?.refusal ? named.refusal
        : !draft ? "there is no team draft above the command"
        : !draft.issues ? `the [team draft](${draft.comment.html_url}) is not valid JSON`
        : teamProblem(job, draft.issues);
      if (refusal) {
        await react(command, "-1");
        await comment(job.number, `@${owner}, the team was not approved: ${refusal}.`);
        continue;
      }
      const { team, committed } = await assembleTeam(job, draft.issues);
      await react(command, "+1");
      await comment(job.number, [
        `**Team approved** by @${owner}, from [the team draft](${draft.comment.html_url}): ${team.map(t => `#${t.issue} ${t.title} (${isVolunteer(t) ? "volunteer" : `${Number(t.amount) / 1e6} USDC`})`).join("; ")}.`,
        `${Number(committed) / 1e6} of ${Number(fenced(job.body, "engagement").deposit.amount) / 1e6} USDC committed. Tasks without dependencies are open to claim now.`,
      ].join(" "));
      console.log(`coordinator: #${job.number} team approved by ${owner}: ${team.map(t => `#${t.issue}`).join(", ")}`);
      break;
    }
  }
}

let payoutSweepAt = 0;
export async function settlePayouts(bot, { now = Date.now() } = {}) {
  if (now - payoutSweepAt < PAYOUT_SWEEP_MS) return;
  payoutSweepAt = now;
  const proposer = process.env.PROPOSER_ACCOUNT;
  const jobs = await github("GET", "/issues?labels=engagement&state=open&per_page=100");
  for (const listed of jobs.filter(j => !j.pull_request && fenced(j.body, "team"))) {
    // Cheap first: a job with an open task is not ready, whatever else holds.
    const tasks = await Promise.all(fenced(listed.body, "team").members.map(m => issue(m.issue)));
    if (tasks.some(t => t.state !== "closed")) continue;
    // A task closed by hand counts as done, and would count the job ready to
    // pay: each closed task's close is checked first, and one a stranger made
    // reopens (closeVerified), holding the job until the task is delivered.
    let stands = true;
    for (const task of tasks) {
      if (!await closeVerified(task.number, task.closed_at)) {
        stands = false;
        break;
      }
    }
    if (!stands) continue;
    let job;
    try {
      job = await loadEngagement(listed.number);
    } catch (error) {
      // One epic the sweep cannot read must not abort the cycle for all of
      // them; /api/health and the next sweep pick it up again.
      console.error(`coordinator: #${listed.number} could not be read for payouts: ${error.message}`);
      continue;
    }
    const log = line => console.log(`coordinator: ${line}`);
    // A task more than one proposal pays is flagged whatever else holds — and
    // whatever its recorded proposal's status: an approval that lands in Trezu
    // between sweeps must not leave the extra proposal quietly votable. The
    // sweep returns the tasks paid more than once, for /api/health.
    for (const double of await flagDuplicateProposals(job, bot, log)) markPaidTwice(listed.number, double);
    // The gate matches proposePayouts' targets: volunteer tasks file nothing,
    // so they are never unpaid work holding the sweep. Their delivery is
    // closeIfPaid's own check below, not a reason to re-run the payout checks
    // once every proposal is filed.
    if (job.members.some(m => !m.payout && !isVolunteer(m)) && proposer) {
      const problem = await payoutProblem(job);
      if (problem) {
        await holdOnce(job.number, `**Payouts on hold:** ${problem}. They are proposed once this is fixed.`, bot);
        continue;
      }
      await proposePayouts(job, proposer, log);
    }
    await recordApprovals(await loadEngagement(job.number), log);
    const held = await closeIfPaid(job.number, log);
    // Every proposal is filed by here, so a hold can only be volunteer work
    // that is not delivered, or duplicate proposals standing beside a payment:
    // say so once, where the payout gate no longer runs.
    if (held) await holdOnce(job.number, `**Delivery on hold:** ${held}. The job completes once it is fixed.`, bot);
  }
}

// Says why a job waits, once per wording, on the job itself: its payouts
// while they wait to be proposed, its delivery when volunteer work holds the
// close after they are.
async function holdOnce(number, body, bot) {
  const said = (await comments(number))
    .filter(c => c.user.login === bot && /^\*\*(?:Payouts|Delivery) on hold:\*\*/.test(c.body))
    .at(-1);
  if (said?.body !== body) await comment(number, body);
}

const reactionsOf = claim => github("GET", `/issues/comments/${claim.id}/reactions?per_page=100`);
const answered = async (claim, bot) => (await reactionsOf(claim)).some(r => r.user.login === bot);
const react = (claim, content) => github("POST", `/issues/comments/${claim.id}/reactions`, { content });
