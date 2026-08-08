/**
 * One-command setup, from a terminal.
 *
 *   npm run setup                 full dataset
 *   npm run setup -- --small      a tiny one, for a quick check
 *   npm run setup -- --password=whatever-you-like
 *
 * All the work lives in src/lib/setup/run.ts, shared with the browser route at
 * /api/setup. This file only turns the result into terminal output.
 *
 * Safe to run repeatedly.
 */
import "dotenv/config";
import { DEFAULT_VOLUMES, type SeedVolumes } from "../db/seed";
import { generatePassword, runSetup } from "../src/lib/setup/run";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const SMALL: SeedVolumes = {
  users: 10,
  accounts: 40,
  contacts: 120,
  opportunities: 60,
  activities: 600,
  days: 180,
};

async function main() {
  const argv = process.argv.slice(2);
  const volumes = argv.includes("--small") ? SMALL : DEFAULT_VOLUMES;
  const passwordArg = argv.find((a) => a.startsWith("--password="));

  console.log(`\n${bold("Megaforce CRM setup")}\n`);
  console.log(dim("  Loading data can take a minute. Nothing to do but wait.\n"));

  const result = await runSetup({
    volumes,
    password: passwordArg ? passwordArg.split("=").slice(1).join("=") : generatePassword(),
  });

  for (const step of result.steps) {
    const mark = step.status === "ok" ? green("✓") : red("✗");
    console.log(`  ${mark} ${step.name} ${dim(`— ${step.detail}`)}`);
  }

  if (!result.ok) {
    console.log(`\n${red(bold("Stopped: " + (result.problem?.problem ?? "unknown")))}\n`);
    for (const line of (result.problem?.fix ?? "").split("\n")) {
      console.log(`  ${line}`);
    }
    console.log("");
    process.exit(1);
  }

  console.log(`\n${green(bold("Ready."))}\n`);
  console.log(`  Sign in with:`);
  console.log(`    email     ${bold(result.login!.email)}`);
  console.log(`    password  ${bold(result.login!.password)}   ${dim("← write this down")}\n`);
  console.log(`  Then run:   ${bold("npm run dev")}`);
  console.log(`  And open:   ${bold("http://localhost:3000")}\n`);
  console.log(
    dim(`  ${result.stats!.qualifyingRate} of the loaded activity qualified under the current rules.`),
  );
  if (result.landmarks?.ambiguousPhone) {
    console.log(
      dim(`  Demo tip: ${result.landmarks.ambiguousPhone} is on file at two different companies.`),
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n${red("Unexpected error:")}\n`, err);
  process.exit(1);
});
