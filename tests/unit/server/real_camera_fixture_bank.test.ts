import { assertEquals } from './assert.ts'
import { validateRealCameraFixtureManifest } from '../../support/real_camera_fixture_bank.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

const MANIFEST_PATH = './test-data/real-camera/manifest.json'

test('real-camera fixture bank rejects incomplete or synthetic evidence', () => {
  const issues = validateRealCameraFixtureManifest({
    version: 1,
    generatedAt: '2026-08-20T00:00:00.000Z',
    fixtures: [{
      fixtureId: 'bad',
      source: 'mock-xr8',
      deviceId: 'tablet',
      place: 'Test',
      capturedAt: '2026-08-20T00:00:00.000Z',
      location: { label: 'Test' },
      artifacts: { cameraPhoto: '../mock.png', tagScreenshot: 'tag.png' },
      verification: { realCameraVisible: false, solidColorScreen: true, generatedTagsVisible: false },
    }],
  })
  assertEquals(issues.length > 0, true)
})

test('local real-camera fixture bank has complete evidence when present', async () => {
  try {
    await fs.stat(MANIFEST_PATH)
  } catch {
    return
  }
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
  const issues = validateRealCameraFixtureManifest(manifest)
  assertEquals(issues, [])
  for (const fixture of manifest.fixtures) {
    await fs.stat(`./test-data/real-camera/${fixture.artifacts.cameraPhoto}`)
    await fs.stat(`./test-data/real-camera/${fixture.artifacts.tagScreenshot}`)
  }
})
