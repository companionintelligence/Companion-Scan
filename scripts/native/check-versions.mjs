#!/usr/bin/env node
/**
 * The desktop, Android and iOS apps share one version, written in seven places:
 * `node scripts/native/check-versions.mjs [--tag v0.2.0]`.
 *
 *   desktop/package.json, desktop/src-tauri/tauri.conf.json, desktop/src-tauri/Cargo.toml and
 *   its Cargo.lock entry, mobile/package.json, mobile/android/app/build.gradle (versionName), and
 *   the iOS target's MARKETING_VERSION in mobile/ios/App/App.xcodeproj/project.pbxproj.
 *
 * They must agree, the Android versionCode must be a positive whole number, the iOS build number
 * (CURRENT_PROJECT_VERSION) must be the same number, so one bump raises both, and with --tag the
 * release tag must be `v` and that version. The release workflow runs this before it builds
 * anything. Exits 1 and says what differs.
 *
 * The iOS app was left out until 2026-11-25 and sat at 1.0 (1) while the others moved on.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const read = (path) => readFileSync(join(ROOT, path), 'utf8')

/** Every place the apps' version is written, with what it says there. */
export function appVersions() {
  const cargoToml = read('desktop/src-tauri/Cargo.toml')
  const cargoLock = read('desktop/src-tauri/Cargo.lock')
  const gradle = read('mobile/android/app/build.gradle')
  return {
    'desktop/package.json': JSON.parse(read('desktop/package.json')).version,
    'desktop/src-tauri/tauri.conf.json': JSON.parse(read('desktop/src-tauri/tauri.conf.json')).version,
    'desktop/src-tauri/Cargo.toml': cargoToml.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m)?.[1],
    'desktop/src-tauri/Cargo.lock': cargoLock.match(/name = "companion-scan-desktop"\r?\nversion = "([^"]+)"/)?.[1],
    'mobile/package.json': JSON.parse(read('mobile/package.json')).version,
    'mobile/android/app/build.gradle (versionName)': gradle.match(/^\s*versionName "([^"]+)"/m)?.[1],
    'mobile/ios/App/App.xcodeproj/project.pbxproj (MARKETING_VERSION)': iosSetting('MARKETING_VERSION'),
  }
}

/**
 * One build setting of the iOS target, which the project writes once per configuration (Debug and Release).
 * When the configurations disagree, every value is returned joined by " / ", so the check names them.
 */
function iosSetting(name) {
  const project = read('mobile/ios/App/App.xcodeproj/project.pbxproj')
  const values = [...new Set([...project.matchAll(new RegExp(`^\\s*${name} = ([^;]+);`, 'gm'))].map((match) => match[1].trim()))]
  return values.length === 0 ? undefined : values.join(' / ')
}

/** The iOS build number (CURRENT_PROJECT_VERSION), which rises with the Android versionCode. */
export function iosBuildNumber() {
  return Number(iosSetting('CURRENT_PROJECT_VERSION'))
}

/** The Android versionCode, which must rise with every release. */
export function androidVersionCode() {
  return Number(read('mobile/android/app/build.gradle').match(/^\s*versionCode (\d+)/m)?.[1])
}

/** What is wrong with the versions, for `tag` when one is given. Empty when nothing is. */
export function versionProblems(tag) {
  const versions = appVersions()
  const problems = []
  const values = new Set(Object.values(versions))
  if (values.size !== 1) {
    problems.push(`the versions differ: ${Object.entries(versions).map(([file, v]) => `${file} ${v ?? '(none)'}`).join(', ')}`)
  }
  const [version] = values
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) problems.push(`"${version}" is not a plain x.y.z version, which the MSI installer needs`)
  const code = androidVersionCode()
  if (!Number.isInteger(code) || code < 1) problems.push(`the Android versionCode "${code}" is not a positive whole number`)
  const build = iosBuildNumber()
  if (build !== code) problems.push(`the iOS build number (CURRENT_PROJECT_VERSION) "${iosSetting('CURRENT_PROJECT_VERSION') ?? '(none)'}" is not the Android versionCode ${code}: raise both together`)
  if (tag !== undefined) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) problems.push(`the tag "${tag}" is not v and a plain x.y.z version`)
    else if (tag.slice(1) !== version) problems.push(`the tag ${tag} does not match the apps' version ${version}`)
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--tag')
  const tag = at > 0 ? process.argv[at + 1] : undefined
  const problems = versionProblems(tag)
  if (problems.length) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  console.log(`Apps at ${Object.values(appVersions())[0]}, Android versionCode and iOS build ${androidVersionCode()}${tag ? `, tag ${tag}` : ''}: all in step`)
}
