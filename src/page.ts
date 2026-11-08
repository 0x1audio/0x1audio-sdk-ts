// The page side of an app: `import { ox } from "@0x1audio/sdk/page"`.
// 0x1audio injects window.ox1 before the page runs; this module is the typed way in.
// Every call either returns its value or throws an OxError with a code.
// The action and protocol shapes below mirror sdk-py/_protocol.py and
// desktop/electron/apps/protocol.ts; GAB-37 generates all three from one contract.

export type ErrorCode = "bad_input" | "problem" | "cancelled" | "crashed" | "timeout" | "permission_denied" | "permission_undeclared" | "unavailable"

export interface ErrorBody {
  code: ErrorCode
  message: string
  hint?: string
  detail?: string
}

export class OxError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly detail?: string
  constructor(body: ErrorBody) {
    super(body.message)
    this.name = "OxError"
    this.code = body.code
    this.hint = body.hint
    this.detail = body.detail
  }
}

export type Control = "files" | "folder" | "choice" | "text" | "number" | "slider" | "toggle"

export interface ControlHint {
  control: Control
  accept?: "audio" | "midi" | "any"
  multiple?: boolean
  label?: string
  placeholder?: string
  step?: number
}

export interface PropertySchema {
  type?: "string" | "number" | "integer" | "boolean" | "array"
  title?: string
  default?: unknown
  enum?: string[]
  minimum?: number
  maximum?: number
  minItems?: number
  items?: { type: "string"; enum?: string[] }
  anyOf?: PropertySchema[]
  "x-ox"?: ControlHint
}

// One @ox.action, as the Python side declared it.
export interface ActionSpec {
  name: string
  title: string
  input: { type: "object"; properties: Record<string, PropertySchema>; required: string[]; additionalProperties: false }
  timeout: number
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
  // Abort to press Stop: the action gets ox.Cancelled and the promise rejects with code "cancelled".
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
}

declare global {
  interface Window {
    ox1?: Bridge
  }
}

function bridge(): Bridge {
  const current = typeof window === "undefined" ? undefined : window.ox1
  if (!current || current.protocol !== 1) {
    throw new OxError({ code: "unavailable", message: current ? "Update 0x1audio to open this app." : "Open this app in 0x1audio." })
  }
  return current
}

function unwrap<T>(result: HostResult<T> | undefined): T {
  if (result && result.ok) return result.body
  throw new OxError(result?.error ?? { code: "crashed", message: "The app ran into a problem." })
}

let tickets = 0

async function run<Result = unknown>(action: string, input: Record<string, unknown> = {}, options: RunOptions = {}): Promise<Result> {
  const host = bridge()
  if (options.signal?.aborted) throw new OxError({ code: "cancelled", message: "Stopped." })
  const ticket = `${Date.now().toString(36)}-${(tickets += 1)}`
  const stop = host.onProgress((from, fraction, label) => {
    if (from === ticket) options.onProgress?.(fraction, label)
  })
  const abort = () => void host.cancel(ticket)
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    return unwrap(await host.run(ticket, action, input)) as Result
  } finally {
    stop()
    options.signal?.removeEventListener("abort", abort)
  }
}

export const ox = {
  // Run an @ox.action. 0x1audio checks the input, runs it in the background, and streams progress.
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
  data: {
    list: (path = ""): Promise<string[]> => bridge().data.list(path),
    read: async (path: string): Promise<Uint8Array> => new Uint8Array(await bridge().data.read(path)),
    readText: async (path: string): Promise<string> => new TextDecoder("utf-8", { fatal: true }).decode(await bridge().data.read(path)),
    write: (path: string, body: Uint8Array | string): Promise<void> => bridge().data.write(path, body),
    remove: (path: string): Promise<void> => bridge().data.remove(path),
  },
  app: {
    // Open another page of this app in a new window, like "settings.html".
    open: (href: string): Promise<void> => bridge().open(href),
  },
  // True inside 0x1audio. Use it to show "Open this app in 0x1audio" in a plain browser.
  available: (): boolean => typeof window !== "undefined" && window.ox1?.protocol === 1,
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
