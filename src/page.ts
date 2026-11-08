// The page side of an app: `import { ox } from "@0x1audio/sdk/page"`.
// Mixel injects window.ox1 before the page runs; this module is the typed way in.
// Every call either returns its value or throws an OxError with a code.

import type { ActionSpec, ErrorBody as ContractErrorBody, ErrorCode } from "./contract.gen.js"

// The shapes shared with sdk-py and the desktop are generated from sdk-py/contract.
export type { ActionSpec, Control, ControlHint, ErrorCode, PropertySchema } from "./contract.gen.js"
export { errorCodes, permissionCodes, protocolVersion } from "./contract.gen.js"

export interface ErrorBody extends Omit<ContractErrorBody, "kept"> {
  // On "cancelled": what the action finished before Stop. Already in the Library.
  kept?: Exported[]
}

export class OxError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly detail?: string
  // After Stop: the sounds and files the action had already made. Empty when nothing was finished.
  readonly kept: Exported[]
  constructor(body: ErrorBody) {
    super(body.message)
    this.name = "OxError"
    this.code = body.code
    this.hint = body.hint
    this.detail = body.detail
    this.kept = body.kept ?? []
  }
}

// What an action returns when it returns ox.sound/midi/file exports: they are already in the Library.
export interface Exported {
  id: string
  kind: "sound" | "midi" | "other"
  title: string
  path: string
}

export interface RunOptions {
  // fraction is 0..1, or null while the action doesn't know how far along it is.
  onProgress?: (fraction: number | null, label: string) => void
  // Events the action sends with ox.emit(name, body) while it runs, like partial results.
  onEvent?: (name: string, body: unknown) => void
  // Abort to press Stop: the action gets ox.Cancelled and the promise rejects with code "cancelled".
  // The OxError's `kept` lists what was finished before Stop.
  signal?: AbortSignal
}

export interface PickOptions {
  accept?: "audio" | "midi" | "any"
  multiple?: boolean
  folder?: boolean
}

export interface LibraryItem {
  id: string
  kind: string
  title: string
  filename: string
  duration: number | null
  bpm: number | null
  musicalKey: string | null
  appName: string | null
  created: number
  url: string
}

type HostResult<T> = { ok: true; body: T } | { ok: false; error: ErrorBody }

// window.ox1, as the desktop's preload exposes it. Pages use `ox` below, not this.
export interface Bridge {
  protocol: number
  actions(): Promise<HostResult<ActionSpec[]>>
  run(ticket: string, action: string, input: Record<string, unknown>): Promise<HostResult<unknown>>
  cancel(ticket: string): Promise<boolean>
  onProgress(callback: (ticket: string, fraction: number | null, label: string) => void): () => void
  onEvent?(callback: (ticket: string, name: string, body: unknown) => void): () => void
  open(href: string): Promise<void>
  pick(options?: PickOptions): Promise<string[]>
  pathFor(file: File): string
  reveal(path: string): Promise<boolean>
  readFile(path: string): Promise<Uint8Array>
  libraryList(kind?: string): Promise<LibraryItem[]>
  libraryImport(paths: string[]): Promise<LibraryItem[]>
  libraryFile(id: string): Promise<string>
  onLibrary(callback: () => void): () => void
  data: {
    list(path?: string): Promise<string[]>
    read(path: string): Promise<Uint8Array>
    write(path: string, body: Uint8Array | string): Promise<void>
    remove(path: string): Promise<void>
  }
  // The data calls with their error code (Mixel 0.3+). Older hosts only have `data`.
  dataResult?(op: "list" | "read" | "write" | "remove", path: string, body?: Uint8Array | string): Promise<HostResult<unknown>>
}

declare global {
  interface Window {
    ox1?: Bridge
  }
}

// Why the page can't reach Mixel, or null when it can. The words name the product, so apps don't have to.
function unavailable(): OxError | null {
  const current = typeof window === "undefined" ? undefined : window.ox1
  if (current && current.protocol === 1) return null
  return new OxError({ code: "unavailable", message: current ? "Update Mixel to open this app." : "Open this app in Mixel." })
}

function bridge(): Bridge {
  const missing = unavailable()
  if (missing) throw missing
  return window.ox1 as Bridge
}

function unwrap<T>(result: HostResult<T> | undefined): T {
  if (result && result.ok) return result.body
  throw new OxError(result?.error ?? { code: "crashed", message: "The app ran into a problem." })
}

// ox.data through dataResult when the host has it, so a refusal is an OxError with its code
// (permission_undeclared names the fix). An Error thrown across the bridge keeps only its message.
async function data<T>(op: "list" | "read" | "write" | "remove", path: string, body?: Uint8Array | string): Promise<T> {
  const host = bridge()
  if (host.dataResult) return unwrap(await host.dataResult(op, path, body)) as T
  try {
    if (op === "list") return (await host.data.list(path)) as T
    if (op === "read") return (await host.data.read(path)) as T
    if (op === "write") return (await host.data.write(path, body ?? "")) as T
    return (await host.data.remove(path)) as T
  } catch (error) {
    throw new OxError({ code: "permission_denied", message: error instanceof Error ? error.message : "Could not use this app's data." })
  }
}

let tickets = 0

async function run<Result = unknown>(action: string, input: Record<string, unknown> = {}, options: RunOptions = {}): Promise<Result> {
  const host = bridge()
  if (options.signal?.aborted) throw new OxError({ code: "cancelled", message: "Stopped." })
  const ticket = `${Date.now().toString(36)}-${(tickets += 1)}`
  const stop = host.onProgress((from, fraction, label) => {
    if (from === ticket) options.onProgress?.(fraction, label)
  })
  const stopEvents = options.onEvent && host.onEvent
    ? host.onEvent((from, name, body) => {
        if (from === ticket) options.onEvent?.(name, body)
      })
    : () => {}
  const abort = () => void host.cancel(ticket)
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    return unwrap(await host.run(ticket, action, input)) as Result
  } finally {
    stop()
    stopEvents()
    options.signal?.removeEventListener("abort", abort)
  }
}

export const ox = {
  // Run an @ox.action. Mixel checks the input, runs it in the background, and streams progress.
  run,
  // The actions the app's Python declared, with their input schemas. <ActionForm> draws from this.
  actions: async (): Promise<ActionSpec[]> => unwrap(await bridge().actions()),
  files: {
    // Ask the person for files (or a folder). Whatever they pick, the app may read and write next to.
    pick: (options: PickOptions = {}): Promise<string[]> => bridge().pick(options),
    // The path of a file dropped on the page, which the app may then use.
    fromDrop: (file: File): string => bridge().pathFor(file),
    read: (path: string): Promise<Uint8Array> => bridge().readFile(path),
    reveal: async (path: string): Promise<void> => {
      await bridge().reveal(path)
    },
  },
  library: {
    list: (options: { kind?: "sound" | "midi" | "other" } = {}): Promise<LibraryItem[]> => bridge().libraryList(options.kind),
    add: (paths: string[]): Promise<LibraryItem[]> => bridge().libraryImport(paths),
    // The file behind a Library item, which the app may then read (needs "files").
    file: (id: string): Promise<string> => bridge().libraryFile(id),
    onChange: (callback: () => void): (() => void) => bridge().onLibrary(callback),
  },
  // The app's own files (needs "data"). Errors are OxError: permission_undeclared when app.json doesn't ask for data.
  data: {
    list: (path = ""): Promise<string[]> => data<string[]>("list", path),
    read: async (path: string): Promise<Uint8Array> => new Uint8Array(await data<Uint8Array>("read", path)),
    readText: async (path: string): Promise<string> => new TextDecoder("utf-8", { fatal: true }).decode(await data<Uint8Array>("read", path)),
    write: async (path: string, body: Uint8Array | string): Promise<void> => {
      await data<null>("write", path, body)
    },
    remove: async (path: string): Promise<void> => {
      await data<null>("remove", path)
    },
  },
  app: {
    // Open another page of this app in a new window, like "settings.html".
    open: (href: string): Promise<void> => bridge().open(href),
  },
  // True inside Mixel.
  available: (): boolean => unavailable() === null,
  // Why calls would fail here, as the OxError they'd throw ("Open this app in Mixel."), or null inside Mixel.
  // Show its message instead of writing the product's name in the app: toast.error(ox.unavailable()?.message).
  unavailable,
}

// Gone in 0.3. Kept as names so old pages fail with the fix instead of "is not a function".
/** @deprecated Gone in 0.3. Use `ox.run(action, input, { onProgress, signal })`. */
export function job(): never {
  throw new Error('job() is gone: use ox.run("action", input, { onProgress, signal }).\nfix:  import { ox } from "@0x1audio/sdk/page"\ndocs: https://docs.0x1audio.com/page#run')
}

/** @deprecated Gone in 0.3. Use the typed `ox` object. */
export function host(): never {
  throw new Error('host() is gone: use the typed ox object.\nfix:  import { ox } from "@0x1audio/sdk/page"; then ox.run, ox.files.pick, ox.data.read ...\ndocs: https://docs.0x1audio.com/page')
}
