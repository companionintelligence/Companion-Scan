/**
 * Which app a scanner page runs in, for advice that depends on it (FN-009).
 *
 * The scanner chose its device advice by user agent. The iOS app's web view says iPhone, so the app was
 * told to use Safari or install HelloXR. The Android app's says Android, so it was told to use Chrome with
 * Play Services for AR. And the motion-permission refusal named Settings → Safari on every target. An app
 * runs its own AR (ARKit or ARCore through its ScanAR plugin), and a browser to switch to is no remedy
 * there. The user agent is still the right reading in a browser, where it says which browser this is.
 *
 * Imports only src/shared/api-base.ts, whose shell checks read what each shell injects before any page
 * script runs, so plain node can test it.
 */
import { isAndroidShell, isCapacitorShell, isDesktopShell } from '../shared/api-base.ts'

/** The app this page runs in, or null for a browser. */
export type AppShell = 'desktop' | 'ios' | 'android' | null

export function appShell(): AppShell {
  if (isDesktopShell()) return 'desktop'
  if (isAndroidShell()) return 'android'
  // isCapacitorShell() is true on Android too, which is answered above.
  if (isCapacitorShell()) return 'ios'
  return null
}

/**
 * The line for a browser. Only WebKit on iOS and iPadOS asks for motion access
 * (DeviceMotionEvent.requestPermission), so a browser that can refuse it is Safari or one built on
 * WebKit there, and Safari's setting is the remedy. iPadOS Safari reports a Mac user agent, so the user
 * agent is not read for this. Kept word for word from before FN-009.
 */
export const SAFARI_MOTION_DENIAL = 'Enable motion & orientation access in Settings → Safari → Motion & Orientation Access.'
/**
 * The iOS app. Safari's setting is not the app's, so the line does not send the person there. That a
 * relaunch asks again is not verified: **needs a device run**.
 */
export const IOS_APP_MOTION_DENIAL = 'Motion access was refused. Quit and reopen the app, then allow it when asked.'

/** What to say when motion and orientation access is refused, for where the page runs. */
export function motionDenialNotice(shell: AppShell): string {
  return shell === 'ios' ? IOS_APP_MOTION_DENIAL : SAFARI_MOTION_DENIAL
}
