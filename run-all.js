#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// Run All Scenarios — Sequential runner for the complete load test suite
// ═══════════════════════════════════════════════════════════════════════════════
// Executes scenarios 01–07 in order. Stops on critical failure (exit code > 1).
// Reports can continue on threshold failures (exit code 1) with --continue-on-fail.
// ═══════════════════════════════════════════════════════════════════════════════

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCENARIOS = [
  { file: "scenarios/01-smoke.js", name: "Smoke", critical: true },
  {
    file: "scenarios/02-presence-ramp.js",
    name: "Presence Ramp",
    critical: false,
  },
  {
    file: "scenarios/03-presence-heartbeat.js",
    name: "Heartbeat Sustained",
    critical: false,
  },
  {
    file: "scenarios/04-chat-throughput.js",
    name: "Chat Throughput",
    critical: false,
  },
  {
    file: "scenarios/05-notification-fanout.js",
    name: "Notification Fanout",
    critical: false,
  },
  {
    file: "scenarios/06-mixed-realistic.js",
    name: "Mixed Realistic",
    critical: false,
  },
  { file: "scenarios/07-breakpoint.js", name: "Breakpoint", critical: false },
];

const continueOnFail = process.argv.includes("--continue-on-fail");

console.log("");
console.log("╔═══════════════════════════════════════════════════════════╗");
console.log("║            C2C SignalR — Full Test Suite                  ║");
console.log("╚═══════════════════════════════════════════════════════════╝");
console.log("");

const results = [];
let hasFailure = false;

for (const scenario of SCENARIOS) {
  const fullPath = path.join(__dirname, scenario.file);

  if (!existsSync(fullPath)) {
    console.log(
      `⚠️  Skipping ${scenario.name} — file not found: ${scenario.file}`,
    );
    results.push({ name: scenario.name, status: "SKIPPED" });
    continue;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`▶ Starting: ${scenario.name} (${scenario.file})`);
  console.log("═".repeat(60));

  try {
    execFileSync("node", [fullPath], {
      cwd: __dirname,
      stdio: "inherit",
      env: { ...process.env },
      timeout: 45 * 60 * 1000, // 45 min max per scenario
    });

    console.log(`✅ ${scenario.name} — PASSED`);
    results.push({ name: scenario.name, status: "PASSED" });
  } catch (err) {
    const exitCode = err.status ?? 1;

    if (exitCode === 1) {
      // Threshold failure — test ran but didn't meet SLA
      console.log(`⚠️  ${scenario.name} — THRESHOLD FAIL (exit code 1)`);
      results.push({ name: scenario.name, status: "THRESHOLD_FAIL" });
      hasFailure = true;

      if (!continueOnFail) {
        console.log(
          "\n💡 Use --continue-on-fail to proceed past threshold failures.\n",
        );
        break;
      }
    } else {
      // Critical failure — scenario crashed
      console.log(
        `❌ ${scenario.name} — CRITICAL FAIL (exit code ${exitCode})`,
      );
      results.push({ name: scenario.name, status: "CRITICAL_FAIL" });
      hasFailure = true;

      if (scenario.critical) {
        console.log(
          "\n🛑 Critical scenario failed. Aborting remaining tests.\n",
        );
        break;
      }

      if (!continueOnFail) {
        console.log("\n💡 Use --continue-on-fail to proceed past failures.\n");
        break;
      }
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("                    SUITE SUMMARY");
console.log("═".repeat(60));

const maxNameLen = Math.max(...results.map((r) => r.name.length));

for (const r of results) {
  const icon =
    r.status === "PASSED"
      ? "✅"
      : r.status === "SKIPPED"
        ? "⏭️ "
        : r.status === "THRESHOLD_FAIL"
          ? "⚠️ "
          : "❌";
  console.log(`  ${icon} ${r.name.padEnd(maxNameLen + 2)} ${r.status}`);
}

const remaining = SCENARIOS.length - results.length;
if (remaining > 0) {
  console.log(`\n  ⏹️  ${remaining} scenario(s) not executed`);
}

console.log("═".repeat(60));

process.exit(hasFailure ? 1 : 0);
