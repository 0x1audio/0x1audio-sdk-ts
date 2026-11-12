import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { version } from "../src/index.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("package.json, version.ts and the newest CHANGELOG entry agree", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }
  assert.equal(version, pkg.version)
  const newest = readFileSync(path.join(root, "CHANGELOG.md"), "utf8").match(/^## (\d+\.\d+\.\d+)\b/m)?.[1]
  assert.equal(newest, pkg.version, "add a CHANGELOG.md entry for this version")
})
