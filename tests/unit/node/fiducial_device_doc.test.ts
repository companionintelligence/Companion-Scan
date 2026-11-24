/**
 * docs/testing/DEVICE_TESTING.md, Procedure 8 (DX8), and the two lines it reads: `[tag]` and `[tagneg]` (`src/ar/fiducial/tag-debug.ts`).
 *
 * A procedure is only as good as the instrument it sends a person to. A document that names a column the line does not have sends someone to
 * read nothing, and a column it forgets to explain gets read wrong; a number in it that the code has since changed sends a person to look for
 * the wrong thing. So, in the same way as `device_testing_probe.test.ts` does for Procedures 2 to 4:
 *
 *  - each example line parses and has exactly the keys the code writes, in order, and each table of fields names every key once and no other;
 *  - the page parameters the document lists are the ones the code reads, with the defaults and ranges the code has;
 *  - the vocabularies it lists (hint codes, phases, fallback and unavailable reasons) are the code's;
 *  - the adopted limits it states, and the arithmetic it does (stand-on marks, the pixels a tag is across, the rule of three), are the code's constants and the numbers they give;
 *  - the QR commands arm what it says, the collection command is run against a log written the way the relay writes one, and the print commands are run, and make the pages and
 *    the mounts it says;
 *  - every part of the procedure reads the columns its question needs.
 *
 * That the procedure is followable is for a person with a phone. These tests hold what a person cannot check afterwards.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_device_doc.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAGES, sheetLayout } from '../../../scripts/print-fiducial.mjs'
import { DEFAULT_MAX_CANDIDATES } from '../../../src/ar/fiducial/detector.ts'
import { DEFAULT_TAG_FAMILY_NAME } from '../../../src/ar/fiducial/families.ts'
import { parseTagPayload } from '../../../src/ar/fiducial/payload.ts'
import { DEFAULT_PIXEL_LAG_FRAMES } from '../../../src/ar/fiducial/pose-history.ts'
import { DEFAULT_TAG_MAX_HZ } from '../../../src/ar/fiducial/tag-capture.ts'
import {
  LAG_FIT_MAX_FRAMES,
  LAG_FIT_MIN_FRAMES,
  TAGCAM_CHANGE_MIN_MS,
  TAGCAM_KEYS,
  TAGCAM_LINE_PERIOD_MS,
  TAGCAM_LINE_PREFIX,
  TAGNEG_KEYS,
  TAGNEG_LINE_PERIOD_MS,
  TAGNEG_LINE_PREFIX,
  TAG_KEYS,
  TAG_LINE_PERIOD_MS,
  TAG_LINE_PREFIX,
  formatTagCamLine,
  formatTagLine,
  tagDebugModes,
  tagDebugParams,
} from '../../../src/ar/fiducial/tag-debug.ts'
import { MAX_ASPECT_MISMATCH, MIN_SCALE_BASELINE_M, POSE_GRADE_MIN_SIDE_PX, projectTagCorners, meanSidePx } from '../../../src/ar/fiducial/tag-pose.ts'
import { CSCAN6_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { DEFAULT_FIDUCIAL_GATES } from '../../../src/ar/fiducial/tag-session.ts'
import { DEFAULT_TAG_FAMILY } from '../../../src/ar/fiducial/families.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DOC = readFileSync(join(ROOT, 'docs/testing/DEVICE_TESTING.md'), 'utf8')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const SCRIPT = join(ROOT, 'scripts', 'print-fiducial.mjs')

/** The text of one section: from its heading to the next heading of the same or a higher level. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n${heading}\n`)
  assert.ok(start !== -1, `DEVICE_TESTING.md has no section "${heading}"`)
  const level = heading.match(/^#+/)![0].length
  const rest = DOC.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'))
  return next === -1 ? rest : rest.slice(0, next)
}

const P8 = section('### Procedure 8 — reading a printed marker (DX8)')
const TAG = section('#### The `[tag]` line')
const CAM = section('#### The `[tagcam]` line')
const NEG = section('#### The `[tagneg]` line')

/** The keys named in the first cell of each table row of a section. */
function tableKeys(text: string): string[] {
  return text
    .split('\n')
    .filter((row) => /^\| `/.test(row))
    .flatMap((row) => [...row.split('|')[1]!.matchAll(/`([A-Za-z0-9]+)`/g)].map((m) => m[1]!))
}

/** The members of a string-literal union in a source file, by the type's name: the line it starts on and the lines after it that go on with `|` or a comment. */
function unionMembers(path: string, typeName: string): string[] {
  const text = read(path)
  const start = text.indexOf(`type ${typeName} =`)
  assert.ok(start !== -1, `${path} has no type ${typeName}`)
  const lines = text.slice(start).split('\n')
  const body = [lines[0]!]
  for (const line of lines.slice(1)) {
    if (!/^\s*(\||\/\*\*|\*)/.test(line)) break
    body.push(line)
  }
  return [...body.join('\n').matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!)
}

// ── The lines the document shows, and the tables it gives ────────────────────────────────────

test('Procedure 8 is in the document once, says what is adopted and what is not measured, and shows both lines as invented examples', () => {
  assert.equal(DOC.split('\n### Procedure 8').length, 2, 'one Procedure 8')
  assert.match(P8, /\*\*adopted, not measured\*\* \(ADR 0005\s+rule 5\)/)
  assert.match(P8, /#### Not measured here/)
  assert.match(P8, /Nothing here measures them, and nothing in the app says they were/)
  assert.match(TAG, /invented example of the shape, not a measurement/)
  assert.match(NEG, /invented example, not a measurement/)
  // The procedure's fields are bare keys: `line.<field>` is the probe line's notation, and the probe test holds every one of those to the probe line.
  assert.doesNotMatch(P8, /`line\./)
})

test('the example [tag] line parses and has exactly the keys the code writes, in order, and is written the way the code writes a line', () => {
  const example = TAG.match(/^\[tag\] (\{.*\})$/m)
  assert.ok(example, 'an example [tag] line')
  const record = JSON.parse(example[1]!) as Record<string, number | string | null>
  assert.deepEqual(Object.keys(record), [...TAG_KEYS])
  assert.equal(record['v'], 1)
  assert.ok((record['hit'] as number) <= (record['fr'] as number))
  // The shape of what the example says about the lag: the best lag is the one with the smallest error.
  const errors = [record['lagRms0'], record['lagRms1'], record['lagRms2']] as number[]
  assert.equal(record['lagBest'], errors.indexOf(Math.min(...errors)))
  // The heading is one angle of the orientation: it scatters no more than the whole.
  assert.ok((record['fuseHeadDeg'] as number) <= (record['fuseRotDeg'] as number))
  assert.equal(JSON.stringify(record), example[1], 'the example is written the way the code writes a line (compact JSON)')
  assert.equal(formatTagLine(record as never), `${TAG_LINE_PREFIX}${example[1]}`, 'and every number in it is inside its column\'s bounds, so the line is unchanged by them')
})

test('the example [tagcam] line parses and has exactly the keys the code writes, in order; the camera in it is one a person could check with Part E', () => {
  const example = CAM.match(/^\[tagcam\] (\{.*\})$/m)
  assert.ok(example, 'an example [tagcam] line')
  const record = JSON.parse(example[1]!) as Record<string, number | string | null>
  assert.deepEqual(Object.keys(record), [...TAGCAM_KEYS])
  assert.equal(record['v'], 1)
  // Part E's arithmetic on the example's own numbers gives a camera that passes Part E's checks.
  const fx = ((record['p0'] as number) * (record['cols'] as number)) / 2
  const fy = ((record['p5'] as number) * (record['rows'] as number)) / 2
  assert.ok(Math.abs(fx / fy - 1) <= MAX_ASPECT_MISMATCH, `fx ${fx}, fy ${fy}`)
  assert.equal(record['p8'], 0)
  assert.equal(record['p9'], 0)
  assert.equal((record['cw'] as number) / (record['ch'] as number), (record['cols'] as number) / (record['rows'] as number))
  assert.equal(record['fit'], 'contain')
  // The feed's counters: held ticks and ticks without history, counts since the page loaded.
  assert.ok(Number.isInteger(record['held']) && Number.isInteger(record['unp']))
  assert.equal(JSON.stringify(record), example[1])
  assert.equal(formatTagCamLine(record as never), `${TAGCAM_LINE_PREFIX}${example[1]}`)
  // The relay's cut the introduction names is the relay's own constant, read from its source.
  const cap = Number(read('src/debug/remote-log.ts').match(/const MAX_MSG_CHARS = (\d+)/)![1])
  assert.match(P8.replace(/\n/g, ' '), new RegExp(`the relay cuts a message at ${cap} characters`))
  // The cadence the text gives.
  assert.equal(TAGCAM_LINE_PERIOD_MS, 30_000)
  assert.equal(TAGCAM_CHANGE_MIN_MS, 1000)
  assert.match(CAM.replace(/\n/g, ' '), /every 30 s, and when the pixel array, the canvas or the fit changes \(not oftener than once a second\)/)
})

test('the example [tagneg] line parses and has exactly the keys the code writes, in order, and its counts are ones the detector could have made', () => {
  const example = NEG.match(/^\[tagneg\] (\{.*\})$/m)
  assert.ok(example, 'an example [tagneg] line')
  const record = JSON.parse(example[1]!) as Record<string, number | string | null>
  assert.deepEqual(Object.keys(record), [...TAGNEG_KEYS])
  assert.equal(record['v'], 1)
  const n = (key: string) => record[key] as number
  // The relations the detector's own counters keep: groups never exceed quads, attempts never exceed quads, those that reached the matcher are the attempts less the early refusals.
  assert.ok(n('groups') <= n('cand') && n('attempts') <= n('cand'))
  assert.equal(n('reach'), n('attempts') - n('rejOff') - n('rejContrast') - n('rejBorder') - n('rejQuiet'))
  assert.ok(n('rejMatch') <= n('reach') && n('det') <= n('reach') && n('maxCand') <= n('cand'))
  assert.equal(n('s') > 0 && n('frames') > 0, true)
})

test('the [tag] table names every key of the line and no other, once each; so do the [tagcam] and [tagneg] tables', () => {
  const tag = tableKeys(TAG)
  assert.deepEqual([...tag].sort(), [...TAG_KEYS].sort())
  assert.equal(new Set(tag).size, tag.length, 'a [tag] key is explained once')
  // The camera is in its own line: none of its columns is in the [tag] line.
  const cam = tableKeys(CAM)
  assert.deepEqual([...cam].sort(), [...TAGCAM_KEYS].sort())
  assert.equal(new Set(cam).size, cam.length)
  for (const key of ['p0', 'p5', 'p8', 'p9', 'cols', 'rows', 'cw', 'ch', 'fit']) assert.equal((TAG_KEYS as readonly string[]).includes(key), false, `${key} is a [tagcam] column`)
  // The [tagneg] table points at the [tag] one for the keys they share.
  const neg = tableKeys(NEG)
  const shared = ['v', 'n', 'rt', 'mode', 'fb', 'un']
  assert.deepEqual([...neg].sort(), [...TAGNEG_KEYS].sort())
  assert.equal(new Set(neg).size, neg.length, 'a [tagneg] key is explained once')
  assert.ok(shared.every((key) => TAG_KEYS.includes(key as never) && TAGNEG_KEYS.includes(key as never)), 'the shared keys are in both lines')
})

test('the vocabularies the table lists are the code\'s: hint codes, phases, fallback and unavailable reasons, the family names', () => {
  const row = (key: string, text = TAG): string => text.split('\n').find((r) => r.startsWith(`| \`${key}\``))!
  const words = (r: string): string[] => [...r.split('|')[3]!.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]!)
  const hints = [...read('src/ar/fiducial/tag-session.ts').match(/export type TagHint =[\s\S]*?\n\n/)![0].matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1]!)
  assert.equal(hints.length, 19)
  assert.deepEqual(words(row('hint')), hints)
  assert.deepEqual(words(row('ph')), unionMembers('src/ar/fiducial/tag-session.ts', 'TagSessionPhase'))
  assert.deepEqual(words(row('fb')).filter((w) => w !== 'null'), unionMembers('src/ar/fiducial/tag-worker-client.ts', 'TagFallbackReason'))
  const unavailable = [...unionMembers('src/ar/camera-frame-feed.ts', 'CameraFrameUnsupportedReason'), 'cover-fit']
  assert.deepEqual(words(row('un')).filter((w) => w !== 'null'), unavailable)
  assert.deepEqual(words(row('mode')).filter((w) => w !== 'null'), ['worker', 'main-thread'])
  assert.deepEqual(words(row('fit', CAM)).slice(0, 2), ['contain', 'cover'])
  assert.deepEqual(words(row('un', CAM)).filter((w) => w !== 'null'), unavailable, 'the camera line says why too')
  // The family names are the registered ones.
  assert.match(P8, new RegExp(`\`cscan-6x6-v1\` or \`cscan-5x5-v1\``))
  assert.equal(DEFAULT_TAG_FAMILY_NAME, 'cscan-6x6-v1')
})

// ── The page parameters ──────────────────────────────────────────────────────────────────────

test('the page parameters the document lists are the ones the code reads, with its defaults and its ranges', () => {
  const source = read('src/ar/fiducial/tag-debug.ts')
  const read_ = [...source.matchAll(/(?:number|q\.get)\('(tag[a-z]+)'\)/g)].map((m) => m[1]!)
  const documented = P8.split('\n').filter((r) => /^\| `tag[a-z]+` \|/.test(r)).map((r) => r.match(/^\| `(tag[a-z]+)`/)![1]!)
  assert.deepEqual([...documented].sort(), [...new Set(read_)].sort())
  const params = tagDebugParams('') as Exclude<ReturnType<typeof tagDebugParams>, { error: string }>
  const row = (name: string) => P8.split('\n').find((r) => r.startsWith(`| \`${name}\` |`))!
  assert.equal(params.printedSizeMm, 200)
  assert.match(row('tagsize'), /\| 200 \|$/)
  assert.match(row('tagfamily'), /`cscan-6x6-v1` \(`DEFAULT_TAG_FAMILY_NAME`/)
  assert.equal(params.family, DEFAULT_TAG_FAMILY_NAME)
  assert.equal(params.lagFrames, DEFAULT_PIXEL_LAG_FRAMES)
  assert.match(row('taglag'), new RegExp(`\\| ${DEFAULT_PIXEL_LAG_FRAMES} \\(\`DEFAULT_PIXEL_LAG_FRAMES\`, adopted\\) \\|$`))
  assert.equal(params.maxHz, DEFAULT_TAG_MAX_HZ)
  assert.match(row('tagrate'), new RegExp(`\\| ${DEFAULT_TAG_MAX_HZ} \\(\`DEFAULT_TAG_MAX_HZ\`, adopted\\) \\|$`))
  assert.equal(params.expectedTagId, null)
  assert.equal(params.mountHeightM, null)
  // The ranges: the number the document gives is in the error the code writes for a value outside it.
  for (const [name, range] of [['tagsize', '40 to 600'], ['taglag', '0 to 8'], ['tagrate', '1 to 30'], ['tagheight', '0 to 4']] as const) {
    assert.ok(row(name).includes(range), `${name}: the document says ${range}`)
    const bad = tagDebugParams(`?${name}=-1000`) as { error: string }
    assert.ok(bad.error?.includes(range), `${name}: the code says "${bad.error}"`)
  }
})

test('the QR commands arm what the document says, with the parameters it gives', () => {
  const commands = [...P8.matchAll(/^npm run qr -- "(\?[^"]+)"/gm)].map((m) => m[1]!)
  assert.equal(commands.length, 3)
  assert.deepEqual(tagDebugModes(commands[0]!), { tag: true, tagneg: false })
  assert.deepEqual(tagDebugModes(commands[1]!), { tag: false, tagneg: true })
  assert.deepEqual(tagDebugModes(commands[2]!), { tag: true, tagneg: false })
  for (const c of commands) assert.ok(c.startsWith('?debug=remote,'), `${c}: the relay is armed, or the lines stay on the phone`)
  const [reading, , fiveMinutes] = commands.map((c) => tagDebugParams(c))
  assert.deepEqual([reading, fiveMinutes].map((p) => 'error' in p!), [false, false])
  assert.equal((reading as { printedSizeMm: number }).printedSizeMm, 200)
  assert.equal((reading as { mountHeightM: number }).mountHeightM, 1.2)
  assert.equal((fiveMinutes as { maxHz: number }).maxHz, 10)
  // The experiment the procedure describes for the five minutes: 300 s of lines at a second each.
  assert.match(P8, /for \*\*300 s\*\*/)
  assert.equal(TAG_LINE_PERIOD_MS, 1000)
  assert.match(P8, /one \*\*`\[tag\]` line a second\*\*/)
  assert.match(P8, /every 30 s\*\* of counts/)
  assert.equal(TAGNEG_LINE_PERIOD_MS, 30_000)
})

// ── The collection command ───────────────────────────────────────────────────────────────────

function collectionScript(): string {
  const script = P8.match(/```bash\nnode -e '([^'\n]+)' '\[tag\] '\n```/)?.[1]
  assert.ok(script, 'Procedure 8 gives a node one-liner that ends with the prefix')
  return script
}

function collect(rows: string[], prefix: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'tag-doc-'))
  try {
    mkdirSync(join(dir, 'scans'))
    writeFileSync(join(dir, 'scans', 'client-logs.jsonl'), rows.join('\n'))
    return execFileSync(process.execPath, ['-e', collectionScript(), prefix], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const logRow = (msg: unknown, ts: number, ip = '100.64.0.1', ua = 'Phone A') => JSON.stringify({ ts, level: 'warn', msg, stack: undefined, url: '/', ua, ip })
const tagLine = (n: number) => `${TAG_LINE_PREFIX}${JSON.stringify({ v: 1, n })}`
const negLine = (n: number) => `${TAGNEG_LINE_PREFIX}${JSON.stringify({ v: 1, n })}`

test('the collection command prints the [tag] lines of a client-logs file and only those, the [tagneg] lines when asked, and says GAP where a phone\'s line is missing', () => {
  const rows = [
    logRow('[8thwall] trackingStatus: NORMAL', 1_000),
    logRow(tagLine(1), 2_000),
    logRow(negLine(1), 2_100),
    'not json at all',
    logRow(tagLine(2), 3_000),
    logRow(negLine(2), 3_100),
    logRow(tagLine(4), 5_000), // 3 was lost
    logRow('[tag-ish] not a line', 5_500),
    logRow(tagLine(1), 6_000), // a new page
    logRow(tagLine(1), 6_100, '100.64.0.2', 'Phone B'),
    logRow(tagLine(3), 7_000, '100.64.0.2', 'Phone B'), // Phone B lost its second
  ]
  const tags = collect(rows, TAG_LINE_PREFIX)
  assert.deepEqual(tags.map((r) => r.split(' ').slice(2).join(' ').replace(/^GAP /, '')), [1, 2, 4, 1, 1, 3].map((n) => JSON.stringify({ v: 1, n })))
  assert.deepEqual(tags.map((r) => (/ GAP \{/.test(r) ? 'GAP' : 'ok')), ['ok', 'ok', 'GAP', 'ok', 'ok', 'GAP'])
  assert.ok(tags[0]!.startsWith(new Date(2_000).toISOString() + ' 100.64.0.1 '), 'the phone\'s own time, then the address')
  assert.ok(tags[4]!.includes(' 100.64.0.2 '))
  const negs = collect(rows, TAGNEG_LINE_PREFIX)
  assert.equal(negs.length, 2, 'only the [tagneg] lines')
  assert.ok(negs.every((r) => !r.includes(' GAP ')))
  assert.match(P8, /`GAP`/)
  assert.match(P8, /a missing line is a missing\s+measurement, so run that again/)
})

// ── The numbers it states are the code's ─────────────────────────────────────────────────────

test('the adopted limits the introduction names are the constants the code has', () => {
  const intro = P8.slice(0, P8.indexOf('**Which runtimes.**'))
  const stated = (re: RegExp): number => {
    const m = intro.replace(/\n/g, ' ').match(re)
    assert.ok(m, `the introduction does not say ${re}`)
    return Number(m[1])
  }
  assert.equal(stated(/the tag (\d+) px across for a pose/), POSE_GRADE_MIN_SIDE_PX)
  assert.equal(stated(/and (\d+) px for an identity alone/), DEFAULT_FIDUCIAL_GATES.minIdentitySidePx)
  assert.equal(stated(/(\d+) frames over \d+ s/), DEFAULT_FIDUCIAL_GATES.minFrames)
  assert.equal(stated(/\d+ frames over (\d+) s/) * 1000, DEFAULT_FIDUCIAL_GATES.minDurationMs)
  assert.equal(stated(/the camera moved ([0-9.]+) m/), DEFAULT_FIDUCIAL_GATES.minTravelM)
  assert.equal(stated(/or\s+turned (\d+)°/), DEFAULT_FIDUCIAL_GATES.minTurnDeg)
  assert.equal(stated(/a scale check at (\d+)%/) / 100, DEFAULT_FIDUCIAL_GATES.maxScaleOffFraction)
  // The limits on a frame and on the scatter between frames, which the introduction names so that a tag the reader turns away is not a surprise.
  assert.equal(stated(/the frames' heading agreeing to (\d+)°/), DEFAULT_FIDUCIAL_GATES.maxHeadingSpreadDeg)
  assert.equal(stated(/the whole orientation to (\d+)°/), DEFAULT_FIDUCIAL_GATES.maxRotationSpreadDeg)
  assert.equal(stated(/no more than (\d+)° off its\s+face/), DEFAULT_FIDUCIAL_GATES.maxViewAngleDeg)
  assert.equal(stated(/between ([0-9.]+) m and \d+ m away/), DEFAULT_FIDUCIAL_GATES.minRangeM)
  assert.equal(stated(/between [0-9.]+ m and (\d+) m away/), DEFAULT_FIDUCIAL_GATES.maxRangeM)
  assert.equal(stated(/(\d+) frames a second/), DEFAULT_TAG_MAX_HZ)
  assert.match(intro.replace(/\n/g, ' '), /a lag of one frame/)
  assert.equal(DEFAULT_PIXEL_LAG_FRAMES, 1)
})

test('the numbers in the tables and parts are the code\'s: the fusion window, the lag fit\'s least, the travel a unit needs, the aspect check, the decode budget', () => {
  assert.match(TAG.replace(/\n/g, ' '), new RegExp(`the latest ${LAG_FIT_MAX_FRAMES} with the tag ${POSE_GRADE_MIN_SIDE_PX} px across`))
  assert.match(TAG.replace(/\n/g, ' '), new RegExp(`\`null\` until it has ${LAG_FIT_MIN_FRAMES} frames`))
  assert.match(TAG.replace(/\n/g, ' '), new RegExp(`until the camera has travelled ${MIN_SCALE_BASELINE_M} m across them \\(\`MIN_SCALE_BASELINE_M\``))
  assert.match(NEG.replace(/\n/g, ' '), new RegExp(`the decode budget is ${DEFAULT_MAX_CANDIDATES} a frame`))
  const e = P8.slice(P8.indexOf('#### Part E'), P8.indexOf('#### Part F')).replace(/\n/g, ' ')
  assert.match(e, new RegExp(`agree within ${MAX_ASPECT_MISMATCH * 100}%`))
  assert.match(e, /`fx` = `p0` × `cols` \/ 2 and `fy` = `p5` × `rows` \/ 2/)
  assert.match(e, /\(1 − `p8`\) × `cols` \/ 2 and\s+\(1 \+ `p9`\) × `rows` \/ 2/)
  assert.equal(P8.includes('Part D'), true)
  assert.equal(MIN_SCALE_BASELINE_M, 0.3)
})

test('the arithmetic in Procedure 8 is right: the stand-on marks, the pixels a tag is across, the rule of three, the A4 limit and the pages the sheets print on', () => {
  // Stand-on marks: d = R cos(theta), s = R sin(theta), to the centimetre.
  const rows = P8.split('\n').filter((r) => /^\| P\d/.test(r))
  assert.equal(rows.length, 6)
  for (const r of rows) {
    const cells = r.split('|').map((c) => c.trim())
    const [R, theta, d, s] = [cells[2]!, cells[3]!, cells[4]!, cells[5]!].map((c) => Number(c.match(/[0-9.]+/)![0]))
    assert.equal(d, Number((R! * Math.cos((theta! * Math.PI) / 180)).toFixed(2)), `${cells[1]}: out from the wall`)
    assert.equal(s, Number((R! * Math.sin((theta! * Math.PI) / 180)).toFixed(2)), `${cells[1]}: along the wall`)
  }
  // The pixels a tag is across at a focal length: the introduction's limit and the Decision's example.
  const px = P8.replace(/\n/g, ' ').match(/at a focal length of (\d+) px a (\d+) mm tag is (\d+) px across at ([0-9.]+) m/)
  assert.ok(px)
  assert.equal(Math.round((Number(px[2]) / 1000) * Number(px[1]) / Number(px[4])), Number(px[3]))
  assert.equal(Number(px[3]), POSE_GRADE_MIN_SIDE_PX)
  // Face-on is the 3.6 m; seen 40 degrees to the side the side that turns away shortens and the 40 px are reached at 3.2 m; the base case P3 is 42 px across at 720 px and 40 at 679.
  const K720 = { fx: 720, fy: 720, cx: 480, cy: 360, width: 960, height: 720 }
  const turned = (deg: number) => [Math.cos((deg * Math.PI) / 180), 0, Math.sin((deg * Math.PI) / 180), 0, 1, 0, -Math.sin((deg * Math.PI) / 180), 0, Math.cos((deg * Math.PI) / 180)]
  const sideAt = (distance: number, deg: number, f = 720) => meanSidePx(projectTagCorners({ rotation: turned(deg), translation: { x: 0, y: 0, z: distance } }, { ...K720, fx: f, fy: f }, 0.2) as never)
  assert.ok(Math.abs(sideAt(3.6, 0) - 40) < 0.05, 'face-on, 3.6 m')
  assert.ok(Math.abs(sideAt(3.2, 40) - 40) < 0.5, `40 degrees to the side, 3.2 m: ${sideAt(3.2, 40)}`)
  assert.ok(sideAt(3.6, 40) < 37, 'and not at 3.6 m')
  const text = P8.replace(/\n/g, ' ')
  assert.match(text, /3\.6 m face-on, and at\s+3\.2 m seen 40° to the side/)
  assert.match(text, /P3 \(3 m, 40°\) is (\d+) px across at a focal length of 720 px, and 40 px at (\d+) px/)
  const p3 = text.match(/P3 \(3 m, 40°\) is (\d+) px across at a focal length of 720 px, and 40 px at (\d+) px/)!
  assert.equal(Math.round(sideAt(3, 40)), Number(p3[1]))
  assert.ok(Math.abs(sideAt(3, 40, Number(p3[2])) - 40) < 0.2, `${sideAt(3, 40, Number(p3[2]))} px at ${p3[2]}`)
  // The rule of three: 3 over the quads is at most 1e-6 from 3,000,000 quads, which is 100,000 frames at 30 a frame.
  assert.match(P8.replace(/\n/g, ' '), /a bound at or under 1 in a million per candidate quad/)
  assert.equal(3 / 3_000_000, 1e-6)
  assert.match(P8, /`cand` of at least 3,000,000 with `det` 0/)
  // The mis-scaled prints: a print at 95% of its size reads as 0.95 of the units to the metre (the kit test `upm is the number of session units` renders both).
  assert.match(P8.replace(/\n/g, ' '), /about 0\.95 for the 95% print and 1\.05 for the 105% one/)
  // ...because a smaller print has fewer pixels and is taken for a FARTHER one (its metres come out longer and its unit shorter): the sentence says which way round it is.
  assert.match(P8.replace(/\n/g, ' '), /takes a smaller print for a farther one, so the metres it measures come out longer and a smaller print reads as fewer units to the metre/)
  assert.doesNotMatch(P8, /smaller tag for a nearer one/)
  // The family's false-accept arithmetic is the code's: 128 codes x 4 turns x 37 grids over 2^36 is 2.8 in 10 million.
  const falseAccept = (CSCAN6_V1.size * 4 * 37) / 2 ** 36
  assert.equal(CSCAN6_V1.size, 128)
  assert.match(P8.replace(/\n/g, ' '), /128 codes × 4 turns × 37 grids within one bit, over 2\^36\) says about\s+2\.8 false accepts in 10 million/)
  assert.equal((falseAccept * 1e7).toFixed(1), '2.8')
  assert.equal(3_000_000 / 30, 100_000)
  assert.match(P8, /about 100,000 frames/)
  // An A4 sheet holds a tag up to 144 mm in the default family: 144 fits and 145 does not.
  const cells = DEFAULT_TAG_FAMILY.cells
  assert.equal(sheetLayout(PAGES.a4, 144, 144 / cells).fits, true)
  assert.equal(sheetLayout(PAGES.a4, 145, 145 / cells).fits, false)
  assert.match(P8, /an A4 sheet holds a tag up to 144 mm/)
})

test('the print commands in the document run, make the pages it says, and mount the sheets the way it says', () => {
  const commands = [...P8.matchAll(/^npm run print:fiducial -- (.+)$/gm)].map((m) => m[1]!)
  assert.equal(commands.length, 4)
  const dir = mkdtempSync(join(tmpdir(), 'tag-doc-print-'))
  try {
    const made: Array<{ size: number; id: number; page: string; mount: string | undefined; height: number | undefined }> = []
    for (const command of commands) {
      const args = command.split(' ')
      const out = join(dir, args[args.indexOf('--out') + 1]!)
      args[args.indexOf('--out') + 1] = out
      const run = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, ...args], { encoding: 'utf8' })
      assert.equal(run.status, 0, `${command}: ${run.stderr}`)
      const wrote = run.stderr.match(/wrote .*: (\w+) \(([0-9.]+) x ([0-9.]+) mm\), black square ([0-9.]+) mm/)
      assert.ok(wrote, run.stderr)
      const svg = readFileSync(out, 'utf8')
      const payload = parseTagPayload(svg.match(/<desc>(.*?)<\/desc>/)![1]!.replace(/&quot;/g, '"'))
      assert.ok(payload, 'the sheet carries a payload the scanner reads')
      assert.equal(payload.placeId, 'dx8')
      made.push({ size: Number(wrote[4]), id: payload.tagId, page: wrote[1]!, mount: payload.mount, height: payload.mountHeightMm })
    }
    assert.deepEqual(made, [
      { size: 160, id: 3, page: 'A3', mount: 'wall', height: 1200 },
      { size: 200, id: 4, page: 'A3', mount: 'wall', height: 1200 },
      { size: 230, id: 5, page: 'A2', mount: 'wall', height: 1200 },
      { size: 200, id: 6, page: 'A3', mount: 'horizontal', height: 750 },
    ])
    assert.match(P8, /The 160 and 200 mm sheets print on A3 and the 230 mm one on A2/)
    assert.match(P8, /\*\*centre of the black square 1\.2 m above the floor\*\*/)
    assert.match(P8, /on a table 0\.75 m high/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── The parts read the columns they need ─────────────────────────────────────────────────────

test('each part of the procedure reads the columns its question needs, and the results table\'s columns are columns of the line', () => {
  const needs: Record<string, string[]> = {
    '#### Part A — range, size and angle': ['hit', 'fr', 'side', 'vang', 'rng', 'amb', 'rms', 'fuseSpreadM', 'fuseHeadDeg', 'fuseRotDeg', 'ph', 'hint', 'tagsize'],
    '#### Part B — what reading costs, on the oldest phones': ['tCopy', 'tRound', 'tDet', 'tWorker', 'tPose', 'tLuma', 'tPyr', 'tQuad', 'tRefine', 'tDecode', 'mode', 'fb', 'roi', 'drop', 'fr', 'tagrate=10'],
    '#### Part C — pose scatter against range': ['fuseSpreadM', 'fuseHeadDeg', 'fuseRotDeg'],
    '#### Part D — the lag between pixels and pose': ['lagBest', 'lagTurn', 'lagRms0', 'lagRms1', 'lagRms2', 'fuseRotDeg', 'fuseRms', 'taglag'],
    '#### Part E — the camera model': ['p0', 'p5', 'p8', 'p9', 'cols', 'rows', 'cw', 'ch', 'fit', 'rng'],
    '#### Part F — the unit from the print': ['upm', 'upmBase', 'sepM', 'tagsize=200'],
    '#### Part G — false accepts': ['frames', 'cand', 'det', '&tagid=4'],
  }
  for (const [heading, fields] of Object.entries(needs)) {
    const text = section(heading)
    for (const field of fields) assert.ok(text.includes(`\`${field}\``), `${heading} never reads \`${field}\``)
  }
  // The results table's header names columns of the line (the ones that are in backticks).
  const header = section('#### Results — Procedure 8, Part A').split('\n').find((r) => /^\| Phone/.test(r))!
  const columns = [...header.matchAll(/`([A-Za-z0-9]+)`/g)].map((m) => m[1]!)
  assert.ok(columns.length >= 8)
  for (const c of columns) assert.ok((TAG_KEYS as readonly string[]).includes(c), `the results table has a column \`${c}\` that the line does not`)
  // Procedure 8 is one of the document's experiments, so its place in the document is before the device list.
  assert.ok(DOC.indexOf('### Procedure 8') < DOC.indexOf('\n### Devices\n'))
  assert.ok(DOC.indexOf('### Procedure 4') < DOC.indexOf('### Procedure 8'))
})
