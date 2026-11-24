import type { NativeARCapabilities } from './native-bridge.ts'

/**
 * Whether the scanner starts on the native AR runtime (ARKit on iOS, ARCore on Android)
 * instead of the web runtimes (8th Wall, then WebXR). Kept pure so the rule is tested without
 * a device.
 *
 * The web runtimes keep their URL switches: `?ar=webxr` and `?ar=8thwall` never pick native,
 * whatever the device can do. Otherwise native wins whenever the native layer reports that a
 * session can start. A native session that fails to start falls back to the web runtimes inside
 * NativeARProvider.start(), so this choice is not final.
 */
export interface NativeRuntimeChoice {
  /** The `?ar=` query value, if any. */
  forced: string | null
  /** The native layer reported that an AR session can start on this device. */
  nativeSupported: boolean
}

export function preferNativeRuntime(choice: NativeRuntimeChoice): boolean {
  if (choice.forced === 'webxr' || choice.forced === '8thwall') return false
  return choice.nativeSupported
}

/**
 * The runtime a build forces when the page's URL names none. `VITE_AR_RUNTIME=8thwall` at build time makes
 * the 8th Wall engine the runtime, so the native runtime is never chosen (the Android 8th Wall APK). Any other
 * value, or no value, forces nothing.
 */
export function buildForcedRuntime(buildValue: string | null | undefined): string | null {
  return buildValue === '8thwall' ? '8thwall' : null
}

/** How many times the page asks the native layer again while its answer still says 'checking'. */
export const NATIVE_RECHECKS = 5
/** The wait before each ask again, in ms. */
export const NATIVE_RECHECK_MS = 1000

/**
 * The native answer the runtime choice is made from. ARCore can still be checking at boot, and a 'checking'
 * answer is not final, so the page asks again: at most NATIVE_RECHECKS times, NATIVE_RECHECK_MS apart, and only
 * while the answer says so. A null answer (no native layer, or a failed call) ends the asks. Under `?ar=webxr`
 * or `?ar=8thwall` native is never chosen, so nothing is waited for.
 */
export async function settleNativeProbe(
  forced: string | null,
  first: NativeARCapabilities | null,
  probe: () => Promise<NativeARCapabilities | null>,
  sleep: (ms: number) => Promise<void>,
): Promise<NativeARCapabilities | null> {
  if (!preferNativeRuntime({ forced, nativeSupported: true })) return first
  let latest = first
  for (let asks = 0; latest?.checking === true && asks < NATIVE_RECHECKS; asks++) {
    await sleep(NATIVE_RECHECK_MS)
    latest = await probe()
  }
  return latest
}

/** The runtime the scanner starts on, and the status note for the web runtime when native was passed over. */
export interface NativeRuntimeDecision {
  native: boolean
  /** Set only when ARCore is not installed or needs an update: why native was passed over, for the 8th Wall status line. */
  note: string | null
}

/**
 * The runtime choice from the settled native answer. preferNativeRuntime() decides, as it always has. The note
 * names only the two states the user can fix, and only where native was open to the choice at all.
 */
export function chooseNativeRuntime(forced: string | null, probe: NativeARCapabilities | null): NativeRuntimeDecision {
  const native = probe !== null && preferNativeRuntime({ forced, nativeSupported: probe.supported })
  const why = probe?.engine === 'arcore' && !probe.supported ? probe.reason?.split('. ')[0] : undefined
  const note = why && preferNativeRuntime({ forced, nativeSupported: true }) ? `${why}, using 8th Wall` : null
  return { native, note }
}

/**
 * Where the scanner's runtime switch (#xr-mode-link) goes: the scanner, with every query parameter this page
 * has except `ar`, and `ar=webxr` when it switches to WebXR. Switching back to the default runtime drops `ar`,
 * which is what '/' always did.
 *
 * The switch used to go to '/?ar=webxr' or '/', so `?debug=pose`, `?project=`, `?world=` and the rest were lost
 * on the way, while webxr.html, the other entry to WebXR, carries them (its scannerUrl()) (FN-013). `ar` is set
 * last, as webxr.html sets it, so the switch always wins over an `ar` the page already had.
 */
export function runtimeSwitchHref(search: string, target: 'webxr' | 'default'): string {
  const params = new URLSearchParams(search)
  params.delete('ar')
  if (target === 'webxr') params.set('ar', 'webxr')
  const query = params.toString()
  return query ? `/?${query}` : '/'
}
