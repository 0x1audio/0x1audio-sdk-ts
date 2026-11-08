import { defineConfig, OperationPath } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "openapi.json",
  output: "src/client",
  plugins: [
    "@hey-api/client-fetch",
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
