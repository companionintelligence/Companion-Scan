/**
 * Smoke-page triage: the POST /infer row on /smoke.html.
 *
 * The row sends a real room photo (public/test-fixtures/room.jpg) and reads the
 * answer: PASS for a 200 detection array in under 30 s, WARN for 30 s or more or
 * 503 model-loading, FAIL for anything else. The mock engine answers at once, so
 * the row must PASS on the test box. The WARN and FAIL verdicts are driven by
 * answering /infer from the test, so that logic is pinned to the server's
 * contract rather than to whatever the mock happens to return.
 *
 * Desktop chromium-mock project. The page is static, so no mobile viewport.
 *
 * Run: node scripts/test-box.mjs tests/mock-smoke-triage.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'

/** The /infer row, found by its name because the rows carry no ids. */
function inferRow(page: Page) {
  return page.locator('#rows .row').filter({ hasText: 'POST /infer round-trip' })
}

/** Waits until the row has left RUN, then returns its badge and detail text. */
async function settledInferRow(page: Page) {
  const row = inferRow(page)
  await expect(row.locator('.badge')).not.toHaveText('RUN', { timeout: 60_000 })
  return {
    badge: (await row.locator('.badge').innerText()).trim(),
    detail: (await row.locator('.detail').innerText()).trim(),
  }
}

test.describe('smoke page POST /infer row', () => {
  test.setTimeout(90_000)

  test('is PASS against the mock engine', async ({ page }) => {
    await page.goto('/smoke.html?debug=remote')
    const { badge, detail } = await settledInferRow(page)
    expect(badge, detail).toBe('PASS')
    expect(detail).toMatch(/^\d+ detection\(s\) · \d+\.\d s$/)
  })

  test('a 500 reads FAIL with the status, the error text and the seconds', async ({ page }) => {
    await page.route('**/infer', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Error: Ollama inference timed out after 55s (model: qwen3.5:9b)' }),
    }))
    await page.goto('/smoke.html?debug=remote')
    const { badge, detail } = await settledInferRow(page)
    expect(badge, detail).toBe('FAIL')
    expect(detail).toContain('HTTP 500')
    expect(detail).toContain('Ollama inference timed out after 55s')
    expect(detail).toMatch(/ · \d+\.\d s$/)
  })

  test('a 503 model-loading reads WARN', async ({ page }) => {
    await page.route('**/infer', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Model still loading after 15s — retry shortly.', code: 'model-loading' }),
    }))
    await page.goto('/smoke.html?debug=remote')
    const { badge, detail } = await settledInferRow(page)
    expect(badge, detail).toBe('WARN')
  })

  test('a detection with no label or bbox reads FAIL', async ({ page }) => {
    await page.route('**/infer', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{}]),
    }))
    await page.goto('/smoke.html?debug=remote')
    const { badge, detail } = await settledInferRow(page)
    expect(badge, detail).toBe('FAIL')
  })
})
