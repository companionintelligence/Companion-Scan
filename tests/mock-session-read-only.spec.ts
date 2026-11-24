/**
 * A second scanner tab is read-only, and says so where the person is looking (wave 14, ticket 0003, F-17).
 *
 * The first scanner page on an origin takes the writer lock (src/shared/scanner-lock.ts), and a later one opens
 * the store read-only and refuses every capture. Its notice used to go only to #status-text, which is painted
 * under #start-screen, so a tap on Walk the room, Film a walkthrough or Sweep from a tripod showed nothing. The
 * start screen now carries the notice from the start, and every refused tap says it again.
 *
 * No other browser spec opens a second tab.
 *
 * Run: npx playwright test --project=chromium-mock mock-session-read-only
 */
import { test, expect } from '@playwright/test'

const READ_ONLY = /Scanner is open in another tab/

test.describe('a second scanner tab', () => {
  test.setTimeout(90_000)

  test('says on its start screen why it refuses, and the first tab does not', async ({ context }) => {
    const writer = await context.newPage()
    await writer.goto('/?mock=xr8')
    // The writer takes its role first thing in main(), before the Start button is enabled.
    await expect(writer.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })

    const reader = await context.newPage()
    await reader.goto('/?mock=xr8')
    const line = reader.locator('#upload-video-progress')
    await expect(line).toHaveText(READ_ONLY, { timeout: 30_000 })
    await expect(line).toBeVisible()

    // A refused tap says it again, on the screen that was tapped. The notice is cleared first, so the
    // tap is what writes it.
    await reader.evaluate(() => { document.getElementById('upload-video-progress')!.textContent = '' })
    await reader.locator('#start-ar-btn').click()
    await expect(line).toHaveText(READ_ONLY)
    await expect(reader.locator('#place-sheet')).toBeHidden()

    await expect(writer.locator('#upload-video-progress')).not.toHaveText(READ_ONLY)
  })
})
