import { Api } from "./client/index.js"
import { createClient } from "./client/client/index.js"
import { MixelApiError, MixelError, MixelTimeoutError, MixelUnavailableError, type ProblemDetail } from "./errors.js"

export const DEFAULT_CLOUD = "https://cloud.0x1audio.com"

export interface CloudOptions {
  // Where the cloud is. Default: MIXEL_API (Node), else https://cloud.0x1audio.com.
  baseUrl?: string
  // The token `mixel login` saved, or MIXEL_TOKEN (Node). A function is asked before every call.
  token?: string | (() => string | undefined)
  // How long one attempt may take, in milliseconds. Default 30 000.
  timeoutMs?: number
  // Extra attempts for a call that is safe to repeat (GET, HEAD, or one with an Idempotency-Key)
  // after a network failure, a timeout, or 408, 429, 502, 503, 504. Default 2. 0 turns them off.
  retries?: number
  fetch?: typeof fetch
}

type Token = CloudOptions["token"]

const env = (name: string): string | undefined => (typeof process === "undefined" ? undefined : process.env?.[name]) || undefined

// The Mixel cloud, typed from openapi.json. Every call returns its data or throws a MixelError:
//
//   const api = cloudApi()
//   const { data } = await api.v1.appCatalog()
//
// cloudApi(baseUrl, token, fetch) still works as before.
export function cloudApi(options?: CloudOptions): Api
export function cloudApi(baseUrl: string | undefined, token?: Token, more?: typeof fetch | Omit<CloudOptions, "baseUrl" | "token">): Api
export function cloudApi(first?: string | CloudOptions, token?: Token, more?: typeof fetch | Omit<CloudOptions, "baseUrl" | "token">): Api {
  const options: CloudOptions =
    typeof first === "object" && first !== null ? first : { baseUrl: first, token, ...(typeof more === "function" ? { fetch: more } : more) }
  const baseUrl = (options.baseUrl || env("MIXEL_API") || DEFAULT_CLOUD).replace(/\/+$/, "")
  const bearer = options.token ?? env("MIXEL_TOKEN")
  const timeoutMs = options.timeoutMs ?? 30_000
  const retries = Math.max(0, Math.trunc(options.retries ?? 2))
  const base = options.fetch ?? globalThis.fetch.bind(globalThis)
  const client = createClient({ baseUrl, throwOnError: true, fetch: resilient(base, timeoutMs, retries, baseUrl) })
  client.interceptors.request.use((request) => {
    const value = typeof bearer === "function" ? bearer() : bearer
    if (value) request.headers.set("authorization", `Bearer ${value}`)
    return request
  })
  client.interceptors.error.use((error, response) => failure(error, response, baseUrl, timeoutMs))
  return new Api({ client })
}

const retryStatus = new Set([408, 429, 502, 503, 504])
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])
// Longer than this and the caller hears about the 429 instead of waiting it out.
const longestWait = 30_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 0.25–0.5 s, then 0.5–1 s, 1–2 s, … up to 8 s: spread out, so many clients don't retry in step.
function backoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2)
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after")
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

function withTimeout(caller: AbortSignal | null | undefined, timer: AbortSignal): AbortSignal {
  if (!caller) return timer
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return any ? any([caller, timer]) : timer
}

// fetch with a timeout per attempt and retries for calls that are safe to repeat.
function resilient(base: typeof fetch, timeoutMs: number, retries: number, where: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const repeatable = safeMethods.has(request.method) || request.headers.has("idempotency-key")
    for (let attempt = 0; ; attempt += 1) {
      const last = !repeatable || attempt >= retries
      const timer = AbortSignal.timeout(timeoutMs)
      let response: Response
      try {
        response = await base(last ? request : request.clone(), { signal: withTimeout(request.signal, timer) })
      } catch (error) {
        // The caller stopped it: never retried, and their own error comes back.
        if (request.signal?.aborted) throw error
        if (last) throw timer.aborted ? timeoutError(where, timeoutMs, error) : offline(where, error)
        await sleep(backoff(attempt))
        continue
      }
      if (last || !retryStatus.has(response.status)) return response
      const wait = retryAfter(response) ?? backoff(attempt)
      if (wait > longestWait) return response
      await response.body?.cancel().catch(() => {})
      await sleep(wait)
    }
  }
}

function timeoutError(where: string, timeoutMs: number, cause?: unknown) {
  return new MixelTimeoutError(`The Mixel cloud at ${where} took longer than ${Math.round(timeoutMs / 1000)} s to answer.`, "try again; a slow network may need a longer timeoutMs", { cause })
}

function offline(where: string, cause?: unknown) {
  return new MixelUnavailableError("network", `Couldn't reach the Mixel cloud at ${where}.`, "check the connection; MIXEL_API or baseUrl sets another address", { cause })
}

function isDetail(value: unknown): value is ProblemDetail {
  return !!value && typeof value === "object" && typeof (value as ProblemDetail).code === "string" && typeof (value as ProblemDetail).message === "string"
}

// What the generated client throws, as a MixelError: the cloud's own code when it sent one.
function failure(error: unknown, response: Response | undefined, where: string, timeoutMs: number): unknown {
  if (error instanceof MixelError) return error
  if (response) {
    const body = error as { error?: unknown; errors?: unknown } | string | undefined
    if (body && typeof body === "object" && isDetail(body.error)) {
      return new MixelApiError(response.status, body.error, Array.isArray(body.errors) ? body.errors.filter(isDetail) : [])
    }
    return new MixelApiError(response.status, { code: `http_${response.status}`, message: `The Mixel cloud answered ${response.status} ${response.statusText}`.trim() + "." })
  }
  const name = (error as { name?: string } | undefined)?.name
  if (name === "TimeoutError") return timeoutError(where, timeoutMs, error)
  // The caller's own AbortSignal: theirs to handle.
  if (name === "AbortError") return error
  return offline(where, error)
}
