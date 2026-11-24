/**
 * F-01: the host name this server names when nothing says what it is called.
 *
 * It used to fall back to one developer machine's tailnet name, written into server/main.ts and vite.config.ts, in a
 * public repository. The fallback is now `localhost`, which only this machine can reach, and the boot log says so once.
 * The resolver takes its probes as arguments, so these tests never run the real tailscale CLI and never see a real name.
 *
 *   deno test --allow-read tests/unit/deno/server_core_hostname.test.ts
 */
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import {
  FALLBACK_HOSTNAME,
  HOSTNAME_FALLBACK_WARNING,
  type HostnameProbes,
  resolveHostnameWith,
} from '../../../server/origin.ts'
import { REPO_ROOT } from '../../../server/repo-root.ts'

function probes(over: Partial<{ env: Record<string, string>; dns: string | null | Error; files: string[] | Error }>): HostnameProbes {
  const env = over.env ?? {}
  return {
    env: (name) => env[name],
    tailscaleDnsName: () => over.dns instanceof Error ? Promise.reject(over.dns) : Promise.resolve(over.dns ?? null),
    workingFolderFiles: () => over.files instanceof Error ? Promise.reject(over.files) : Promise.resolve(over.files ?? []),
  }
}

Deno.test('hostname: TAILSCALE_HOSTNAME wins over every probe', async () => {
  const found = await resolveHostnameWith(probes({
    env: { TAILSCALE_HOSTNAME: 'scan.test', VITE_HOSTNAME: 'other.test' },
    dns: 'box.example.ts.net.',
    files: ['box.example.ts.net.crt'],
  }))
  assertEquals(found, { hostname: 'scan.test', source: 'env' })
})

Deno.test('hostname: VITE_HOSTNAME when TAILSCALE_HOSTNAME is unset', async () => {
  assertEquals(await resolveHostnameWith(probes({ env: { VITE_HOSTNAME: 'other.test' } })), { hostname: 'other.test', source: 'env' })
})

Deno.test('hostname: tailscale names the machine, without its trailing dot', async () => {
  assertEquals(await resolveHostnameWith(probes({ dns: 'box.example.ts.net.' })), { hostname: 'box.example.ts.net', source: 'tailscale cli' })
})

Deno.test('hostname: a cert file in the working folder, when tailscale does not answer', async () => {
  const found = await resolveHostnameWith(probes({ dns: new Error('not installed'), files: ['README.md', 'box.example.ts.net.crt'] }))
  assertEquals(found, { hostname: 'box.example.ts.net', source: 'cert file' })
})

Deno.test('hostname: nothing found falls back to localhost, a name no other machine has', async () => {
  const found = await resolveHostnameWith(probes({ dns: null, files: new Error('unreadable') }))
  assertEquals(found, { hostname: 'localhost', source: 'default' })
  assertEquals(FALLBACK_HOSTNAME, 'localhost')
})

Deno.test('hostname: the fallback warning names the settings and the fallback, and no host', () => {
  assertMatch(HOSTNAME_FALLBACK_WARNING, /TAILSCALE_HOSTNAME/)
  assertMatch(HOSTNAME_FALLBACK_WARNING, /VITE_HOSTNAME/)
  assertMatch(HOSTNAME_FALLBACK_WARNING, /Using localhost/)
  // The only tailnet name it may mention is the file pattern, never a machine.
  assertEquals(HOSTNAME_FALLBACK_WARNING.match(/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/gi), null)
})

Deno.test('hostname: main.ts and vite.config.ts keep the same fallback, and main.ts warns when it is used', async () => {
  const read = (rel: string) => Deno.readTextFile(fromFileUrl(new URL(rel, REPO_ROOT)))
  const [main, vite] = await Promise.all([read('server/main.ts'), read('vite.config.ts')])
  assertMatch(vite, /const FALLBACK_HOSTNAME = 'localhost'/)
  assert(main.includes('resolveHostnameWith('), 'main.ts resolves through server/origin.ts')
  assert(main.includes('HOSTNAME_FALLBACK_WARNING'), 'main.ts prints the warning when the fallback is used')
  // Neither file names a tailnet machine of its own: a `<name>.<tailnet>.ts.net` literal in quotes.
  for (const [name, text] of [['server/main.ts', main], ['vite.config.ts', vite]] as const) {
    assertEquals(text.match(/['"`][a-z0-9-]+\.[a-z0-9-]+\.ts\.net/gi), null, `${name} holds a tailnet host literal`)
  }
})
