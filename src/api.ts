import { Api } from "./client/index.js"
import { createClient } from "./client/client/index.js"

export function cloudApi(
  baseUrl: string,
  token?: string | (() => string | undefined),
  fetchImpl?: typeof fetch,
): Api {
  const client = createClient({ baseUrl, fetch: fetchImpl })
  client.interceptors.request.use((request) => {
    const value = typeof token === "function" ? token() : token
    if (value) request.headers.set("authorization", `Bearer ${value}`)
    return request
  })
  return new Api({ client })
}
