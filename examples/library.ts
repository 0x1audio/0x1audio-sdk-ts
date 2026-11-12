// What your Mixel Library holds, in counts: node examples/library.ts
import { Mixel, MixelError } from "@0x1audio/sdk/local"

const mixel = new Mixel({ caller: "sdk example" })
try {
  const library = await mixel.overview()
  console.log(`${library.sounds} sounds`)
  for (const [concept, count] of Object.entries(library.concepts)) console.log(`  ${concept.padEnd(16)} ${count}`)
  if (library.more) console.log(`  and ${library.more} more kinds`)
} catch (error) {
  if (!(error instanceof MixelError)) throw error
  console.error(`${error.message}\nfix: ${error.fix ?? "-"}`)
  process.exitCode = 1
}
