// The package as a stranger gets it: pack it, install the .tgz into an empty project, and
// import every entry point. `npm run pack:check` (CI and the release workflow run it).
//
//   node scripts/pack-check.mjs [--keep <dir>]   --keep leaves the .tgz in <dir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const keep = process.argv.includes("--keep") ? path.resolve(process.argv[process.argv.indexOf("--keep") + 1]) : null
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mixel-sdk-pack-"))
const run = (cwd, command, args) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const [packed] = JSON.parse(run(root, "npm", ["pack", "--json", "--pack-destination", work]))
  const files = packed.files.map((file) => file.path)
  for (const need of ["package.json", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md", "openapi.json", "dist/src/index.js", "dist/src/index.d.ts", "dist/src/page.js", "dist/src/page.d.ts", "dist/src/local.js", "dist/src/local.d.ts"]) {
    if (!files.includes(need)) throw new Error(`The package is missing ${need}.`)
  }
  const stray = files.filter((file) => /^(test|examples|scripts|src)\//.test(file) || file.startsWith("dist/test"))
  if (stray.length) throw new Error(`The package carries files it shouldn't: ${stray.join(", ")}`)

  const app = path.join(work, "app")
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "stranger", private: true, type: "module" }))
  run(app, "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", path.join(work, packed.filename)])
  fs.writeFileSync(
    path.join(app, "check.mjs"),
    `import { cloudApi, MixelError, version } from "@ox1audio/sdk"
import { Mixel } from "@ox1audio/sdk/local"
import { ox, OxError, permissionCodes } from "@ox1audio/sdk/page"
if (version !== ${JSON.stringify(pkg.version)}) throw new Error("version is " + version)
if (typeof cloudApi !== "function" || typeof Mixel !== "function" || typeof ox.run !== "function") throw new Error("an entry point is missing")
if (!permissionCodes.includes("library-read")) throw new Error("no library-read")
if (!(new OxError({ code: "unavailable", message: "x" }) instanceof Error) || !(MixelError.prototype instanceof Error)) throw new Error("errors")
console.log("ok")
`,
  )
  if (run(app, "node", ["check.mjs"]).trim() !== "ok") throw new Error("The installed package didn't import.")
  if (keep) {
    fs.mkdirSync(keep, { recursive: true })
    fs.copyFileSync(path.join(work, packed.filename), path.join(keep, packed.filename))
  }
  console.log(`${packed.filename}: ${files.length} files, ${packed.size} bytes, installs and imports.`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
