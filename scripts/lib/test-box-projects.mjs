/**
 * The Playwright projects `npm run test:box` (scripts/test-box.mjs) runs against its own servers.
 *
 * By default the `api` and `chromium-mock` pair, as it always ran. TEST_BOX_PROJECTS, a comma-separated list, names
 * others instead, for example the two WebKit profiles, which no workflow runs:
 *
 *   TEST_BOX_PROJECTS=webkit-iphone15,webkit-desktop npm run test:box
 *
 * Extra command-line arguments still go to Playwright, but a `--project` there adds to the list rather than
 * replacing it, which is why the list has a variable of its own, beside TEST_BOX_API_PORT and TEST_BOX_VITE_PORT.
 */
export const DEFAULT_BOX_PROJECTS = Object.freeze(['api', 'chromium-mock'])

/** The projects to run: TEST_BOX_PROJECTS when it names any, in its order without repeats, else the default pair. */
export function boxProjects(env) {
  const named = String(env.TEST_BOX_PROJECTS ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  return named.length > 0 ? [...new Set(named)] : [...DEFAULT_BOX_PROJECTS]
}
