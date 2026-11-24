/**
 * A COLMAP that is an executable, for a test that has to run the real server. `COLMAP_BIN` is a one-line shell script that runs this with
 * the command line it was given, and the answer is the stand-in of sfm_fixtures.ts: the model files a real run would write, built from
 * the truth in the JSON file `FAKE_COLMAP_WORLD` names (`{ places: [[imageName, [x, y, z]], ...], solver }`).
 *
 * Not a test file: `npm run test:server` runs only `*.test.ts`. It reads and writes the files the command line names and nothing else, and opens no
 * connection.
 */
import { fakeColmap, type SolverFrame, type V3 } from './sfm_fixtures.ts'
import * as fs from 'node:fs/promises'

const worldPath = process.env.FAKE_COLMAP_WORLD
if (!worldPath) {
  console.error('FAKE_COLMAP_WORLD is not set')
  process.exit(2)
}
const description = JSON.parse(await fs.readFile(worldPath, 'utf8')) as { places: Array<[string, V3]>; solver?: SolverFrame }
const fake = fakeColmap({ world: { places: new Map(description.places), solver: description.solver } })
const answer = await fake.spawn('colmap', process.argv.slice(2))
if (answer.stderr) console.error(answer.stderr)
process.exit(answer.code)
