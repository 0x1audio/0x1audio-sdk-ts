import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { cloudApi, DEFAULT_CLOUD, MixelApiError, MixelError, MixelTimeoutError, MixelUnavailableError } from "../src/index.js"

type Seen = { method: string; path: string; authorization: string | undefined; raw: string }
type Route = (request: IncomingMessage, response: ServerResponse, raw: string) => void

async function serve(route: Route) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString()
      seen.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization, raw })
      route(request, response, raw)
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
  }
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}

const root = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let step = 0; step < 4 && !existsSync(resolve(dir, "openapi.json")); step += 1) dir = resolve(dir, "..")
  return dir
})()

test("calls return their data and send the bearer token and the body", async () => {
  const server = await serve((request, response) => {
    if (request.url === "/api/v1/health") return json(response, 200, { status: "ok" })
    if (request.url === "/api/v1/cli/login") return json(response, 200, { device_code: "d", user_code: "CALM-RIVER-42", verification_url: "https://cloud.0x1audio.com/cli", interval: 5, expires_in: 600 })
    if (request.url === "/api/v1/account/cli-tokens/revoke") {
      response.writeHead(204)
      return response.end()
    }
    json(response, 404, { error: { code: "not_found", message: "no route" } })
  })
  try {
    const api = cloudApi(server.url, () => "mxl_secret")
    const { data: health } = await api.v1.health()
    assert.deepEqual(health, { status: "ok" })
    assert.equal(server.seen[0]?.authorization, "Bearer mxl_secret")
    assert.equal(server.seen[0]?.raw, "")
    const { data: device } = await api.v1.cliLogin({ body: { client: "my script" } })
    assert.equal(device.user_code, "CALM-RIVER-42")
    assert.deepEqual(JSON.parse(server.seen.at(-1)?.raw ?? ""), { client: "my script" })
    const revoked = await api.v1.revokeCliToken({ body: { id: "t1" } })
    assert.equal(revoked.response.status, 204)
  } finally {
    await server.close()
  }
})

test("the options form, the default cloud and MIXEL_API, MIXEL_TOKEN", async () => {
  assert.equal(DEFAULT_CLOUD, "https://cloud.0x1audio.com")
  const server = await serve((_, response) => json(response, 200, { status: "ok" }))
  const before = { api: process.env.MIXEL_API, token: process.env.MIXEL_TOKEN }
  try {
    process.env.MIXEL_API = `${server.url}/`
    process.env.MIXEL_TOKEN = "mxl_from_env"
    await cloudApi().v1.health()
    assert.equal(server.seen[0]?.authorization, "Bearer mxl_from_env")
    await cloudApi({ baseUrl: server.url, token: "mxl_given" }).v1.health()
    assert.equal(server.seen[1]?.authorization, "Bearer mxl_given")
  } finally {
    if (before.api === undefined) delete process.env.MIXEL_API
    else process.env.MIXEL_API = before.api
    if (before.token === undefined) delete process.env.MIXEL_TOKEN
    else process.env.MIXEL_TOKEN = before.token
    await server.close()
  }
})

test("an error status throws a MixelApiError with the cloud's code, and every problem", async () => {
  const server = await serve((request, response) => {
    if (request.url === "/api/v1/me") return json(response, 401, { error: { code: "unauthenticated", message: "Sign in to continue." } })
    json(response, 400, {
      error: { code: "manifest_invalid", message: "app.json has 2 problems.", fix: "mixel check", doc_url: "https://developers.0x1audio.com/errors#manifest_invalid" },
      errors: [
        { code: "manifest_summary", message: "summary is missing." },
        { code: "sdk_missing", message: "app.json has no sdk range.", param: "sdk" },
      ],
    })
  })
  try {
    const api = cloudApi({ baseUrl: server.url })
    const denied = await api.v1.me().then(() => null, (error: unknown) => error)
    assert.ok(denied instanceof MixelApiError)
    assert.ok(denied instanceof MixelError)
    assert.equal(denied.status, 401)
    assert.equal(denied.code, "unauthenticated")
    assert.equal(denied.message, "Sign in to continue.")
    // The body's own shape still reads the same way.
    assert.deepEqual(denied.error, { code: "unauthenticated", message: "Sign in to continue." })
    assert.deepEqual(JSON.parse(JSON.stringify(denied)), { code: "unauthenticated", message: "Sign in to continue.", status: 401 })

    const refused = await api.v1.createSubmission({ body: { repository: "ada/app", commit: "0".repeat(40) } }).then(() => null, (error: unknown) => error)
    assert.ok(refused instanceof MixelApiError)
    assert.equal(refused.code, "manifest_invalid")
    assert.equal(refused.fix, "mixel check")
    assert.equal(refused.docUrl, "https://developers.0x1audio.com/errors#manifest_invalid")
    assert.deepEqual(refused.errors.map((problem) => problem.code), ["manifest_summary", "sdk_missing"])
    // A POST is never sent twice.
    assert.equal(server.seen.filter((seen) => seen.method === "POST").length, 1)
  } finally {
    await server.close()
  }
})

test("a GET is retried after 503 and 429, honouring Retry-After; a POST is not", async () => {
  let health = 0
  let login = 0
  const server = await serve((request, response) => {
    if (request.url === "/api/v1/health") {
      health += 1
      if (health === 1) return json(response, 503, { error: { code: "unavailable", message: "A dependency is quiet." } })
      if (health === 2) return json(response, 429, { error: { code: "rate_limited", message: "Slow down." } }, { "retry-after": "0" })
      return json(response, 200, { status: "ok" })
    }
    login += 1
    json(response, 503, { error: { code: "unavailable", message: "A dependency is quiet." } })
  })
  try {
    const api = cloudApi({ baseUrl: server.url, retries: 2 })
    const { data } = await api.v1.health()
    assert.deepEqual(data, { status: "ok" })
    assert.equal(health, 3)
    const failed = await api.v1.cliLogin({ body: {} }).then(() => null, (error: unknown) => error)
    assert.ok(failed instanceof MixelApiError)
    assert.equal(failed.status, 503)
    assert.equal(login, 1)
  } finally {
    await server.close()
  }
})

test("retries give up, and a 429 that asks for a long wait comes back at once", async () => {
  const server = await serve((_, response) => json(response, 429, { error: { code: "rate_limited", message: "Slow down." } }, { "retry-after": "120" }))
  try {
    const started = Date.now()
    const failed = await cloudApi({ baseUrl: server.url }).v1.health().then(() => null, (error: unknown) => error)
    assert.ok(failed instanceof MixelApiError)
    assert.equal(failed.code, "rate_limited")
    assert.equal(server.seen.length, 1)
    assert.ok(Date.now() - started < 10_000, "it didn't wait out the 120 s")
  } finally {
    await server.close()
  }
})

test("a slow cloud is a MixelTimeoutError, after the retries", async () => {
  const server = await serve((_, response) => setTimeout(() => json(response, 200, { status: "ok" }), 400))
  try {
    const failed = await cloudApi({ baseUrl: server.url, timeoutMs: 50, retries: 1 }).v1.health().then(() => null, (error: unknown) => error)
    assert.ok(failed instanceof MixelTimeoutError, String(failed))
    assert.equal(failed.code, "timeout")
    assert.equal(server.seen.length, 2)
  } finally {
    await server.close()
  }
})

test("an unreachable cloud is a MixelUnavailableError with code network", async () => {
  const failed = await cloudApi({ baseUrl: "http://127.0.0.1:9", retries: 1 }).v1.health().then(() => null, (error: unknown) => error)
  assert.ok(failed instanceof MixelUnavailableError, String(failed))
  assert.equal(failed.code, "network")
  assert.match(failed.fix ?? "", /MIXEL_API/)
})

test("the caller's own abort is theirs, and isn't retried", async () => {
  const server = await serve((_, response) => setTimeout(() => json(response, 200, { status: "ok" }), 300))
  try {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 30)
    const failed = await cloudApi({ baseUrl: server.url }).v1.health({ signal: stop.signal }).then(() => null, (error: unknown) => error)
    assert.equal((failed as Error).name, "AbortError")
    assert.equal(server.seen.length, 1)
  } finally {
    await server.close()
  }
})

test("openapi.json is the public list, and the generated client has every operation", async () => {
  const { PUBLIC } = (await import(pathToFileURL(resolve(root, "scripts/openapi.mjs")).href)) as { PUBLIC: Record<string, string> }
  const spec = JSON.parse(readFileSync(resolve(root, "openapi.json"), "utf8")) as { paths: Record<string, Record<string, { operationId?: string }>> }
  const operations = Object.values(spec.paths).flatMap((item) => Object.values(item).map((operation) => operation.operationId).filter(Boolean))
  assert.deepEqual([...operations].sort(), Object.keys(PUBLIC).sort())
  const source = readFileSync(resolve(root, "src/client/sdk.gen.ts"), "utf8")
  for (const operation of operations) assert.match(source, new RegExp(`\\b${operation}\\b`))
  // Nothing private leaves: no reviewer, admin, billing or webhook route.
  assert.doesNotMatch(JSON.stringify(spec.paths), /\/review\/|\/admin\/|billing|webhook/)
})
