import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { dataDir, Found, Mixel, MixelError, MixelTimeoutError, MixelUnavailableError } from "../src/local.js"
import { startFakeMixel } from "./fake-mixel.js"

const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)

test("overview, search, similar and a crate, over the Library socket", async () => {
  const fake = await startFakeMixel()
  try {
    const mixel = new Mixel({ dataDir: fake.dataDir, caller: "my-script" })
    assert.deepEqual(await mixel.overview(), { sounds: 4, concepts: { snare: 2, clap: 1, loop: 1 }, more: 0 })

    const found = await mixel.search("snare", { avoid: ["clap"] })
    assert.ok(found instanceof Found)
    assert.equal(found.answerable, true)
    assert.deepEqual(found.sounds[0], { id: "s1", title: "Snare Tape 04.wav", type: "one-shot", key: null, bpm: null, length: 0.1, tier: "named", reason: "named snare" })
    assert.deepEqual([...found].map((sound) => sound.id), ["s1", "s2"])
    // A model gets Mixel's compact rows, as sent, not the objects.
    assert.equal(JSON.stringify(found), found.text)
    // Ten results as rows against the same ten as objects: about a third smaller (Mixel measured 237 tokens against 362).
    const ten = new Found(JSON.stringify({ answerable: true, columns: ["id", "title", "type", "key", "bpm", "length", "tier", "reason"], results: Array.from({ length: 10 }, (_, at) => [`s${at + 1}`, `Snare ${at} dusty tape.wav`, "one-shot", "F minor", 92, 0.4, "named", "named snare"]) }))
    assert.ok(JSON.stringify(ten).length < JSON.stringify(ten.sounds).length * 0.7, `${JSON.stringify(ten).length} vs ${JSON.stringify(ten.sounds).length}`)
    assert.deepEqual(fake.calls.at(-1), { caller: "my-script", tool: "library_search", args: { want: "snare", avoid: ["clap"] } })

    const like = await mixel.similar("s1", { type: "one-shot" })
    assert.deepEqual(like.sounds.map((sound) => sound.id), ["s2", "s3"])
    assert.deepEqual(fake.calls.at(-1)?.args, { filters: { type: "one-shot" }, like: "s1" })

    const loops = await mixel.search(undefined, { type: "loop", bpm: [90, null] })
    assert.deepEqual(loops.sounds.map((sound) => sound.title), ["Dusty Loop 92.wav"])
    assert.deepEqual(fake.calls.at(-1)?.args, { filters: { type: "loop", bpm: [90, null] } })

    const none = await mixel.search("bagpipes")
    assert.equal(none.answerable, false)
    assert.deepEqual(none.sounds, [])
    assert.deepEqual(none.nearest, { snare: 2, clap: 1 })

    assert.deepEqual(await mixel.proposeCrate({ title: "Snares", request: "two snares, not claps", ids: ["s1", "s2", "s9"] }), { sounds: 2, unknown: 1 })
  } finally {
    await fake.close()
  }
})

test("what Mixel refuses is a MixelError with its code and fix, never retried", async () => {
  const fake = await startFakeMixel({ crates: false })
  try {
    const mixel = new Mixel({ dataDir: fake.dataDir })
    const unknown = await failure(mixel.similar("s99"))
    assert.ok(unknown instanceof MixelError)
    assert.ok(!(unknown instanceof MixelUnavailableError))
    assert.equal(unknown.code, "unknown_id")
    assert.equal(unknown.fix, "search again and use the ids it returns")
    assert.deepEqual(JSON.parse(JSON.stringify(unknown)), { code: "unknown_id", message: "s99 isn't an id from a library_search result.", fix: "search again and use the ids it returns" })
    assert.equal(fake.calls.length, 1)
    const off = await failure(mixel.proposeCrate({ title: "Snares", request: "snares", ids: ["s1"] }))
    assert.equal((off as MixelError).code, "crates_off")
    const empty = await failure(mixel.search(""))
    assert.equal((empty as MixelError).code, "bad_input")
  } finally {
    await fake.close()
  }
})

test("Mixel closed, or the switch off: MixelUnavailableError at once, with the fix", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "no-mixel-"))
  try {
    const started = Date.now()
    const off = await failure(new Mixel({ dataDir: empty, retries: 5 }).search("snare"))
    assert.ok(off instanceof MixelUnavailableError)
    assert.equal(off.code, "library_search_off")
    assert.match(off.fix ?? "", /Settings › Your assistant/)
    // Five retries would wait 0.1 + 0.2 + 0.4 + 0.8 + 1.6 s.
    assert.ok(Date.now() - started < 2000, "no retries when nothing is there")
    const windows = await failure(new Mixel({ dataDir: empty, platform: "win32" }).overview())
    assert.equal((windows as MixelError).code, "library_search_off")
    const dev = await failure(new Mixel({ dataDir: empty }).status())
    assert.ok(dev instanceof MixelUnavailableError)
    assert.equal(dev.code, "desktop_unavailable")
    assert.match(dev.fix ?? "", /Developer mode/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test("a dropped connection is retried for a search, never for a crate", async () => {
  const fake = await startFakeMixel({ drop: 1 })
  try {
    const mixel = new Mixel({ dataDir: fake.dataDir })
    assert.equal((await mixel.search("snare")).sounds.length, 2)
    assert.equal(fake.calls.length, 1)
  } finally {
    await fake.close()
  }
  const again = await startFakeMixel({ drop: 1 })
  try {
    const lost = await failure(new Mixel({ dataDir: again.dataDir }).proposeCrate({ title: "Snares", request: "snares", ids: ["s1"] }))
    assert.ok(lost instanceof MixelUnavailableError)
    assert.equal(lost.message, "Mixel stopped answering before it replied.")
    assert.equal(again.calls.length, 0)
  } finally {
    await again.close()
  }
})

test("a slow Mixel is a MixelTimeoutError, after the retries", async () => {
  const fake = await startFakeMixel({ delayMs: 300 })
  try {
    const slow = await failure(new Mixel({ dataDir: fake.dataDir, timeoutMs: 50, retries: 1 }).overview())
    assert.ok(slow instanceof MixelTimeoutError)
    assert.equal(slow.code, "timeout")
    assert.equal(fake.calls.length, 2)
  } finally {
    await fake.close()
  }
})

test("Windows: 127.0.0.1, the port and token from endpoint.json", async () => {
  const fake = await startFakeMixel({ windows: true })
  try {
    const mixel = new Mixel({ dataDir: fake.dataDir, platform: "win32" })
    assert.equal((await mixel.overview()).sounds, 4)
    assert.equal(fake.calls[0]?.token, fake.token)
  } finally {
    await fake.close()
  }
})

test("developer mode: status, open an app, reload, read its log, close it", async () => {
  const fake = await startFakeMixel({ developer: true })
  const folder = mkdtempSync(path.join(tmpdir(), "make-it-mono-"))
  try {
    const mixel = new Mixel({ dataDir: fake.dataDir })
    assert.deepEqual(await mixel.status(), { mixel: "0.1.17", sdk: "0.3.4", protocol: 1 })
    const app = await mixel.openApp(folder)
    assert.equal(app.id, "dev-1")
    assert.equal(app.displayName, path.basename(folder))
    await app.reload(["app.py"])
    const lines = []
    for await (const line of app.log()) lines.push(line)
    assert.deepEqual(lines.map((line) => line.type), ["info", "log", "closed"])
    await app.close()
    assert.deepEqual(fake.devCalls.map((call) => `${call.method} ${call.url}`), ["GET /v1/status", "POST /v1/apps", "POST /v1/apps/dev-1/reload", "GET /v1/apps/dev-1/log", "DELETE /v1/apps/dev-1"])
    assert.deepEqual(fake.devCalls[2]?.body, { changed: ["app.py"] })
  } finally {
    rmSync(folder, { recursive: true, force: true })
    await fake.close()
  }
})

test("a search pages with next and offset", async () => {
  const fake = await startFakeMixel({ page: 1 })
  try {
    const mixel = new Mixel({ dataDir: fake.dataDir })
    const first = await mixel.search("snare")
    assert.deepEqual([first.sounds.map((sound) => sound.id), first.more, first.next], [["s1"], 1, 1])
    const second = await mixel.search("snare", { offset: first.next ?? undefined })
    assert.deepEqual([second.sounds.map((sound) => sound.id), second.more, second.next], [["s2"], 0, null])
    assert.deepEqual(fake.calls.at(-1)?.args, { want: "snare", offset: 1 })
  } finally {
    await fake.close()
  }
})

test("without the sound model, similar() is refused with not_ready and a fix", async () => {
  const fake = await startFakeMixel({ noModel: true })
  try {
    const refused = await failure(new Mixel({ dataDir: fake.dataDir }).similar("s1"))
    assert.ok(refused instanceof MixelError)
    assert.equal(refused.code, "not_ready")
    assert.equal(refused.fix, "search with words instead, or ask the person to check Mixel")
  } finally {
    await fake.close()
  }
})

test("a log that hasn't said anything yet ends quietly when the signal aborts", async () => {
  const fake = await startFakeMixel({ developer: true, quietLog: true })
  const folder = mkdtempSync(path.join(tmpdir(), "quiet-app-"))
  try {
    const app = await new Mixel({ dataDir: fake.dataDir }).openApp(folder)
    const lines = []
    for await (const line of app.log(AbortSignal.timeout(100))) lines.push(line)
    assert.deepEqual(lines, [])
    await app.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
    await fake.close()
  }
})

test("the data folder is Mixel's own, or MIXEL_DATA_DIR", () => {
  assert.equal(dataDir("linux", { MIXEL_DATA_DIR: "/tmp/profile" }), "/tmp/profile")
  assert.equal(dataDir("linux", { XDG_CONFIG_HOME: "/x" }), path.join("/x", "0x1audio"))
  assert.match(dataDir("darwin", {}), /Library\/Application Support\/0x1audio$/)
  assert.equal(dataDir("win32", { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }), path.join("C:\\Users\\ada\\AppData\\Roaming", "0x1audio"))
})
