// A stand-in for a running Mixel, for tests: its Library socket (agent/mixel.sock, or on Windows
// agent/endpoint.json with a port and token) and its dev socket (dev.json), answering in the shapes
// the desktop's electron/agent/tools.ts and electron/apps/dev.ts send. The real thing is checked by
// `npm run smoke` with Mixel open.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

const columns = ["id", "title", "type", "key", "bpm", "length", "tier", "reason"]
const sounds: Array<[string, string, string | null, string | null, number | null, number | null, string | null, string]> = [
  ["s1", "Snare Tape 04.wav", "one-shot", null, null, 0.1, "named", "named snare"],
  ["s2", "Snare tight.wav", "one-shot", null, null, 0.1, "named", "named snare"],
  ["s3", "Clap 04.wav", "one-shot", null, null, 0.1, "named", "named clap"],
  ["s4", "Dusty Loop 92.wav", "loop", "F minor", 92, 8, "sounds_like", "sounds like dusty"],
]

export interface Call {
  caller: unknown
  tool: unknown
  args: Record<string, unknown>
  token?: unknown
}

export interface FakeOptions {
  // Windows' way: 127.0.0.1, a port and a token in agent/endpoint.json.
  windows?: boolean
  // Close this many connections without answering, before answering normally.
  drop?: number
  // Wait this long before each answer.
  delayMs?: number
  crates?: boolean
  // Turn on the dev socket (developer mode).
  developer?: boolean
  // The sound model is off or still indexing: "like this sound" is refused with not_ready.
  noModel?: boolean
  // The dev socket's log sends nothing, not even its headers, until the app closes.
  quietLog?: boolean
  // Results a search sends at once (Mixel: 10).
  page?: number
}

export interface FakeMixel {
  dataDir: string
  calls: Call[]
  devCalls: Array<{ method: string; url: string; body: unknown }>
  token: string
  close(): Promise<void>
}

function reply(call: Call, crates: boolean, model: boolean, page = 10): { ok: boolean; body: unknown } {
  const refuse = (code: string, message: string, fix?: string) => ({ ok: false, body: { error: { code, message, ...(fix ? { fix } : {}) } } })
  const args = call.args ?? {}
  if (call.tool === "library_overview") return { ok: true, body: { sounds: 4, concepts: { snare: 2, clap: 1, loop: 1 } } }
  if (call.tool === "library_search") {
    const want = String(args.want ?? "").toLowerCase()
    const avoid = (Array.isArray(args.avoid) ? args.avoid : []).map((word) => String(word).toLowerCase())
    const filters = (args.filters ?? {}) as { type?: string }
    if (args.like !== undefined) {
      if (!model) return refuse("not_ready", "Mixel can't compare sounds yet: the sound model is off or still indexing.", "search with words instead, or ask the person to check Mixel")
      if (!sounds.some((sound) => sound[0] === args.like)) return refuse("unknown_id", `${String(args.like)} isn't an id from a library_search result.`, "search again and use the ids it returns")
      return { ok: true, body: { answerable: true, columns, results: sounds.filter((sound) => sound[0] !== args.like && sound[2] === "one-shot").slice(0, 2) } }
    }
    if (!want && !filters.type) return refuse("bad_input", "want is what to find, in a few plain words.", 'library_search {"want": "dusty snare", "avoid": ["clap"]}')
    const words = want.split(/\s+/).filter(Boolean)
    const found = sounds.filter((sound) => (!filters.type || sound[2] === filters.type) && words.every((word) => sound[1].toLowerCase().includes(word) || sound[7].includes(word)) && !avoid.some((word) => sound[1].toLowerCase().includes(word)))
    if (!found.length) return { ok: true, body: { answerable: false, nearest: { snare: 2, clap: 1 } } }
    const start = typeof args.offset === "number" ? args.offset : 0
    const shown = found.slice(start, start + page)
    const more = found.length - start - shown.length
    return { ok: true, body: { answerable: true, columns, results: shown, ...(more > 0 ? { more, next: start + shown.length } : {}) } }
  }
  if (call.tool === "propose_crate") {
    if (!crates) return refuse("crates_off", "Proposing crates is off in this Mixel, so nothing was made.", "the person turns it on in Mixel › Settings › Your assistant; tell them what you found instead")
    const ids = Array.isArray(args.ids) ? args.ids : []
    const known = ids.filter((id) => sounds.some((sound) => sound[0] === id))
    if (!known.length) return refuse("unknown_id", "None of those ids came from a library_search result.", "search again and use the ids it returns")
    return { ok: true, body: { ok: true, sounds: known.length, ...(ids.length > known.length ? { unknown: ids.length - known.length } : {}) } }
  }
  return refuse("unknown_tool", "Mixel has three tools: library_overview, library_search and propose_crate.")
}

export async function startFakeMixel(options: FakeOptions = {}): Promise<FakeMixel> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fake-mixel-"))
  mkdirSync(path.join(dataDir, "agent"), { recursive: true, mode: 0o700 })
  const calls: Call[] = []
  const devCalls: FakeMixel["devCalls"] = []
  const token = "t".repeat(43)
  let drop = options.drop ?? 0
  const open = new Set<Socket>()
  const server: Server = createServer((socket) => {
    open.add(socket)
    socket.on("close", () => open.delete(socket))
    socket.setEncoding("utf8")
    let pending = ""
    socket.on("data", (chunk: string) => {
      pending += chunk
      const end = pending.indexOf("\n")
      if (end < 0) return
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (drop > 0) {
        drop -= 1
        socket.destroy()
        return
      }
      const call = JSON.parse(line) as Call & { id: unknown }
      calls.push({ caller: call.caller, tool: call.tool, args: call.args, ...(options.windows ? { token: call.token } : {}) })
      const answer = () => {
        if (options.windows && call.token !== token) return socket.destroy()
        const { ok, body } = reply(call, options.crates ?? true, !options.noModel, options.page ?? 10)
        socket.write(`${JSON.stringify({ id: call.id, ok, text: JSON.stringify(body) })}\n`)
      }
      if (options.delayMs) setTimeout(answer, options.delayMs)
      else answer()
    })
  })
  if (options.windows) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as { port: number }
    writeFileSync(path.join(dataDir, "agent", "endpoint.json"), JSON.stringify({ port, token }))
  } else {
    await new Promise<void>((resolve) => server.listen(path.join(dataDir, "agent", "mixel.sock"), resolve))
  }

  let dev: HttpServer | null = null
  if (options.developer) {
    let opened = 0
    dev = createHttpServer((request, response) => {
      let raw = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => (raw += chunk))
      request.on("end", () => {
        const body = raw ? (JSON.parse(raw) as unknown) : undefined
        devCalls.push({ method: request.method ?? "", url: request.url ?? "", body })
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(JSON.stringify(value))
        }
        if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: "unauthorized", message: "This request doesn't carry the dev socket's token." } })
        const parts = (request.url ?? "").split("/").filter(Boolean)
        if (request.method === "GET" && request.url === "/v1/status") return send(200, { mixel: "0.1.17", sdk: "0.3.4", protocol: 1 })
        if (request.method === "POST" && request.url === "/v1/apps") {
          const dir = String((body as { dir?: unknown })?.dir ?? "")
          if (!path.isAbsolute(dir)) return send(400, { error: { code: "bad_input", message: "dir is the app folder's absolute path.", fix: "pass the full path" } })
          opened += 1
          return send(200, { id: `dev-${opened}`, displayName: path.basename(dir), version: "0.1.0" })
        }
        if (parts[0] === "v1" && parts[1] === "apps" && parts[2]) {
          if (request.method === "POST" && parts[3] === "reload") return send(200, { ok: true })
          if (request.method === "DELETE" && parts.length === 3) return send(200, { ok: true })
          if (request.method === "GET" && parts[3] === "log") {
            if (options.quietLog) return
            response.writeHead(200, { "content-type": "application/x-ndjson" })
            response.write(`${JSON.stringify({ type: "info", text: "Started the worker." })}\n`)
            response.write(`${JSON.stringify({ type: "log", text: "mono: 1 file" })}\n`)
            response.end(`${JSON.stringify({ type: "closed" })}\n`)
            return
          }
        }
        send(404, { error: { code: "not_found", message: `${request.method} ${request.url} is not part of the dev socket.` } })
      })
    })
    await new Promise<void>((resolve) => dev!.listen(0, "127.0.0.1", resolve))
    const { port } = dev.address() as { port: number }
    writeFileSync(path.join(dataDir, "dev.json"), JSON.stringify({ port, token }), { mode: 0o600 })
  }

  return {
    dataDir,
    calls,
    devCalls,
    token,
    async close() {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (dev) {
        dev.closeAllConnections()
        await new Promise<void>((resolve) => dev!.close(() => resolve()))
      }
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
