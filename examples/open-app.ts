// Run an app in Mixel: open an app folder in the running Mixel, badged "In development", print its
// log for a few seconds, then close it. Needs Settings › Developer mode.
//   node examples/open-app.ts path/to/my-app [seconds]
// To run one action from the terminal instead, without Mixel: mixel run ACTION --file song.wav
import { Mixel, MixelError } from "@ox1audio/sdk/local"

const [dir = ".", seconds = "5"] = process.argv.slice(2)
const mixel = new Mixel({ caller: "sdk example" })
try {
  const { mixel: version } = await mixel.status()
  const app = await mixel.openApp(dir)
  console.log(`Opened ${app.displayName} ${app.version} in Mixel ${version}.`)
  const stop = AbortSignal.timeout(Number(seconds) * 1000)
  for await (const line of app.log(stop)) if (line.text) console.log(`[${line.type}] ${line.text}`)
  await app.close()
  console.log("Closed it.")
} catch (error) {
  if (!(error instanceof MixelError)) throw error
  console.error(`${error.message}\nfix: ${error.fix ?? "-"}`)
  process.exitCode = 1
}
