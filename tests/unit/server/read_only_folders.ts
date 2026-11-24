/**
 * Whether this process can remove a file from a folder that has no write permission, which is true of root and defeats a
 * failure made with permissions. A test that needs that failure is declared with `ignore: !(await cannotRemoveFromReadOnlyFolder())`,
 * so that on such a machine it shows as ignored and not as a pass that tested nothing.
 *
 * Not a test file: the runner picks up only `*.test.ts`.
 */
import * as fs from 'node:fs/promises'
import { makeTempDir } from '../../../server/fs_util.ts'

export async function cannotRemoveFromReadOnlyFolder(): Promise<boolean> {
  const root = await makeTempDir({ prefix: 'read-only-probe-' })
  const folder = `${root}/probe`
  try {
    await fs.mkdir(folder)
    await fs.writeFile(`${folder}/file`, 'x')
    await fs.chmod(folder, 0o555)
    try {
      await fs.rm(`${folder}/file`)
      return false
    } catch {
      return true
    } finally {
      await fs.chmod(folder, 0o755)
    }
  } finally {
    await fs.rm(root, { recursive: true }).catch(() => undefined)
  }
}
