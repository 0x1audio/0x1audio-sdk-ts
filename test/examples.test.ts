// Every example runs, as a developer would run it, against a stand-in Mixel. `npm run smoke` runs
// the same files against the real one.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { startFakeMixel } from "./fake-mixel.js"

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples")

function run(file: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(examples, file), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("close", (code) => resolve({ code, out, err }))
  })
}

test("library.ts, search.ts and crate.ts against a Mixel with the switch on", async () => {
  const fake = await startFakeMixel()
  try {
    const env = { MIXEL_DATA_DIR: fake.dataDir }
    const library = await run("library.ts", [], env)
    assert.equal(library.code, 0, library.err)
    assert.match(library.out, /^4 sounds\n {2}snare {12}2/)
    const search = await run("search.ts", ["snare", "--avoid", "clap"], env)
    assert.equal(search.code, 0, search.err)
    assert.match(search.out, /s1 {4}Snare Tape 04\.wav .* named: named snare/)
    assert.match(search.out, /Like Snare Tape 04\.wav: /)
    assert.match(search.out, /For a model \(\d+ bytes\): \{"answerable":true,"columns":/)
    const crate = await run("crate.ts", ["snare"], env)
    assert.equal(crate.code, 0, crate.err)
    assert.match(crate.out, /Proposed a crate of 2 sounds/)
    assert.deepEqual(new Set(fake.calls.map((call) => call.caller)), new Set(["sdk example"]))
  } finally {
    await fake.close()
  }
})

test("search.ts without the sound model still finds by words, and says why similar waits", async () => {
  const fake = await startFakeMixel({ noModel: true })
  try {
    const search = await run("search.ts", ["snare"], { MIXEL_DATA_DIR: fake.dataDir })
    assert.equal(search.code, 0, search.err)
    assert.match(search.out, /Like Snare Tape 04\.wav: Mixel can't compare sounds yet: the sound model is off or still indexing\./)
  } finally {
    await fake.close()
  }
})

test("open-app.ts opens a folder in Mixel, shows its log and closes it", async () => {
  const fake = await startFakeMixel({ developer: true })
  const folder = mkdtempSync(path.join(tmpdir(), "make-it-mono-"))
  try {
    const opened = await run("open-app.ts", [folder, "2"], { MIXEL_DATA_DIR: fake.dataDir })
    assert.equal(opened.code, 0, opened.err)
    assert.match(opened.out, /^Opened make-it-mono-\w+ 0\.1\.0 in Mixel 0\.1\.17\.\n\[info\] Started the worker\.\n\[log\] mono: 1 file\nClosed it\.\n$/)
  } finally {
    rmSync(folder, { recursive: true, force: true })
    await fake.close()
  }
})

test("with Mixel closed, an example says what to do and exits 1", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "no-mixel-"))
  try {
    const closed = await run("search.ts", ["snare"], { MIXEL_DATA_DIR: empty })
    assert.equal(closed.code, 1)
    assert.equal(closed.out, "")
    assert.equal(closed.err, "Mixel isn't open, or it doesn't let assistants search the Library.\nfix: open Mixel and turn on Settings › Your assistant › Let an assistant search your Library\n")
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test("cloud.ts reaches the cloud named by MIXEL_API", async () => {
  const { createServer } = await import("node:http")
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ status: "ok" }))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  try {
    const { port } = server.address() as { port: number }
    const cloud = await run("cloud.ts", [], { MIXEL_API: `http://127.0.0.1:${port}`, MIXEL_TOKEN: "" })
    assert.equal(cloud.code, 0, cloud.err)
    assert.equal(cloud.out, "cloud: ok\n")
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
})
