// Search your own sounds by words, then find more like the first one:
//   node examples/search.ts "snare" --avoid clap
import { Mixel, MixelError } from "@ox1audio/sdk/local"

const [want = "snare", ...rest] = process.argv.slice(2)
const avoid = rest.flatMap((arg, at) => (rest[at - 1] === "--avoid" ? [arg] : []))
const mixel = new Mixel({ caller: "sdk example" })
try {
  const found = await mixel.search(want, { avoid })
  if (!found.answerable) {
    console.log(`Nothing in the Library is proven to be "${want}". Nearest: ${Object.keys(found.nearest).join(", ") || "none"}`)
  } else {
    for (const sound of found) console.log(`${sound.id.padEnd(5)} ${sound.title.padEnd(32)} ${sound.tier ?? "-"}: ${sound.reason}`)
    if (found.more) console.log(`and ${found.more} more`)
    const first = found.sounds[0]!
    try {
      const like = await mixel.similar(first.id)
      console.log(`\nLike ${first.title}: ${like.sounds.map((sound) => sound.title).join(", ") || "nothing close"}`)
    } catch (error) {
      // Sounds like this one need Mixel's sound model; words work without it.
      if (!(error instanceof MixelError && error.code === "not_ready")) throw error
      console.log(`\nLike ${first.title}: ${error.message}`)
    }
  }
  // What to hand a model: Mixel's compact reply, not the objects above.
  console.log(`\nFor a model (${found.text.length} bytes): ${found.text}`)
} catch (error) {
  if (!(error instanceof MixelError)) throw error
  console.error(`${error.message}\nfix: ${error.fix ?? "-"}`)
  process.exitCode = 1
}
