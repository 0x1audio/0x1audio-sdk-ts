import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { cloudApi } from "../src/index.js"

test("cloud client sends the bearer token and the login body", async () => {
  const seen: Array<{ method: string; path: string; authorization: string | undefined; raw: string }> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString()
      seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        raw,
      })
      if (request.url === "/api/v1/health") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "ok" }))
        return
      }
      if (request.url === "/api/v1/auth/session") {
        response.writeHead(401, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { code: "unauthorized", message: "sign in" } }))
        return
      }
      if (request.url === "/api/v1/auth/logout") {
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "user", email: "ada@example.com" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const api = cloudApi(`http://127.0.0.1:${port}`, () => "secret")
  try {
    const health = await api.v1.health()
    assert.deepEqual(health.data, { status: "ok" })
    assert.equal(seen[0]?.authorization, "Bearer secret")
    assert.equal(seen[0]?.raw, "")
    const denied = await api.v1.session()
    assert.deepEqual(denied.error, { error: { code: "unauthorized", message: "sign in" } })
    const account = await api.v1.login({ body: { email: "ada@example.com", password: "correct horse" } })
    assert.equal(account.data?.email, "ada@example.com")
    assert.equal(seen.at(-1)?.path, "/api/v1/auth/login")
    assert.deepEqual(JSON.parse(seen.at(-1)?.raw ?? ""), { email: "ada@example.com", password: "correct horse" })
    const gone = await api.v1.logout()
    assert.equal(gone.response?.status, 204)
    assert.equal(gone.data, null)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test("an unreachable host comes back as an error", async () => {
  const api = cloudApi("http://127.0.0.1:9")
  const health = await api.v1.health()
  assert.ok(health.error)
  assert.equal(health.data, undefined)
})

test("the generated client matches the snapshot", () => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let step = 0; step < 4; step += 1) {
    if (existsSync(resolve(dir, "openapi.json"))) break
    dir = resolve(dir, "..")
  }
  const spec = JSON.parse(readFileSync(resolve(dir, "openapi.json"), "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }
  const source = readFileSync(resolve(dir, "src/client/sdk.gen.ts"), "utf8")
  for (const item of Object.values(spec.paths)) {
    for (const operation of Object.values(item)) {
      if (operation.operationId) assert.match(source, new RegExp(`\\b${operation.operationId}\\b`))
    }
  }
})
