import assert from "node:assert/strict"
import { test } from "node:test"

import { OxError, host, job, ox, type Bridge } from "../src/page.js"

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

test("outside 0x1audio the error says where to open the app", async () => {
  ;(globalThis as { window?: unknown }).window = {}
  assert.equal(ox.available(), false)
  await assert.rejects(ox.run("convert"), /Open this app in 0x1audio/)
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
