#!/usr/bin/env node
/**
 * Third-party notices for a native app bundle, generated from the lockfiles.
 *
 *   node scripts/native/third-party-notices.mjs --shell desktop|mobile --bundle-report <json>
 *        --out <THIRD-PARTY-NOTICES.txt> [--json <notices.json>] [--targets <rust triple,...>]
 *   node scripts/native/third-party-notices.mjs --merge <a.json> <b.json>... --out <file.txt>
 *   node scripts/native/third-party-notices.mjs --shell quest [--out-dir <folder>]
 *
 * scripts/native/build-web.mjs runs the first form for every shell build and puts the result in
 * the bundle (THIRD-PARTY-NOTICES.txt beside index.html), so each app carries its own notices.
 * The release workflow merges the JSON of every build into the release asset. The last form is the
 * Quest app's (meta/), which has no web bundle: run it after the app's build, and it writes the
 * notices to meta/build/third-party-notices/ (or <folder>) for a release to attach beside the APK.
 *
 * What is listed, and where it comes from:
 *   - npm packages: the ones whose modules are in the web bundle (the Vite module list that
 *     build-web.mjs records), at the version and licence package-lock.json gives, with the
 *     licence files from node_modules.
 *   - Rust crates (desktop): the crates linked into the app, walked through Cargo.lock's
 *     normal dependencies with `cargo metadata --locked` for each target, with the licence
 *     files from each crate's source. MPL-2.0 crates also get where to download their source.
 *   - Android (mobile): Capacitor's Android runtime from mobile/package-lock.json, and every
 *     library in the release APK, direct or transitive, from the Gradle lockfile
 *     (mobile/android/app/gradle.lockfile). The release build uses the versions locked there,
 *     and fails when its libraries are not the ones the lockfile lists, so this list cannot fall
 *     behind the APK.
 *   - Components no package manager knows: the vendored XR Engine (mobile, except a build that forces
 *     WebXR, which leaves it out: scripts/native/build-web.mjs, bundlesEngine), the Draco decoder,
 *     the onnxruntime-web WASM files, qrcodegen, and the WebView2 loader (Windows).
 *   - Data the bundle includes by its module: the World Magnetic Model coefficients (NOAA NCEI), when
 *     the web bundle holds src/world/wmm<year>-coefficients.ts (addBundledData).
 *   - The Quest app (--shell quest): every library in its release APK, direct or transitive, from its
 *     Gradle lockfile (meta/app/gradle.lockfile), which its release build enforces as the Android
 *     app's does, each with the licence QUEST_LICENCES gives it. The Meta Spatial SDK gets the
 *     copyright notice its agreement asks for and the agreement's text, and its notices.html goes
 *     beside the notices: both files are read from the SDK's AARs, in the Gradle cache that the
 *     app's build filled (questNotices).
 *
 * Every component gets its licence text: the files it ships, or, for one that ships none, its
 * project's text kept in scripts/native/licence-texts/ (SUPPLIED_TEXTS). A proprietary SDK whose
 * agreement is linked, not reproduced (the XR Engine), gets a short notice of its own instead. ARCore's
 * terms are reproduced from licence-texts/ and come after Google's disclosure. The notices are not made
 * while any component is left without a text.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)([._-].*)?$/i

/** Licence texts for components that ship none of their own, as their projects publish them. */
export const TEXTS_DIR = join(ROOT, 'scripts', 'native', 'licence-texts')

/** Where each file in TEXTS_DIR was copied from. */
export const SUPPLIED_TEXT_SOURCES = {
  'onnxruntime-LICENSE.txt': 'https://github.com/microsoft/onnxruntime/blob/v1.21.1/LICENSE',
  'webview2-rs-LICENSE.txt': 'https://github.com/wravery/webview2-rs/blob/main/LICENSE',
  'Microsoft.Web.WebView2-LICENSE.txt': 'the licence of the Microsoft.Web.WebView2 1.0.3800.47 package, '
    + 'https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3800.47/License',
  // The 0.6 crates' own repository state names MIT and links the OSI template; this is the
  // project's MIT file with its copyright line.
  'objc2-LICENSE-MIT.txt': 'https://github.com/madsmtm/objc2/blob/main/LICENSE-MIT.txt',
  // Copied without the contact addresses that follow two of the names in its copyright lines.
  'dlopen2-LICENSE.txt': 'https://github.com/OpenByteDev/dlopen2/blob/master/LICENSE',
  'cordova-android-NOTICE.txt': 'https://github.com/apache/cordova-android/blob/14.0.1/NOTICE',
  // ARCore's AAR ships no licence file. Its terms are Google's ARCore Additional Terms of Service,
  // copied from the page on 2026-11-16; the page says the terms were last modified on 2022-05-11.
  'arcore-additional-terms.txt': 'https://developers.google.com/ar/develop/terms, retrieved 2026-11-16',
}

/**
 * The texts in TEXTS_DIR that stand in for the licence files a package or crate does not ship,
 * keyed by the component's group and name. Only used when the component has no file of its own.
 */
export const SUPPLIED_TEXTS = {
  'npm:onnxruntime-web': ['onnxruntime-LICENSE.txt'],
  'rust:webview2-com': ['webview2-rs-LICENSE.txt'],
  'rust:webview2-com-macros': ['webview2-rs-LICENSE.txt'],
  'rust:webview2-com-sys': ['webview2-rs-LICENSE.txt'],
  'rust:block2': ['objc2-LICENSE-MIT.txt'],
  'rust:objc2': ['objc2-LICENSE-MIT.txt'],
  'rust:objc2-encode': ['objc2-LICENSE-MIT.txt'],
  'rust:objc2-foundation': ['objc2-LICENSE-MIT.txt'],
  'rust:dlopen2': ['dlopen2-LICENSE.txt'],
  'rust:dlopen2_derive': ['dlopen2-LICENSE.txt'],
}

/**
 * npm packages whose package.json declares no licence, though the licence file they ship states one, keyed by
 * `npm:<name>`. Only used when neither the lockfile nor the package.json names a licence, so a package that later
 * declares one is reported as it declares it.
 */
export const DECLARED_LICENCES = {
  'npm:locar': { licence: 'MIT', source: 'https://github.com/AR-js-org/locar.js' },
}

/** Crates that ship no licence file, and the crate from the same repository, under the same licence, whose files apply. */
export const CRATE_TEXTS_FROM = { 'alloc-stdlib': 'alloc-no-stdlib' }

/** A text from TEXTS_DIR, as the notices print it. */
function suppliedText(file) {
  return readFileSync(join(TEXTS_DIR, file), 'utf8').replace(/\r\n/g, '\n').trim()
}

/** The note for a component whose texts come from SUPPLIED_TEXTS. */
function suppliedNote(kind, files) {
  return `The ${kind} ships no licence file; the text below is its project's (${files.map((file) => SUPPLIED_TEXT_SOURCES[file]).join('; ')}).`
}

let apacheLicence = null

/** The Apache License 2.0, as TypeScript's package ships it, for components under it that ship no copy. */
function apacheText() {
  apacheLicence ??= licenceFiles(join(ROOT, 'node_modules', 'typescript')).filter((text) => text.startsWith('Apache License'))
  return apacheLicence
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Licence and notice files at the top of a package or crate folder, sorted by name. */
export function licenceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim())
}

/** The npm package a bundled module id belongs to, or null for the app's own code. */
export function packageOfModule(id) {
  const path = id.replace(/\\/g, '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const rest = path.slice(at + '/node_modules/'.length).split('/')
  if (!rest[0]) return null
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const url = repo ?? pkg.homepage ?? null
  if (!url) return null
  // npm's shorthand: "user/repo" and "github:user/repo" name GitHub repositories.
  const shorthand = url.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/)
  if (shorthand) return `https://github.com/${shorthand[1]}`
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
}

/** Collects components and deduplicated licence texts. */
class Notices {
  constructor(title) {
    this.title = title
    this.components = []
    this.texts = {}
  }

  add(component, texts = []) {
    const ids = texts.map((text) => {
      const id = createHash('sha256').update(text).digest('hex').slice(0, 16)
      this.texts[id] = text
      return id
    })
    const key = `${component.group}|${component.name}|${component.version ?? ''}`
    if (this.components.some((c) => `${c.group}|${c.name}|${c.version ?? ''}` === key)) return
    this.components.push({ ...component, texts: ids })
  }

  toJSON() {
    return { titles: [this.title], components: this.components, texts: this.texts }
  }
}

/** npm packages in the web bundle, from the root lockfile. */
function addNpmPackages(notices, bundledModules) {
  const lock = readJson(join(ROOT, 'package-lock.json'))
  const names = [...new Set(bundledModules.map(packageOfModule).filter(Boolean))].sort()
  for (const name of names) {
    const entry = lock.packages[`node_modules/${name}`]
    if (!entry) throw new Error(`${name} is in the bundle but not in package-lock.json`)
    const dir = join(ROOT, 'node_modules', name)
    const pkg = existsSync(join(dir, 'package.json')) ? readJson(join(dir, 'package.json')) : {}
    const shipped = licenceFiles(dir)
    const supplied = shipped.length ? [] : SUPPLIED_TEXTS[`npm:${name}`] ?? []
    const declared = DECLARED_LICENCES[`npm:${name}`]
    notices.add({
      group: 'npm',
      name,
      version: entry.version,
      licence: entry.license ?? pkg.license ?? declared?.licence ?? 'not declared',
      source: repositoryOf(pkg) ?? declared?.source ?? `https://www.npmjs.com/package/${name}/v/${entry.version}`,
      note: shipped.length ? undefined : supplied.length ? suppliedNote('package', supplied)
        : `The package ships no licence file; its package.json declares ${entry.license ?? 'no licence'}.`,
    }, shipped.length ? shipped : supplied.map(suppliedText))
  }
  return names
}

/** The Rust crates linked into the desktop app for `targets`: normal dependencies from the root, through Cargo.lock. */
export function linkedCrates(metadata) {
  const root = metadata.resolve.root
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const seen = new Set()
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg)
    }
  }
  seen.delete(root)
  return metadata.packages.filter((pkg) => seen.has(pkg.id))
}

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  return out.match(/^host: (\S+)$/m)?.[1]
}

function addRustCrates(notices, targets) {
  const manifest = join(ROOT, 'desktop', 'src-tauri', 'Cargo.toml')
  const crates = new Map()
  for (const target of targets) {
    const metadata = JSON.parse(execFileSync('cargo', [
      'metadata', '--format-version', '1', '--locked', '--manifest-path', manifest, '--filter-platform', target,
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
    for (const pkg of linkedCrates(metadata)) crates.set(`${pkg.name}@${pkg.version}`, pkg)
  }
  const sorted = [...crates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const textsOf = new Map(sorted.map((pkg) => {
    const dir = dirname(pkg.manifest_path)
    const texts = licenceFiles(dir)
    if (pkg.license_file && existsSync(join(dir, pkg.license_file))) {
      const text = readFileSync(join(dir, pkg.license_file), 'utf8').replace(/\r\n/g, '\n').trim()
      if (!texts.includes(text)) texts.push(text)
    }
    return [pkg, texts]
  }))
  // MPL-2.0 and Apache-2.0 texts name no copyright holder, so a crate that ships no licence
  // file still gets the full text of its licence, taken from a crate that does ship it.
  const shared = {}
  for (const [pkg, texts] of textsOf) {
    if (pkg.license === 'MPL-2.0' && texts.length === 1) shared['MPL-2.0'] ??= texts[0]
    const apache = texts.find((text) => /^\s*Apache License\s+Version 2\.0/.test(text))
    if (apache) shared['Apache-2.0'] ??= apache
  }
  // A crate that ships no licence file gets, in this order: the files of a crate from its own
  // repository (CRATE_TEXTS_FROM), its project's text (SUPPLIED_TEXTS), or the standard text of
  // its MPL-2.0 or Apache-2.0 licence, which names no copyright holder.
  const fallback = (pkg, licence) => {
    const sibling = CRATE_TEXTS_FROM[pkg.name]
    const siblingTexts = sibling ? [...textsOf].find(([other]) => other.name === sibling)?.[1] ?? [] : []
    if (siblingTexts.length) {
      return { texts: siblingTexts, note: `The crate ships no licence file; the text below is ${sibling}'s, from the same repository and under the same licence.` }
    }
    const supplied = SUPPLIED_TEXTS[`rust:${pkg.name}`] ?? []
    if (supplied.length) return { texts: supplied.map(suppliedText), note: suppliedNote('crate', supplied) }
    const standard = ['MPL-2.0', 'Apache-2.0'].filter((id) => licence.includes(id) && shared[id]).map((id) => shared[id])
    if (standard.length) return { texts: standard, note: 'The crate ships no licence file; the standard text of its licence is below.' }
    return { texts: [], note: 'The crate ships no licence file.' }
  }
  for (const [pkg, shipped] of textsOf) {
    const licence = pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'not declared')
    const { texts, note } = shipped.length ? { texts: shipped, note: null } : fallback(pkg, licence)
    const crate = `https://crates.io/crates/${pkg.name}/${pkg.version}`
    const mpl = /MPL-2\.0/.test(licence)
    notices.add({
      group: 'rust',
      name: pkg.name,
      version: pkg.version,
      licence,
      source: pkg.repository ?? crate,
      note: [
        mpl ? `MPL-2.0 source: ${crate}, download https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`
          + (pkg.repository ? `, repository ${pkg.repository}` : '') + '. The files under MPL-2.0 are unmodified.' : null,
        note,
      ].filter(Boolean).join(' ') || undefined,
    }, texts)
  }
  return crates.size
}

/** Capacitor's Android runtime, from mobile/package-lock.json, and every library in the APK, from the Gradle lockfile. */
function addAndroid(notices) {
  const lock = readJson(join(ROOT, 'mobile', 'package-lock.json'))
  const runtime = ['@capacitor/android', '@capacitor/app', '@capacitor/browser', '@capacitor/core']
  for (const name of runtime) {
    const entry = lock.packages[`node_modules/${name}`]
    if (!entry) throw new Error(`${name} is not in mobile/package-lock.json`)
    const dir = join(ROOT, 'mobile', 'node_modules', name)
    const pkg = existsSync(join(dir, 'package.json')) ? readJson(join(dir, 'package.json')) : {}
    notices.add({
      group: 'android',
      name,
      version: entry.version,
      licence: entry.license ?? pkg.license ?? 'not declared',
      source: repositoryOf(pkg) ?? `https://www.npmjs.com/package/${name}/v/${entry.version}`,
    }, licenceFiles(dir))
  }
  // Every library in the release APK, direct or transitive, as the Gradle lockfile pins it.
  if (!existsSync(ANDROID_LOCKFILE)) {
    throw new Error('mobile/android/app/gradle.lockfile is missing. In mobile/android, after npx cap sync android, run '
      + './gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks')
  }
  const unknown = []
  for (const { group, artifact, version } of lockedLibraries(readFileSync(ANDROID_LOCKFILE, 'utf8'))) {
    // A BOM only aligns the versions of other libraries; it puts nothing in the APK.
    if (artifact.endsWith('-bom')) continue
    const name = `${group}:${artifact}`
    const known = ANDROID_LICENCES.find((entry) => entry.match.test(name))
    if (!known) {
      unknown.push(`${name}:${version}`)
      continue
    }
    notices.add({ group: 'android', name, version, licence: known.licence, source: known.source }, androidLicenceTexts(known))
  }
  if (unknown.length) {
    throw new Error(`the Android app's libraries include some of no known licence: ${unknown.join(', ')}. `
      + 'Check the licence of each (its POM, and the LICENSE in its AAR), then add it to ANDROID_LICENCES in scripts/native/third-party-notices.mjs.')
  }
}

/** The lockfile that pins every library of the Android app's release build (mobile/android/app/build.gradle). */
export const ANDROID_LOCKFILE = join(ROOT, 'mobile', 'android', 'app', 'gradle.lockfile')

/** The libraries a Gradle lockfile pins for `configuration`, as `{ group, artifact, version }`. */
export function lockedLibraries(text, configuration = 'releaseRuntimeClasspath') {
  const libraries = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^#=:\s]+):([^=:\s]+):([^=:\s]+)=(.*)$/)
    if (match?.[4].split(',').includes(configuration)) libraries.push({ group: match[1], artifact: match[2], version: match[3] })
  }
  return libraries
}

/**
 * What Google asks an app that uses ARCore to tell its users, and the terms the SDK is under. Google's
 * page (https://developers.google.com/ar/develop/privacy-requirements) asks for the first sentence below
 * to be prominent and easy to find, with links to Google Play Services for AR and to the Google Privacy
 * Policy. This is the copy THIRD-PARTY-NOTICES.txt carries, ahead of the text of the SDK's terms
 * (licence-texts/arcore-additional-terms.txt).
 */
export const ARCORE_NOTICE = [
  'This application runs on Google Play Services for AR (ARCore), which is provided by Google and governed by the Google Privacy Policy.',
  'Google Play Services for AR: https://play.google.com/store/apps/details?id=com.google.ar.core\n'
    + 'Google Privacy Policy: https://policies.google.com/privacy',
  'The ARCore SDK for Android (com.google.ar:core) is licensed under the ARCore Additional Terms of Service, '
    + 'https://developers.google.com/ar/develop/terms, not under the licence of this app. Those terms are proprietary: '
    + 'their text follows this notice.',
].join('\n\n')

/**
 * The licence of each library the Android app's release build pins, by `group:artifact`, as each
 * library's POM declares it (and the LICENSE.txt the AndroidX AARs carry). All but ARCore are under
 * the Apache License 2.0, whose text each one gets (androidLicenceTexts); Cordova also has a NOTICE file
 * (`notice`), which section 4(d) of that licence asks to pass on. ARCore's AAR carries no licence file, so
 * its entry names Google's ARCore Additional Terms of Service, supplies their text (`text`, a file in
 * licence-texts/) and carries the disclosure Google asks an app that uses ARCore to make (`disclosure`).
 * A library that matches none stops the notices: check its licence, then add it here.
 */
export const ANDROID_LICENCES = [
  { match: /^androidx\./, licence: 'Apache-2.0', source: 'https://developer.android.com/jetpack/androidx' },
  { match: /^org\.apache\.cordova:framework$/, licence: 'Apache-2.0', source: 'https://github.com/apache/cordova-android', notice: 'cordova-android-NOTICE.txt' },
  { match: /^org\.jetbrains\.kotlin:kotlin-stdlib/, licence: 'Apache-2.0', source: 'https://github.com/JetBrains/kotlin' },
  { match: /^org\.jetbrains\.kotlinx:kotlinx-coroutines-/, licence: 'Apache-2.0', source: 'https://github.com/Kotlin/kotlinx.coroutines' },
  { match: /^org\.jetbrains:annotations$/, licence: 'Apache-2.0', source: 'https://github.com/JetBrains/java-annotations' },
  { match: /^org\.jspecify:jspecify$/, licence: 'Apache-2.0', source: 'https://github.com/jspecify/jspecify' },
  { match: /^com\.google\.guava:listenablefuture$/, licence: 'Apache-2.0', source: 'https://github.com/google/guava' },
  {
    match: /^com\.google\.ar:core$/,
    licence: 'ARCore Additional Terms of Service',
    source: 'https://developers.google.com/ar/develop/terms',
    disclosure: ARCORE_NOTICE,
    text: 'arcore-additional-terms.txt',
  },
]

/**
 * The licence texts an ANDROID_LICENCES entry puts in the notices: its `disclosure`, if it has one, then the
 * Apache License 2.0, or the entry's own `text` (a file in licence-texts/) when its library is not under it,
 * and then the entry's `notice` file, if any.
 */
export function androidLicenceTexts(entry) {
  return [
    ...(entry.disclosure ? [entry.disclosure] : []),
    ...(entry.text ? [suppliedText(entry.text)] : apacheText()),
    ...(entry.notice ? [suppliedText(entry.notice)] : []),
  ]
}

function addVendored(notices, shell, targets, engineBundled) {
  if (engineBundled) {
    // The notice section 1.3.2 of the Agreement asks for, as the app's Legal notices view shows it
    // (src/ui/legal-notices.ts). The Agreement itself is proprietary and linked, not reproduced.
    notices.add({
      group: 'vendored',
      name: 'Niantic Spatial XR Engine (8th Wall), @8thwall/engine-binary',
      version: '1.0.0',
      licence: 'XR Engine License Agreement (proprietary, binary only)',
      source: 'https://github.com/8thwall/engine/blob/main/LICENSE',
      note: 'Files: xr.js, xr-slam.js, xr-face.js and resources/, unmodified.',
    }, [[
      'This product includes the XR Engine software developed by Niantic Spatial, Inc.',
      'Copyright © 2026 Niantic Spatial, Inc. All rights reserved.',
      'The XR Engine is licensed under the XR Engine License Agreement, '
        + 'https://github.com/8thwall/engine/blob/main/LICENSE, not under the licence of this app. It is provided '
        + '"as is", without warranties of any kind; section 4 (Disclaimers) of the Agreement sets out the disclaimer.',
    ].join('\n\n')])
  }
  const draco = join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco')
  notices.add({
    group: 'vendored',
    name: 'Draco 3D decoder (Google), copied to draco/ from three',
    licence: 'Apache-2.0',
    source: 'https://github.com/google/draco',
    note: existsSync(join(draco, 'README.md')) ? 'The three.js copy states the Apache License 2.0 in its README.' : undefined,
  }, apacheText())
  const ort = readJson(join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json')).version
  const ortTexts = licenceFiles(join(ROOT, 'node_modules', 'onnxruntime-web'))
  notices.add({
    group: 'vendored',
    name: 'onnxruntime-web WebAssembly runtime (Microsoft), copied to ort/',
    version: ort,
    licence: 'MIT',
    source: 'https://github.com/microsoft/onnxruntime',
    note: (ortTexts.length ? '' : `${suppliedNote('package', SUPPLIED_TEXTS['npm:onnxruntime-web'])} `)
      + `The WebAssembly build also contains third-party code, which onnxruntime lists with its licences in https://github.com/microsoft/onnxruntime/blob/v${ort}/ThirdPartyNotices.txt.`,
  }, ortTexts.length ? ortTexts : SUPPLIED_TEXTS['npm:onnxruntime-web'].map(suppliedText))
  const qr = readFileSync(join(ROOT, 'src', 'third-party', 'qrcodegen', 'qrcodegen.ts'), 'utf8')
  const qrHeader = qr.match(/^\/\*([\s\S]*?)\*\//)?.[1].split('\n').map((line) => line.replace(/^\s*\* ?/, '')).join('\n').trim()
  notices.add({
    group: 'vendored',
    name: 'QR Code generator library (Project Nayuki), in src/third-party/qrcodegen',
    licence: 'MIT',
    source: 'https://www.nayuki.io/page/qr-code-generator-library',
  }, qrHeader ? [qrHeader] : [])
  if (targets.some((target) => target.includes('windows'))) {
    notices.add({
      group: 'vendored',
      name: 'Microsoft Edge WebView2 loader (WebView2LoaderStatic.lib), linked through the webview2-com-sys crate',
      licence: 'WebView2 SDK licence (Microsoft, BSD-style)',
      source: 'https://www.nuget.org/packages/Microsoft.Web.WebView2',
      note: 'Distributed under the licence of the Microsoft.Web.WebView2 package, below.',
    }, [suppliedText('Microsoft.Web.WebView2-LICENSE.txt')])
  }
}

/**
 * The generated coefficient modules of the World Magnetic Model, by the id of a bundled module (the Vite module
 * list build-web.mjs records): src/world/wmm<year>-coefficients.ts, whose header scripts/gen-wmm-coefficients.mjs
 * writes with the notice NOAA NCEI asks for (17 U.S.C. 403).
 */
export const WMM_MODULE = /(?:^|\/)src\/world\/(wmm(\d{4})-coefficients\.ts)$/

/**
 * The NCEI notice in the header of a generated coefficient module, as one paragraph: the header's paragraph that
 * starts "Notice (17 U.S.C. 403)", or null when it has none. The notice is written once, by the generator, and this
 * carries those words, so a bundle cannot say anything but what the module says.
 */
export function wmmNotice(moduleSource) {
  const header = moduleSource.match(/^\/\*\*([\s\S]*?)\*\//)?.[1] ?? ''
  const paragraphs = header.split('\n').map((line) => line.replace(/^\s*\* ?/, '')).join('\n').split(/\n\s*\n/)
  const paragraph = paragraphs.find((text) => text.trim().startsWith('Notice (17 U.S.C. 403)'))
  return paragraph ? paragraph.replace(/\s*\n\s*/g, ' ').trim() : null
}

/**
 * The notices a bundle owes for the data it includes by module, beyond the packages and libraries the lockfiles list:
 * for the World Magnetic Model coefficients, the notice NCEI asks for, with the component it is for. Throws when the
 * module is bundled but its header carries no notice, so a bundle cannot ship the data without it.
 * @param {string[]} bundledModules module ids, as the bundle report lists them
 * @param {string} [root] the checkout the module is read from (the tests give another)
 * @returns {Array<{ component: object, texts: string[] }>}
 */
export function bundledDataNotices(bundledModules, root = ROOT) {
  const found = new Map()
  for (const id of bundledModules) {
    const match = id.replace(/\\/g, '/').match(WMM_MODULE)
    if (match) found.set(match[1], match[2])
  }
  return [...found].sort().map(([file, year]) => {
    const notice = wmmNotice(readFileSync(join(root, 'src', 'world', file), 'utf8'))
    if (!notice) {
      throw new Error(`src/world/${file} is in the bundle but its header has no "Notice (17 U.S.C. 403)" paragraph, which NOAA asks to go with `
        + 'the data. Write the module again with scripts/gen-wmm-coefficients.mjs.')
    }
    return {
      component: {
        group: 'vendored',
        name: `World Magnetic Model WMM${year} coefficients (NOAA NCEI), in src/world/${file}`,
        licence: 'Public domain (U.S. Government material, 17 U.S.C. 403)',
        source: 'https://www.ncei.noaa.gov/products/world-magnetic-model',
      },
      texts: [notice],
    }
  })
}

function addBundledData(notices, bundledModules) {
  for (const { component, texts } of bundledDataNotices(bundledModules)) notices.add(component, texts)
}

/** The components left with no licence text, by group, name and version. The notices are not made while there are any. */
export function componentsWithoutText(notices) {
  return notices.components.filter((c) => !c.texts?.length).map((c) => `${c.group} ${c.name}${c.version ? ` ${c.version}` : ''}`)
}

/**
 * Builds the notices for one bundle. `engineBundled` says whether it carries the XR Engine: the mobile bundle does,
 * unless it was built to run WebXR alone (scripts/native/build-web.mjs, bundlesEngine); the desktop bundle never does.
 */
export function bundleNotices({ shell, bundledModules, targets = [], title, engineBundled = shell === 'mobile' }) {
  const notices = new Notices(title ?? `${shell === 'desktop' ? 'Desktop app' : 'Android app'}${targets.length ? ` (${targets.join(', ')})` : ''}`)
  addVendored(notices, shell, targets, engineBundled)
  addBundledData(notices, bundledModules)
  addNpmPackages(notices, bundledModules)
  if (shell === 'mobile') addAndroid(notices)
  if (shell === 'desktop') addRustCrates(notices, targets)
  const json = notices.toJSON()
  const bare = componentsWithoutText(json)
  if (bare.length) {
    throw new Error(`no licence text for: ${bare.join('; ')}. Copy each one's licence from its project into `
      + 'scripts/native/licence-texts/, and name the file in SUPPLIED_TEXTS (and its origin in SUPPLIED_TEXT_SOURCES).')
  }
  return json
}

/** Merges notices of several bundles into one. */
export function mergeNotices(parts) {
  const merged = new Notices('')
  merged.titles = []
  for (const part of parts) {
    merged.titles.push(...part.titles)
    for (const component of part.components) {
      merged.add({ ...component, texts: undefined }, component.texts.map((id) => part.texts[id]))
    }
  }
  return { titles: merged.titles, components: merged.components, texts: merged.texts }
}

/** The lockfile that pins every library of the Quest app's release build (meta/app/build.gradle.kts). */
export const QUEST_LOCKFILE = join(ROOT, 'meta', 'app', 'gradle.lockfile')

/** Where `--shell quest` writes the Quest app's notices, unless --out-dir names another folder. build/ is git-ignored. */
export const QUEST_NOTICES_DIR = join(ROOT, 'meta', 'build', 'third-party-notices')

/** The Quest app's name, as its manifest labels it, which the first line of its notices gives. */
export const QUEST_PRODUCT = 'Scan for Quest'

/** The file the Meta Spatial SDK's notices.html is copied to, beside the Quest app's THIRD-PARTY-NOTICES.txt. */
export const META_SDK_NOTICES_FILE = 'META-SPATIAL-SDK-NOTICES.html'

/**
 * What the Quest app's notices say of the Meta Spatial SDK, ahead of the text of its agreement. Section 1.3 of the
 * Meta Platform Technologies SDK License Agreement asks that a redistribution of the SDK's materials carry the
 * copyright notice below, and a copy of the "License" or "Notice" file they include. Each of the SDK's AARs carries
 * two: LICENSE, the agreement, whose text follows this notice, and notices.html, the third-party code in the SDK's
 * native libraries, which goes beside the notices unchanged (META_SDK_NOTICES_FILE).
 */
export const META_SPATIAL_SDK_NOTICE = [
  'This app includes the Meta Spatial SDK.',
  'Copyright © Meta Platform Technologies, LLC and its affiliates. All rights reserved.',
  'The Meta Spatial SDK is licensed under the Meta Platform Technologies SDK License Agreement, '
    + 'https://developer.oculus.com/licenses/oculussdk/, not under the licence of this app. Its text follows, as '
    + "each of the SDK's AARs carries it (LICENSE).",
].join('\n\n')

/**
 * The licence of each library the Quest app's release build pins (meta/app/gradle.lockfile), by `group:artifact`,
 * as its POM declares it, but for its BOMs, which questNotices leaves out. Every name is spelled out, so a library none of them matches stops the notices, even one
 * from a family listed here: check its licence (its POM, and the LICENSE in its AAR), then add it. The entries take
 * the shape of ANDROID_LICENCES, and androidLicenceTexts gives each its texts, except the Meta Spatial SDK's
 * (`metaSdk`), which get META_SPATIAL_SDK_NOTICE and then the agreement as the SDK's AARs carry it
 * (questLicenceTexts). A `source` or `note` may be a function of the library, `{ group, artifact, version }`.
 */
export const QUEST_LICENCES = [
  {
    match: /^com\.meta\.spatial:meta-spatial-sdk(?:-isdk|-splat|-toolkit|-vr)?$/,
    licence: 'Meta Platform Technologies SDK License Agreement (proprietary)',
    source: ({ group, artifact, version }) => `https://repo1.maven.org/maven2/${group.replaceAll('.', '/')}/${artifact}/${version}/`,
    note: `Its native libraries include third-party code, which ${META_SDK_NOTICES_FILE} lists with its licences `
      + "(the notices.html each of the SDK's AARs carries, unchanged).",
    metaSdk: true,
  },
  {
    // The AAR ships no licence file; the text is onnxruntime's own LICENSE, as licence-texts/ keeps it.
    match: /^com\.microsoft\.onnxruntime:onnxruntime-android$/,
    licence: 'MIT',
    source: 'https://github.com/microsoft/onnxruntime',
    note: ({ version }) => 'The library also contains third-party code, which onnxruntime lists with its licences in '
      + `https://github.com/microsoft/onnxruntime/blob/v${version}/ThirdPartyNotices.txt.`,
    text: 'onnxruntime-LICENSE.txt',
  },
  { match: /^com\.squareup\.okhttp3:okhttp$/, licence: 'Apache-2.0', source: 'https://square.github.io/okhttp/' },
  { match: /^com\.squareup\.okio:okio$/, licence: 'Apache-2.0', source: 'https://github.com/square/okio/' },
  { match: /^org\.jetbrains\.kotlin:kotlin-stdlib$/, licence: 'Apache-2.0', source: 'https://github.com/JetBrains/kotlin' },
  { match: /^org\.jetbrains\.kotlin:kotlin-stdlib-common$/, licence: 'Apache-2.0', source: 'https://kotlinlang.org/' },
  {
    match: /^org\.jetbrains\.kotlinx:kotlinx-coroutines-(?:android|core|core-jvm)$/,
    licence: 'Apache-2.0',
    source: 'https://github.com/Kotlin/kotlinx.coroutines',
  },
  {
    match: /^org\.jetbrains\.kotlinx:kotlinx-serialization-(?:core|core-jvm|json|json-jvm)$/,
    licence: 'Apache-2.0',
    source: 'https://github.com/Kotlin/kotlinx.serialization',
  },
  { match: /^org\.jetbrains:annotations$/, licence: 'Apache-2.0', source: 'https://github.com/JetBrains/java-annotations' },
]

/**
 * The licence texts a QUEST_LICENCES entry puts in the notices: androidLicenceTexts' for every entry but the Meta
 * Spatial SDK's, which gets META_SPATIAL_SDK_NOTICE and then `metaSdk.licence`, the agreement its AARs carry.
 */
export function questLicenceTexts(entry, metaSdk) {
  if (!entry.metaSdk) return androidLicenceTexts(entry)
  if (!metaSdk?.licence) throw new Error("the Meta Spatial SDK's agreement was not read from its AARs, and the notices cannot be made without it")
  return [META_SPATIAL_SDK_NOTICE, metaSdk.licence]
}

/** The Gradle home whose cache holds what a build downloaded: GRADLE_USER_HOME, as Gradle reads it, or ~/.gradle. */
export function gradleHome(env = process.env) {
  return env.GRADLE_USER_HOME || join(homedir(), '.gradle')
}

/** Every copy of a library's AAR in a Gradle cache: caches/modules-2/files-2.1/<group>/<artifact>/<version>/<sha1>/. */
export function cachedAars({ group, artifact, version }, home = gradleHome()) {
  const dir = join(home, 'caches', 'modules-2', 'files-2.1', group, artifact, version)
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().map((hash) => join(dir, hash, `${artifact}-${version}.aar`)).filter((path) => existsSync(path))
}

/**
 * One file of a ZIP archive, such as an AAR, by its name, or null when the archive holds none by that name. It reads
 * the central directory, so it needs no tool beside Node, and takes stored and deflated files, checked against their
 * size and CRC-32. It does not read ZIP64 archives, which an AAR under 4 GiB is not.
 * @param {Buffer} zip
 * @param {string} name
 * @returns {Buffer | null}
 */
export function zipEntry(zip, name) {
  // The end of central directory record: 22 bytes, then a comment of up to 65535.
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error(`no ZIP end of central directory, so ${name} cannot be read: not a ZIP archive`)
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff) throw new Error(`a ZIP64 archive, which zipEntry does not read (${name})`)
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`a damaged ZIP central directory, at entry ${i} (${name})`)
    const nameLength = zip.readUInt16LE(at + 28)
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const [method, crc, size, length, offset] = [zip.readUInt16LE(at + 10), zip.readUInt32LE(at + 16), zip.readUInt32LE(at + 20),
        zip.readUInt32LE(at + 24), zip.readUInt32LE(at + 42)]
      if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`${name}: a damaged ZIP local header`)
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28)
      const stored = zip.subarray(start, start + size)
      if (method !== 0 && method !== 8) throw new Error(`${name}: ZIP compression method ${method}, which zipEntry does not read`)
      const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored)
      if (data.length !== length || crc32(data) !== crc) throw new Error(`${name}: its size or CRC-32 is not the one the ZIP directory records`)
      return data
    }
    at = next
  }
  return null
}

/**
 * The Meta Spatial SDK's agreement and third-party notices, from the AARs of `libraries` (the SDK's modules, at the
 * versions the lockfile pins) in the Gradle cache that the Quest app's build filled. Each AAR carries both, as LICENSE
 * and notices.html; the notices hold one copy of each, so every AAR must carry the same two files, and LICENSE must be
 * the agreement. Stops when an AAR is not in the cache.
 * @returns {{ licence: string, noticesHtml: Buffer }} the agreement as the notices print it, and notices.html's bytes
 */
export function metaSpatialSdkFiles(libraries, home = gradleHome()) {
  const copies = []
  for (const library of libraries) {
    const coordinates = `${library.group}:${library.artifact}:${library.version}`
    const aars = cachedAars(library, home)
    if (!aars.length) {
      throw new Error(`${coordinates} is not in the Gradle cache (${home}), so the LICENSE and notices.html its AAR carries cannot be `
        + 'read. Build the Quest app first (in meta/: ./gradlew :app:assembleRelease), or set GRADLE_USER_HOME to the Gradle home its build used.')
    }
    for (const aar of aars) {
      const zip = readFileSync(aar)
      const [licence, noticesHtml] = ['LICENSE', 'notices.html'].map((name) => zipEntry(zip, name))
      if (!licence || !noticesHtml) {
        throw new Error(`the AAR of ${coordinates} carries no ${licence ? 'notices.html' : 'LICENSE'}, which every Meta Spatial SDK AAR has carried `
          + 'and section 1.3 of its agreement asks to pass on. Read what this version carries, then change questNotices to match.')
      }
      copies.push({ coordinates, licence, noticesHtml })
    }
  }
  if (!copies.length) throw new Error('no Meta Spatial SDK module was given, so there is no agreement to read')
  const [first] = copies
  const others = copies.filter((copy) => !copy.licence.equals(first.licence) || !copy.noticesHtml.equals(first.noticesHtml))
  if (others.length) {
    throw new Error(`the Meta Spatial SDK's AARs do not all carry the same LICENSE and notices.html (${first.coordinates} against `
      + `${others.map((copy) => copy.coordinates).join(', ')}), so one copy of each cannot stand for them all. Change questNotices to carry each.`)
  }
  const licence = first.licence.toString('utf8').replace(/\r\n/g, '\n').trim()
  if (!licence.startsWith('Meta Platform Technologies SDK License Agreement')) {
    throw new Error(`the LICENSE in the AAR of ${first.coordinates} is not the Meta Platform Technologies SDK License Agreement. `
      + 'Read what it is before the notices name it.')
  }
  return { licence, noticesHtml: first.noticesHtml }
}

/** The Quest app's version, as its build sets it (versionName in meta/app/build.gradle.kts), which titles its notices. */
export function questVersion(gradle = readFileSync(join(ROOT, 'meta', 'app', 'build.gradle.kts'), 'utf8')) {
  const version = gradle.match(/^\s*versionName\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (!version) throw new Error('meta/app/build.gradle.kts sets no versionName, which the Quest notices are titled with')
  return version
}

/**
 * Builds the Quest app's notices (meta/): every library its release build pins, sorted by name, with the licence
 * QUEST_LICENCES gives it, the Meta Spatial SDK's with its notice and agreement. A BOM is left out, as addAndroid
 * leaves it out. Returns the notices, and the SDK's notices.html, which goes beside them (writeQuestNotices).
 * @param {object} [options]
 * @param {string} [options.lockfile] the lockfile's text: meta/app/gradle.lockfile's, unless the tests give another
 * @param {(libraries: Array<{ group: string, artifact: string, version: string }>) => { licence: string, noticesHtml: Buffer }} [options.readMetaSdk]
 *   what reads the SDK's agreement and notices.html: metaSpatialSdkFiles, from the Gradle cache, unless the tests give another
 */
export function questNotices({ lockfile, readMetaSdk = metaSpatialSdkFiles } = {}) {
  if (lockfile === undefined) {
    if (!existsSync(QUEST_LOCKFILE)) {
      throw new Error('meta/app/gradle.lockfile is missing. In meta/, run ./gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks')
    }
    lockfile = readFileSync(QUEST_LOCKFILE, 'utf8')
  }
  const libraries = lockedLibraries(lockfile)
    // A BOM only aligns the versions of other libraries; it puts nothing in the APK.
    .filter((library) => !library.artifact.endsWith('-bom'))
    .map((library) => ({ ...library, name: `${library.group}:${library.artifact}` }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (!libraries.length) throw new Error('meta/app/gradle.lockfile pins no library for releaseRuntimeClasspath')
  const entryOf = (library) => QUEST_LICENCES.find((entry) => entry.match.test(library.name))
  const unknown = libraries.filter((library) => !entryOf(library)).map((library) => `${library.name}:${library.version}`)
  if (unknown.length) {
    throw new Error(`the Quest app's libraries include some of no known licence: ${unknown.join(', ')}. `
      + 'Check the licence of each (its POM, and the LICENSE in its AAR), then add it to QUEST_LICENCES in scripts/native/third-party-notices.mjs.')
  }
  const sdkModules = libraries.filter((library) => entryOf(library).metaSdk)
  const metaSdk = sdkModules.length ? readMetaSdk(sdkModules.map(({ group, artifact, version }) => ({ group, artifact, version }))) : null
  const notices = new Notices(`${QUEST_PRODUCT} (meta/), release APK`)
  const of = (field, { group, artifact, version }) => (typeof field === 'function' ? field({ group, artifact, version }) : field)
  for (const library of libraries) {
    const entry = entryOf(library)
    notices.add({
      group: 'quest',
      name: library.name,
      version: library.version,
      licence: entry.licence,
      source: of(entry.source, library),
      note: of(entry.note, library),
    }, questLicenceTexts(entry, metaSdk))
  }
  const json = notices.toJSON()
  const bare = componentsWithoutText(json)
  if (bare.length) {
    throw new Error(`no licence text for: ${bare.join('; ')}. The Apache License 2.0 is read from node_modules/typescript, so run npm ci `
      + 'in the repo root first; an entry under another licence in QUEST_LICENCES needs a text of its own.')
  }
  return { notices: json, metaSdkNotices: metaSdk?.noticesHtml ?? null }
}

/**
 * Writes the Quest app's notices into `outDir`: THIRD-PARTY-NOTICES.txt, the Meta Spatial SDK's notices.html beside it
 * (META_SDK_NOTICES_FILE), and third-party-notices.json, the notices as --merge reads them. Returns the notices.
 */
export function writeQuestNotices(outDir = QUEST_NOTICES_DIR, options = {}) {
  const { notices, metaSdkNotices } = questNotices(options)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.txt'), renderNotices(notices, questVersion(), { product: QUEST_PRODUCT }))
  if (metaSdkNotices) writeFileSync(join(outDir, META_SDK_NOTICES_FILE), metaSdkNotices)
  else rmSync(join(outDir, META_SDK_NOTICES_FILE), { force: true })
  writeFileSync(join(outDir, 'third-party-notices.json'), JSON.stringify(notices))
  return notices
}

const GROUPS = [
  ['vendored', 'Components no package manager lists'],
  ['npm', 'npm packages in the web bundle (from package-lock.json)'],
  ['android', 'Android runtime and libraries (from mobile/package-lock.json and mobile/android/app/gradle.lockfile)'],
  ['rust', 'Rust crates linked into the desktop app (from desktop/src-tauri/Cargo.lock)'],
  ['quest', 'Libraries in the Quest app (from meta/app/gradle.lockfile)'],
]

/** The notices as the text file each bundle and each release carries. `product` is the app its first line names. */
export function renderNotices(notices, version, { product = 'Companion Scan' } = {}) {
  const lines = [
    `${product} ${version} - third-party notices`,
    `For: ${notices.titles.join('; ')}`,
    'Generated from the lockfiles by scripts/native/third-party-notices.mjs.',
    '',
    'Companion Scan itself is licensed under the PolyForm Noncommercial License 1.0.0 (LICENSE).',
    'Required Notice: Copyright LifeScope INC, DBA Companion Intelligence (https://ci.computer)',
    '',
    'The software below is included in the app under its own licence. Each entry gives its version,',
    'its licence and where its source is; the licence texts follow at the end.',
  ]
  for (const [group, heading] of GROUPS) {
    const components = notices.components.filter((c) => c.group === group)
    if (!components.length) continue
    lines.push('', `== ${heading} ==`, '')
    for (const c of components) {
      lines.push(`* ${c.name}${c.version ? ` ${c.version}` : ''}: ${c.licence}`)
      if (c.source) lines.push(`  ${c.source}`)
      if (c.note) lines.push(`  ${c.note}`)
    }
  }
  const users = new Map()
  for (const c of notices.components) {
    for (const id of c.texts ?? []) users.set(id, [...(users.get(id) ?? []), `${c.name}${c.version ? ` ${c.version}` : ''}`])
  }
  lines.push('', '== Licence texts ==')
  for (const [id, names] of users) {
    lines.push('', `---- Applies to: ${names.join(', ')}`, '', notices.texts[id])
  }
  return `${lines.join('\n')}\n`
}

function parseArgs(argv) {
  const args = { merge: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--merge') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.merge.push(argv[++i])
    } else if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[++i]
    }
  }
  return args
}

/** Rust target triples for a build: Tauri's own (universal means both Mac ones), or this host's. */
export function rustTargets(triple = process.env.TAURI_ENV_TARGET_TRIPLE) {
  if (triple === 'universal-apple-darwin') return ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  return [triple || hostTriple()]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  if (args.shell === 'quest') {
    const outDir = resolve(args['out-dir'] ?? QUEST_NOTICES_DIR)
    const notices = writeQuestNotices(outDir)
    console.log(`[notices] ${notices.components.length} components, ${Object.keys(notices.texts).length} licence texts: ${outDir}`)
  } else {
    const version = readJson(join(ROOT, 'desktop', 'package.json')).version
    let notices
    if (args.merge.length) {
      notices = mergeNotices(args.merge.map(readJson))
    } else {
      const report = readJson(args['bundle-report'])
      const targets = args.shell === 'desktop' ? (args.targets ? args.targets.split(',') : rustTargets()) : []
      notices = bundleNotices({ shell: args.shell, bundledModules: report.modules, targets })
    }
    if (args.json) writeFileSync(args.json, JSON.stringify(notices))
    writeFileSync(args.out, renderNotices(notices, version))
    console.log(`[notices] ${notices.components.length} components, ${Object.keys(notices.texts).length} licence texts: ${args.out}`)
  }
}
