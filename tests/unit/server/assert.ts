// `equal` below, and the rules of the assertions after it, are ported from @std/assert 1.0.19
// (https://jsr.io/@std/assert, equal.ts and its siblings), under its MIT licence:
//
//   Copyright 2018-2026 the Deno authors.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
//   associated documentation files (the "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
//   following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or substantial
//   portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
//   EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
//   IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
//   USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// This is test code and ships in no build. The messages and the AssertionError are the repo's own.

/**
 * The assertions the server suite uses, under `node:test` (ADR 0016, wave 18 ticket 0002).
 *
 * The suite was written against `jsr:@std/assert`, and keeps its calls: the names, argument
 * orders and rules here are that module's. `node:assert` is not a drop-in for them:
 *
 * - `deepStrictEqual` tells `0` from `-0`. `assertEquals` does not, and the geometry tests compare
 *   computed vectors, whose zeros carry either sign, against literal ones.
 * - `assertAlmostEquals` has no `node:assert` counterpart. Its default tolerance is relative:
 *   1e-7 of the expected value.
 * - `assertRejects` and `assertThrows` return the error, and match `msgIncludes` as a substring.
 *
 * Failures throw `node:assert`'s `AssertionError`, so `node --test` prints them as its own.
 */
import { AssertionError } from 'node:assert'
import { inspect } from 'node:util'

function format(value: unknown): string {
  return inspect(value, { depth: Infinity, sorted: true, breakLength: 120, colors: false })
}

function fail(message: string, extra: { actual?: unknown; expected?: unknown; operator?: string } = {}): never {
  throw new AssertionError({ message, ...extra })
}

// ── equal: @std/assert 1.0.19's rules ────────────────────────────────────────────────────────────

type KeyedCollection = Set<unknown> | Map<unknown, unknown>

function isKeyedCollection(x: unknown): x is KeyedCollection {
  return x instanceof Set || x instanceof Map
}

function prototypesEqual(a: object, b: object): boolean {
  const pa = Object.getPrototypeOf(a)
  const pb = Object.getPrototypeOf(b)
  return pa === pb || (pa === Object.prototype && pb === null) || (pa === null && pb === Object.prototype)
}

function isBasicObjectOrArray(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj)
  return proto === null || proto === Object.prototype || proto === Array.prototype
}

function ownKeys(obj: object): (string | symbol)[] {
  return [...Object.getOwnPropertyNames(obj), ...Object.getOwnPropertySymbols(obj)]
}

function getKeysDeep(obj: object): Set<string | symbol> {
  const keys = new Set<string | symbol>()
  while (obj !== Object.prototype && obj !== Array.prototype && obj != null) {
    for (const key of ownKeys(obj)) keys.add(key)
    obj = Object.getPrototypeOf(obj)
  }
  return keys
}

// Types compared by their string form. Temporal may be absent, so only what exists is listed.
const temporal = (globalThis as unknown as { Temporal?: Record<string, { prototype: unknown } | undefined> }).Temporal ?? {}
const stringComparablePrototypes = new Set<unknown>(
  [
    Intl.Locale,
    RegExp,
    temporal.Duration,
    temporal.Instant,
    temporal.PlainDate,
    temporal.PlainDateTime,
    temporal.PlainTime,
    temporal.PlainYearMonth,
    temporal.PlainMonthDay,
    temporal.ZonedDateTime,
    URL,
    URLSearchParams,
  ].filter((x) => x != null).map((x) => (x as { prototype: unknown }).prototype),
)

function isPrimitive(x: unknown): boolean {
  return typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint' ||
    typeof x === 'symbol' || x == null
}

type TypedArray = Pick<Uint8Array | BigUint64Array, 'length' | number>
const TypedArray = Object.getPrototypeOf(Uint8Array)

function compareTypedArrays(a: TypedArray, b: TypedArray): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < b.length; i++) {
    if (!sameValueZero(a[i], b[i])) return false
  }
  return true
}

function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || Object.is(a, b)
}

/** Deep equality with @std/assert 1.0.19's rules: `0` equals `-0`, `NaN` equals `NaN`, prototypes must match. */
export function equal(a: unknown, b: unknown): boolean {
  const seen = new Map<unknown, unknown>()
  return (function compare(a: unknown, b: unknown): boolean {
    if (sameValueZero(a, b)) return true
    if (isPrimitive(a) || isPrimitive(b)) return false
    if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime())
    if (a && typeof a === 'object' && b && typeof b === 'object') {
      if (!prototypesEqual(a, b)) return false
      if (a instanceof TypedArray) return compareTypedArrays(a as TypedArray, b as TypedArray)
      if (a instanceof ArrayBuffer || (globalThis.SharedArrayBuffer && a instanceof SharedArrayBuffer)) {
        return compareTypedArrays(new Uint8Array(a), new Uint8Array(b as ArrayBuffer | SharedArrayBuffer))
      }
      if (a instanceof WeakMap) throw new TypeError('Cannot compare WeakMap instances')
      if (a instanceof WeakSet) throw new TypeError('Cannot compare WeakSet instances')
      if (a instanceof WeakRef) return compare(a.deref(), (b as WeakRef<WeakKey>).deref())
      if (seen.get(a) === b) return true
      if (Object.keys(a).length !== Object.keys(b).length) return false
      seen.set(a, b)
      if (isKeyedCollection(a) && isKeyedCollection(b)) {
        if (a.size !== b.size) return false
        const aKeys = [...a.keys()]
        if (aKeys.every(isPrimitive)) {
          if (a instanceof Set) return a.symmetricDifference(b as Set<unknown>).size === 0
          for (const key of aKeys) {
            if (!b.has(key) || !compare(a.get(key), (b as Map<unknown, unknown>).get(key))) return false
          }
          return true
        }
        let unmatchedEntries = a.size
        for (const [aKey, aValue] of a.entries()) {
          for (const [bKey, bValue] of b.entries()) {
            // Map keys can be references, so a key is matched by deep equality, as its value is.
            if (!compare(aKey, bKey)) continue
            if ((aKey === aValue && bKey === bValue) || compare(aValue, bValue)) {
              unmatchedEntries--
              break
            }
          }
        }
        return unmatchedEntries === 0
      }
      let keys: Iterable<string | symbol>
      if (isBasicObjectOrArray(a)) {
        keys = ownKeys({ ...a, ...b })
      } else if (stringComparablePrototypes.has(Object.getPrototypeOf(a))) {
        return String(a) === String(b)
      } else {
        keys = getKeysDeep(a).union(getKeysDeep(b))
      }
      for (const key of keys) {
        type Key = keyof typeof a
        if (!compare(a[key as Key], b[key as Key])) return false
        if ((key in a && !(key in b)) || (key in b && !(key in a))) return false
      }
      return true
    }
    return false
  })(a, b)
}

// ── The assertions ───────────────────────────────────────────────────────────────────────────────

const suffix = (msg?: string) => (msg ? `: ${msg}` : '.')

export function assert(expr: unknown, msg = ''): asserts expr {
  if (!expr) fail(msg || 'Expected a truthy value.', { actual: expr, expected: true, operator: '==' })
}

export type Falsy = false | 0 | 0n | '' | null | undefined

export function assertFalse(expr: unknown, msg = ''): asserts expr is Falsy {
  if (expr) fail(msg || 'Expected a falsy value.', { actual: expr, expected: false, operator: '==' })
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (equal(actual, expected)) return
  fail(`Values are not equal${suffix(msg)}\n  actual: ${format(actual)}\nexpected: ${format(expected)}`, {
    actual,
    expected,
    operator: 'assertEquals',
  })
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  if (!equal(actual, expected)) return
  fail(`Expected actual: ${format(actual)} not to be: ${format(expected)}${suffix(msg)}`)
}

export function assertAlmostEquals(actual: number, expected: number, tolerance?: number, msg?: string): void {
  if (Object.is(actual, expected)) return
  const delta = Math.abs(expected - actual)
  const limit = tolerance ?? (isFinite(expected) ? Math.abs(expected * 1e-7) : 1e-7)
  if (delta <= limit) return
  const f = (n: number) => (Number.isInteger(n) ? n : n.toExponential())
  fail(
    `Expected actual: "${f(actual)}" to be close to "${f(expected)}": delta "${f(delta)}" is greater than "${f(limit)}"${
      suffix(msg)
    }`,
  )
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (actual.includes(expected)) return
  fail(`Expected actual: "${actual}" to contain: "${expected}"${suffix(msg)}`)
}

export function assertMatch(actual: string, expected: RegExp, msg?: string): void {
  if (expected.test(actual)) return
  fail(`Expected actual: "${actual}" to match: "${expected}"${suffix(msg)}`)
}

export function assertGreater<T>(actual: T, expected: T, msg?: string): void {
  if (actual > expected) return
  fail(msg ?? `Expect ${format(actual)} > ${format(expected)}`)
}

// What @std/internal's stripAnsiCode removes, so an error message is matched without its colours.
const ANSI = new RegExp(
  ['[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'].join('|'),
  'g',
)
const stripAnsi = (text: string) => text.replace(ANSI, '')

type ErrorClass<E extends Error> = abstract new (...args: any[]) => E

function assertIsError<E extends Error>(
  error: unknown,
  errorClass?: ErrorClass<E>,
  msgIncludes?: string,
  msg?: string,
): asserts error is E {
  if (!(error instanceof Error)) fail(`Expected "error" to be an Error object${suffix(msg)}`)
  if (errorClass && !(error instanceof errorClass)) {
    fail(`Expected error to be instance of "${errorClass.name}", but was "${error?.constructor?.name}"${suffix(msg)}`)
  }
  if (msgIncludes && !stripAnsi(error.message).includes(stripAnsi(msgIncludes))) {
    fail(`Expected error message to include ${JSON.stringify(msgIncludes)}, but got ${JSON.stringify(error.message)}${suffix(msg)}`)
  }
}

function isErrorClass(value: unknown): value is ErrorClass<Error> {
  const proto = (value as { prototype?: unknown } | undefined)?.prototype
  return proto instanceof Error || proto === Error.prototype
}

export function assertThrows(fn: () => unknown, msg?: string): unknown
export function assertThrows<E extends Error = Error>(fn: () => unknown, errorClass: ErrorClass<E>, msgIncludes?: string, msg?: string): E
export function assertThrows<E extends Error = Error>(
  fn: () => unknown,
  errorClassOrMsg?: ErrorClass<E> | string,
  msgIncludesOrMsg?: string,
  msg?: string,
): unknown {
  let errorClass: ErrorClass<E> | undefined
  let msgIncludes: string | undefined
  if (typeof errorClassOrMsg !== 'string') {
    if (errorClassOrMsg === undefined || isErrorClass(errorClassOrMsg)) {
      errorClass = errorClassOrMsg
      msgIncludes = msgIncludesOrMsg
    } else {
      msg = msgIncludesOrMsg
    }
  } else {
    msg = errorClassOrMsg
  }
  try {
    fn()
  } catch (error) {
    if (errorClass) {
      if (!(error instanceof Error)) fail(`A non-Error object was thrown${suffix(msg)}`)
      assertIsError(error, errorClass, msgIncludes, msg)
    }
    return error
  }
  fail(`Expected function to throw${suffix(msg)}`)
}

export function assertRejects(fn: () => PromiseLike<unknown>, msg?: string): Promise<unknown>
export function assertRejects<E extends Error = Error>(
  fn: () => PromiseLike<unknown>,
  errorClass: ErrorClass<E>,
  msgIncludes?: string,
  msg?: string,
): Promise<E>
export async function assertRejects<E extends Error = Error>(
  fn: () => PromiseLike<unknown>,
  errorClassOrMsg?: ErrorClass<E> | string,
  msgIncludesOrMsg?: string,
  msg?: string,
): Promise<unknown> {
  let errorClass: ErrorClass<E> | undefined
  let msgIncludes: string | undefined
  if (typeof errorClassOrMsg !== 'string') {
    if (errorClassOrMsg === undefined || isErrorClass(errorClassOrMsg)) {
      errorClass = errorClassOrMsg
      msgIncludes = msgIncludesOrMsg
    }
  } else {
    msg = errorClassOrMsg
  }
  let promiseReturned = false
  try {
    const possiblePromise = fn()
    if (possiblePromise && typeof possiblePromise === 'object' && typeof possiblePromise.then === 'function') {
      promiseReturned = true
      await possiblePromise
    } else {
      throw new Error()
    }
  } catch (error) {
    if (!promiseReturned) fail(`Function throws when expected to reject${suffix(msg)}`)
    if (errorClass) {
      if (!(error instanceof Error)) fail(`A non-Error object was rejected${suffix(msg)}`)
      assertIsError(error, errorClass, msgIncludes, msg)
    }
    return error
  }
  fail(`Expected function to reject${suffix(msg)}`)
}
