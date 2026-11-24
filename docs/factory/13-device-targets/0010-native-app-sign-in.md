> **Type:** Backend / Native app
> **Wave:** 13-device-targets
> **Branch:** `feat/native-app-sign-in`
> **Commit style:** `feat(auth): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0005

## Goal

The Quest app signs in to a server that has sign-in on, through the existing shell sign-in flow. Until this wave that flow returned to one fixed URL, `SHELL_RETURN_URL = 'com.companionintelligence.scan://auth'` (`server/portal_auth.ts:391`). Only the phone shells could use it.

## Non-goals

- Do not accept a free-form return URL. That would be an open redirect.
- Do not add a second sign-in route or a second token type.
- Do not change the OIDC client id `'ci-web-xr-scan'`, which is on the do-not-rename list in `CLAUDE.md`.

## Pinned conventions

- ADR 0001. This extends `SHELL_RETURN_URL` into a fixed allowlist of native return URLs, chosen by a fixed request value. Today that value is `shell === '1'` (`server/portal_auth.ts:407`). The token comes from the existing `POST /authenticate/shell/exchange` (`server/portal_auth.ts`, line 26 doc, around line 414).
- The flow stays as the phone shells use it (`src/shared/shell-sign-in.ts`, `mobile/README.md`, "Companion Account sign-in"):
  - a PKCE challenge made by the app;
  - a one-time code that lasts 60 seconds;
  - a session token valid for seven days, sent as `Authorization: Bearer`.
- The Quest app's return URL is `com.companionintelligence.scan.quest://auth`, registered by an intent filter in `meta/`.

## Before implementation

- Read `server/portal_auth.ts` whole, `tests/unit/deno/portal_auth.test.ts`, `src/shared/shell-sign-in.ts` and the desktop deep-link note near `server/portal_auth.ts:394`.

## Open questions & answers

- Q: Does the IdP need a change? — A: Not expected. The return URL is the server's own redirect after the Portal sign-in, not the IdP's. Confirm in `portal_auth.ts` — OPEN.
- Q: Should the 8th Wall Android debug build get its own return URL (ticket 0004)? — OPEN. It shares the shell's scheme unless it gets its own.

## Files impacted

- Changed: `server/portal_auth.ts`, `tests/unit/deno/portal_auth.test.ts`.
- New: the sign-in client and intent filter in `meta/`.

## Schema required

None. The allowlist is a constant, not a config variable.

## Definition of Done

- [ ] The server redirects to the Quest app's return URL only when asked with its fixed value, and to no other URL.
- [ ] The Quest app completes the PKCE exchange and sends the token on uploads.
- [ ] `deno task check` and `deno task test` pass.

## Tests

- [ ] Deno tests: each allowlisted value maps to its URL; an unknown value maps to none.
- [ ] A JVM test for the Quest app's PKCE verifier and its intent parsing.

```bash
export ONNXRUNTIME_NODE_INSTALL_CUDA=skip
deno task check && deno test -A tests/unit/deno/portal_auth.test.ts
cd meta && ./gradlew testDebugUnitTest --no-daemon
```

## Acceptance Criteria

- [ ] Given a server with sign-in on, when the Quest app signs in, then its uploads are accepted. Without the token they are refused, as today.

## Risks / potential issues

- **Risk:** An allowlist entry becomes an open redirect. — **Mitigation:** Fixed constants only, and tests for unknown values.
- **Risk:** Another app could claim the custom scheme on a headset. — **Mitigation:** PKCE keeps a stolen code useless without the verifier.

## Subtasks

1. [ ] Read the sign-in code and tests.
2. [ ] Turn `SHELL_RETURN_URL` into a fixed allowlist.
3. [ ] Add the Quest app's client and intent filter.
4. [ ] Add tests on both sides.
