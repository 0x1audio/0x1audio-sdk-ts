// The page side of an app. The desktop injects window.ox1 before the page runs.
// An app's files live in its data folder, separate from the installed code.

export interface AppData {
  list(path?: string): Promise<string[]>
  read(path: string): Promise<Uint8Array>
  readText(path: string): Promise<string>
  write(path: string, body: Uint8Array | string): Promise<void>
  remove(path: string): Promise<void>
}

export interface Host {
  call<Result = unknown>(name: string, body?: unknown): Promise<Result>
  open(href: string): Promise<void>
  pick?(kind?: "file" | "folder"): Promise<string[]>
  pathFor?(file: File): string
  reveal?(path: string): Promise<boolean>
  readFile?(path: string): Promise<Uint8Array>
  data: {
    list(path?: string): Promise<string[]>
    read(path: string): Promise<Uint8Array>
    write(path: string, body: Uint8Array | string): Promise<void>
    remove(path: string): Promise<void>
  }
}

export function host(): Host | undefined {
  if (typeof window === "undefined") return undefined
  return window.ox1
}

export async function job<Result>(
  name: string,
  body?: unknown,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal,
): Promise<Result> {
  const current = host()
  if (!current) throw new Error("Open this app in 0x1audio.")
  const started = await current.call<{ id: string }>(name, body ?? {})
  const cancel = () => {
    void current.call("cancel", { id: started.id })
  }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      const state = await current.call<{
        done: boolean
        progress?: number
        label?: string
        error?: string | null
        result?: Result
      }>("status", { id: started.id })
      if (typeof state.progress === "number") onProgress?.(state.progress, state.label ?? "")
      if (state.done) {
        if (state.error) throw new Error(state.error)
        return state.result as Result
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

export function data(): AppData {
  const current = host()
  if (!current?.data) throw new Error("Open this app in 0x1audio.")
  return {
    list: (path) => current.data.list(path),
    read: async (path) => new Uint8Array(await current.data.read(path)),
    readText: async (path) => new TextDecoder("utf-8", { fatal: true }).decode(await current.data.read(path)),
    write: (path, body) => current.data.write(path, body),
    remove: (path) => current.data.remove(path),
  }
}

declare global {
  interface Window {
    ox1?: Host
  }
}
