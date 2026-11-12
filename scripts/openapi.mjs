#!/usr/bin/env node
// openapi.json is the public part of the Mixel API, cut from the cloud's own spec.
//
//   npm run openapi                     rewrite openapi.json from the cloud's spec
//   npm run openapi -- --check          exit 1 if openapi.json or src/client drifted (CI)
//   npm run openapi -- path/to/openapi.yaml    read another spec (or set MIXEL_OPENAPI)
//
// The spec is read from MIXEL_OPENAPI, or from a sibling checkout of the cloud repo
// (../0x1audio-cloud/apps/api/openapi/openapi.yaml). Without one, --check still checks that
// src/client is what openapi.json generates, and says the spec part was skipped.
//
// The SDK is public; the cloud's spec also holds reviewer, admin, billing and webhook routes.
// Only the operations in PUBLIC leave, with the schemas they use, and descriptions lose their
// pointers to internal documents. sdk-py cuts the same list (scripts/openapi.py): change both.

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const vendored = path.join(root, "openapi.json")

// operationId: what a developer, a script or an agent does with it.
export const PUBLIC = {
  health: "Is the cloud up",
  me: "Approved or waitlisted, and the Terms",
  cliLogin: "Start a mixel sign-in (device flow)",
  cliLoginPoll: "Finish it: the token, once",
  cliTokens: "The command lines signed in",
  revokeCliToken: "Sign one out",
  appCatalog: "The reviewed apps",
  createSubmission: "Submit an app for review",
  submissions: "An app's submissions",
  submission: "One submission",
}

const DESCRIPTION =
  "The Mixel cloud for developers: your account, signing in the mixel command line, and the reviewed app registry. " +
  "Send the token from mixel login (or MIXEL_TOKEN) as Authorization: Bearer. Errors are {error: {code, message}}; " +
  "refusals the command line prints also carry fix or doc_url."

// "(launch.md 1.4)", "(reports/ship/w1/…)", "(GAB-123)": pointers into documents only the team can read.
const INTERNAL = /\s*\((?=[^()]*(?:\.md\b|reports\/|GAB-\d))[^()]*\)/g

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "description" && typeof item === "string" ? item.replace(INTERNAL, "") : scrub(item)]))
  }
  return value
}

function refs(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => refs(item, found))
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/components/schemas/")) found.add(item.slice(21))
      else refs(item, found)
    }
  }
  return found
}

export function cut(spec) {
  const paths = {}
  const missing = new Set(Object.keys(PUBLIC))
  for (const [where, item] of Object.entries(spec.paths ?? {})) {
    const kept = {}
    for (const [method, operation] of Object.entries(item)) {
      if (operation && typeof operation === "object" && operation.operationId in PUBLIC) {
        kept[method] = operation
        missing.delete(operation.operationId)
      }
    }
    if (Object.keys(kept).length) {
      if (item.parameters) kept.parameters = item.parameters
      paths[where] = kept
    }
  }
  if (missing.size) throw new Error(`The cloud's spec has no ${[...missing].join(", ")}. Was it renamed? Update PUBLIC here and in sdk-py.`)
  const all = spec.components?.schemas ?? {}
  const used = refs(paths)
  for (const queue = [...used]; queue.length; ) {
    for (const name of refs(all[queue.pop()])) {
      if (!used.has(name)) {
        used.add(name)
        queue.push(name)
      }
    }
  }
  const schemas = Object.fromEntries(Object.keys(all).filter((name) => used.has(name)).map((name) => [name, all[name]]))
  return scrub({
    openapi: spec.openapi,
    info: { title: "Mixel API", version: spec.info?.version ?? "0.0.0", license: spec.info?.license, description: DESCRIPTION },
    servers: [{ url: "https://cloud.0x1audio.com" }],
    paths,
    components: { schemas },
  })
}

export function render(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`
}

// What changed between two cut specs, by name: what a person needs to judge the drift.
export function changes(before, after) {
  const index = (spec) => {
    const found = new Map()
    for (const [where, item] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(item)) {
        if (operation?.operationId) found.set(`operation ${operation.operationId} (${method.toUpperCase()} ${where})`, JSON.stringify(operation))
      }
    }
    for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) found.set(`schema ${name}`, JSON.stringify(schema))
    return found
  }
  const old = index(before)
  const now = index(after)
  const lines = []
  for (const [name, body] of now) {
    if (!old.has(name)) lines.push(`added    ${name}`)
    else if (old.get(name) !== body) lines.push(`changed  ${name}`)
  }
  for (const name of old.keys()) if (!now.has(name)) lines.push(`removed  ${name}`)
  return lines
}

function shown(file) {
  const relative = path.relative(process.cwd(), file)
  return relative.startsWith("..") ? file : relative
}

function source(given) {
  const candidates = [given, process.env.MIXEL_OPENAPI, path.resolve(root, "../0x1audio-cloud/apps/api/openapi/openapi.yaml")]
  return candidates.find((file) => file && existsSync(file)) ?? null
}

function files(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full, base) : [path.relative(base, full)]
  })
}

// Generates openapi.json into a scratch folder with this repo's config and compares it with src/client.
async function staleClient() {
  const { createClient } = await import("@hey-api/openapi-ts")
  const { default: config } = await import(path.join(root, "openapi-ts.config.ts"))
  const scratch = mkdtempSync(path.join(tmpdir(), "mixel-sdk-client-"))
  try {
    await createClient({ ...config, input: vendored, output: scratch, logs: { level: "silent" } })
    const want = path.join(root, "src/client")
    const names = new Set([...files(scratch), ...files(want)])
    return [...names].filter((name) => {
      const a = path.join(scratch, name)
      const b = path.join(want, name)
      return !existsSync(a) || !existsSync(b) || readFileSync(a, "utf8") !== readFileSync(b, "utf8")
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(args) {
  const check = args.includes("--check")
  const file = source(args.find((arg) => !arg.startsWith("--")))
  let failed = false
  if (!file) {
    console.log("openapi.json: skipped, no cloud spec here (set MIXEL_OPENAPI, or check out 0x1audio-cloud beside this repo).")
  } else {
    const want = render(cut(yaml.load(readFileSync(file, "utf8"))))
    const have = existsSync(vendored) ? readFileSync(vendored, "utf8") : ""
    if (want === have) {
      console.log(`openapi.json: up to date with ${shown(file)}.`)
    } else if (check) {
      failed = true
      console.log(`openapi.json: behind ${shown(file)}.`)
      for (const line of changes(have ? JSON.parse(have) : {}, JSON.parse(want))) console.log(`  ${line}`)
      console.log("fix: npm run openapi && npm run generate, then read the diff before you commit.")
    } else {
      const temporary = `${vendored}.tmp`
      writeFileSync(temporary, want)
      renameSync(temporary, vendored)
      console.log(`openapi.json: rewritten from ${shown(file)}. Next: npm run generate.`)
    }
  }
  if (check) {
    const stale = await staleClient()
    if (stale.length) {
      failed = true
      console.log(`src/client: ${stale.length} file(s) differ from what openapi.json generates (${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}).`)
      console.log("fix: npm run generate")
    } else {
      console.log("src/client: what openapi.json generates.")
    }
  }
  process.exitCode = failed ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
