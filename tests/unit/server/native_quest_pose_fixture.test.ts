/**
 * The shared fixture that ties the Quest app's pose tests to the server's matrix code (FN-171).
 *
 * meta/app/src/test/resources/pose-to-matrix.fixture.json lists poses and the row-major camera-to-world matrix that
 * `poseToMatrix()` (server/splat/splat_train_dataset.ts) makes of each. This test holds the file to the server function,
 * and the Quest app's CoordinateConversionsTest holds its Kotlin restatement of that function to the same file. So a change
 * to `poseToMatrix` fails here first. Regenerating the fixture for the new function then fails the Kotlin test, until the
 * Kotlin restatement (and whatever the Quest app derives from it) follows:
 *
 *   UPDATE_POSE_FIXTURE=1 node --test tests/unit/server/native_quest_pose_fixture.test.ts
 *   (cd meta && ./gradlew :app:testDebugUnitTest)
 */
import { assert, assertEquals } from './assert.ts'
import { poseToMatrix } from '../../../server/splat/splat_train_dataset.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

const FIXTURE = new URL('../../../meta/app/src/test/resources/pose-to-matrix.fixture.json', import.meta.url)

type Vec = { x: number; y: number; z: number }
type Case = { name: string; pose: { position: Vec; rotation: Vec & { w: number } }; matrix?: number[][] }
type Fixture = { about: string; cases: Case[] }

const TOLERANCE = 1e-12

test('every pose in the Quest fixture is turned into its matrix by the server\'s own poseToMatrix', async () => {
  const fixture = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as Fixture
  assert(fixture.cases.length >= 6, 'the fixture lists its poses')

  if (process.env.UPDATE_POSE_FIXTURE === '1') {
    for (const entry of fixture.cases) entry.matrix = poseToMatrix(entry.pose)
    await fs.writeFile(FIXTURE, JSON.stringify(fixture, null, 2) + '\n')
    return
  }

  for (const entry of fixture.cases) {
    const expected = entry.matrix
    assert(expected, `${entry.name}: the fixture has no matrix; regenerate it (see the header of this test)`)
    const actual = poseToMatrix(entry.pose)
    assertEquals(actual.length, 4, `${entry.name}: four rows`)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const delta = Math.abs(actual[r]![c]! - expected[r]![c]!)
        assert(
          delta <= TOLERANCE,
          `${entry.name}: poseToMatrix gives m[${r}][${c}] = ${actual[r]![c]}, the fixture says ${expected[r]![c]}. ` +
            'server/splat/splat_train_dataset.ts changed: regenerate the fixture, then make the Quest app\'s Kotlin follow.',
        )
      }
    }
  }
})

test('the fixture covers what the Quest sends: a turned and moved camera, and a quaternion off unit length', async () => {
  const fixture = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as Fixture
  const names = fixture.cases.map((entry) => entry.name)
  assertEquals(new Set(names).size, names.length, 'each case has its own name')
  const norm = (q: Case['pose']['rotation']) => Math.hypot(q.x, q.y, q.z, q.w)
  assert(fixture.cases.some((entry) => Math.abs(norm(entry.pose.rotation) - 1) > 0.1), 'a quaternion poseToMatrix must normalise')
  assert(fixture.cases.some((entry) => entry.pose.rotation.x !== 0 && entry.pose.rotation.y !== 0 && entry.pose.rotation.z !== 0), 'a rotation about no single axis')
  assert(fixture.cases.some((entry) => entry.pose.position.z !== 0), 'a camera off the origin')
})
