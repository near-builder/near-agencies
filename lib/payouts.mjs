// Paying a job's team from the DAO treasury: the checks before any proposal,
// one Transfer proposal per task, and recording each payment once an approver
// has voted. Shared by payout.mjs (a person at a terminal) and the coordinator
// (automatically, with a key that can only file proposals). Approving is
// always a person's vote.
import { comment, commentAt, comments, digest, fence, github, pullRepo, pullRequest } from "./github.mjs";
import { codeRepo } from "../agents/claude-worker/repos.mjs";
import { findApproval, txBlockHeight } from "./history.mjs";
import { loadEngagement, proposalState, recordPaid, settleEpic } from "./engagement-state.mjs";
import { USDC, call, view } from "./near.mjs";
import { byGithub } from "./roster.mjs";
import { pinProblem } from "./seats.mjs";
import { isVolunteer } from "./team.mjs";
import { network, trezuRequestLink } from "./network.mjs";

export const DEAD = ["Rejected", "Failed", "Expired", "Removed"];
const LIVE = ["InProgress", "Approved"];
const list = members => members.map(m => `#${m.issue}`).join(", ");
const named = ids => (ids.length === 2 ? `${ids[0]} and ${ids[1]}` : ids.join(", "));

/** Why the job's payouts cannot be proposed yet, or null. */
export async function payoutProblem(job) {
  const { members } = job;
  if (members.length === 0) return "the job has no team";
  const unfinished = members.filter(m => m.state !== "closed" || !m.handoff);
  if (unfinished.length) return `${list(unfinished)} ${unfinished.length === 1 ? "has" : "have"} not closed with a handoff`;
  // Volunteer tasks are not paid, so only the paid ones gate on who receives
  // the money; every task still has to close with a handoff, pinned and
  // unedited, whatever its payout.
  const owed = members.filter(m => !isVolunteer(m));
  const unpaid = owed.filter(m => !m.payee);
  if (unpaid.length) return `no roster payout account for the claimant of ${list(unpaid)}`;
  const mismatched = owed.filter(m => m.handoff.payout?.account_id !== m.payee);
  if (mismatched.length) return `the handoff's payout account differs from the payee on ${list(mismatched)}`;
  // A code task delivers a pull request; the payout counts one only once it is
  // merged, from the task's repository, by the assignee the handoff pays.
  // Another task kind may cite pull requests; its links are not the deliverable.
  // A task whose payout was already proposed keeps the payee it was filed
  // with, so the roster is not read for it again: a claimant leaving the
  // roster, or an owner moving their account, must not hold the job's other
  // payouts.
  for (const m of owed.filter(m => !m.payout && m.skills?.includes("skill:code"))) {
    const problem = await pullsProblem(m, true);
    if (problem) return problem;
  }
  return deliverablesProblem(members);
}

/** The closing reference an auto task's pull request owes the source issue its
 * brief names (`Closes <owner>/<repo>#<n>`, lib/coordinator.mjs): GitHub's own
 * closing keywords, and the issue named with or without its repository, as
 * GitHub closes it either way. The keyword is a whole word, as GitHub reads it:
 * `prefix #1` closes nothing. Exported for the sweep's own eligibility check
 * (lib/coordinator.mjs), so one function decides what counts as closing a
 * source issue everywhere it matters (#175). */
export const closesSource = (pr, source) => {
  const [, repo, number] = /^(.+)#(\d+)$/.exec(source) ?? [];
  if (!number) return false;
  const named = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:${named})?#${number}\\b`, "i").test(pr.body ?? "");
};

/**
 * Why a code task's handoff owes a merged pull request yet, or null. Whatever
 * the payout, one of the claimant's pull requests must be merged from the
 * task's repository; a paid task's must also be by the account the handoff
 * pays, a volunteer's has no payee and counts the claimant alone. A task
 * whose terms carry a source issue (an auto job's, lib/coordinator.mjs) owes
 * more: its pull request merges into the repository's base branch and closes
 * that issue — the linkage its brief tells the claimant to put in the pull
 * request's body — so an unrelated merged pull request finishes nothing.
 */
async function pullsProblem(m, pays) {
  const pulls = [...new Set((m.handoff.links ?? [])
    .map(link => /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(link)?.[0])
    .filter(Boolean))];
  if (pulls.length === 0) return `#${m.issue}'s handoff links no pull request`;
  // The repository the task's terms name, from the registry everything reads
  // a task's repository through (agents/claude-worker/repos.mjs); a task
  // naming none is near-agencies'. Terms naming a repository outside the
  // registry hold the payout: nothing may be shipped there.
  let repo;
  try {
    repo = codeRepo(m);
  } catch {
    return `#${m.issue}'s terms name a repository code tasks do not deliver against`;
  }
  const target = repo.name.toLowerCase();
  let problem = null;
  for (const url of pulls) {
    if (pullRepo(url) !== target) {
      problem ??= `#${m.issue}'s pull request ${url} is in another repository; the pull request must be in ${repo.name}.`;
      continue;
    }
    const pr = await pullRequest(url);
    const author = pr.user.login;
    const claimant = (m.claimedBy ?? []).some(login => login.toLowerCase() === author.toLowerCase()) &&
      (!pays || byGithub(author)?.nearAccount === m.payee);
    if (!claimant) {
      problem ??= `#${m.issue}'s pull request ${url} is by @${author}, not the claimant`;
      continue;
    }
    if (!pr.merged) {
      problem ??= `#${m.issue}'s pull request ${url} is not merged yet`;
      continue;
    }
    if (m.source && pr.base?.ref !== repo.base) {
      problem ??= `#${m.issue}'s pull request ${url} merges into \`${pr.base?.ref}\`, not \`${repo.base}\``;
      continue;
    }
    if (m.source && !closesSource(pr, m.source)) {
      problem ??= `#${m.issue}'s pull request ${url} does not close ${m.source}; its body must name it, the way the task's brief shows`;
      continue;
    }
    return null;
  }
  return problem;
}

/**
 * Why the volunteer members that still settle hold the job open, or null: a
 * volunteer is never proposed or paid, so this is the only check its delivery
 * gets, and it is the same one a paid task passes before its proposal —
 * closed with a handoff, deliverable pinned and unedited, and for a code task
 * its merged pull request.
 */
async function volunteerProblem(members) {
  const settling = members.filter(m => !m.paid && isVolunteer(m));
  if (settling.some(m => m.state !== "closed" || !m.handoff)) {
    return `${list(settling)} ${settling.length === 1 ? "has" : "have"} not closed with a handoff`;
  }
  for (const m of settling.filter(m => m.skills?.includes("skill:code"))) {
    const problem = await pullsProblem(m, false);
    if (problem) return problem;
  }
  return deliverablesProblem(settling);
}

/**
 * Why one volunteer member's delivery does not stand yet, or null — the same
 * checks volunteerProblem makes for a job's close, on a member that is still
 * open: the coordinator closes an auto job's task the moment this returns
 * null, and the job then completes through closeIfPaid (lib/coordinator.mjs).
 */
export async function deliveredProblem(m) {
  if (m.skills?.includes("skill:code")) {
    const problem = await pullsProblem(m, false);
    if (problem) return problem;
  }
  return deliverablesProblem([m]);
}

// A deliverable is a comment its author can still edit; the handoff pins the
// signed-off text, so an edit after the handoff stops the payout.
export async function deliverablesProblem(members) {
  const unpinned = members.filter(m => pinProblem(m.handoff));
  if (unpinned.length) return `the handoffs of ${list(unpinned)} link a deliverable comment without pinning its sha256`;
  for (const m of members.filter(m => m.handoff.deliverable)) {
    const { url, sha256 } = m.handoff.deliverable;
    if (digest((await commentAt(url)).body) !== sha256) return `#${m.issue}'s deliverable was edited after its handoff`;
  }
  return null;
}

/** Accounts that may approve the treasury's transfer proposals, from its role policy. */
export async function daoApprovers() {
  const { roles } = await view(network.treasury, "get_policy", {});
  const votes = ["transfer:VoteApprove", "transfer:*", "*:VoteApprove", "*:*"];
  return [...new Set(roles.filter(r => r.kind.Group && r.permissions.some(p => votes.includes(p))).flatMap(r => r.kind.Group))];
}

/** A job's proposals waiting for a vote, what an approver's wallet needs to vote, and any reason not to. */
export async function pendingPayouts(job, approvers, proposals = null) {
  const pending = job.members.filter(m => m.payout?.status === "InProgress");
  // The treasury is read for any job whose tasks record a payout — a
  // duplicate beside an approved payment holds the panel too; a job with
  // none (a volunteer's team included) costs no chain read.
  const recent = proposals ?? (job.members.some(m => m.payout) ? await recentProposals(job) : []);
  return {
    approvers,
    pending: pending.map(m => ({ issue: m.issue, proposal_id: m.payout.proposal_id, proposer: m.proposal.proposer, kind: m.proposal.kind })),
    problem: (await duplicatePayoutProblem(job, recent)) ?? (pending.length ? await deliverablesProblem(pending) : null),
  };
}

/**
 * A task's matching proposals sorted by what an approver can still do: which
 * were approved (more than one, and the task was paid twice), and which are
 * still live to vote. The recorded proposal counts from its own live state
 * rather than from the recent window, so a proposal that fell out of the
 * window is not mistaken for one that is gone.
 */
function duplicateAudit(recent, m) {
  const approved = [];
  const live = [];
  for (const p of matchingProposals(recent, m)) {
    if (p.id === m.payout.proposal_id) continue;
    (p.status === "Approved" ? approved : live).push(p.id);
  }
  if (LIVE.includes(m.payout.status)) (m.payout.status === "Approved" ? approved : live).push(m.payout.proposal_id);
  return { approved: approved.sort((a, b) => a - b), live: live.sort((a, b) => a - b) };
}

/** Why a task's payout must not be voted or closed over as it stands, or null. */
function duplicateProblem(m, audit) {
  const ids = [...audit.approved, ...audit.live];
  if (audit.approved.length > 1) {
    return `#${m.issue} was paid more than once: payout proposals ${named(ids)} were all approved for one payment of ${Number(m.amount) / 1e6} USDC to \`${m.payee}\``;
  }
  if (ids.length < 2) return null;
  if (audit.approved.length === 0) {
    // A live recorded proposal stays the one to approve. A dead one can never
    // be paid, and proposePayouts never files again beside a recorded payout,
    // so the advice moves the payment to a live proposal and rejects the rest.
    if (LIVE.includes(m.payout.status)) {
      const extras = audit.live.filter(id => id !== m.payout.proposal_id);
      return `#${m.issue} has ${ids.length} payout proposals (${named(ids)}) for one payment; reject ${named(extras)} so only ${m.payout.proposal_id} can be paid`;
    }
    const [approve, ...reject] = audit.live;
    return `#${m.issue} has ${ids.length} payout proposals (${named(ids)}) for one payment and its recorded proposal ${m.payout.proposal_id} is ${m.payout.status}; approve ${approve} and reject ${named(reject)} so the task can be paid once`;
  }
  const [adopted] = audit.approved;
  const tail = adopted === m.payout.proposal_id
    ? `${adopted} was approved, so reject ${named(audit.live)}`
    : `${adopted} was approved and the payment is recorded with it, so reject ${named(audit.live)}`;
  return `#${m.issue} has ${ids.length} payout proposals (${named(ids)}) for one payment; ${tail}`;
}

/**
 * Why no payout of this job may be voted or closed over while duplicates
 * stand, or null: one sentence per task holding more than one matching
 * proposal, whatever its recorded payout's status. The one check the
 * approval panel, the payout sweep and payout.mjs approve all read.
 */
export async function duplicatePayoutProblem(job, proposals = null) {
  const recorded = job.members.filter(m => m.payout);
  if (recorded.length === 0) return null;
  const recent = proposals ?? (await recentProposals(job));
  const problems = recorded.map(m => duplicateProblem(m, duplicateAudit(recent, m))).filter(Boolean);
  // A capped read cannot vouch for a duplicate past where it stopped: a
  // complete audit is the only one money can move on.
  if (job.number != null && capped.has(job.number)) problems.unshift(auditCappedProblem());
  return problems.join("; ") || null;
}

/** What a payout proposal says: Trezu shows `title` and links `url`, the task. */
export const proposalDescription = (jobNumber, m) => JSON.stringify({
  title: `Job #${jobNumber}: ${m.title}`,
  notes: `MultiAgency payout to ${m.payee} for signed-off work on issue #${m.issue}`,
  url: m.url,
});

// Whether a proposal is the one task m's payout would move on: same payee,
// amount, token and task url. A proposal's kind, description, receiver and
// amount never change once filed, only its status does — so this holds
// forever once it holds at all, whatever the proposal goes on to do.
function matchesPayout(p, m) {
  const transfer = p.kind?.Transfer;
  let url = null;
  try { url = JSON.parse(p.description).url; } catch {}
  return Boolean(transfer && transfer.token_id === USDC && transfer.receiver_id === m.payee && transfer.amount === m.amount && url === m.url);
}

/**
 * Every proposal already filed for this task that money could still move on:
 * the same task, payee, amount and token, its status still InProgress or
 * Approved. More than one means two coordinators raced to file it, and
 * approving both would pay the task twice.
 */
function matchingProposals(proposals, m) {
  return proposals.filter(p => matchesPayout(p, m) && !DEAD.includes(p.status));
}

/**
 * A live proposal already filed for this task: the same task, payee, amount
 * and token. A run whose reply was lost after the proposal landed must not
 * file a second one, which could be paid twice.
 */
export function filedProposal(proposals, m) {
  return matchingProposals(proposals, m)[0] ?? null;
}

const PAGE = 100;
// Pages one read may take, so one very old job cannot stall a coordinator
// cycle: 1000 proposals past wherever its audit has reached.
export const AUDIT_PAGE_CAP = 10;
const capped = new Map();
// A job's audit in progress: how far past its floor it has scanned for a
// match, and every match found so far (never the recorded proposal alone —
// any other proposal that moves the same payment). Kept across calls so a
// read that falls short of the treasury's tip picks up where the last one
// stopped instead of paying for the same ground twice — a fixed floor beside
// a treasury that only grows would otherwise never finish even one audit.
const scans = new Map();

/** Jobs whose last payout audit stopped at the page cap, for /api/health. */
export const payoutAuditCapped = () => [...capped.values()];

/** Forget every job's audit progress, as a restart would: nothing here is
 * durable, so a caller that wants a clean read starts one by calling this. */
export const resetPayoutAudit = () => { scans.clear(); capped.clear(); };

/** Why a capped read must hold every payout of the job, regardless of what it found. */
const auditCappedProblem = () =>
  `the payout audit stopped at its page cap (${AUDIT_PAGE_CAP * PAGE} proposals past wherever it last reached); payouts hold until it can read every proposal up to the treasury's tip`;

/**
 * The treasury's proposals that move a job's own payouts, from its audit
 * floor up to the newest. Without a job the 100 newest are read, in one page,
 * for proposePayouts' own duplicate check. With a job, the read is one that
 * resumes: each call scans at most AUDIT_PAGE_CAP more pages from wherever
 * the job's audit last stopped, so a treasury that has grown far past a job's
 * floor is covered over however many calls it takes rather than never, and a
 * read that reaches the treasury's tip keeps the ground it covered for next
 * time instead of paying to cover it again — but never more than that: a hop
 * only tells a finished read from a capped one by landing past the tip, so
 * what is remembered as covered is clamped to the tip itself, and whatever is
 * filed in that overshoot before the next call is read then, not skipped as
 * already scanned. A page is kept against every member's payee, amount and
 * url, not only those with a payout recorded so far, so a duplicate filed for
 * a task before that task's own payout is recorded is still remembered the
 * first time its page is read. A match already found has its status re-read
 * fresh on every call, since scanning past its page does not freeze it — a
 * dead one (rejected, failed, expired or removed) is forgotten, since that
 * never changes again. A read that still falls short of the tip is reported
 * through payoutAuditCapped.
 */
async function recentProposals(job = null) {
  const last = await view(network.treasury, "get_last_proposal_id", {});
  if (!job) {
    const from = Math.max(0, last - PAGE);
    return view(network.treasury, "get_proposals", { from_index: from, limit: PAGE });
  }
  const floor = payoutFloor(job) ?? Math.max(0, last - PAGE);
  // A new floor — a task's payout just recorded with a lower id than any scan
  // has covered — owes ground no scan has read; starting over is the only way
  // to be sure of it.
  let scan = scans.get(job.number);
  if (!scan || scan.floor !== floor) scan = { floor, next: floor, matches: new Map() };
  let next = scan.next;
  for (let pages = 0; next <= last && pages < AUDIT_PAGE_CAP; pages++) {
    const page = await view(network.treasury, "get_proposals", { from_index: next, limit: PAGE });
    for (const p of page) if (job.members.some(m => !isVolunteer(m) && matchesPayout(p, m))) scan.matches.set(p.id, p);
    next += PAGE;
  }
  for (const id of [...scan.matches.keys()]) {
    const fresh = await proposalState(network.treasury, id);
    if (DEAD.includes(fresh.status)) scan.matches.delete(id);
    else scan.matches.set(id, fresh);
  }
  scan.next = Math.min(next, last);
  scans.set(job.number, scan);
  if (next > last) capped.delete(job.number);
  else capped.set(job.number, { job: job.number, pages: AUDIT_PAGE_CAP, from_index: scan.next, at: new Date().toISOString() });
  return [...scan.matches.values()];
}

// How far below a job's earliest recorded proposal the audit reads: two
// coordinators race to file within moments, so a duplicate's id sits beside
// the proposal it repeats, whatever the treasury's total has grown to.
const AUDIT_MARGIN = 25;

/** The proposal id a job's payout audit must see past, or null. */
const payoutFloor = job => {
  const ids = job.members.map(m => m.payout?.proposal_id).filter(Number.isFinite);
  return ids.length ? Math.min(...ids) - AUDIT_MARGIN : null;
};

/** File one proposal per paid task that has none, reusing any already on chain. Check payoutProblem first. */
export async function proposePayouts(job, signer, log = console.log) {
  // Volunteer tasks file nothing and read nothing: the sweep skips them whole.
  const targets = job.members.filter(m => !m.payout && !isVolunteer(m));
  if (targets.length === 0) return;
  const recent = await recentProposals();
  for (const m of targets) {
    const filed = filedProposal(recent, m);
    let proposalId = filed?.id;
    let hash = null;
    if (!filed) {
      const proposal = {
        description: proposalDescription(job.number, m),
        kind: { Transfer: { token_id: USDC, receiver_id: m.payee, amount: m.amount, msg: null } },
      };
      // add_proposal burns about 3 Tgas; the default 100 Tgas would reserve 0.1 NEAR per call.
      ({ hash, value: proposalId } = await call(signer, network.treasury, "add_proposal", { proposal }, { gas: "30000000000000" }));
    }
    const trezu = trezuRequestLink(proposalId);
    await comment(m.issue, [
      `**Payout proposed:** DAO proposal ${proposalId} on \`${network.treasury}\` transfers ${Number(m.amount) / 1e6} USDC to \`${m.payee}\`${trezu ? ` ([review in Trezu](${trezu}))` : ""}.`,
      "",
      fence("payout", { proposal_id: proposalId, treasury: network.treasury, payee: m.payee, amount: m.amount, proposed_tx: hash }),
    ].join("\n"));
    log(`#${m.issue}: proposal ${proposalId}${filed ? " (already on chain)" : ""}`);
  }
}

/**
 * One comment per task holding more than one matching proposal for its
 * payout, whatever its recorded proposal's status: while any duplicate is
 * still live, the comment asks an approver to reject it; when the payment
 * has moved to (or was made by) an approved proposal, it says which one the
 * task's payment now stands on; and where two were approved, that the task
 * was paid more than once. Said once per wording, so the sweep repeats
 * nothing; a further duplicate changes the ids and is named by a fresh
 * comment. Returns the tasks paid more than once, for /api/health.
 */
export async function flagDuplicateProposals(job, bot, log = console.log) {
  const recorded = job.members.filter(m => m.payout);
  if (recorded.length === 0) return [];
  const recent = await recentProposals(job);
  const doubles = [];
  for (const m of recorded) {
    const audit = duplicateAudit(recent, m);
    const ids = [...audit.approved, ...audit.live];
    if (audit.approved.length > 1) {
      doubles.push({ issue: m.issue, proposals: audit.approved });
      const body = `**Double payout:** DAO proposals ${named(ids)} on \`${network.treasury}\` were all approved for this task's payment of ${Number(m.amount) / 1e6} USDC to \`${m.payee}\`; it was paid more than once, and no further payment will be recorded for it.`;
      const said = (await comments(m.issue)).some(c => c.user.login === bot && c.body === body);
      if (!said) {
        await comment(m.issue, body);
        log(`#${m.issue}: proposals ${named(ids)} were all approved for one payment; the task was paid more than once`);
      }
      continue;
    }
    if (ids.length < 2) continue;
    const extras = audit.approved.length === 0
      ? audit.live.filter(id => id !== m.payout.proposal_id)
      : audit.live;
    const tail = audit.approved.length === 0
      ? (LIVE.includes(m.payout.status)
        ? `Approve ${m.payout.proposal_id} alone and reject ${named(extras)}, so this task cannot be paid twice.`
        : `Its recorded proposal ${m.payout.proposal_id} is ${m.payout.status}; approve ${audit.live[0]} and reject ${named(audit.live.slice(1))}, so this task cannot be paid twice.`)
      : audit.approved[0] === m.payout.proposal_id
        ? `Proposal ${audit.approved[0]} was approved; reject ${named(extras)}, so this task cannot be paid twice.`
        : `Proposal ${audit.approved[0]} was approved, so the payment is recorded with it; reject ${named(extras)}, so this task cannot be paid twice.`;
    const body = [
      `**Duplicate payout proposals:** DAO proposals ${named(ids)} on \`${network.treasury}\` each pay this task ${Number(m.amount) / 1e6} USDC to \`${m.payee}\`.`,
      tail,
    ].join(" ");
    const said = (await comments(m.issue)).some(c => c.user.login === bot && c.body === body);
    if (said) continue;
    await comment(m.issue, body);
    log(`#${m.issue}: proposals ${named(ids)} stand for one payout; flagged for the extras' rejection`);
  }
  return doubles;
}

/**
 * Record each payment an approver has voted through, from the treasury's
 * history. The payment follows the proposal that was actually approved: the
 * task's recorded one when that is the one, otherwise an approved duplicate
 * is adopted as the payment and the recorded proposal becomes the one to
 * reject. Where two or more matching proposals were approved, the task was
 * paid twice and nothing records until a person has sorted the recovery out.
 */
export async function recordApprovals(job, log = console.log) {
  const owing = job.members.filter(m => m.payout && !m.paid);
  if (owing.length === 0) return;
  const recent = await recentProposals(job);
  if (capped.has(job.number)) {
    log(`#${job.number}: payout audit stopped at its page cap; recording nothing until it can read every proposal`);
    return;
  }
  for (const m of owing) {
    const { approved } = duplicateAudit(recent, m);
    if (approved.length > 1) {
      log(`#${m.issue}: proposals ${named(approved)} were all approved for one payment; the task was paid more than once, recording nothing`);
      continue;
    }
    if (approved.length === 0) continue;
    // A proposal found on chain rather than filed here has no transaction of
    // ours; the job's deposit is earlier than any vote on it. A job opened
    // from the board has no deposit transaction at all — it can only carry
    // volunteer tasks, so this line is unreachable for one — and searches
    // from the treasury's first block rather than throw.
    const anchor = m.payout.proposed_tx ?? job.engagement.deposit.transaction;
    const from = anchor ? await txBlockHeight(anchor) : 0;
    const approval = await findApproval(approved[0], from);
    if (!approval) {
      log(`#${m.issue}: proposal ${approved[0]} is Approved but its vote is not indexed yet`);
      continue;
    }
    // The paid record names the proposal the payment really ran on, which a
    // duplicate approved beside a still-live recorded one is.
    const adopted = approved[0] === m.payout.proposal_id
      ? m
      : { ...m, payout: { ...m.payout, proposal_id: approved[0] } };
    await recordPaid(adopted, approval);
    log(`#${m.issue}: paid ${m.amount} to ${m.payee}, proposal ${approved[0]} approved by ${approval.approver}` +
      (approved[0] === m.payout.proposal_id ? "" : ` (adopted over the recorded proposal ${m.payout.proposal_id})`));
  }
}

/**
 * Close the job once every task is paid — volunteer tasks settle once
 * delivered. Returns what an undelivered volunteer task holds against the
 * close, or null once the job closes (or already stood closed, or a paid
 * task still waits on its payout, which payoutProblem's hold already names).
 */
export async function closeIfPaid(jobNumber, log = console.log) {
  const current = await loadEngagement(jobNumber);
  if (current.members.some(m => !m.paid && !isVolunteer(m))) return null;
  // A volunteer's work is never proposed or paid, so for it this close is the
  // only delivery check: callers reach it without payoutProblem (the
  // coordinator without a proposer, payout.mjs reconcile and approve), and a
  // job must not complete over an undelivered or edited volunteer task.
  const held = await volunteerProblem(current.members);
  if (held) return held;
  // A payment with a matching proposal still standing beside it — live, or a
  // second approval — must not close the job: the extra is still votable,
  // and voting it pays the task again.
  const duplicated = await duplicatePayoutProblem(current);
  if (duplicated) return duplicated;
  if (current.state === "open") {
    // A job opened from the board has no deposit behind it: its completion
    // says so, where a paid job's names its payouts.
    const complete = current.engagement.channel === "board"
      ? "**Job complete.** Its tasks were volunteer work; no payouts were made."
      : `**Job complete.** ${current.members.filter(m => m.paid).length} payouts executed from \`${network.treasury}\` (${Number(current.totals.committed) / 1e6} USDC); ${Number(current.totals.margin) / 1e6} USDC of the deposit remains with MultiAgency.`;
    await comment(jobNumber, complete);
    await github("PATCH", `/issues/${jobNumber}`, { state: "closed", state_reason: "completed" });
    log(`#${jobNumber}: closed`);
  }
  // Closed now or earlier: drop `blocked`, record each delivery.
  const settled = await settleEpic(jobNumber);
  if (settled) log(`#${jobNumber}: settled (${Object.keys(settled).join(", ")})`);
  // Nothing will call recentProposals for this job again; its audit progress
  // would otherwise sit in memory for as long as the process runs.
  scans.delete(jobNumber);
  capped.delete(jobNumber);
  return null;
}
