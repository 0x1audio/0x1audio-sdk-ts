// @0x1audio/sdk: the Mixel cloud, typed from openapi.json. The page side of an app is
// "@0x1audio/sdk/page"; the Mixel on this computer (Node) is "@0x1audio/sdk/local".
export { cloudApi, DEFAULT_CLOUD, type CloudOptions } from "./api.js"
export { MixelApiError, MixelError, MixelTimeoutError, MixelUnavailableError, type ProblemDetail } from "./errors.js"
export { version } from "./version.js"
export {
  Api,
  type CatalogList,
  type CliDevice,
  type CliToken,
  type CliTokenList,
  type Health,
  type Me,
  type Options,
  type SubmissionCreated,
  type SubmissionList,
  type SubmissionStatus,
  V1,
} from "./client/index.js"
export { createClient } from "./client/client/index.js"
