import assert from "node:assert/strict"
import { test } from "node:test"

import { OxError, host, job, ox, permissionCodes, permissionText, type Bridge, type PermissionCode } from "../src/page.js"

type Listener = (ticket: string, fraction: number | null, label: string) => void

function fakeHost(behaviour: (ticket: string, action: string, input: Record<string, unknown>, emit: Listener, cancelled: Set<string>) => Promise<unknown>) {
  const listeners = new Set<Listener>()
  const cancelled = new Set<string>()
  const emit: Listener = (ticket, fraction, label) => listeners.forEach((listener) => listener(ticket, fraction, label))
  const bridge = {
    protocol: 1,
    actions: async () => ({ ok: true as const, body: [] }),
    run: async (ticket: string, action: string, input: Record<string, unknown>) => behaviour(ticket, action, input, emit, cancelled),
    cancel: async (ticket: string) => {
      cancelled.add(ticket)
      return true
    },
    onProgress: (callback: Listener) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  } as unknown as Bridge
  ;(globalThis as { window?: unknown }).window = { ox1: bridge }
  return { listeners, cancelled }
}

test("ox.run streams progress for its own call and returns the body", async () => {
  const { listeners } = fakeHost(async (ticket, action, input, emit) => {
    emit("someone-else", 0.9, "Not mine")
    emit(ticket, 0.5, "Halfway")
    return { ok: true, body: { action, input } }
  })
  const seen: Array<[number | null, string]> = []
  const result = await ox.run("convert", { format: "wav" }, { onProgress: (fraction, label) => seen.push([fraction, label]) })
  assert.deepEqual(result, { action: "convert", input: { format: "wav" } })
  assert.deepEqual(seen, [[0.5, "Halfway"]])
  assert.equal(listeners.size, 0)
})

test("aborting the signal presses Stop and the run rejects as cancelled", async () => {
  const { cancelled } = fakeHost(async (ticket) => {
    while (!cancelled.has(ticket)) await new Promise((resolve) => setTimeout(resolve, 5))
    return { ok: false, error: { code: "cancelled", message: "Stopped." } }
  })
  const stop = new AbortController()
  const running = ox.run("split", {}, { signal: stop.signal })
  setTimeout(() => stop.abort(), 20)
  await assert.rejects(running, (error: unknown) => error instanceof OxError && error.code === "cancelled")
})

test("errors keep their code and hint", async () => {
  fakeHost(async () => ({ ok: false, error: { code: "problem", message: "That file has no audio.", hint: "Try a WAV." } }))
  await assert.rejects(ox.run("convert"), (error: unknown) => error instanceof OxError && error.code === "problem" && error.hint === "Try a WAV.")
})

test("outside Mixel the error says where to open the app", async () => {
  ;(globalThis as { window?: unknown }).window = {}
  assert.equal(ox.available(), false)
  await assert.rejects(ox.run("convert"), /: Open this app in Mixel\.$/)
})

test("ox.unavailable() gives apps the words, so they never name the product (GAB-107)", () => {
  ;(globalThis as { window?: unknown }).window = {}
  assert.equal(ox.unavailable()?.message, "Open this app in Mixel.")
  assert.equal(ox.unavailable()?.code, "unavailable")
  ;(globalThis as { window?: unknown }).window = { ox1: { protocol: 2 } }
  assert.equal(ox.unavailable()?.message, "Update Mixel to open this app.")
  assert.equal(ox.available(), false)
  ;(globalThis as { window?: unknown }).window = { ox1: { protocol: 1 } }
  assert.equal(ox.unavailable(), null)
  assert.equal(ox.available(), true)
})

test("job() and host() are gone and say what replaced them", () => {
  assert.throws(() => job(), /job\(\) is gone: use ox.run[\s\S]*fix:  import \{ ox \}[\s\S]*docs: https:\/\/docs.0x1audio.com/)
  assert.throws(() => host(), /host\(\) is gone[\s\S]*fix:/)
})

test("events reach their own run, and Stop says what was kept", async () => {
  type EventListener = (ticket: string, name: string, body: unknown) => void
  const events = new Set<EventListener>()
  const { cancelled } = fakeHost(async (ticket) => {
    events.forEach((listener) => listener("someone-else", "partial", 0))
    events.forEach((listener) => listener(ticket, "partial", { done: 1 }))
    while (!cancelled.has(ticket)) await new Promise((resolve) => setTimeout(resolve, 5))
    return { ok: false, error: { code: "cancelled", message: "Stopped. Kept 1: song.flac.", kept: [{ id: "1", kind: "sound", title: "song", path: "/m/song.flac" }] } }
  })
  ;(window.ox1 as Bridge).onEvent = (callback) => {
    events.add(callback)
    return () => events.delete(callback)
  }
  const seen: unknown[] = []
  const stop = new AbortController()
  const running = ox.run("convert", {}, { onEvent: (name, body) => seen.push([name, body]), signal: stop.signal })
  setTimeout(() => stop.abort(), 20)
  await assert.rejects(running, (error: unknown) => error instanceof OxError && error.code === "cancelled" && error.kept[0]?.path === "/m/song.flac")
  assert.deepEqual(seen, [["partial", { done: 1 }]])
  assert.equal(events.size, 0)
})

test("ox.data refusals are OxErrors with the code and the fix (GAB-79)", async () => {
  const stored = new Map<string, Uint8Array>()
  const bridge = {
    protocol: 1,
    dataResult: async (op: string, path: string, body?: Uint8Array | string) => {
      if (path.startsWith("secret")) {
        return { ok: false, error: { code: "permission_undeclared", message: "Loop Maker used data, but its app.json doesn't ask for it.", hint: 'add "data": "…" to app.json › permissions' } }
      }
      if (op === "write") stored.set(path, typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array))
      if (op === "read") return { ok: true, body: stored.get(path) }
      if (op === "list") return { ok: true, body: [...stored.keys()] }
      return { ok: true, body: null }
    },
  } as unknown as Bridge
  ;(globalThis as { window?: unknown }).window = { ox1: bridge }
  await ox.data.write("loops/a.json", "{}")
  assert.equal(await ox.data.readText("loops/a.json"), "{}")
  assert.deepEqual(await ox.data.list(), ["loops/a.json"])
  await assert.rejects(ox.data.write("secret", "x"), (error: unknown) => error instanceof OxError && error.code === "permission_undeclared" && /app\.json › permissions/.test(error.hint ?? ""))
})

test("ox.data on an older host still works and still throws an OxError", async () => {
  const bridge = {
    protocol: 1,
    data: {
      list: async () => ["a"],
      read: async () => new Uint8Array([104, 105]),
      write: async () => {
        throw new Error("Loop Maker needs permission to keep its own files.")
      },
      remove: async () => undefined,
    },
  } as unknown as Bridge
  ;(globalThis as { window?: unknown }).window = { ox1: bridge }
  assert.equal(await ox.data.readText("a"), "hi")
  await assert.rejects(ox.data.write("a", "x"), (error: unknown) => error instanceof OxError && error.code === "permission_denied" && /keep its own files/.test(error.message))
})

test("the Library permission split: library adds, library-read lists and opens", async () => {
  assert.ok(permissionCodes.includes("library") && permissionCodes.includes("library-read"))
  assert.equal(permissionText["library-read"], "Read your Library")
  const code: PermissionCode = "library-read"
  assert.equal(code, "library-read")
  const bridge = {
    protocol: 1,
    libraryList: async () => {
      throw new Error("Error invoking remote method 'ox1:library-list': Error: Loop Maker can add to your Library, but it didn't ask to see it.")
    },
    libraryImport: async () => [{ imported: "already" }],
    libraryFile: async () => {
      throw new Error("This app can't open sounds from your Library.")
    },
  } as unknown as Bridge
  ;(globalThis as { window?: unknown }).window = { ox1: bridge }
  await assert.rejects(ox.library.list(), (error: unknown) => error instanceof OxError && error.code === "permission_undeclared" && error.message === "Loop Maker can add to your Library, but it didn't ask to see it." && /"library-read"/.test(error.hint ?? ""))
  await assert.rejects(ox.library.file("s1"), (error: unknown) => error instanceof OxError && error.code === "permission_denied" && error.hint === undefined)
  assert.deepEqual(await ox.library.add(["/m/a.wav"]), [{ imported: "already" }])
})
