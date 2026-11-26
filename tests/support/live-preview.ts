import type { APIRequestContext } from '@playwright/test'

/** Why a spec skipped: the reason the specs give, worded once. */
export const LIVE_PREVIEW_OFF = 'the live preview is off on this server (VITE_ENABLE_WEBRTC_LIVE, FN-121)'

/**
 * Whether the Scan server opens the live preview's `phone` and `viewer` roles on /rtc-signal.
 *
 * They are off unless the server runs with VITE_ENABLE_WEBRTC_LIVE=true (FN-121, server/main.ts). When they are off,
 * a plain GET for either role is answered 404 with the server's own reason before any upgrade; when they are on, the
 * GET passes the gate and finds no plain-HTTP route, so its 404 carries no such reason. The specs that open those
 * roles skip when the preview is off, as the live-feed tests in ar-scan.spec.ts skip when the page has no live-feed
 * button. `npm run test:box` passes its environment to both servers, so
 * `VITE_ENABLE_WEBRTC_LIVE=true npm run test:box -- ...` runs them.
 */
export async function livePreviewOpen(request: APIRequestContext, base: string): Promise<boolean> {
  const res = await request.get(`${base}/rtc-signal?role=phone`, { failOnStatusCode: false })
  if (res.status() !== 404) return true
  return !(await res.text()).includes('WebRTC live streaming is disabled')
}
