// Every script is run by a test (problem #130): each `scripts/*.mjs` and each
// top-level CLI is spawned once, the way a live run starts it — as
// test/payout-tool.test.mjs was the first — with an input that makes it exit
// early and cleanly without touching the network: `--help`, a missing
// required argument, or a missing GITHUB_EVENT_PATH. The entry asserts the
// expected exit code and a stderr free of load-time crashes — a
// ReferenceError, a SyntaxError, a "before initialization" — the class of
// defect the lib-only tests miss, because importing a script's library never
// runs the script (the describe-before-initialization in
// scripts/staging-approval.mjs reached staging's first live run).
//
// One entry goes further than its startup: scripts/staging-approval.mjs runs
// decide() itself against the stubbed fetch in
// test/fixtures/github-decide-stub.mjs, so the hold log whose describe() call
// crashed production is reached by CI, not by staging.
//
// The list is explicit on purpose: the last test fails when a new
// scripts/*.mjs shows up without a smoke entry here. A script with no clean
// early exit gets the smallest one — a usage message on missing input, as
// connector.mjs and agent.mjs got — rather than a skip.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// A load-time crash reads as one of these on stderr, whatever the script's own
// error handling prints around it.
const CRASH = /ReferenceError|SyntaxError|before initialization/;
const TIMEOUT_MS = 30_000;

// Spawn arguments per entry point: the input that exits early, the exit code
// it exits with, and what its own message on that path says (stderr, or stdout
// for a `--help` that prints usage). `drop` names environment variables the
// spawn must not inherit — the absence the early exit answers, or a value a
// GitHub Actions runner sets (GITHUB_EVENT_PATH) that would send the script
// on to the network.
const ENTRIES = [
  {
    file: "scripts/operator-approval.mjs",
    drop: ["GITHUB_EVENT_PATH"],
    code: 1,
    stderr: /operator-approval: .*failing closed/,
  },
  {
    // The missing-event exit stops at the event read, so this entry runs the
    // script through decide() itself: the stubbed fetch answers GitHub for
    // one open pull request that changes no file, the run holds (a hold
    // decides nothing and posts nothing), and its log line calls describe() —
    // the call that crashed production with a "before initialization" (#130).
    file: "scripts/staging-approval.mjs",
    stubbed: true,
    code: 0,
    stdout: [/staging-approval hold on #1/, /internal 1 member/],
  },
  {
    // The same run started by an edited pull request (#168), whose body now
    // carries a tool attribution line: the edit's own hold takes down the
    // reviewer's approval standing at its head.
    file: "scripts/staging-approval.mjs",
    stubbed: true,
    event: { action: "edited", pull_request: { number: 1 } },
    set: { STUB_ATTRIBUTION: "1" },
    code: 0,
    stdout: [/staging-approval hold on #1 at \w+: .*tool attribution/, /dismissed @multai-builder's approval 99 on #1/],
  },
  {
    // An edit whose hold is not the edit's doing (the pull request changes no
    // file) leaves the approval alone.
    file: "scripts/staging-approval.mjs",
    stubbed: true,
    event: { action: "edited", pull_request: { number: 1 } },
    code: 0,
    stdout: /staging-approval hold on #1/,
    notStdout: /dismissed/,
  },
  {
    // A read in decide() that throws on an edit (here the commit list) still
    // takes the standing approval down: an approval never stands over a body
    // the gate has not re-read. The run fails red (exit 1) as any broken read does.
    file: "scripts/staging-approval.mjs",
    stubbed: true,
    event: { action: "edited", pull_request: { number: 1 } },
    set: { STUB_ATTRIBUTION: "1", STUB_COMMITS_FAIL: "1" },
    code: 1,
    stdout: /dismissed @multai-builder's approval 99 on #1/,
    stderr: /pull request #1: .*500/,
  },
  {
    // The same failed read on a run that no edit started leaves the approval:
    // a transient read there schedules a new run, as it always has.
    file: "scripts/staging-approval.mjs",
    stubbed: true,
    set: { STUB_ATTRIBUTION: "1", STUB_COMMITS_FAIL: "1" },
    code: 1,
    notStdout: /dismissed/,
    stderr: /pull request #1: .*500/,
  },
  {
    // On an edit, a read that fails without throwing also takes the standing
    // approval down (#168): the team's member list answers 500 through
    // readTeam's retries and comes back null, so the hold is not the edit's
    // doing — but the approval would stand over the body's attribution line,
    // which the gate could not finish reading.
    file: "scripts/staging-approval.mjs",
    stubbed: true,
    event: { action: "edited", pull_request: { number: 1 } },
    set: { STUB_ATTRIBUTION: "1", STUB_TEAM_FAIL: "1" },
    code: 0,
    stdout: [/staging-approval hold on #1 at \w+: .*team internal could not be read/, /dismissed @multai-builder's approval 99 on #1/],
  },
  {
    // The same failed team read on a run no edit started dismisses nothing:
    // the approval stands until an edit or a push starts a run of its own.
    file: "scripts/staging-approval.mjs",
    stubbed: true,
    set: { STUB_TEAM_FAIL: "1" },
    code: 0,
    stdout: /staging-approval hold on #1/,
    notStdout: /dismissed/,
  },
  {
    file: "scripts/registry-backfill.mjs",
    drop: ["REGISTRY_URL", "REGISTRY_TOKEN"],
    code: 1,
    stderr: /REGISTRY_URL is not set/,
  },
  { file: "scripts/replay-check.mjs", code: 64, stderr: /usage:/ },
  { file: "scripts/decide-source.mjs", code: 64, stderr: /usage:/ },
  { file: "scripts/review-rounds.mjs", args: ["--help"], code: 0, stdout: /usage:/ },
  { file: "roster.mjs", code: 64, stderr: /usage:/ },
  { file: "payout.mjs", code: 64, stderr: /usage:/ },
  { file: "assemble.mjs", code: 64, stderr: /usage:/ },
  { file: "org.mjs", code: 64, stderr: /usage:/ },
  { file: "connector.mjs", args: ["--help"], code: 0, stdout: /usage:/ },
  { file: "agent.mjs", args: ["--help"], code: 0, stdout: /usage:/ },
];

const env = (drop, set) => {
  const copied = { ...process.env };
  for (const name of drop ?? []) delete copied[name];
  return { ...copied, ...set };
};

// The environment for the stubbed staging-approval run: the fetch stub loads
// before the script does, the token names nothing real (every GitHub read
// lands on the stub), and the event carries one open pull request so
// openCandidates picks it up without a network read.
const stubbedEnv = (eventPath, set = {}) => env([], {
  ...set,
  NODE_OPTIONS: `--import ${pathToFileURL(join(ROOT, "test/fixtures/github-decide-stub.mjs")).href}`,
  GITHUB_TOKEN: "test-token",
  SANDBOX_REPO: "MultiAgency/near-agencies",
  ROSTER_URL: "http://127.0.0.1:4021/api",
  GITHUB_EVENT_PATH: eventPath,
});

for (const entry of ENTRIES) {
  test(`${entry.file}${entry.event ? ` (${entry.event.action} event${entry.set ? ", with a stubbed condition" : ""})` : entry.set ? " (with a stubbed condition)" : ""} exits ${entry.code} on its smoke input, with no load-time crash`, () => {
    let eventDir = null;
    try {
      if (entry.stubbed) {
        eventDir = mkdtempSync(join(tmpdir(), "staging-approval-smoke-"));
        writeFileSync(join(eventDir, "event.json"), JSON.stringify(entry.event ?? {
          workflow_run: { name: "ci", head_sha: "0".repeat(40), pull_requests: [{ number: 1 }] },
        }));
      }
      const run = spawnSync(process.execPath, [join(ROOT, entry.file), ...(entry.args ?? [])], {
        env: entry.stubbed ? stubbedEnv(join(eventDir, "event.json"), entry.set) : env(entry.drop),
        encoding: "utf8",
        timeout: TIMEOUT_MS,
      });
      assert.equal(run.status, entry.code, `${entry.file}: stderr was:\n${run.stderr}`);
      for (const pattern of [].concat(entry.stderr ?? [])) assert.match(run.stderr, pattern);
      for (const pattern of [].concat(entry.stdout ?? [])) assert.match(run.stdout, pattern);
      for (const pattern of [].concat(entry.notStdout ?? [])) assert.doesNotMatch(run.stdout, pattern);
      assert.doesNotMatch(String(run.stderr), CRASH);
    } finally {
      if (eventDir) rmSync(eventDir, { recursive: true, force: true });
    }
  });
}

// The server listens (every module in its graph loads, mounts, and reaches
// app.listen) and then stops cleanly on the SIGTERM a deployment sends it —
// server.mjs exits 0 on that signal on purpose, so a replaced deployment does
// not read as a crash. PORT=0 binds an ephemeral loopback port; with
// REGISTRY_URL and COORDINATOR unset nothing reads the board or the registry
// during startup.
test("server.mjs listens and stops cleanly on SIGTERM, with no load-time crash", async () => {
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    env: env(["FACILITATOR_URL", "COORDINATOR", "REGISTRY_URL", "GITHUB_EVENT_PATH"], { PORT: "0", HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  let stdout = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  const listened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server.mjs did not listen within ${TIMEOUT_MS} ms; stdout:\n${stdout}stderr:\n${stderr}`)), TIMEOUT_MS);
    child.stdout.on("data", () => {
      if (stdout.includes("MultiAgency demo on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server.mjs exited before it listened (code ${code}, signal ${signal}); stderr:\n${stderr}`));
    });
  });
  await listened;
  child.kill("SIGTERM");
  const stopped = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const enforcer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const { code } = await stopped;
  clearTimeout(enforcer);
  assert.equal(code, 0, `SIGTERM should exit 0; stderr was:\n${stderr}`);
  assert.doesNotMatch(stderr, CRASH);
});

test("every scripts/*.mjs has a smoke entry above", () => {
  const listed = new Set(ENTRIES.filter(entry => entry.file.startsWith("scripts/")).map(entry => basename(entry.file)));
  const missing = readdirSync(join(ROOT, "scripts")).filter(name => name.endsWith(".mjs") && !listed.has(name));
  assert.deepEqual(missing, [], `no smoke entry for ${missing.map(name => `scripts/${name}`).join(", ")} — add one to ENTRIES in test/scripts-smoke.test.mjs, with an input that exits early and cleanly (add the smallest early exit to the script itself when it has none)`);
});
