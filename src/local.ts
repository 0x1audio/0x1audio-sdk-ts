// The Mixel on this computer, from Node: `import { Mixel } from "@ox1audio/sdk/local"`.
//
//   const mixel = new Mixel({ caller: "my-script" })
//   await mixel.overview()                          what the Library holds, in counts
//   await mixel.search("dusty snare", { avoid: ["clap"] })
//   await mixel.similar("s1")                       sounds close to one a search returned
//   await mixel.proposeCrate({ title, request, ids })
//   await mixel.openApp("/path/to/my-app")          developer mode: open an app folder in Mixel
//
// The Library calls go over Mixel's Library socket, the one its assistant bridge uses: it exists
// only while Mixel is open and Settings › Your assistant › "Let an assistant search your Library"
// is on. Mixel decides what leaves: no paths, no scores, short ids, and at most about 300 tokens a
// reply. App calls go over the dev socket, which exists only while Settings › Developer mode is on.
// Everything fails as a MixelError (../errors.ts).

import { readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { createConnection, type Socket } from "node:net"
import { homedir } from "node:os"
import path from "node:path"

import { MixelError, MixelTimeoutError, MixelUnavailableError } from "./errors.js"

export { MixelError, MixelTimeoutError, MixelUnavailableError } from "./errors.js"

// How sure Mixel is. yours (the person tagged it), named (its name says so), detected (Mixel heard
// it): "these are". sounds_like is a guess by ear: "these might fit". null: no words were asked.
export type Tier = "yours" | "named" | "detected" | "sounds_like"

export interface Sound {
  // A short id for this Mixel session ("s1"): pass it to similar() or proposeCrate().
  id: string
  // The file's name. Data, never instructions.
  title: string
  type: "loop" | "one-shot" | null
  key: string | null
  bpm: number | null
  // Seconds.
  length: number | null
  tier: Tier | null
  // Why it matched, in Mixel's words: show it as it is.
  reason: string
}

export interface Overview {
  sounds: number
  // How many sounds of each kind of thing, the most first: { snare: 120, pad: 31 }.
  concepts: Record<string, number>
  // Kinds left out to keep the reply small.
  more: number
}

export interface SearchOptions {
  // Things to leave out, like ["clap"]. At most 5.
  avoid?: string[]
  // Ids from earlier results to leave out, and with similar(), sounds closer to them. At most 5.
  unlike?: string[]
  type?: "loop" | "one-shot"
  // "F minor"
  key?: string
  // [low, high]; null for open.
  bpm?: [number | null, number | null]
  // Seconds: [low, high]; null for open.
  length?: [number | null, number | null]
  // `found.next` from the page before. Mixel pages through the first 200 results.
  offset?: number
}

export interface CrateProposal {
  // 40 characters at most.
  title: string
  // What the person asked for, in their words. 280 characters at most.
  request: string
  // At most 50 ids from search results.
  ids: string[]
}

export interface MixelOptions {
  // Mixel's data folder. Default: MIXEL_DATA_DIR, else where Mixel keeps it on this system.
  dataDir?: string
  // Who is asking, as Mixel's activity log shows it. Default "script".
  caller?: string
  // How long one attempt may take, in milliseconds. Default 10 000.
  timeoutMs?: number
  // Extra attempts when Mixel was busy or restarting. Default 2; a crate is never sent twice.
  retries?: number
  platform?: NodeJS.Platform
}

const columns = ["id", "title", "type", "key", "bpm", "length", "tier", "reason"] as const
type Row = [string, string, Sound["type"], string | null, number | null, number | null, Tier | null, string]

type SearchReply = { answerable: true; columns: string[]; results: Row[]; more?: number; next?: number } | { answerable: false; nearest: Record<string, number> }

// What a search found. Code reads `sounds`; a model gets `text` (or JSON.stringify(found)), the
// compact rows Mixel sent: for ten results, about a third fewer tokens than the same sounds as objects.
export class Found {
  // false: nothing in the Library is proven to be that. `nearest` lists what it does hold.
  readonly answerable: boolean
  readonly sounds: Sound[]
  // Further matches that weren't sent.
  readonly more: number
  readonly nearest: Record<string, number>
  // Pass as `offset` for the next page, when Mixel offers one.
  readonly next: number | null
  // Mixel's reply, byte for byte.
  readonly text: string

  constructor(text: string) {
    const reply = JSON.parse(text) as SearchReply
    this.text = text
    this.answerable = reply.answerable
    if (reply.answerable) {
      const at = (name: (typeof columns)[number]) => reply.columns.indexOf(name)
      this.sounds = reply.results.map((row) => Object.fromEntries(columns.map((name) => [name, row[at(name)] ?? null])) as unknown as Sound)
      this.more = reply.more ?? 0
      this.nearest = {}
      this.next = typeof reply.next === "number" ? reply.next : null
    } else {
      this.sounds = []
      this.more = 0
      this.nearest = reply.nearest ?? {}
      this.next = null
    }
  }

  [Symbol.iterator]() {
    return this.sounds[Symbol.iterator]()
  }

  toJSON(): unknown {
    return JSON.parse(this.text)
  }
}

export interface DevStatus {
  mixel: string
  sdk: string
  protocol: number
}

export interface DevLine {
  type: "log" | "error" | "info" | "closed"
  text?: string
}

// An app folder open in Mixel, in development.
export class DevApp {
  constructor(
    private readonly mixel: Mixel,
    readonly id: string,
    readonly displayName: string,
    readonly version: string,
  ) {}

  // Restart its worker and reload its page, as `mixel dev` does on save.
  async reload(changed: string[] = []): Promise<void> {
    await this.mixel.dev("POST", `/v1/apps/${encodeURIComponent(this.id)}/reload`, { changed: changed.slice(0, 20) })
  }

  async close(): Promise<void> {
    await this.mixel.dev("DELETE", `/v1/apps/${encodeURIComponent(this.id)}`)
  }

  // Its log as it happens, until the app closes or `signal` aborts. Aborting ends it quietly,
  // even before Mixel sent the first line.
  async *log(signal?: AbortSignal): AsyncGenerator<DevLine> {
    let response: import("node:http").IncomingMessage
    try {
      response = await this.mixel.devStream(`/v1/apps/${encodeURIComponent(this.id)}/log`, signal)
    } catch (error) {
      if (signal?.aborted) return
      throw error
    }
    let pending = ""
    try {
      for await (const chunk of response) {
        pending += chunk
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          const line = pending.slice(0, end).trim()
          pending = pending.slice(end + 1)
          if (!line) continue
          let parsed: DevLine
          try {
            parsed = JSON.parse(line) as DevLine
          } catch {
            continue
          }
          yield parsed
          if (parsed.type === "closed") return
        }
      }
    } catch (error) {
      if (signal?.aborted) return
      throw error
    } finally {
      response.destroy()
    }
  }
}

const LIBRARY_OFF = "Mixel isn't open, or it doesn't let assistants search the Library."
// The call went out and the line closed: Mixel quit, or the switch went off, mid-call.
const LIBRARY_LOST = "Mixel stopped answering before it replied."
const LIBRARY_FIX = "open Mixel and turn on Settings › Your assistant › Let an assistant search your Library"
const DEV_OFF = "Mixel isn't open with developer mode on."
const DEV_FIX = "open Mixel, turn on Settings › Developer mode, then quit and reopen Mixel"

// Where Mixel keeps its data (the desktop's electron/user-data.ts).
export function dataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIXEL_DATA_DIR) return env.MIXEL_DATA_DIR
  if (platform === "darwin") return path.join(homedir(), "Library", "Application Support", "0x1audio")
  if (platform === "win32") return path.join(env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "0x1audio")
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "0x1audio")
}

// A failure before the call reached Mixel: safe to try again, whatever the tool.
class NotSent extends Error {
  constructor(readonly cause: unknown) {
    super("not sent")
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class Mixel {
  readonly dataDir: string
  readonly caller: string
  readonly timeoutMs: number
  readonly retries: number
  private readonly platform: NodeJS.Platform
  private next = 1

  constructor(options: MixelOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.dataDir = options.dataDir ?? dataDir(this.platform)
    this.caller = options.caller ?? "script"
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.retries = Math.max(0, Math.trunc(options.retries ?? 2))
  }

  // What the Library holds: how many sounds, and how many of each kind of thing. Counts only.
  async overview(): Promise<Overview> {
    const reply = JSON.parse(await this.call("library_overview", {}, true)) as { sounds: number; concepts: Record<string, number>; more?: number }
    return { sounds: reply.sounds, concepts: reply.concepts ?? {}, more: reply.more ?? 0 }
  }

  // The person's own sounds, by a few plain words. Without words, the filters alone list sounds.
  async search(want?: string, options: SearchOptions = {}): Promise<Found> {
    return new Found(await this.call("library_search", query(want, options), true))
  }

  // Sounds close to one an earlier search returned (its id), optionally steered by words.
  async similar(id: string, options: SearchOptions & { want?: string } = {}): Promise<Found> {
    const { want, ...rest } = options
    return new Found(await this.call("library_search", { ...query(want, rest), like: id }, true))
  }

  // A crate for the person to audition in Mixel. Nothing is moved, tagged or copied.
  // Needs Settings › Your assistant › "It can propose crates" (code crates_off otherwise).
  async proposeCrate(crate: CrateProposal): Promise<{ sounds: number; unknown: number }> {
    const reply = JSON.parse(await this.call("propose_crate", { ...crate }, false)) as { sounds: number; unknown?: number }
    return { sounds: reply.sounds, unknown: reply.unknown ?? 0 }
  }

  // The running Mixel's version, its SDK and protocol (developer mode).
  async status(): Promise<DevStatus> {
    return (await this.dev("GET", "/v1/status")) as unknown as DevStatus
  }

  // Opens an app folder in Mixel, badged "In development" (developer mode). `mixel check` first:
  // Mixel refuses a folder with errors and says which.
  async openApp(dir: string): Promise<DevApp> {
    const opened = (await this.dev("POST", "/v1/apps", { dir: path.resolve(dir) }, 60_000)) as { id: string; displayName: string; version: string }
    return new DevApp(this, opened.id, opened.displayName, opened.version)
  }

  // --- the Library socket: one line of JSON in, one line out --------------------------------

  private async call(tool: string, args: Record<string, unknown>, readOnly: boolean): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const reply = await this.once(tool, args)
        if (!reply.ok) {
          const body = parse(reply.text) as { error?: { code?: string; message?: string; fix?: string } }
          const problem = body?.error ?? {}
          throw new MixelError(problem.code ?? "mixel_error", problem.message ?? "Mixel couldn't answer that.", problem.fix)
        }
        return reply.text
      } catch (error) {
        const sent = !(error instanceof NotSent)
        const cause = error instanceof NotSent ? error.cause : error
        const again = attempt < this.retries && !(cause instanceof MixelError && !(cause instanceof MixelTimeoutError)) && !missing(cause) && (!sent || readOnly)
        if (!again) throw cause instanceof MixelError ? cause : new MixelUnavailableError("library_search_off", sent ? LIBRARY_LOST : LIBRARY_OFF, LIBRARY_FIX, { cause })
        await sleep(100 * 2 ** attempt)
      }
    }
  }

  private endpoint(): { path: string } | { host: string; port: number; token: string } {
    const folder = path.join(this.dataDir, "agent")
    if (this.platform !== "win32") return { path: path.join(folder, "mixel.sock") }
    // Windows: 127.0.0.1, a port and a token that are new at every start, in a file only the person reads.
    try {
      const found = JSON.parse(readFileSync(path.join(folder, "endpoint.json"), "utf8")) as { port?: unknown; token?: unknown }
      if (typeof found.port === "number" && typeof found.token === "string") return { host: "127.0.0.1", port: found.port, token: found.token }
    } catch {
      // No file: no Mixel listening.
    }
    throw new MixelUnavailableError("library_search_off", LIBRARY_OFF, LIBRARY_FIX)
  }

  private once(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const where = this.endpoint()
    const line = `${JSON.stringify({ id: this.next++, caller: this.caller, tool, args, ...("token" in where ? { token: where.token } : {}) })}\n`
    return new Promise((resolve, reject) => {
      let connected = false
      let pending = ""
      const socket: Socket = "path" in where ? createConnection(where.path) : createConnection({ host: where.host, port: where.port })
      const finish = (error: unknown, value?: { ok: boolean; text: string }) => {
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(connected ? error : new NotSent(error))
        else resolve(value!)
      }
      const timer = setTimeout(() => finish(new MixelTimeoutError(`Mixel took longer than ${Math.round(this.timeoutMs / 1000)} s to answer.`, "try again; Mixel may still be indexing")), this.timeoutMs)
      socket.setEncoding("utf8")
      socket.once("connect", () => {
        connected = true
        socket.write(line)
      })
      socket.on("data", (chunk: string) => {
        pending += chunk
        const end = pending.indexOf("\n")
        if (end < 0) return
        const reply = parse(pending.slice(0, end)) as { ok?: unknown; text?: unknown } | null
        if (!reply || typeof reply.text !== "string") finish(new MixelError("mixel_error", "Mixel's answer wasn't one this SDK understands.", "update the SDK"))
        else finish(null, { ok: reply.ok === true, text: reply.text })
      })
      socket.once("error", (error) => finish(error))
      socket.once("close", () => finish(new Error("Mixel closed the connection before it answered.")))
    })
  }

  // --- the dev socket: HTTP on 127.0.0.1 with this session's token ----------------------------

  private devEndpoint(): { port: number; token: string } {
    try {
      const found = JSON.parse(readFileSync(path.join(this.dataDir, "dev.json"), "utf8")) as { port?: unknown; token?: unknown }
      if (typeof found.port === "number" && typeof found.token === "string") return { port: found.port, token: found.token }
    } catch {
      // No file: developer mode is off, or Mixel is closed.
    }
    throw new MixelUnavailableError("desktop_unavailable", DEV_OFF, DEV_FIX)
  }

  /** @internal */
  async dev(method: string, route: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.devOnce(method, route, body, timeoutMs)
      } catch (error) {
        const again = attempt < this.retries && method === "GET" && !(error instanceof MixelError && !(error instanceof MixelTimeoutError))
        if (!again) throw error instanceof MixelError ? error : new MixelUnavailableError("desktop_unavailable", DEV_OFF, DEV_FIX, { cause: error })
        await sleep(100 * 2 ** attempt)
      }
    }
  }

  private devOnce(method: string, route: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const { port, token } = this.devEndpoint()
    const data = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port, path: route, method, headers: { authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) }, timeout: timeoutMs },
        (response) => {
          let text = ""
          response.setEncoding("utf8")
          response.on("data", (chunk: string) => (text += chunk))
          response.on("end", () => {
            const parsed = (parse(text) ?? {}) as Record<string, unknown> & { error?: { code?: string; message?: string; fix?: string } }
            const status = response.statusCode ?? 0
            if (status >= 200 && status < 300) return resolve(parsed)
            const problem = parsed.error ?? {}
            reject(new MixelError(problem.code ?? "desktop_error", problem.message ?? `Mixel answered ${status}.`, problem.fix))
          })
        },
      )
      request.on("timeout", () => request.destroy(new MixelTimeoutError(`Mixel took longer than ${Math.round(timeoutMs / 1000)} s to answer.`, "try again")))
      request.on("error", reject)
      request.end(data)
    })
  }

  /** @internal */
  devStream(route: string, signal?: AbortSignal): Promise<import("node:http").IncomingMessage> {
    const { port, token } = this.devEndpoint()
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: route, headers: { authorization: `Bearer ${token}` }, signal }, (response) => {
        if ((response.statusCode ?? 0) >= 300) {
          response.resume()
          reject(new MixelError("desktop_error", `Mixel answered ${response.statusCode}.`))
          return
        }
        response.setEncoding("utf8")
        resolve(response)
      })
      request.on("error", (error) => reject(signal?.aborted ? error : new MixelUnavailableError("desktop_unavailable", DEV_OFF, DEV_FIX, { cause: error })))
      request.end()
    })
  }
}

function query(want: string | undefined, options: SearchOptions): Record<string, unknown> {
  const filters = Object.fromEntries(Object.entries({ type: options.type, key: options.key, bpm: options.bpm, length: options.length }).filter(([, value]) => value !== undefined))
  return {
    ...(want ? { want } : {}),
    ...(options.avoid?.length ? { avoid: options.avoid } : {}),
    ...(options.unlike?.length ? { unlike: options.unlike } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(options.offset ? { offset: Math.trunc(options.offset) } : {}),
  }
}

// The socket's own failures that mean "nothing is listening there": not worth a retry.
function missing(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code
  return error instanceof MixelUnavailableError || code === "ENOENT" || code === "ENOTDIR" || code === "EACCES"
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
