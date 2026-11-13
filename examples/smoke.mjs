#!/usr/bin/env node
// Runs every example against the Mixel on this computer and prints one line each.
//
//   npm run smoke                       Mixel open, "Let an assistant search your Library" on
//   npm run smoke -- --app path/to/app  also open that app (Settings › Developer mode on)
//   npm run smoke -- --strict           a skipped example fails the run
//
// MIXEL_DATA_DIR points it at another Mixel data folder (a test profile). An example is skipped,
// with the fix, when the part of Mixel it needs isn't on; it fails when it runs and goes wrong.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Mixel, MixelUnavailableError } from "@ox1audio/sdk/local"

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const strict = args.includes("--strict")
const given = args[args.indexOf("--app") + 1]
const mixel = new Mixel({ caller: "sdk smoke", retries: 0 })

async function needs(probe) {
  try {
    await probe()
    return null
  } catch (error) {
    if (error instanceof MixelUnavailableError) return `${error.message} fix: ${error.fix}`
    throw error
  }
}

const library = await needs(() => mixel.overview())
const developer = await needs(() => mixel.status())

// An app for open-app.ts: the one given, else a fresh `mixel new` when the mixel command is here.
let app = args.includes("--app") ? path.resolve(given ?? ".") : null
let scratch = null
if (!app && !developer) {
  scratch = mkdtempSync(path.join(tmpdir(), "mixel-smoke-"))
  const made = spawnSync("mixel", ["new", "Smoke Test"], { cwd: scratch, encoding: "utf8" })
  if (made.status === 0) app = path.join(scratch, "smoke-test")
}

const runs = [
  ["library.ts", [], library],
  ["search.ts", ["snare"], library],
  ["crate.ts", ["snare"], library],
  ["open-app.ts", [app ?? "", "2"], developer ?? (app ? null : "No app to open. fix: pass --app path/to/app, or install the mixel command")],
  ["cloud.ts", [], null],
]

let failed = 0
for (const [file, extra, skip] of runs) {
  if (skip) {
    if (strict) failed += 1
    console.log(`skip  ${file.padEnd(12)} ${skip}`)
    continue
  }
  const started = Date.now()
  const run = spawnSync(process.execPath, [path.join(here, file), ...extra], { encoding: "utf8", timeout: 60_000 })
  const ms = Date.now() - started
  const first = (run.status === 0 ? run.stdout : run.stderr || run.stdout).trim().split("\n")[0] ?? ""
  if (run.status === 0) console.log(`ok    ${file.padEnd(12)} ${String(ms).padStart(5)} ms  ${first}`)
  else {
    failed += 1
    console.log(`FAIL  ${file.padEnd(12)} ${String(ms).padStart(5)} ms  ${first}`)
    console.log((run.stderr || run.stdout).trim().replace(/^/gm, "      "))
  }
}
if (scratch) rmSync(scratch, { recursive: true, force: true })
process.exitCode = failed ? 1 : 0
