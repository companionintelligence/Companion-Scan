import { assertEquals } from './assert.ts'
import { belongsToWorldProject, scanProjectId, shouldIncludeStoredScanInWorld } from '../../../server/world/world_membership.ts'
import { test } from 'node:test'

test('project world includes only scans for that project', () => {
  assertEquals(belongsToWorldProject('proj-a', 'proj-a'), true)
  assertEquals(belongsToWorldProject('proj-a', 'proj-b'), false)
  assertEquals(belongsToWorldProject('proj-a', null), false)
})

test('legacy world keeps existing scans and accepts unassigned scans', () => {
  const existing = new Set(['kept.glb'])
  assertEquals(belongsToWorldProject(null, 'proj-a', existing, 'kept.glb'), true)
  assertEquals(belongsToWorldProject(null, null, existing, 'new.glb'), true)
  assertEquals(belongsToWorldProject(null, 'proj-a', existing, 'new.glb'), false)
})

test('stored scan membership preserves base predicate', () => {
  const scan = { filename: 'a.glb', size: 1, meta: { projectId: 'proj-a' } }
  assertEquals(shouldIncludeStoredScanInWorld('proj-a', scan, () => true), true)
  assertEquals(shouldIncludeStoredScanInWorld('proj-a', scan, () => false), false)
  assertEquals(scanProjectId({ projectId: '' }), null)
})
