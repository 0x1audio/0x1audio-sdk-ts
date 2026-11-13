# Changelog

Every release of `@0x1audio/sdk`, newest first. Versions follow [semantic versioning](https://semver.org): until 1.0, a release that changes the version's middle number (0.3 → 0.4) may break code written for the one before, and every 0.3.x release keeps working with code written for 0.3.0. The page API (`@0x1audio/sdk/page`) follows the Mixel app SDK it pairs with: an app whose `app.json` says `"sdk": "^0.3"` uses `@0x1audio/sdk` 0.3.x.

## 0.3.1 (not published yet)

### Added

- **`@0x1audio/sdk/local`: the Mixel on this computer, from Node.** `new Mixel()` finds the running Mixel through its data folder (or `MIXEL_DATA_DIR`).
  - `overview()` says what the Library holds, in counts.
  - `search(words, { avoid, type, key, bpm, length })` searches your own sounds by words, 10 at a time. `offset: found.next` gets the next page from a Mixel that pages.
  - `similar(id)` finds sounds close to one a search returned.
  - `proposeCrate({ title, request, ids })` hands you a crate to audition.
  - In developer mode, `status()` and `openApp(folder)` open an app folder in Mixel, with `reload()`, `log()` and `close()`.
- **Typed errors** for every client. Every failure is a `MixelError` with `code`, `message` and `fix`:
  - `MixelApiError` when the cloud answered with an error, with `status`, `param`, `docUrl` and every problem in `errors`;
  - `MixelUnavailableError` when nothing answered;
  - `MixelTimeoutError` when the answer was too slow.

  `JSON.stringify(error)` gives `{code, message, fix}`.
- **Timeouts and retries in `cloudApi`.** It waits 30 s per attempt (`timeoutMs`). It makes 2 more attempts (`retries`) for a GET after a network failure, a timeout, or a 408, 429, 502, 503 or 504, and honours `Retry-After`. A POST is never sent twice. `MixelUnavailableError` and `MixelTimeoutError` work the same way for the local client.
- `cloudApi()` takes an options object. Without one it uses `MIXEL_API` and `MIXEL_TOKEN` (Node), else `https://cloud.0x1audio.com`.
- Agent-friendly output: `JSON.stringify(found)` is the compact reply Mixel sent (about 300 tokens at most), not the objects.
- `version`, the package's version.
- `examples/` with five runnable examples, and `npm run smoke` to run them against your Mixel.
- `npm run openapi` cuts `openapi.json` from the cloud's spec. `npm run drift` fails when `openapi.json` or `src/client` is behind.

- **The Library permission split (Mixel 0.1.23), on the page.** `PermissionCode` and `permissionCodes` have `"library-read"` next to `"library"`, and the page exports `permissionText`, the line Mixel shows for each.
  - `"library"` adds to the Library: `ox.library.add`.
  - `"library-read"` lists it and opens a sound the person picks: `ox.library.list` and `ox.library.file`.
  - A refusal from `ox.library` is an `OxError`: `permission_undeclared` when `app.json` doesn't ask (its `hint` names the line to add), `permission_denied` when the person said no.
- The cloud types follow today's API: `Me` has `notices` (the emails an account can turn off), and `TermsStanding` has `minimum`, `requiredFrom` and `review`.
- Installs from a release file or from git before npm has the package: `npm install` builds a git checkout (`prepare`), and every release attaches the packed `.tgz`.

### Changed

- **A page that lists or opens Library sounds needs `"library-read"` in `app.json`.** With `"library"` alone, Mixel 0.1.23 refuses `ox.library.list`, and `ox.library.file` for a sound the app didn't make or add.
- `ox.library.add` returns `LibraryAdded[]`: each item, or only `{ imported: "already" }` when the Library had the same audio from elsewhere.
- **The cloud client now matches the Mixel cloud as it is.** The methods are `health`, `me`, `cliLogin`, `cliLoginPoll`, `cliTokens`, `revokeCliToken`, `appCatalog`, `createSubmission`, `submissions` and `submission`.
- Calls return `{ data }` and throw a `MixelError` on failure, instead of returning `{ error }`.
- The package ships `dist/src` only, not the compiled tests.

### Removed

- `register`, `verifyRegistration`, `choosePassword`, `resendRegistration`, `login`, `session`, `logout`, `desktopHandoff` and `desktopExchange`. Sign-in is now on the web, through the cloud's own sign-in pages, and these routes no longer exist on the server, so calling them already failed with a 404.

## 0.3.0

The first version under the Apache-2.0 licence. It was never published to npm; Mixel's own apps used it from a checkout.

- `@0x1audio/sdk/page`: the typed `ox` object around `@ox.action`. It has `ox.run` with progress, events and Stop (an `OxError` lists what was kept), `ox.files`, `ox.data`, `ox.unavailable()` and typed multiple choices. Its types come from the shared contract, including `ControlHint.origin` and the `gpu` permission.
- `cloudApi(baseUrl, token)`: a client for the cloud's first API.
- Apache-2.0, a DCO for contributions, a security policy, and a hand-run npm publish with provenance.
