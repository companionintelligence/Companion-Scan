/**
 * The Quest app's third-party notices (scripts/native/third-party-notices.mjs --shell quest): its release build's
 * dependency lock (meta/app/gradle.lockfile) against what meta/app/build.gradle.kts declares, the licence each locked
 * library gets, the Meta Spatial SDK's notice and agreement, and the two files the SDK's AARs carry. Everything here
 * reads the repo, a temporary folder or stand-ins, except the whole generation at the end, which reads the AARs from
 * the Gradle cache that the Quest app's build fills, and is skipped where they are not.
 *
 * What this cannot see: the transitive libraries, which only Gradle resolves. In meta/,
 * `./gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks` must leave
 * app/gradle.lockfile unchanged.
 *
 * Run: npm run test:notices
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import {
  META_SDK_NOTICES_FILE,
  META_SPATIAL_SDK_NOTICE,
  QUEST_LICENCES,
  QUEST_LOCKFILE,
  QUEST_PRODUCT,
  TEXTS_DIR,
  androidLicenceTexts,
  cachedAars,
  componentsWithoutText,
  gradleHome,
  lockedLibraries,
  metaSpatialSdkFiles,
  questLicenceTexts,
  questNotices,
  questVersion,
  renderNotices,
  writeQuestNotices,
  zipEntry,
} from '../../../scripts/native/third-party-notices.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

type Library = { group: string; artifact: string; version: string }
type Entry = { match: RegExp; licence: string; source: string | ((library: Library) => string); note?: string | ((library: Library) => string); text?: string; metaSdk?: boolean }
type Component = { group: string; name: string; version?: string; licence: string; source?: string; note?: string; texts: string[] }
type Notices = { titles: string[]; components: Component[]; texts: Record<string, string> }
type ReadMetaSdk = (libraries: Library[]) => { licence: string; noticesHtml: Buffer }
const build = questNotices as unknown as (options?: { lockfile?: string; readMetaSdk?: ReadMetaSdk }) => { notices: Notices; metaSdkNotices: Buffer | null }

/** The copyright notice section 1.3 of the Meta Platform Technologies SDK License Agreement asks a redistribution to carry. */
const META_COPYRIGHT = 'Copyright © Meta Platform Technologies, LLC and its affiliates. All rights reserved.'
const META_AGREEMENT = 'Meta Platform Technologies SDK License Agreement'

const entriesFor = (name: string) => (QUEST_LICENCES as Entry[]).filter((entry) => entry.match.test(name))
const locked = (): Library[] => lockedLibraries(readFileSync(QUEST_LOCKFILE, 'utf8'))
const lockLine = (name: string, version: string) => `${name}:${version}=releaseRuntimeClasspath`

/** Stands in for the AARs: hands back a fixed agreement and notices.html, and records which modules it was asked for. */
function standIn(licence = `${META_AGREEMENT}\nEffective date: (a stand-in)`) {
  const asked: Library[][] = []
  const readMetaSdk: ReadMetaSdk = (libraries) => {
    asked.push(libraries)
    return { licence, noticesHtml: Buffer.from('<html>notices</html>') }
  }
  return { asked, readMetaSdk }
}

/** A ZIP archive of `files`, each stored or deflated, as an AAR is packed, with an optional archive comment at its end. */
function zipOf(files: Array<{ name: string; data: Buffer | string; deflate?: boolean }>, comment = ''): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = Buffer.from(file.data)
    const body = file.deflate ? deflateRawSync(data) : data
    const name = Buffer.from(file.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(file.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(file.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    parts.push(local, name, body)
    directory.push(central, name)
    offset += 30 + name.length + body.length
  }
  const centralDirectory = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(Buffer.byteLength(comment), 20)
  return Buffer.concat([...parts, centralDirectory, end, Buffer.from(comment)])
}

// ── The lock ───────────────────────────────────────────────────────────────────────────────────

/** The configurations whose libraries end up in releaseRuntimeClasspath, and so in the release APK. */
const IN_RELEASE_APK = new Set(['implementation', 'api', 'runtimeOnly', 'releaseImplementation', 'releaseApi', 'releaseRuntimeOnly'])

/** The libraries meta/app/build.gradle.kts declares for the release APK. A form this does not read stops the test. */
function declaredLibraries(): Library[] {
  const code = read('meta/app/build.gradle.kts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  const open = code.search(/^dependencies\s*\{/m)
  assert.ok(open >= 0, 'meta/app/build.gradle.kts has a top-level dependencies block')
  const body = code.slice(code.indexOf('{', open) + 1, code.indexOf('\n}', open))
  const declared: Library[] = []
  const unread: string[] = []
  for (const line of body.split('\n')) {
    const [, configuration, rest] = line.match(/^\s*(\w+)\s*\((.*)\)\s*$/) ?? []
    if (!configuration || !IN_RELEASE_APK.has(configuration)) continue
    const parts = rest!.match(/^"([^":\s$]+):([^":\s$]+):([\w.+-]+)"$/)
    if (!parts) {
      unread.push(line.trim())
      continue
    }
    declared.push({ group: parts[1]!, artifact: parts[2]!, version: parts[3]! })
  }
  assert.deepEqual(unread, [], 'dependencies this test does not read: teach declaredLibraries() the form, so the lock still covers it')
  return declared
}

/** How dotted version `a` orders against `b`, by its numbers. */
function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => {
    assert.match(version, /^\d+(\.\d+)*$/, `version ${version}: this test reads dotted numbers only`)
    return version.split('.').map(Number)
  })
  for (let i = 0; i < Math.max(x!.length, y!.length); i++) {
    const difference = (x![i] ?? 0) - (y![i] ?? 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

test('the Quest release build takes the locked versions, and each library its build file declares is locked at that version or a higher one', () => {
  assert.match(read('meta/app/build.gradle.kts'),
    /configurations\.matching \{ it\.name == "releaseRuntimeClasspath" \}\.configureEach \{\s*resolutionStrategy\.activateDependencyLocking\(\)\s*\}/,
    'the release build uses the versions locked in app/gradle.lockfile, and fails when its libraries are not the locked ones')
  assert.ok(existsSync(QUEST_LOCKFILE), 'meta/app/gradle.lockfile is committed')
  const declared = declaredLibraries()
  const names = declared.map((d) => `${d.group}:${d.artifact}`)
  for (const name of ['com.meta.spatial:meta-spatial-sdk', 'com.microsoft.onnxruntime:onnxruntime-android', 'com.squareup.okhttp3:okhttp']) {
    assert.ok(names.includes(name), `${name} is read from meta/app/build.gradle.kts`)
  }
  assert.ok(!names.includes('junit:junit'), 'a test library is not in the release APK, so it is not read')
  const pins = locked()
  const problems: string[] = []
  for (const { group, artifact, version } of declared) {
    const pinned = pins.find((l) => l.group === group && l.artifact === artifact)
    if (!pinned) problems.push(`${group}:${artifact}:${version} is declared but not locked for releaseRuntimeClasspath, so assembleRelease stops`)
    else if (compareVersions(pinned.version, version) < 0) problems.push(`${group}:${artifact} is locked at ${pinned.version}, below the ${version} declared`)
  }
  assert.deepEqual(problems, [], 'regenerate the lock: in meta/, ./gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks')
})

test('every library the Quest lockfile pins has exactly one licence entry, so the notices can name it', () => {
  const pins = locked()
  assert.ok(pins.length >= 15, 'the lockfile is read')
  // questNotices leaves a BOM out: it aligns versions and puts nothing in the APK.
  const problems = pins
    .filter((l) => !l.artifact.endsWith('-bom'))
    .map((l) => `${l.group}:${l.artifact}`)
    .filter((name) => entriesFor(name).length !== 1)
  assert.deepEqual(problems, [], 'a pinned library with no licence entry stops the notices: check its licence, then add it to QUEST_LICENCES')
  const licenceOf = (name: string) => entriesFor(name)[0]?.licence
  for (const module of ['', '-isdk', '-splat', '-toolkit', '-vr']) {
    assert.equal(licenceOf(`com.meta.spatial:meta-spatial-sdk${module}`), 'Meta Platform Technologies SDK License Agreement (proprietary)', `meta-spatial-sdk${module}`)
  }
  assert.equal(licenceOf('com.microsoft.onnxruntime:onnxruntime-android'), 'MIT')
  assert.equal(licenceOf('com.squareup.okhttp3:okhttp'), 'Apache-2.0')
})

test('a library no entry spells out stops the Quest notices, even one from a family the table lists', () => {
  const { readMetaSdk } = standIn()
  const lockfile = [
    lockLine('org.jetbrains.kotlinx:kotlinx-coroutines-play-services', '1.10.1'),
    lockLine('com.meta.spatial:meta-spatial-sdk-physics', '0.15.0'),
    lockLine('com.squareup.okhttp3:okhttp', '4.9.1'),
    '',
  ].join('\n')
  assert.throws(() => build({ lockfile, readMetaSdk }),
    /no known licence: com\.meta\.spatial:meta-spatial-sdk-physics:0\.15\.0, org\.jetbrains\.kotlinx:kotlinx-coroutines-play-services:1\.10\.1\. .*QUEST_LICENCES/)
  assert.throws(() => build({ lockfile: 'empty=\n', readMetaSdk }), /pins no library for releaseRuntimeClasspath/)
})

test("a BOM the lockfile pins is left out of the Quest notices, as it is of the Android app's, and needs no entry: it puts nothing in the APK", () => {
  const { asked, readMetaSdk } = standIn()
  const lockfile = [
    lockLine('com.microsoft.onnxruntime:onnxruntime-android', '1.32.0'),
    lockLine('org.jetbrains.kotlinx:kotlinx-serialization-bom', '1.6.3'),
    lockLine('com.example:a-library-bom', '1.0.0'),
    '',
  ].join('\n')
  const { notices, metaSdkNotices } = build({ lockfile, readMetaSdk })
  assert.deepEqual(notices.components.map((c) => c.name), ['com.microsoft.onnxruntime:onnxruntime-android'], 'a BOM, even one no entry names, is not listed and does not stop the notices')
  assert.deepEqual(entriesFor('org.jetbrains.kotlinx:kotlinx-serialization-bom'), [], 'the table names no BOM')
  assert.deepEqual(asked, [], 'with no SDK module pinned, no AAR is read')
  assert.equal(metaSdkNotices, null)
  assert.throws(() => build({ lockfile: `${lockLine('org.jetbrains.kotlinx:kotlinx-coroutines-bom', '1.10.1')}\n`, readMetaSdk }),
    /pins no library for releaseRuntimeClasspath/, 'a lockfile of BOMs alone pins no library')
})

// ── The Meta Spatial SDK ───────────────────────────────────────────────────────────────────────

test("the Meta Spatial SDK's notice carries the copyright notice its agreement asks for, word for word, then its agreement", () => {
  assert.ok(META_SPATIAL_SDK_NOTICE.includes(`\n\n${META_COPYRIGHT}\n\n`), 'section 1.3: the copyright notice, as a paragraph of its own')
  assert.match(META_SPATIAL_SDK_NOTICE, /^This app includes the Meta Spatial SDK\.\n/)
  assert.ok(META_SPATIAL_SDK_NOTICE.includes(`licensed under the ${META_AGREEMENT}, https://developer.oculus.com/licenses/oculussdk/, not under the licence of this app`),
    'the agreement it is under, linked, and not the app licence')
  assert.doesNotMatch(META_SPATIAL_SDK_NOTICE, /Apache|MIT|PolyForm/, 'it names no other licence')
  const [entry] = entriesFor('com.meta.spatial:meta-spatial-sdk')
  assert.ok(entry!.metaSdk)
  assert.deepEqual(questLicenceTexts(entry, { licence: 'the agreement' }), [META_SPATIAL_SDK_NOTICE, 'the agreement'], 'the notice, then the agreement')
  assert.throws(() => questLicenceTexts(entry, null), /agreement was not read/, 'no notices without the agreement')
  const [ort] = entriesFor('com.microsoft.onnxruntime:onnxruntime-android')
  assert.deepEqual(questLicenceTexts(ort, null), androidLicenceTexts(ort), 'every other entry gets its texts as an Android one does')
})

test('a file is read from a ZIP archive whether it is stored or deflated, and its CRC-32 is checked', () => {
  const html = '<html>' + 'notices '.repeat(500) + '</html>'
  const zip = zipOf([
    { name: 'classes.jar', data: 'a jar' },
    { name: 'LICENSE', data: `${META_AGREEMENT}\r\nterms\r\n` },
    { name: 'notices.html', data: html, deflate: true },
  ], 'an archive comment')
  assert.equal(zipEntry(zip, 'LICENSE')!.toString(), `${META_AGREEMENT}\r\nterms\r\n`, 'stored, byte for byte')
  assert.equal(zipEntry(zip, 'notices.html')!.toString(), html, 'deflated')
  assert.equal(zipEntry(zip, 'NOTICE'), null, 'a file the archive does not hold')
  assert.equal(zipEntry(zip, 'licence'), null, 'names are matched exactly')
  const damaged = Buffer.from(zip)
  damaged[damaged.indexOf('terms')] = 'T'.charCodeAt(0)
  assert.throws(() => zipEntry(damaged, 'LICENSE'), /CRC-32/)
  assert.throws(() => zipEntry(Buffer.from('not an archive at all, and longer than one record'), 'LICENSE'), /not a ZIP archive/)
})

test("the SDK's agreement and notices.html are read from the AARs of the versions pinned, and every AAR must carry the same two", () => {
  const home = mkdtempSync(join(tmpdir(), 'quest-gradle-'))
  try {
    const aar = (library: Library, files: Record<string, string>, hash = 'a1') => {
      const dir = join(home, 'caches', 'modules-2', 'files-2.1', library.group, library.artifact, library.version, hash)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${library.artifact}-${library.version}.aar`),
        zipOf(Object.entries(files).map(([name, data]) => ({ name, data, deflate: true }))))
    }
    const sdk = { group: 'com.meta.spatial', artifact: 'meta-spatial-sdk', version: '0.15.0' }
    const vr = { group: 'com.meta.spatial', artifact: 'meta-spatial-sdk-vr', version: '0.15.0' }
    const agreement = `\r\n${META_AGREEMENT}\r\nEffective date: (a stand-in)\r\n`
    const files = { 'classes.jar': 'a jar', LICENSE: agreement, 'notices.html': '<html>notices</html>' }
    aar(sdk, files)
    aar(vr, files)
    aar({ ...sdk, version: '0.14.0' }, { ...files, LICENSE: 'an older agreement' })
    assert.equal(cachedAars(sdk, home).length, 1, 'only the pinned version is read')
    const read = metaSpatialSdkFiles([sdk, vr], home)
    assert.equal(read.licence, `${META_AGREEMENT}\nEffective date: (a stand-in)`, 'the agreement with LF line ends and no blank lines at either end')
    assert.equal(read.noticesHtml.toString(), '<html>notices</html>', 'notices.html, unchanged')
    // A second copy of an AAR in the cache is read too, and must agree.
    aar(vr, { ...files, 'notices.html': '<html>other notices</html>' }, 'b2')
    assert.throws(() => metaSpatialSdkFiles([sdk, vr], home), /do not all carry the same LICENSE and notices\.html \(com\.meta\.spatial:meta-spatial-sdk:0\.15\.0 against com\.meta\.spatial:meta-spatial-sdk-vr:0\.15\.0\)/)
    rmSync(join(home, 'caches', 'modules-2', 'files-2.1', vr.group, vr.artifact, vr.version, 'b2'), { recursive: true })
    assert.throws(() => metaSpatialSdkFiles([sdk, { ...vr, artifact: 'meta-spatial-sdk-splat' }], home),
      /com\.meta\.spatial:meta-spatial-sdk-splat:0\.15\.0 is not in the Gradle cache .*:app:assembleRelease/)
    aar(vr, { 'classes.jar': 'a jar', LICENSE: agreement })
    assert.throws(() => metaSpatialSdkFiles([vr], home), /carries no notices\.html/)
    aar(vr, { ...files, LICENSE: 'Apache License\nVersion 2.0' })
    assert.throws(() => metaSpatialSdkFiles([vr], home), /is not the Meta Platform Technologies SDK License Agreement/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  assert.equal(gradleHome({ GRADLE_USER_HOME: '/srv/gradle' }), '/srv/gradle', "Gradle's own variable")
  assert.match(gradleHome({}), /[\\/]\.gradle$/, 'or ~/.gradle')
})

// ── The notices ────────────────────────────────────────────────────────────────────────────────

test("the Quest notices are titled with the app's version, which its build file sets", () => {
  assert.equal(questVersion(read('meta/app/build.gradle.kts')), read('meta/app/build.gradle.kts').match(/versionName = "([^"]+)"/)![1])
  assert.equal(questVersion('android {\n    defaultConfig {\n        versionName = "1.2.3"\n    }\n}\n'), '1.2.3')
  assert.throws(() => questVersion('android {}\n'), /sets no versionName/)
})

// The Apache License 2.0 comes from TypeScript's package, as for the Android app's libraries.
const apacheMissing = !existsSync(join(ROOT, 'node_modules/typescript'))

test('the Quest notices list each pinned library once, by name, at its pinned version, with the texts its entry names', {
  skip: apacheMissing ? 'not installed: node_modules/typescript (run npm ci)' : false,
}, () => {
  const { asked, readMetaSdk } = standIn()
  const { notices, metaSdkNotices } = build({ readMetaSdk })
  assert.deepEqual(componentsWithoutText(notices), [])
  assert.equal(metaSdkNotices!.toString(), '<html>notices</html>', 'the notices.html the AARs carry goes beside the notices')
  const pins = locked()
  assert.deepEqual(asked, [pins.filter((l) => l.group === 'com.meta.spatial').sort((a, b) => (a.artifact < b.artifact ? -1 : 1))],
    "the SDK's files are read once, from the AARs of every SDK module at its pinned version")
  // Every pin but the BOMs, once, in order of name.
  assert.ok(pins.some((l) => l.artifact.endsWith('-bom')), 'control: the lockfile pins BOMs')
  const names = pins.filter((l) => !l.artifact.endsWith('-bom')).map((l) => `${l.group}:${l.artifact}`).sort()
  assert.deepEqual(notices.components.map((c) => c.name), names)
  assert.ok(!notices.components.some((c) => c.name.endsWith('-bom')), 'no BOM is listed: it puts nothing in the APK')
  for (const component of notices.components) {
    const pin = pins.find((l) => `${l.group}:${l.artifact}` === component.name)!
    const [entry] = entriesFor(component.name)
    assert.equal(component.group, 'quest', component.name)
    assert.equal(component.version, pin.version, `${component.name} at the version the lockfile pins`)
    assert.equal(component.licence, entry!.licence, `${component.name}: its entry's licence`)
    const texts = component.texts.map((id) => notices.texts[id]!)
    assert.deepEqual(texts, questLicenceTexts(entry, { licence: `${META_AGREEMENT}\nEffective date: (a stand-in)` }), `${component.name}: the texts its entry names`)
    if (entry!.licence === 'Apache-2.0') assert.match(texts[0]!, /^Apache License\b/, `${component.name} is under the Apache License 2.0, and its text is that licence`)
  }
  const sdk = notices.components.find((c) => c.name === 'com.meta.spatial:meta-spatial-sdk')!
  assert.equal(sdk.source, `https://repo1.maven.org/maven2/com/meta/spatial/meta-spatial-sdk/${sdk.version}/`)
  assert.ok(sdk.note!.includes(META_SDK_NOTICES_FILE), 'it names the file its notices.html is copied to')
  const ort = notices.components.find((c) => c.name === 'com.microsoft.onnxruntime:onnxruntime-android')!
  assert.deepEqual(ort.texts.map((id) => notices.texts[id]), [readFileSync(join(TEXTS_DIR, 'onnxruntime-LICENSE.txt'), 'utf8').replace(/\r\n/g, '\n').trim()])
  assert.ok(ort.note!.includes(`https://github.com/microsoft/onnxruntime/blob/v${ort.version}/ThirdPartyNotices.txt`), 'its third-party notices, at its version')
  // As the notices file prints it.
  const printed = renderNotices(notices, '0.1.0', { product: QUEST_PRODUCT })
  assert.match(printed, /^Scan for Quest 0\.1\.0 - third-party notices\nFor: Scan for Quest \(meta\/\), release APK\n/)
  assert.ok(printed.includes('\n== Libraries in the Quest app (from meta/app/gradle.lockfile) ==\n'))
  assert.ok(!printed.includes('Android runtime and libraries'), "none of the Android app's headings")
  const sdkModules = notices.components.filter((c) => c.name.startsWith('com.meta.spatial:')).map((c) => `${c.name} ${c.version}`)
  assert.equal(sdkModules.length, 5)
  assert.ok(printed.includes(`\n---- Applies to: ${sdkModules.join(', ')}\n\n${META_SPATIAL_SDK_NOTICE}\n\n---- Applies to: ${sdkModules.join(', ')}\n\n${META_AGREEMENT}\n`),
    "the SDK's notice under its modules' names, then its agreement")
  assert.match(renderNotices(notices, '0.1.0'), /^Companion Scan 0\.1\.0 - third-party notices\n/, 'the first line names Companion Scan unless told otherwise')
})

// The whole generation, as `node scripts/native/third-party-notices.mjs --shell quest` runs it after the app's build:
// it reads the SDK's AARs from the Gradle cache, and is skipped where the build has not put them there.
const sdkPins = existsSync(QUEST_LOCKFILE) ? locked().filter((l) => l.group === 'com.meta.spatial') : []
const notCached = sdkPins.filter((l) => !cachedAars(l).length).map((l) => `${l.group}:${l.artifact}:${l.version}`)

test("the Quest notices are written with the SDK's own agreement, and its notices.html beside them byte for byte", {
  skip: apacheMissing ? 'not installed: node_modules/typescript (run npm ci)'
    : notCached.length ? `not in the Gradle cache: ${notCached.join(', ')} (build the Quest app in meta/ first)` : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'quest-notices-'))
  try {
    const notices = writeQuestNotices(dir) as Notices
    const text = readFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    assert.ok(text.startsWith(`${QUEST_PRODUCT} ${questVersion()} - third-party notices\n`))
    const aar = readFileSync(cachedAars(sdkPins[0]!)[0]!)
    assert.ok(readFileSync(join(dir, META_SDK_NOTICES_FILE)).equals(zipEntry(aar, 'notices.html')!), 'notices.html, unchanged')
    const agreement = zipEntry(aar, 'LICENSE')!.toString('utf8').replace(/\r\n/g, '\n').trim()
    assert.ok(agreement.startsWith(`${META_AGREEMENT}\n`))
    assert.ok(agreement.includes(META_COPYRIGHT), 'the agreement carries the same copyright notice')
    assert.ok(text.includes(`\n\n${agreement}\n`), 'the agreement as the AAR carries it')
    assert.equal(text.split(META_AGREEMENT + '\n').length - 1, 1, 'printed once for the five modules')
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'third-party-notices.json'), 'utf8')), JSON.parse(JSON.stringify(notices)), 'and the JSON a merge reads')
    assert.equal(notices.components.length, locked().filter((l) => !l.artifact.endsWith('-bom')).length, 'every pin but the BOMs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the Quest target doc says how its notices are made, and no longer that they are not', () => {
  const doc = read('docs/targets/meta-quest.md').replace(/\s+/g, ' ')
  assert.ok(doc.includes('third-party-notices.mjs --shell quest'), 'it names the command')
  assert.ok(doc.includes('meta/app/gradle.lockfile'), 'and the lockfile the notices are made from')
  assert.doesNotMatch(doc, /third-party notices do not cover `meta\/`/)
})
