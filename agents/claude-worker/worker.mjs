// A MultiAgency task worker built on the Claude Agent SDK. It knows nothing
// about MultiAgency's code: each run reads the published skill.md and follows
// it. One run handles at most one task:
//
//   deliver  a task assigned to this agent with no handoff since the last
//            change request: do the work, post the deliverable and handoff
//   claim    otherwise, the first ready task this agent may claim: /claim it
//
// Finding that work is a few GitHub reads; Claude runs only when there is some.
// Run it on a schedule (see README); --dry-run only names the task.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { accessFor, allowedTools, codeAccess, deliversCodeSeat, handBackComment, ship, termsOf, SDK_SETTINGS } from "./code-mode.mjs";
import { nextTask as selectTask } from "./next-task.mjs";
import { gitEnv, probeDelivery } from "./preflight.mjs";
import { deleteSaved, deliveredHead, deliveryRemote, handBackReason, resumableWork, saveUnfinished, setupResume, taskTip, wipBranchOf } from "./resume.mjs";
import { codeRepo } from "./repos.mjs";

const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const login = env("AGENT_LOGIN");
// The board's coordinator bot: a ```changes comment counts as a new revision
// round only when the coordinator wrote it, and every block a round is owed
// to is its own — it posts the block itself when it routes a reviewer's
// request (trust.mjs). Defaults to this deployment's coordinator; set it
// when yours is another account.
const bot = process.env.BOARD_BOT ?? "multi-agency";
const nearAccount = env("NEAR_ACCOUNT");
const skills = env("AGENT_SKILLS").split(",").map(s => s.trim());
// Code mode: how an agent with the code skill ships its branch — "fork" (its
// own fork, an outside contributor) or "branch" (near-agencies itself, an
// internal contributor). Null without the code skill.
const codeMode = codeAccess(skills, process.env.CODE_ACCESS);
// The toolchain this image carries: the Dockerfile sets WORKER_TOOLCHAIN to
// the TOOLCHAIN it was built with (node by default), and the registry's
// image per repository decides which code seats this run may take
// (next-task.mjs).
const toolchain = process.env.WORKER_TOOLCHAIN ?? "node";
const board = process.env.BOARD ?? "MultiAgency/kanban-sandbox";
// Where the board's API lives: the real GitHub unless another root answers
// for it (a GitHub Enterprise root, or the stub the spawned tests run
// against). gh keeps its own host setting; only these two fetches read it.
const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const skillUrl = process.env.SKILL_URL ?? "https://demo.multiagency.ai/skill.md";
const model = process.env.MODEL ?? "claude-sonnet-5";
const maxBudgetUsd = Number(process.env.MAX_BUDGET_USD ?? "3");
// A house agent sets this so it claims a task only after others have had it
// for a while: it is the fallback that finishes a job, not the first in line.
const claimAfterMs = Number(process.env.CLAIM_AFTER_MINUTES ?? "0") * 60_000;
const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
env("GH_TOKEN");
if (!dryRun) env("ANTHROPIC_API_KEY");
// git ships a code task's work as the agent: gh (holding GH_TOKEN) is its
// only credential helper, injected through the environment together with a
// clean git config so no system or operator setting — a stored keychain
// entry, say — can answer first or leak another identity into a push. Every
// commit is authored as the agent, and a failed authentication fails
// instead of hanging the run waiting for input. The delivery preflight runs
// under this same environment (preflight.mjs's gitEnv, its one definition),
// so the check and the push it clears answer to the same credentials.
if (codeMode) Object.assign(process.env, gitEnv(login));

async function github(path) {
  const response = await fetch(`${api}/repos/${board}${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub GET ${path}: ${response.status}`);
  return response.json();
}

// Posts a comment on a seat: the one board write the task selection makes,
// the refusal a run without code mode leaves on an assigned skill:code seat.
async function comment(number, body) {
  const response = await fetch(`${api}/repos/${board}/issues/${number}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`GitHub POST comment: ${response.status}`);
}

// The selection itself lives in next-task.mjs, which imports nothing but the
// dependency-free code-mode.mjs and trust.mjs: the repository's tests can run
// it from the root, where this folder's dependencies are not installed.
const nextTask = () =>
  selectTask({ github, comment, login, skills, codeMode, bot, claimAfterMs, dryRun, toolchain, probe: probeDelivery });

// Hashing is the one step easy to get subtly wrong in a shell, so the worker
// provides it as a tool: sha256 of the comment body exactly as GitHub stores it.
const helpers = createSdkMcpServer({
  name: "multiagency",
  tools: [
    tool("deliverable_sha256", "sha256 (hex) of a board comment's body exactly as GitHub stores it, for the handoff's deliverable.sha256.",
      { comment_url: z.string().describe("The deliverable comment URL, ending in #issuecomment-<id>") },
      async ({ comment_url }) => {
        const id = comment_url.match(/#issuecomment-(\d+)$/)?.[1];
        if (!id) return { content: [{ type: "text", text: "Not a comment URL ending in #issuecomment-<id>." }], isError: true };
        const { body } = await github(`/issues/comments/${id}`);
        return { content: [{ type: "text", text: createHash("sha256").update(body).digest("hex") }] };
      }),
  ],
});

// Where a resumed prompt says the previous run stopped: the commits it made
// after the round's base, then the note its save left. Both were read by the
// worker's own code (resume.mjs) — the model runs no git to see them, so
// nothing joins the allowlist for this.
const stoppedAt = resume =>
  [
    "A previous run of this task stopped unfinished; this clone starts from the branch it saved, and the work it finished is already here.",
    "",
    "What it did, its commits newest first:",
    "",
    ...resume.log.trimEnd().split("\n").map(l => `  ${l}`),
    "",
    "The note its last commit carries (what that run was, and which checks failed):",
    "",
    ...resume.note.trimEnd().split("\n").map(l => `  ${l}`),
    "",
    "Continue the work from what is here: whatever those commits already did is done.",
  ].join("\n");

function instructions(task, resume = null) {
  const n = task.seat.number;
  // With code mode off, an assigned skill:code seat cannot be delivered:
  // the shipping steps would name commands the run is not allowed to run.
  const code = Boolean(codeMode) && deliversCodeSeat(task);
  // The registry entry for the repository this delivery ships to, and how it
  // pushes its branch there: the selection (next-task.mjs) has already
  // refused a code seat this run cannot ship, so this parses.
  const repo = code ? codeRepo(termsOf(task.seat)) : null;
  // The revision sentence names the credited round's comment — the
  // coordinator's own, which nextTask() returns — never "the latest":
  // whatever ```changes block anyone else posted after it must not steer
  // the run.
  const revisionNote = round =>
    round
      ? ` The reviewer asked for another round (the ${"```"}changes comment by @${round.user.login}: ${round.html_url}): address every point in it in a new deliverable.`
      : "";
  const doing = task.action === "claim"
    ? `Claim task #${n}: comment exactly \`/claim\` on it, then stop. The coordinator assigns it; a later run does the work.`
    : code
      ? [
          `Deliver task #${n}, which is assigned to you.${revisionNote(task.round)}`,
          "Read the task, the job it names, and the deliverables of any tasks it depends on. Do the work, citing sources inline as links.",
          ...ship(accessFor(repo, codeMode), repo, n, login, task.revision, task.reviewed, Boolean(resume)),
          `Then post the deliverable comment, naming the pull request, get its sha256 with the deliverable_sha256 tool, and post the handoff comment, exactly as the rules say. The coordinator closes the task once the handoff checks out.`,
        ].join("\n")
      : [
          `Deliver task #${n}, which is assigned to you.${revisionNote(task.round)}`,
          "Read the task, the job it names, and the deliverables of any tasks it depends on. Do the work, citing sources inline as links.",
          `Then post the deliverable comment, get its sha256 with the deliverable_sha256 tool, and post the handoff comment, exactly as the rules say. The coordinator closes the task once the handoff checks out.`,
        ].join("\n");
  return [
    `You are @${login}, an AI agent on the MultiAgency roster with skills ${skills.join(", ")}. Your roster NEAR account, for payout.account_id, is ${nearAccount}.`,
    "",
    doing,
    ...(resume ? ["", stoppedAt(resume)] : []),
    "",
    `Use \`gh\` for GitHub; it is authenticated as you. The board is ${board}: pass \`--repo ${board}\`. Write each comment to a file in \`.board/\` (create it if it is missing), never loose in this directory, and post it with \`gh issue comment ${n} --repo ${board} --body-file .board/<file>\`, which prints the new comment's URL.`,
    "Work on this one task only. If you cannot do the work, comment on the task saying why, and stop.",
  ].join("\n");
}

// The one line of an error worth a worker log: git and the SDK both write
// multi-line errors, and the second line onward is rarely more than detail.
const oneLine = error => String(error?.stack ?? error).split("\n")[0].slice(0, 200);

async function run() {
  const task = await nextTask();
  if (!task) return console.log("worker: nothing to do");
  console.log(`worker: ${task.action} #${task.seat.number}${task.revision ? " (revision)" : ""}`);
  if (dryRun) return;
  // Only a run with code mode (the agent listed the code skill and chose a
  // CODE_ACCESS) that is delivering a skill:code seat gets the git
  // environment, the shipping instructions and the code tools. A run without
  // code mode never gets here on a skill:code seat: nextTask() refused it
  // once and moved on to what this run can deliver.
  const code = Boolean(codeMode) && deliversCodeSeat(task);
  // The repository this delivery ships to, as the selection gated it: the
  // tools list the registry's checks for it, and the branch goes to a fork
  // for any repository but near-agencies (accessFor).
  const repo = code ? codeRepo(termsOf(task.seat)) : null;
  const skill = await (await fetch(skillUrl)).text();
  const n = task.seat.number;
  const access = code ? accessFor(repo, codeMode) : null;
  const round = task.round?.id ?? 0;
  const cwd = await mkdtemp(join(tmpdir(), `seat-${n}-`));
  // A code run continues what an unfinished one saved (#169): the branch
  // wip/task-n holds the work of every run that stopped, and a save from
  // this very round means this clone starts there instead of at the base.
  // A setup that fails starts no model run at all: a run from the base
  // branch could neither save (that would overwrite the round's saved work)
  // nor count toward the attempts, so it would be paid for and repeated with
  // nothing to show. The next cron run tries the setup again, at no cost.
  let resume = null;
  if (code) {
    try {
      const found = await resumableWork({ remote: deliveryRemote(access, repo, login), n, round });
      if (found) {
        resume = {
          round,
          ...await setupResume({
            remote: deliveryRemote(access, repo, login), forkFetch: access === "fork"
              ? [`https://github.com/${repo.name}.git`, repo.base]
              : null,
            baseBranch: repo.base, n, resume: found, cwd,
          }),
        };
        console.log(`worker: #${n} continues run ${found.record.run} of this round (${wipBranchOf(n)})`);
      }
    } catch (error) {
      // Nothing is posted: a setup that keeps failing costs no model runs,
      // and with no passing handoff the coordinator's stale release (#166)
      // reopens the task after CLAIM_TTL_HOURS, which is the escalation.
      console.log(`worker: #${n} not run: the saved work on ${wipBranchOf(n)} could not be set up (${oneLine(error)}); the next run tries again`);
      await rm(cwd, { recursive: true, force: true });
      return;
    }
  }
  // What the model run ended with: the result message's fields, or the
  // marker of a run the SDK threw out — which used to crash this process
  // with the clone's work still in it.
  let ended = null;
  // Where task-n stood before the model run: a delivery is a run that moved
  // it (deliveredHead), which a revision round's clone, starting at the pull
  // request's head, cannot fake by stopping without a push.
  const tipBefore = code ? await taskTip({ remote: deliveryRemote(access, repo, login), n }) : undefined;
  try {
    for await (const message of query({
      prompt: instructions(task, resume),
      options: {
        cwd,
        model,
        maxBudgetUsd,
        maxTurns: 60,
        settingSources: [],
        settings: SDK_SETTINGS,
        systemPrompt: { type: "preset", preset: "claude_code", append: `\n\n# The MultiAgency rules (${skillUrl})\n\n${skill}` },
        mcpServers: { multiagency: helpers },
        tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
        permissionMode: "dontAsk",
        allowedTools: allowedTools(access, repo, n, login, task.reviewed),
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") console.log(`  tool ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
        }
      } else if (message.type === "result") {
        // A model call that fails still ends the run with subtype "success"
        // and is_error: true (an out-of-credit API error reads exactly so),
        // and nothing was delivered — so the run counts as failed, both in
        // this log and in what the settle below does with the clone.
        ended = { subtype: message.subtype, isError: Boolean(message.is_error), turns: message.num_turns, cost: message.total_cost_usd };
        console.log(ended.isError
          ? `worker: failed (${message.subtype}) on #${n} after ${message.num_turns} turns, $${message.total_cost_usd.toFixed(2)}`
          : `worker: ${message.subtype} on #${n} after ${message.num_turns} turns, $${message.total_cost_usd.toFixed(2)}`);
        if (ended.isError) {
          if (message.result) console.log(message.result);
        } else if (message.subtype === "success") console.log(message.result);
      }
    }
  } catch (error) {
    // The SDK also throws after a result that ended the run short (the turn
    // limit, a failed call): the result already says how the run ended, with
    // its turns and cost, so it stands, and only a throw with no result is
    // recorded as one.
    ended ??= { subtype: "thrown" };
    console.log(`worker: the model run threw: ${oneLine(error)}`);
  } finally {
    // The clone goes either way; what a code run leaves behind depends on
    // how it ended. Delivered — a clean success that moved task-n on the
    // remote to this clone's HEAD — leaves the saved branch nothing to hold,
    // and it is deleted. Anything else — out of turns, out of budget, thrown,
    // a failed model call (the SDK reports one as a success carrying
    // is_error), or a clean success that pushed nothing — the worker's own
    // code saves to wip/task-n before the clone is removed, and hands the
    // task back once its attempts are spent (#169). A save that finds the
    // round's saved work on the remote without having started from it saves
    // nothing, rather than overwrite it. A save that cannot run at all (the
    // model never cloned, git failed) leaves the run as it was.
    try {
      const clean = code && ended?.subtype === "success" && !ended.isError;
      const delivered = clean && await deliveredHead({ remote: deliveryRemote(access, repo, login), n, cwd, before: tipBefore });
      if (delivered) {
        await deleteSaved({ remote: deliveryRemote(access, repo, login), n, cwd });
      } else if (code && ended) {
        // A clean success whose work never reached task-n on the remote — the
        // model stopped short of pushing — is unfinished like any other.
        if (clean) console.log(`worker: #${n} ended in success, but this run did not move task-${n} on the remote to its work: saving it as unfinished`);
        const saved = await saveUnfinished({
          remote: deliveryRemote(access, repo, login), n, round,
          resumed: Boolean(resume), cwd, repo,
          subtype: clean ? "success, undelivered" : ended.subtype, isError: ended.isError, turns: ended.turns, cost: ended.cost,
        });
        if (saved.skipped) {
          console.log(`worker: #${n} saved nothing: ${wipBranchOf(n)} still holds this round's saved work, this run did not start from it, and pushing would overwrite it — it waits there for the next run to resume`);
        } else {
          const reason = handBackReason({
            saves: saved.run,
            sameTree: saved.previousTree !== null && saved.tree === saved.previousTree,
          });
          if (reason) {
            await comment(n, handBackComment({
              n,
              branch: wipBranchOf(n),
              remote: access === "fork" ? `${login}/${repo.name.split("/")[1]}` : repo.name,
              reason,
              note: saved.message,
            }));
            console.log(`worker: #${n} handed back: ${reason}`);
          }
        }
      }
    } catch (error) {
      console.log(`worker: the end of the run could not be settled (${oneLine(error)})`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

await run();
