// Hand yourself a crate of sounds to audition in Mixel: node examples/crate.ts "snare"
// Nothing is moved, tagged or copied. Needs Settings › Your assistant › It can propose crates.
import { Mixel, MixelError } from "@ox1audio/sdk/local"

const want = process.argv[2] ?? "snare"
const mixel = new Mixel({ caller: "sdk example" })
try {
  const found = await mixel.search(want)
  if (!found.answerable) throw new MixelError("nothing_found", `Nothing in the Library is proven to be "${want}".`, "try other words")
  const crate = await mixel.proposeCrate({ title: `From a script: ${want}`.slice(0, 40), request: want, ids: found.sounds.map((sound) => sound.id) })
  console.log(`Proposed a crate of ${crate.sounds} sounds. It's in Mixel, under From your assistant.`)
} catch (error) {
  if (!(error instanceof MixelError)) throw error
  console.error(`${error.message}\nfix: ${error.fix ?? "-"}`)
  process.exitCode = 1
}
