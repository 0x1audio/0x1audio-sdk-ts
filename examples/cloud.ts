// The Mixel cloud: is it up, and, signed in, who you are and the reviewed apps.
//   node examples/cloud.ts                 health only
//   MIXEL_TOKEN=mxl_… node examples/cloud.ts
import { cloudApi, MixelError } from "@0x1audio/sdk"

const api = cloudApi()
try {
  const { data: health } = await api.v1.health()
  console.log(`cloud: ${health.status}`)
  if (process.env.MIXEL_TOKEN) {
    const { data: me } = await api.v1.me()
    console.log(`account: ${me.status}`)
    const { data: catalog } = await api.v1.appCatalog()
    for (const app of catalog.apps) console.log(`  ${app.displayName.padEnd(24)} ${app.version}`)
  }
} catch (error) {
  if (!(error instanceof MixelError)) throw error
  console.error(`${error.code}: ${error.message}${error.fix ? `\nfix: ${error.fix}` : ""}`)
  process.exitCode = 1
}
