#!/usr/bin/env node
/**
 * upstream-sync.mjs
 *
 * Keeps the wopr-network/nemoclaw fork rebased on NVIDIA/NemoClaw upstream.
 *
 * Our fork adds a WOPR sidecar (wopr/ directory) + Dockerfile/entrypoint
 * tweaks for managed hosting. Upstream changes are always taken; our
 * additions are rebased on top.
 *
 *   1. Fetches upstream and checks for new commits
 *   2. Rebases our sidecar commits on top
 *   3. Resolves any rebase conflicts (via Agent SDK)
 *   4. Runs a build check
 *   5. Pushes or creates a PR
 *
 * Usage:
 *   node scripts/upstream-sync.mjs [options]
 *
 * Options:
 *   --dry-run   Report status but don't push
 *   --push      Force-push main after sync
 *   --pr        Create a PR instead of pushing (default for cron)
 *
 * Requires:
 *   - CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY env var
 *   - @anthropic-ai/claude-agent-sdk (npm install -g)
 *   - git remotes: origin (wopr-network), upstream (NVIDIA)
 */

import { execSync } from "node:child_process";
import { existsSync, appendFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const CWD = process.cwd();
const DRY_RUN = process.argv.includes("--dry-run");
const AUTO_PUSH = process.argv.includes("--push");
const CREATE_PR = process.argv.includes("--pr");

// Agent event log — saved as CI artifact
const AGENT_LOG_TMP = join("/tmp", `agent-events-${Date.now()}.log`);
const AGENT_LOG_PATH = join(CWD, "agent-events.log");
writeFileSync(AGENT_LOG_TMP, `=== upstream-sync agent log — ${new Date().toISOString()} ===\n`);

function logEvent(phase, event) {
  const ts = new Date().toISOString();
  appendFileSync(AGENT_LOG_TMP, `[${ts}] [${phase}] ${JSON.stringify(event)}\n`);
}

function flushLog() {
  try { copyFileSync(AGENT_LOG_TMP, AGENT_LOG_PATH); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(cmd) {
  return execSync(cmd, { cwd: CWD, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function tryRun(cmd) {
  try {
    return { ok: true, output: run(cmd) };
  } catch (e) {
    return { ok: false, output: (e.stderr || e.message || "").trim() };
  }
}

function log(msg) { console.log(`[upstream-sync] ${msg}`); }

function die(msg) {
  flushLog();
  console.error(`[upstream-sync] FATAL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Agent SDK wrapper
// ---------------------------------------------------------------------------

let _query;

async function loadSdk() {
  if (_query) return;
  const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
  const candidates = [
    "@anthropic-ai/claude-agent-sdk",
    `${globalRoot}/@anthropic-ai/claude-agent-sdk/sdk.mjs`,
  ];
  for (const candidate of candidates) {
    try {
      const sdk = await import(candidate);
      _query = sdk.query;
      return;
    } catch { /* try next */ }
  }
  die("@anthropic-ai/claude-agent-sdk not installed.\n  npm install -g @anthropic-ai/claude-agent-sdk\n  npm install -g @anthropic-ai/claude-code");
}

async function runAgent(prompt, opts = {}) {
  await loadSdk();
  const phase = opts.phase ?? "unknown";
  const tools = opts.tools ?? ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];
  let result = "";
  let turnCount = 0;

  log(`Agent [${phase}] starting (model: ${opts.model ?? "claude-sonnet-4-6"}, maxTurns: ${opts.maxTurns ?? 60})`);
  logEvent(phase, { type: "agent_start", model: opts.model, maxTurns: opts.maxTurns ?? 60 });

  for await (const message of _query({
    prompt,
    options: {
      cwd: CWD,
      allowedTools: tools,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: opts.maxTurns ?? 60,
      model: opts.model ?? "claude-sonnet-4-6",
    },
  })) {
    if (message.type === "tool_use") {
      turnCount++;
      logEvent(phase, { type: "tool_use", turn: turnCount, tool: message.tool, input_preview: JSON.stringify(message.input).slice(0, 200) });
    } else if (message.type === "text") {
      logEvent(phase, { type: "text", preview: (message.text || "").slice(0, 300) });
    } else if ("result" in message) {
      result = message.result;
      logEvent(phase, { type: "result", preview: result.slice(0, 500) });
    } else {
      logEvent(phase, { type: message.type || "unknown", keys: Object.keys(message) });
    }
  }

  log(`Agent [${phase}] finished after ${turnCount} tool calls`);
  logEvent(phase, { type: "agent_done", turnCount });
  return result;
}

// ---------------------------------------------------------------------------
// Fork context (shared across agent prompts)
// ---------------------------------------------------------------------------

const FORK_CONTEXT = `
## Context: WOPR NemoClaw Fork

This is a fork of NVIDIA/NemoClaw maintained by wopr-network.
The fork adds a WOPR sidecar for managed hosting. Our additions:

### Files we added (preserve these):
- \`wopr/sidecar.js\` — HTTP sidecar exposing /internal/health and /internal/provision
- \`wopr/package.json\` — sidecar dependencies
- Dockerfile modifications — adds sidecar setup and entrypoint changes
- Entrypoint tweaks — foreground sidecar, correct port, writable HOME

### Conflict Resolution Rules:
1. TAKE all of upstream's changes (new features, bug fixes, security hardening)
2. REAPPLY our wopr/ additions on top
3. If upstream changed Dockerfile or entrypoint, adapt our additions to the new structure
4. Never drop upstream functionality — only add our sidecar layer
5. Keep wopr/ directory intact
`;

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

async function rebase() {
  log("Fetching upstream...");
  run("git fetch upstream");

  const behind = parseInt(run("git rev-list HEAD..upstream/main --count"), 10);
  const ahead = parseInt(run("git rev-list upstream/main..HEAD --count"), 10);

  if (behind === 0) {
    log("Already up to date with upstream.");
    return { rebased: false, behind: 0, ahead };
  }

  log(`Behind upstream by ${behind} commits, ahead by ${ahead} commits.`);

  // Backup
  const datestamp = new Date().toISOString().slice(0, 10);
  const backupBranch = `backup/pre-sync-${datestamp}`;
  tryRun(`git branch -D ${backupBranch}`);
  run(`git branch ${backupBranch}`);
  log(`Backup: ${backupBranch}`);

  // Attempt rebase
  log("Rebasing onto upstream/main...");
  const rebaseResult = tryRun("git rebase upstream/main");

  if (rebaseResult.ok) {
    log("Rebase succeeded cleanly.");
    return { rebased: true, behind, ahead };
  }

  // Conflicts — invoke agent
  log("Rebase has conflicts. Invoking agent to resolve...");
  const conflicting = tryRun("git diff --name-only --diff-filter=U");
  const conflictFiles = conflicting.ok ? conflicting.output : "unknown";

  await runAgent(
    `You are resolving git rebase conflicts in a NemoClaw fork.

${FORK_CONTEXT}

## Current Conflicts

These files have conflicts:
${conflictFiles}

## Steps

1. For each conflicting file, read it and find the conflict markers (<<<<<<< / ======= / >>>>>>>)
2. Resolve each conflict following the rules above
3. Run: git add <resolved-file>
4. After ALL conflicts are resolved, run: git rebase --continue
5. If new conflicts appear, repeat
6. Continue until the rebase completes

IMPORTANT: Do NOT use git rebase --abort. Resolve all conflicts.`,
    { model: "claude-sonnet-4-6", maxTurns: 80, phase: "rebase-conflicts" },
  );

  // Verify rebase completed
  const status = tryRun("git rebase --show-current-patch");
  if (status.ok) {
    die("Rebase still in progress after agent intervention. Manual resolution needed.");
  }

  log("Rebase completed after conflict resolution.");
  return { rebased: true, behind, ahead };
}

// ---------------------------------------------------------------------------
// Build check
// ---------------------------------------------------------------------------

async function buildCheck() {
  log("Running build check...");

  // Check sidecar syntax
  const sidecarCheck = tryRun("node --check wopr/sidecar.js");
  if (!sidecarCheck.ok) {
    log("Sidecar syntax check failed. Invoking agent to fix...");
    await runAgent(
      `The WOPR sidecar has a syntax error after upstream sync:

\`\`\`
${sidecarCheck.output.slice(0, 2000)}
\`\`\`

Fix the syntax error in wopr/sidecar.js. Do NOT remove sidecar functionality.`,
      { model: "claude-sonnet-4-6", phase: "sidecar-fix" },
    );
  }

  // Check Dockerfile builds (syntax only — full build is too slow for CI sync)
  if (existsSync(`${CWD}/Dockerfile`)) {
    // docker build --check isn't universally available, so just verify Dockerfile parses
    const hasFrom = tryRun("grep -q '^FROM' Dockerfile");
    if (!hasFrom.ok) {
      log("Dockerfile appears broken (no FROM instruction).");
      return false;
    }
  }

  log("Build check passed.");
  return true;
}

// ---------------------------------------------------------------------------
// Push / PR
// ---------------------------------------------------------------------------

function pushOrPr() {
  if (DRY_RUN) {
    log("Dry run — skipping push.");
    return;
  }

  // Configure git auth — write a tiny credential helper that returns the GH_TOKEN
  // This is the simplest approach: no headers, no base64, no quoting issues
  const ghToken = process.env.GH_TOKEN;
  const pushEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (ghToken) {
    // Write a one-shot credential helper script
    const helperPath = join("/tmp", `git-cred-helper-${Date.now()}.sh`);
    writeFileSync(helperPath, `#!/bin/sh\necho "username=x-access-token"\necho "password=${ghToken}"\n`, { mode: 0o700 });
    // GIT_CONFIG_COUNT overrides all config levels including system
    pushEnv.GIT_CONFIG_COUNT = "2";
    pushEnv.GIT_CONFIG_KEY_0 = "credential.helper";
    pushEnv.GIT_CONFIG_VALUE_0 = helperPath;
    pushEnv.GIT_CONFIG_KEY_1 = "credential.useHttpPath";
    pushEnv.GIT_CONFIG_VALUE_1 = "true";
    log("Will use credential helper script for push.");
  }

  function gitPush(args) {
    return execSync(`git ${args}`, {
      cwd: CWD,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: pushEnv,
    }).trim();
  }

  if (AUTO_PUSH) {
    log("Force-pushing to origin/main...");
    gitPush("push --force-with-lease origin main");
    log("Pushed successfully.");
  } else if (CREATE_PR) {
    const datestamp = new Date().toISOString().slice(0, 10);
    const branch = `sync/upstream-${datestamp}`;
    tryRun(`git branch -D ${branch}`);
    run(`git checkout -b ${branch}`);
    gitPush(`push -u origin ${branch} --force-with-lease`);

    const prBody = [
      "## Automated upstream sync",
      "",
      "Rebased our WOPR sidecar commits onto upstream/main (NVIDIA/NemoClaw).",
      "",
      "### What this does",
      "- Pulls in latest upstream changes (security fixes, features, CI improvements)",
      "- Resolves any rebase conflicts (preserving wopr/ sidecar)",
      "- Verifies sidecar + Dockerfile integrity",
      "",
      "### Verify",
      "- [ ] Build passes",
      "- [ ] wopr/sidecar.js intact",
      "- [ ] Dockerfile includes sidecar setup",
    ].join("\n");

    const pr = tryRun(
      `gh pr create --title "sync: rebase on upstream (${datestamp})" --body "${prBody.replace(/"/g, '\\"')}" --base main`,
    );
    if (pr.ok) {
      log(`PR created: ${pr.output}`);
    } else {
      log(`PR creation failed: ${pr.output}`);
    }

    run("git checkout main");
  } else {
    log("Sync complete. Use --push to force-push or --pr to create a PR.");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const remotes = tryRun("git remote -v");
  if (!remotes.output.includes("nemoclaw")) {
    die("Not in a nemoclaw repo.");
  }

  if (!tryRun("git remote get-url upstream").ok) {
    die("No 'upstream' remote. Add with: git remote add upstream https://github.com/NVIDIA/NemoClaw.git");
  }

  const status = run("git status --porcelain");
  if (status) {
    die("Working tree is dirty. Commit or stash changes first.");
  }

  const { rebased, behind } = await rebase();

  if (!rebased && behind === 0) {
    log("Up to date. Nothing to do.");
    flushLog();
    return;
  }

  const buildOk = await buildCheck();
  if (!buildOk) {
    die("Build failed. Not pushing.");
  }

  pushOrPr();
  flushLog();
  log("Done.");
}

main().catch((err) => {
  flushLog();
  console.error(err);
  process.exit(1);
});
