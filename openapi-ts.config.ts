import { defineConfig, OperationPath } from "@hey-api/openapi-ts"

// npm run generate: src/client from openapi.json (npm run openapi cuts that from the cloud's spec).
// Calls throw instead of returning { error }: cloudApi (src/api.ts) turns every failure into a
// MixelApiError, MixelTimeoutError or MixelUnavailableError.
export default defineConfig({
  input: "openapi.json",
  output: "src/client",
  plugins: [
    { name: "@hey-api/client-fetch", throwOnError: true },
    {
      name: "@hey-api/sdk",
      operations: {
        containerName: "Api",
        strategy: "single",
        nesting(operation) {
          const version = String(operation.path).match(/^\/api\/(v\d+)\b/)?.[1] ?? "v1"
          return [version, ...OperationPath.fromOperationId()(operation)]
        },
      },
    },
  ],
})
