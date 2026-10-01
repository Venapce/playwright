// Convert a recorded Playwright script into the plugin's steps JSON, from the
// terminal — the same conversion the "Convert to steps" button performs, for
// when the recording is already a file.
//
//   npx playwright codegen https://example.com -o flow.spec.ts
//   npm run convert -- flow.spec.ts            # steps JSON on stdout
//   npm run convert < flow.spec.ts             # or from stdin
//
// Whatever could not be converted goes to stderr, so a pipe gets clean JSON
// while the author still gets told what was left out.

import { readFileSync } from "node:fs";

import { convertRecording, renderSteps } from "../codegen/convert.js";

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.includes("-h") || args.includes("--help")) {
    process.stderr.write(
      "usage: convert-recording [file]\n\n" +
        "Converts code from `playwright codegen` into the Run browser flow node's\n" +
        "steps JSON. Reads stdin when no file is given.\n",
    );
    process.exit(0);
  }

  let source: string;
  try {
    source = args.length > 0 ? readFileSync(args[0], "utf8") : readFileSync(0, "utf8");
  } catch (e) {
    process.stderr.write(`could not read ${args[0] ?? "stdin"}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  const conversion = convertRecording(source);

  if (conversion.steps.length === 0) {
    process.stderr.write(
      `no steps found (${conversion.summary}). Pass the generated code itself — the "await page.…" lines.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(renderSteps(conversion.steps) + "\n");

  process.stderr.write(`\n${conversion.summary}\n`);
  for (const skip of conversion.skipped) {
    process.stderr.write(`  line ${skip.line}: ${skip.reason}\n    ${skip.source}\n`);
  }
  if (conversion.assertions > 0) {
    process.stderr.write(
      `  ${conversion.assertions} assertion(s) dropped — steps cannot assert; use an "extract" step and branch on the value.\n`,
    );
  }
}

main();
