// Whole cron runs of worker.mjs, spawned for real (#169): the Claude SDK is
// a stub the test writes into a copy of the worker folder, the board is a
// local HTTP server speaking just the routes the worker reads and writes —
// its seat is a real issue captured from GitHub (test/fixtures/github/,
// task-issue-58.json) so selection reads GitHub's own response shape —
// and git is the real one — reached through PATH shims that rewrite the
// github.com URLs the delivery uses onto bare repositories on this disk and
// answer the registry's checks without running them. So a run that saves,
// resumes, hands back or cleans up is observed end to end: what it pushed,
// what it posted, and what its prompt said.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { HAND_BACK_FIRST_LINE } from "../agents/claude-worker/code-mode.mjs";

const execFile = promisify(execFileCb);

const workerDir = join(new URL("..", import.meta.url).pathname, "agents", "claude-worker");
const realGit = (await execFile("which", ["git"])).stdout.trim();
// The seat every run works on: an issue captured from the board itself
// (test/fixtures/github/README.md) — claimed, in progress, skill:code, its
// terms naming near-agencies — so the routes task selection reads return
// GitHub's own shapes, not hand-written ones.
const capturedSeat = JSON.parse(readFileSync(new URL("./fixtures/github/task-issue-58.json", import.meta.url), "utf8"));

// The stub SDK: query() hands each run to a scenario module of the test's
// choosing (STUB_SCENARIO), which plays the model — cloning, editing files,
// ending however the test needs. zod is stubbed to the one call worker.mjs
// makes building its own tool.
const SDK_STUB = `
import { pathToFileURL } from "node:url";
export const createSdkMcpServer = ({ tools }) => ({ name: "stub", tools });
export const tool = (name, description, input, fn) => ({ name, description, input, fn });
export async function* query(args) {
  const scenario = await import(pathToFileURL(process.env.STUB_SCENARIO));
  yield* scenario.query(args);
}
`;
const ZOD_STUB = `export const z = { string: () => ({ describe: () => ({}) }) };`;

// The spawned run's git answers to the delivery's clean config, not to the
// operator's (worker.mjs assigns gitEnv once the code skill is on) — spelled
// out here too, so a signing setup of this machine cannot reach into the
// test's commits and wait on a key.
const cleanGit = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_TERMINAL_PROMPT: "0",
};

// Two PATH shims. git's is the real git with the delivery's github.com URLs
// mapped onto local bare repositories; bash's answers the registry's checks
// without running them, failing exactly the ones CHECKS_FAIL names. Both log
// every call for the tests.
const gitShim = () => `#!/bin/bash
args=()
for a in "$@"; do
  case "$a" in
    https://github.com/MultiAgency/near-agencies|https://github.com/MultiAgency/near-agencies.git)
      a="$FAKE_UPSTREAM" ;;
    https://github.com/agency-builder/near-agencies|https://github.com/agency-builder/near-agencies.git)
      a="$FAKE_FORK" ;;
  esac
  args+=("$a")
done
case ",$FAIL_RESUME_CHECKOUT," in *,1,*)
  for a in "\${args[@]}"; do
    case "$a" in refs/remotes/*) exit 42 ;; esac
  done ;;
esac
printf '=== git %s\\n' "\${args[*]}" >> "$SHIM_LOG"
exec "$GIT_REAL" "\${args[@]}"
`;
const bashShim = () => `#!/bin/bash
printf '=== bash %s\\n' "$*" >> "$SHIM_LOG"
cmd="$2"
case ",$CHECKS_FAIL," in *",$cmd,"*) exit 1 ;; esac
exit 0
`;

// The stub board: the routes task selection reads, the comment write a
// refusal or a hand-back makes, and the skill the prompt appends. Every
// request is recorded, so a test can hold the run to what it may not do.
async function boardStub() {
  const state = { seats: [], threads: {}, posts: [], requests: [] };
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (url.pathname === "/skill.md") return json(res, 200, { note: "do the work well" });
      if (url.pathname === "/repos/MultiAgency/kanban-sandbox/issues" && url.search.includes("state=open")) {
        return json(res, 200, state.seats);
      }
      const on = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/(comments|events)$/);
      // Reads carry per_page=100; the one write (a refusal or a hand-back)
      // posts the comment body with no query at all.
      if (on && (url.search.includes("per_page=100") || (req.method === "POST" && on[2] === "comments"))) {
        const number = Number(on[1]);
        if (on[2] === "events") return json(res, 200, []);
        if (req.method === "GET") return json(res, 200, state.threads[number] ?? []);
        if (req.method === "POST") {
          const id = 1000 + state.posts.length;
          const comment = {
            id,
            user: { login: "agency-builder" },
            body: JSON.parse(body).body,
            html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}#issuecomment-${id}`,
            created_at: new Date().toISOString(),
          };
          state.posts.push({ number, body: comment.body });
          (state.threads[number] ??= []).push(comment);
          return json(res, 201, comment);
        }
      }
      return json(res, 404, { message: `unexpected ${req.method} ${url.pathname}` });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// One harness per test: the copied worker with its stub SDK, the PATH shims,
// two bare repositories standing in for near-agencies and the agent's fork,
// and the stub board with seat #14 assigned. spawn() runs one cron run.
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "worker-run-"));
  const app = join(dir, "app");
  const bin = join(dir, "bin");
  const out = join(dir, "scenario-out");
  await mkdir(app, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(out, { recursive: true });
  for (const file of await readdir(workerDir)) {
    if (file.endsWith(".mjs")) await copyFile(join(workerDir, file), join(app, file));
  }
  for (const [name, main, body] of [
    ["@anthropic-ai/claude-agent-sdk", "index.mjs", SDK_STUB],
    ["zod", "index.mjs", ZOD_STUB],
  ]) {
    const pkg = join(app, "node_modules", name);
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name, type: "module", main }));
    await writeFile(join(pkg, main), body);
  }
  await writeFile(join(bin, "git"), gitShim(), { mode: 0o755 });
  await writeFile(join(bin, "bash"), bashShim(), { mode: 0o755 });

  const upstream = join(dir, "upstream.git");
  const fork = join(dir, "fork.git");
  for (const bare of [upstream, fork]) {
    await execFile("git", ["init", "--bare", "--initial-branch=staging", bare], { env: { ...process.env, ...cleanGit } });
  }
  const seed = join(dir, "seed");
  const seedEnv = { ...process.env, ...cleanGit, GIT_AUTHOR_NAME: "agency-builder", GIT_AUTHOR_EMAIL: "agency-builder@users.noreply.github.com", GIT_COMMITTER_NAME: "agency-builder", GIT_COMMITTER_EMAIL: "agency-builder@users.noreply.github.com" };
  await execFile("git", ["clone", upstream, seed], { env: seedEnv });
  await writeFile(join(seed, "README.md"), "# scratch\n");
  await execFile("git", ["add", "-A"], { cwd: seed, env: seedEnv });
  await execFile("git", ["commit", "-m", "seed staging"], { cwd: seed, env: seedEnv });
  await execFile("git", ["push", "origin", "staging"], { cwd: seed, env: seedEnv });

  const board = await boardStub();
  board.state.seats.push(capturedSeat);
  board.state.threads[capturedSeat.number] = [];

  const identity = {
    ...cleanGit,
    GIT_AUTHOR_NAME: "agency-builder",
    GIT_AUTHOR_EMAIL: "agency-builder@users.noreply.github.com",
    GIT_COMMITTER_NAME: "agency-builder",
    GIT_COMMITTER_EMAIL: "agency-builder@users.noreply.github.com",
  };
  const env = {
    ...process.env,
    ...identity,
    AGENT_LOGIN: "agency-builder",
    NEAR_ACCOUNT: "agency-builder.testnet",
    AGENT_SKILLS: "code",
    CODE_ACCESS: "branch",
    GH_TOKEN: "stub-token",
    ANTHROPIC_API_KEY: "stub-key",
    BOARD: "MultiAgency/kanban-sandbox",
    BOARD_BOT: "multi-agency",
    GITHUB_API_URL: board.url,
    SKILL_URL: `${board.url}/skill.md`,
    FAKE_UPSTREAM: upstream,
    FAKE_FORK: fork,
    GIT_REAL: realGit,
    SHIM_LOG: join(dir, "shim-calls.log"),
    SCENARIO_OUT: out,
    PATH: `${bin}:${process.env.PATH}`,
  };

  const spawn = async (scenario, extraEnv = {}) => {
    const k = spawn.count++;
    const scenarioFile = join(dir, `scenario-${k}.mjs`);
    await writeFile(scenarioFile, scenario);
    const { stdout } = await execFile(process.execPath, [join(app, "worker.mjs")], {
      cwd: app,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...env, ...extraEnv, STUB_SCENARIO: scenarioFile },
    });
    // The scenario copies the prompt it was given to one file; a run whose
    // model never started (nothing to do) leaves the previous one in place.
    const prompt = await readFile(join(out, "prompt.txt"), "utf8").catch(() => null);
    return { stdout, prompt };
  };
  spawn.count = 0;

  return {
    dir, board, env, spawn, upstream, fork,
    gitCalls: async () =>
      (await readFile(env.SHIM_LOG, "utf8")).split("\n").filter(l => l.startsWith("=== ")).map(l => l.slice(4)),
    refs: async remote =>
      (await execFile("git", ["ls-remote", remote])).stdout.trim().split("\n").filter(Boolean)
        .map(l => l.split("\t")[1]).filter(n => n.startsWith("refs/")),
    tipMessage: async (remote, branch) => {
      await execFile("git", ["fetch", "--depth=1", remote, branch], { cwd: seed });
      return (await execFile("git", ["show", "-s", "--format=%B", "FETCH_HEAD"], { cwd: seed })).stdout;
    },
    cleanup: async () => {
      await board.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// The scenario modules: what the model does, played locally. Each copies the
// prompt it was given where the test can read it, works the way the shipping
// instructions tell it to, and ends with the result the test is about.

// Reads, clones, works, commits one checkpoint — and stops at the turn limit
// with a change still uncommitted.
const SCENARIO_STOPS = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await run("git", ["clone", "--branch", "staging", process.env.FAKE_UPSTREAM, "."], { cwd: options.cwd, env: process.env });
  await run("git", ["checkout", "-b", "task-58"], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "WORK.md"), "step one\\n");
  await run("git", ["add", "-A"], { cwd: options.cwd, env: process.env });
  await run("git", ["commit", "-m", "step: wrote the change, left the tests unrun"], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "UNCOMMITTED.md"), "half a step\\n");
  await writeFile(join(options.cwd, "deliverable.md"), "the comment draft the old habit left loose\\n");
  yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } };
  yield { type: "result", subtype: "error_max_turns", num_turns: 61, total_cost_usd: 2.41, result: "" };
}
`;

// A resumed run: another checkpoint on top of what it found, then the turn
// limit again — the tree moves, so the attempts are not spent.
const SCENARIO_RESUMES = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await writeFile(join(options.cwd, "MORE.md"), "step two\\n");
  await run("git", ["add", "-A"], { cwd: options.cwd, env: process.env });
  await run("git", ["commit", "-m", "step: added the second file, left the lint"], { cwd: options.cwd, env: process.env });
  yield { type: "result", subtype: "error_max_turns", num_turns: 58, total_cost_usd: 1.9, result: "" };
}
`;

// A resumed run that only reads: the tree it saves is the one it started
// from, so the attempts are spent and the task is handed back.
const SCENARIO_STUCK = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  yield { type: "result", subtype: "error_max_turns", num_turns: 60, total_cost_usd: 2, result: "" };
}
`;

// A round change: the model starts at the base branch again, because the
// round is new and the saved work belongs to the old one.
const SCENARIO_NEW_ROUND = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await run("git", ["clone", "--branch", "staging", process.env.FAKE_UPSTREAM, "."], { cwd: options.cwd, env: process.env });
  await run("git", ["checkout", "-b", "task-58"], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "REWORK.md"), "the new round's work\\n");
  yield { type: "result", subtype: "error_max_turns", num_turns: 12, total_cost_usd: 0.5, result: "" };
}
`;

// The fallback: the saved branch was found but could not be set up, so the
// run starts at the base branch and works there — and ends unfinished, with
// work that never saw what the saved branch holds.
const SCENARIO_FALLBACK = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await run("git", ["clone", "--branch", "staging", process.env.FAKE_UPSTREAM, "."], { cwd: options.cwd, env: process.env });
  await run("git", ["checkout", "-b", "task-58"], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "FALLBACK.md"), "work that never saw the saved branch\\\\n");
  yield { type: "result", subtype: "error_max_turns", num_turns: 9, total_cost_usd: 0.4, result: "" };
}
`;

// A model call that failed: the SDK ends the run with subtype "success"
// carrying is_error, and nothing was delivered — reproduced 2026-10-07 with
// the worker's SDK (0.3.283): an out-of-credit API error reads exactly so.
const SCENARIO_MODEL_ERROR = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await run("git", ["clone", "--branch", "staging", process.env.FAKE_UPSTREAM, "."], { cwd: options.cwd, env: process.env });
  await run("git", ["checkout", "-b", "task-58"], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "WORK.md"), "written before the model call failed\\\\n");
  yield { type: "result", subtype: "success", is_error: true, num_turns: 4, total_cost_usd: 0.31, result: "API Error: Your credit balance is too low" };
}
`;

// The delivery: push the branch, end in success — the worker then has a
// saved branch to delete.
const SCENARIO_DELIVERS = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await writeFile(join(options.cwd, "FINAL.md"), "finished\\n");
  await run("git", ["add", "-A"], { cwd: options.cwd, env: process.env });
  await run("git", ["commit", "-m", "finish the change"], { cwd: options.cwd, env: process.env });
  await run("git", ["push", "-u", "origin", "task-58"], { cwd: options.cwd, env: process.env });
  yield { type: "result", subtype: "success", num_turns: 44, total_cost_usd: 2.8, result: "delivered" };
}
`;

// The model stops cleanly without pushing — for example after saying it
// cannot do the work. The SDK reports success; nothing was delivered.
const SCENARIO_GIVES_UP = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await writeFile(join(options.cwd, "PARTIAL.md"), "started, then stopped\\n");
  yield { type: "result", subtype: "success", num_turns: 7, total_cost_usd: 0.5, result: "I cannot finish this task." };
}
`;

// A run that starts at task-58's head on the remote (a revision round
// starts at the pull request's head), changes files, and stops cleanly
// without committing or pushing.
const SCENARIO_ON_HEAD_NO_PUSH = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await run("git", ["clone", "--branch", "task-58", process.env.FAKE_UPSTREAM, "."], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "REVISION.md"), "a revision never committed\\n");
  yield { type: "result", subtype: "success", num_turns: 12, total_cost_usd: 0.9, result: "done, I think" };
}
`;

// The SDK itself throws mid-run — the crash the worker used to die of.
// The turn limit as the SDK delivers it in production (agency-builder,
// 2026-10-07 08:08Z): a result with subtype error_max_turns, then a throw
// ("Claude Code returned an error result: Reached maximum number of turns").
const SCENARIO_RESULT_THEN_THROWS = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await run("git", ["clone", "--branch", "staging", process.env.FAKE_UPSTREAM, "."], { cwd: options.cwd, env: process.env });
  await run("git", ["checkout", "-b", "task-58"], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "WORK.md"), "most of the change\\n");
  yield { type: "result", subtype: "error_max_turns", num_turns: 61, total_cost_usd: 1.34, result: "" };
  throw new Error("Claude Code returned an error result: Reached maximum number of turns (60)");
}
`;

const SCENARIO_THROWS = `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function* query({ options, prompt }) {
  await writeFile(join(process.env.SCENARIO_OUT, "prompt.txt"), prompt);
  await run("git", ["clone", "--branch", "staging", process.env.FAKE_UPSTREAM, "."], { cwd: options.cwd, env: process.env });
  await run("git", ["checkout", "-b", "task-58"], { cwd: options.cwd, env: process.env });
  await writeFile(join(options.cwd, "WORK.md"), "thrown-away?\\n");
  yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm ci" } }] } };
  throw new Error("Connection error");
}
`;

// The shim logs every call; the saves and the cleanup are the pushes that
// name the branch, which is how the tests tell them from the preflight's
// dry-run probe.
const wipPush = l => l.startsWith("git push") && l.includes("wip/task-58");

describe("a spawned cron run of worker.mjs, end to end (#169)", () => {
  test("a run that stops at the turn limit leaves a work-in-progress push, the run recorded, and no pull request", async () => {
    const h = await harness();
    try {
      const { prompt } = await h.spawn(SCENARIO_STOPS, { CHECKS_FAIL: "npm ci" });
      assert.match(prompt, /git clone --branch staging/, "a fresh run is told to set the clone up itself");
      assert.deepEqual(await h.refs(h.upstream), ["refs/heads/staging", "refs/heads/wip/task-58"],
        "only the wip branch exists besides staging: no pull request head");
      const tip = await h.tipMessage(h.upstream, "wip/task-58");
      assert.match(tip, /^wip: task #58 run 1 saved unfinished/);
      assert.match(tip, /error_max_turns after 61 turns at \$2\.41/);
      assert.match(tip, /Checks: npm ci failed; 2 checks were not run\./,
        "the note records which registry check fails, and what the stop left untried");
      assert.deepEqual(h.board.state.posts, [], "a run with attempts left posts nothing");
      assert.match((await h.gitCalls()).at(-1), /^git push --force origin HEAD:refs\/heads\/wip\/task-58$/);
      assert.match(prompt, /Write each comment to a file in `\.board\/`/,
        "the drafts go where the save will not stage them");
      const savedTip = await mkdtemp(join(tmpdir(), "saved-tip-"));
      try {
        await execFile("git", ["clone", "--quiet", "--branch", "wip/task-58", h.upstream, savedTip]);
        await readFile(join(savedTip, "UNCOMMITTED.md"), "utf8"); // the uncommitted work is in the save
        await assert.rejects(() => readFile(join(savedTip, "deliverable.md"), "utf8"),
          "the loose comment draft stayed out of the commit a resumed delivery would push");
      } finally {
        await rm(savedTip, { recursive: true, force: true });
      }
    } finally {
      await h.cleanup();
    }
  });

  test("the next run starts from the saved branch, with the previous run's note in its prompt", async () => {
    const h = await harness();
    try {
      await h.spawn(SCENARIO_STOPS);
      const pushesBefore = (await h.gitCalls()).filter(wipPush).length;
      const { prompt } = await h.spawn(SCENARIO_RESUMES);
      assert.match(prompt, /The repository is already cloned in this directory/,
        "the resumed run is not told to set the clone up");
      assert.equal(prompt.includes("git clone"), false, "and is not given a clone command at all");
      assert.match(prompt, /A previous run of this task stopped unfinished/);
      assert.match(prompt, /wip: task #58 run 1 saved unfinished/, "the note the last run left is quoted");
      assert.match(prompt, /multiagency-run: /, "with the run's record in it");
      const pushes = (await h.gitCalls()).filter(wipPush);
      assert.equal(pushes.length, pushesBefore + 1, "the resumed save pushed once more");
      assert.match(pushes.at(-1), /^git push origin HEAD:refs\/heads\/wip\/task-58$/,
        "no force: the remote tip is this chain's own ancestor");
      const tip = await h.tipMessage(h.upstream, "wip/task-58");
      assert.match(tip, /^wip: task #58 run 2 saved unfinished/);
      assert.deepEqual(h.board.state.posts, [], "progress keeps the attempts unspent");
    } finally {
      await h.cleanup();
    }
  });

  test("two runs with no new work hand the task back once, without unassigning, and the seat is not selected again that round", async () => {
    const h = await harness();
    try {
      await h.spawn(SCENARIO_STOPS);            // run 1: tree T1
      await h.spawn(SCENARIO_RESUMES);          // run 2: tree T2, progress
      const before = h.board.state.posts.length;
      await h.spawn(SCENARIO_STUCK);            // run 3: tree T3 = T2
      assert.equal(h.board.state.posts.length, before + 1, "one comment, on the run that spent the attempts");
      const [handBack] = h.board.state.posts.slice(-1);
      assert.match(handBack.body, new RegExp(`^${HAND_BACK_FIRST_LINE}`));
      assert.match(handBack.body, /no new work/);
      assert.match(handBack.body, /wip\/task-58/, "names the branch the work waits on");
      assert.match(handBack.body, /wip: task #58 run 3 saved unfinished/, "quotes the last note");
      assert.equal(handBack.body.includes("```handoff"), false,
        "a hand-back must never read as a handoff to the coordinator");
      const posts = h.board.state.posts.length;
      const pushes = (await h.gitCalls()).filter(wipPush).length;
      const { stdout } = await h.spawn(SCENARIO_STUCK);
      assert.match(stdout, /worker: nothing to do/, "the seat waits for the release, not for this agent");
      assert.equal(h.board.state.posts.length, posts, "the hand-back is not posted twice");
      assert.equal((await h.gitCalls()).filter(wipPush).length, pushes,
        "and no run touched the branch again");
      assert.match(await h.tipMessage(h.upstream, "wip/task-58"), /^wip: task #58 run 3 saved unfinished/,
        "no further run saved over it");
    } finally {
      await h.cleanup();
    }
  });

  test("a round change ignores the old branch: the new round's first save replaces it", async () => {
    const h = await harness();
    try {
      await h.spawn(SCENARIO_STOPS);
      h.board.state.threads[58].push({
        id: 9001,
        user: { login: "multi-agency" },
        body: "Once more:\n```changes\naddress the review\n```",
        html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/58#issuecomment-9001",
        created_at: new Date().toISOString(),
      });
      const { prompt } = await h.spawn(SCENARIO_NEW_ROUND);
      assert.match(prompt, /The reviewer asked for another round/, "the run knows it is a revision");
      assert.match(prompt, /```changes comment by @multi-agency/, "and names the credited round's comment");
      assert.equal(prompt.includes("already cloned in this directory"), false,
        "the old round's save is not resumed");
      assert.equal(prompt.includes("multiagency-run: "), false, "and its note does not reach this prompt");
      assert.match((await h.gitCalls()).filter(wipPush).at(-1), /^git push --force origin HEAD:refs\/heads\/wip\/task-58$/);
      const tip = await h.tipMessage(h.upstream, "wip/task-58");
      assert.match(tip, /^wip: task #58 run 1 saved unfinished \(the revision round opened by comment 9001\)/,
        "the ledger starts over: this round's first unfinished run");
    } finally {
      await h.cleanup();
    }
  });

  test("a saved branch whose setup failed starts no model run, so nothing is paid for or pushed over", async () => {
    const h = await harness();
    try {
      await h.spawn(SCENARIO_STOPS);
      const pushesBefore = (await h.gitCalls()).filter(wipPush).length;
      const { stdout } = await h.spawn(SCENARIO_FALLBACK, { FAIL_RESUME_CHECKOUT: "1" });
      assert.match(stdout, /worker: #58 not run: the saved work on wip\/task-58 could not be set up/,
        "the failed setup is said, and the run stops there");
      assert.equal(/worker: error_max_turns on #58 after 9 turns/.test(stdout), false,
        "no model run: a run from the base branch could neither save nor count");
      assert.equal((await h.gitCalls()).filter(wipPush).length, pushesBefore,
        "no push touched the branch: not to force it over, not to update it");
      assert.match(await h.tipMessage(h.upstream, "wip/task-58"), /^wip: task #58 run 1 saved unfinished/,
        "the first run's save is still the ledger the next run resumes");
      assert.deepEqual(h.board.state.posts, [], "nothing posted: the next cron run tries the setup again");
      const { prompt: retried } = await h.spawn(SCENARIO_RESUMES);
      assert.match(retried, /already cloned in this directory/, "once the setup works, the next run resumes the saved work");
    } finally {
      await h.cleanup();
    }
  });

  test("a clean success that never pushed its work is unfinished: the work is saved, not deleted", async () => {
    const h = await harness();
    try {
      await h.spawn(SCENARIO_STOPS);
      const { stdout } = await h.spawn(SCENARIO_GIVES_UP);
      assert.match(stdout, /worker: success on #58 after 7 turns/, "the SDK said success");
      assert.match(stdout, /worker: #58 ended in success, but this run did not move task-58 on the remote to its work: saving it as unfinished/);
      assert.deepEqual(await h.refs(h.upstream), ["refs/heads/staging", "refs/heads/wip/task-58"],
        "the saved branch is kept: no delivery reached the remote");
      assert.match(await h.tipMessage(h.upstream, "wip/task-58"), /^wip: task #58 run 2 saved unfinished \(the first round\): success, undelivered after 7 turns/,
        "the run is recorded as unfinished and counts toward the attempts");
    } finally {
      await h.cleanup();
    }
  });

  test("a run that starts at the pull request's head and pushes nothing is not a delivery, however clean its end", async () => {
    const h = await harness();
    try {
      await h.spawn(SCENARIO_STOPS);
      await h.spawn(SCENARIO_DELIVERS);
      const tip = (await h.refs(h.upstream)).includes("refs/heads/task-58");
      assert.ok(tip, "a delivery left task-58 on the remote: the pull request's head");
      const { stdout } = await h.spawn(SCENARIO_ON_HEAD_NO_PUSH);
      assert.match(stdout, /worker: #58 ended in success, but this run did not move task-58 on the remote to its work: saving it as unfinished/,
        "its HEAD equals task-58, yet it moved nothing");
      assert.deepEqual(await h.refs(h.upstream), ["refs/heads/staging", "refs/heads/task-58", "refs/heads/wip/task-58"],
        "its uncommitted work is saved, and the delivered head is untouched");
      assert.match(await h.tipMessage(h.upstream, "wip/task-58"), /^wip: task #58 run 2 saved unfinished \(the first round\): success, undelivered after 12 turns/,
        "and the run counts toward the attempts, after the one saved earlier this round");
    } finally {
      await h.cleanup();
    }
  });

  test("a delivered run deletes the saved branch", async () => {
    const h = await harness();
    try {
      await h.spawn(SCENARIO_STOPS);
      const { prompt } = await h.spawn(SCENARIO_DELIVERS);
      assert.match(prompt, /already cloned in this directory/, "the delivery resumed the saved work");
      assert.deepEqual(await h.refs(h.upstream), ["refs/heads/staging", "refs/heads/task-58"],
        "the branch is deleted; only the delivered pull request head is left");
      const calls = await h.gitCalls();
      assert.match(calls.filter(wipPush).at(-1), /^git push origin --delete wip\/task-58$/);
      assert.deepEqual(h.board.state.posts, []);
    } finally {
      await h.cleanup();
    }
  });

  test("a model call that failed reads as unfinished: the errored success saves instead of deleting, and the log says failed", async () => {
    const h = await harness();
    try {
      const { stdout } = await h.spawn(SCENARIO_MODEL_ERROR);
      assert.match(stdout, /worker: failed \(success\) on #58 after 4 turns, \$0\.31/,
        "the result line reads failed — the subtype alone never passes for a delivery");
      assert.match(stdout, /Your credit balance is too low/, "the log carries the result text");
      assert.equal(stdout.includes("worker: success on #58"), false);
      assert.deepEqual(await h.refs(h.upstream), ["refs/heads/staging", "refs/heads/wip/task-58"],
        "an errored success delivered nothing: its work is saved, not cleaned up");
      const tip = await h.tipMessage(h.upstream, "wip/task-58");
      assert.match(tip, /^wip: task #58 run 1 saved unfinished/);
      assert.match(tip, /failed \(success\) after 4 turns at \$0\.31/, "so does the note the next run reads");
      assert.match(tip, /"subtype":"success","isError":true/);
      assert.deepEqual(h.board.state.posts, []);
    } finally {
      await h.cleanup();
    }
  });

  test("a run that hits the turn limit and then throws keeps its result in the save note", async () => {
    const h = await harness();
    try {
      const { stdout } = await h.spawn(SCENARIO_RESULT_THEN_THROWS);
      assert.match(stdout, /worker: error_max_turns on #58 after 61 turns, \$1\.34/);
      assert.match(stdout, /worker: the model run threw: .*Reached maximum number of turns/);
      const tip = await h.tipMessage(h.upstream, "wip/task-58");
      assert.match(tip, /^wip: task #58 run 1 saved unfinished \(the first round\): error_max_turns after 61 turns at \$1\.34/,
        "the note keeps how the run ended, not \"ended without a result\"");
      assert.match(tip, /"subtype":"error_max_turns"/);
    } finally {
      await h.cleanup();
    }
  });

  test("a run the SDK throws out no longer crashes the worker: its work is saved too", async () => {
    const h = await harness();
    try {
      const { prompt } = await h.spawn(SCENARIO_THROWS, { CHECKS_FAIL: "npm ci" });
      assert.notEqual(prompt, null, "the worker caught the throw and exited cleanly");
      assert.deepEqual(await h.refs(h.upstream), ["refs/heads/staging", "refs/heads/wip/task-58"]);
      const tip = await h.tipMessage(h.upstream, "wip/task-58");
      assert.match(tip, /^wip: task #58 run 1 saved unfinished/);
      assert.match(tip, /"subtype":"thrown"/);
      assert.match(tip, /Checks: npm ci failed/);
    } finally {
      await h.cleanup();
    }
  });
});
