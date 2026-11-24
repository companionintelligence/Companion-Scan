/**
 * COLMAP for the photo method of `place-register`: a model of ONE earlier session that is built once and kept (the reference), and
 * a new session registered into it without moving it.
 *
 * `runColmapPoses` solves one session for its own sake and `runColmapJointPoses` (colmap_joint.ts) solves several sessions into one
 * model at once. This is neither: the earlier scan's photographs are solved by themselves, the model and the database that
 * produced it are kept (server/register/sfm_workspace.ts says where, and why there), and each later scan's photographs are added to
 * a COPY of that database and registered with `mapper --input_path <reference> --Mapper.fix_existing_frames 1`. The reference's
 * cameras do not move, which is what makes one fit of the reference to its own recorded poses good for every scan registered to it
 * (star topology: every new session against the reference, never one new session against another, where errors would add).
 *
 * It composes what the two drivers share and does not repeat it: the command lines (`featureExtractorArgs`, `matchesImporterArgs`,
 * `mapperArgs`, `growMapperArgs`), the step runner, the model readers, the one-camera-per-session reader options and the starting
 * camera from a session's own field of view (colmap_sessions.ts), and the pair list (server/register/pair_list.ts). What differs
 * is the work directory, the frozen input model, and that no frame is linked or copied anywhere: COLMAP reads each photograph where its
 * session keeps it (sfm_workspace.ts says why).
 *
 * CPU only. Every command line the builders give is `use_gpu 0`, and {@link deadlineSpawn} also hides every GPU from the child, so a
 * COLMAP built with CUDA cannot touch the card the other services hold.
 *
 * What it does not do: it does not decide whether a result is believable (the fit to the AR poses and the registration's checks do,
 * in place_register_sfm.ts), it does not own the work directory (the caller creates and removes it), and it writes no image anywhere.
 */
import { describeBudget, runWithDeadline, within } from '../run_with_deadline.ts'
import {
  bestOf,
  type ColmapPosesRunOptions,
  createStepRunner,
  featureExtractorArgs,
  growMapperArgs,
  listModels,
  mapperArgs,
  matchesImporterArgs,
  type resolveParams,
} from './colmap_poses.ts'
import { type ColmapImage, parseImagesBin } from './colmap_model.ts'
import { countSessionModels, type JointFrame, jointReaderArgs, type SessionCameraPrior } from './colmap_sessions.ts'
import { formatMatchList, type ImagePair, type PairImage, planMatching } from '../register/pair_list.ts'
import { frameKey } from '../register/session_priors.ts'
import * as fs from 'node:fs/promises'
import { readBytes } from '../fs_util.ts'

/** How a COLMAP command is run: the seam the tests replace. The same shape `ColmapPosesRunOptions._spawn` has. */
export type ColmapSpawn = NonNullable<ColmapPosesRunOptions['_spawn']>

/** What a step needs: the binary, the feature and matcher settings, how to run a command, and where its output goes. */
export interface ColmapContext {
  bin: string
  /**
   * The folder every image name is relative to: the sessions folder, by its real path (COLMAP stores an image under the path its file
   * resolves to, so a folder that is itself reached through a link would give names that match nothing). Each frame is read where its
   * session keeps it, as `<sessionId>/kf-NNNNN.jpg`; nothing is linked or copied.
   */
  imageRoot: string
  params: Pick<ReturnType<typeof resolveParams>, 'featureType' | 'matcherType' | 'maxImageSize'>
  spawn: ColmapSpawn
  /** Each step's output is appended here. It can name paths, so it is for the caller to scrub, never to log. */
  logs: string[]
}

/** One session as COLMAP is given it: its directory, its frames (all one size) and its camera's starting point. */
export interface SfmSessionInput {
  sessionId: string
  sessionDir: string
  frames: JointFrame[]
  prior: SessionCameraPrior
}

/** A COLMAP step that did not succeed. `message` is COLMAP's own last words: it can hold paths, and the caller scrubs it. */
export interface ColmapFailure {
  ok: false
  reason: 'colmap-failed' | 'timed-out'
  message: string
}

function failureOf(message: string): ColmapFailure {
  return { ok: false, reason: /timed out/.test(message) ? 'timed-out' : 'colmap-failed', message }
}

// ─── The wall clock ──────────────────────────────────────────────────────────

/** The limit on a whole run: when it started, how long it may take, and what time it is. Injectable so a test needs no real waiting. */
export interface WallClock {
  now(): number
  deadlineAt: number
  budgetMs: number
}

export function startWallClock(budgetMs: number, now: () => number = Date.now): WallClock {
  return { now, deadlineAt: now() + budgetMs, budgetMs }
}

/**
 * A spawn that answers to the run's wall clock: no step may start after the limit, and none may run past it. A step also has its
 * own budget (`stepBudgetMs`, COLMAP's `COLMAP_TIMEOUT_MS`), and the smaller of the two applies. A real run kills the child
 * (`runWithDeadline`, SIGKILL); a replaced `base` is waited for no longer than the limit, which is how a test makes a COLMAP that
 * hangs. Either way the answer is the shape `createStepRunner` turns into "timed out", and the caller removes its work directory.
 *
 * The real child runs with no GPU visible (`CUDA_VISIBLE_DEVICES` empty): the GPU is held by other services, and a CUDA build of
 * COLMAP would otherwise be free to use it for steps no option here asks it to.
 */
export function deadlineSpawn(clock: WallClock, stepBudgetMs: number, base?: ColmapSpawn): ColmapSpawn {
  return async (bin, args) => {
    const remaining = clock.deadlineAt - clock.now()
    const limit = Math.min(remaining, stepBudgetMs)
    const timedOut = (ms: number) => ({ code: 1, stderr: '', timeoutReason: `timed out after ${describeBudget(Math.max(1, ms))}` })
    if (!(limit > 0)) return timedOut(clock.budgetMs)
    if (base) {
      const answered = await within(base(bin, args), limit, null)
      return answered ?? timedOut(limit)
    }
    const out = await runWithDeadline(bin, { args, stdout: 'piped', stderr: 'piped', env: { CUDA_VISIBLE_DEVICES: '' } }, limit)
    return { code: out.code, stderr: new TextDecoder().decode(out.stderr).slice(-4000), timeoutReason: out.timeoutReason }
  }
}

// ─── Laying a session out ────────────────────────────────────────────────────

/**
 * Writes the list `feature_extractor --image_list_path` reads, one name `<sessionId>/kf-NNNNN.jpg` per frame, which is the key the
 * pair list, the poses and the fit all use and the name COLMAP stores an image under when the image root is the sessions folder.
 * Returns the list's path. Only the frames offered are in it, so a session's other frames are never read.
 */
async function writeImageList(workDir: string, session: SfmSessionInput): Promise<string> {
  await fs.mkdir(`${workDir}/lists`, { recursive: true })
  const listPath = `${workDir}/lists/${session.sessionId}.txt`
  await fs.writeFile(listPath, session.frames.map((frame) => frameKey(session.sessionId, frame.file)).join('\n') + '\n')
  return listPath
}

async function readModelImages(modelDir: string): Promise<ColmapImage[]> {
  try {
    return parseImagesBin(await readBytes(`${modelDir}/images.bin`))
  } catch {
    return []
  }
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ─── The reference ───────────────────────────────────────────────────────────

/** The reference session was solved into a model. `dbPath` and `modelDir` are in the work directory: the caller publishes them or they go with it. */
export interface ReferenceBuilt {
  ok: true
  dbPath: string
  modelDir: string
  images: ColmapImage[]
  offered: number
  registered: number
  /** Models the first mapper pass built. More than one means the session's photographs did not all join. */
  models: number
  pairCount: number
}

/** The reference session's photographs did not join into one usable model. `message` is a sentence, with no path in it. */
export interface ReferenceWeak {
  ok: false
  reason: 'reference-weak'
  message: string
  offered: number
  registered: number
  models: number
}

export interface BuildReferenceOptions {
  ctx: ColmapContext
  /** An empty directory of this run's, which is not a session directory and not inside one. */
  workDir: string
  session: SfmSessionInput
  /** The session's frames as pair-list images, with Place-frame poses where it has them. Only its own sequence and revisit pairs are used. */
  pairImages: readonly PairImage[]
  /** Fewest photographs, and the least share of them, the model must place for the reference to be of use. */
  minRegisteredImages: number
  minRegisteredRatio: number
}

/**
 * Solves ONE session by itself and leaves its database and model in `workDir`: features with the session's own camera and its
 * prior, matches over the pair list (each photograph with the next ones in capture order and with revisits), the mapper, and the
 * mapper again seeded from the largest model, as `runColmapJointPoses` does for the reasons colmap_poses.ts gives. It is
 * `reference-weak` when COLMAP placed too few of the photographs: a model made of a third of a walk is not a reference for the rest.
 */
export async function buildReferenceModel(options: BuildReferenceOptions): Promise<ReferenceBuilt | ReferenceWeak | ColmapFailure> {
  const { ctx, workDir, session } = options
  const offered = session.frames.length
  await fs.mkdir(workDir, { recursive: true })
  const weak = (message: string, registered = 0, models = 0): ReferenceWeak => ({
    ok: false, reason: 'reference-weak', message, offered, registered, models,
  })
  if (offered < 2) return weak('The reference has fewer than two photographs.')

  const plan = planMatching(options.pairImages, { referenceSessionId: session.sessionId })
  if (plan.kind === 'refused') return weak(plan.message)
  // One session has no other session to be isolated from, so its plan is always pairs.
  const pairs = plan.kind === 'pairs' ? plan.pairs : []
  if (pairs.length === 0) return weak('No two of the reference photographs could be matched.')

  const listPath = await writeImageList(workDir, session)
  const imagesDir = ctx.imageRoot
  const db = `${workDir}/db.db`
  const step = createStepRunner(ctx.spawn, ctx.bin, ctx.logs)

  let err = await step(
    'feature_extractor(reference)',
    featureExtractorArgs(ctx.params, db, imagesDir, jointReaderArgs(listPath, session.prior)),
  )
  if (err) return failureOf(err)

  const pairsPath = `${workDir}/pairs.txt`
  await fs.writeFile(pairsPath, formatMatchList(pairs))
  err = await step('matches_importer(reference)', matchesImporterArgs(ctx.params, db, pairsPath))
  if (err) return failureOf(err)

  const sparse = `${workDir}/sparse`
  const grown = `${workDir}/sparse_grown`
  await fs.mkdir(sparse, { recursive: true })
  err = await step('mapper(reference)', mapperArgs(db, imagesDir, sparse))
  if (err) return failureOf(err)

  const firstPass = (await listModels(sparse)).sort((a, b) => byName(a.dir, b.dir))
  const largest = firstPass.reduce<(typeof firstPass)[number] | null>((best, model) => (!best || model.count > best.count ? model : best), null)
  if (!largest) return weak('COLMAP placed none of the reference photographs.', 0, 0)

  await fs.mkdir(grown, { recursive: true })
  const growErr = await step('mapper(reference, grow)', growMapperArgs(db, imagesDir, largest.dir, grown))
  const modelDir = growErr ? largest.dir : await bestOf(grown, largest.dir)

  const images = await readModelImages(modelDir)
  const names = session.frames.map((frame) => frameKey(session.sessionId, frame.file))
  const counts = countSessionModels(new Map([[session.sessionId, names]]), new Set(images.map((image) => image.name)), firstPass.map((model) => model.names))
  const registered = counts.get(session.sessionId)?.registered ?? 0
  if (registered < options.minRegisteredImages || registered < options.minRegisteredRatio * offered) {
    return weak(`COLMAP placed ${registered} of ${offered} reference photographs in one model.`, registered, firstPass.length)
  }
  return { ok: true, dbPath: db, modelDir, images, offered, registered, models: firstPass.length, pairCount: pairs.length }
}

// ─── A new session against the frozen reference ──────────────────────────────

/** A new session was registered. `images` is the whole output model: the reference's images (unmoved) and the new session's that were placed. */
export interface SessionRegistered {
  ok: true
  images: ColmapImage[]
  modelDir: string
  offered: number
  /** New-session photographs in the output model. */
  registered: number
  /** New-session photographs COLMAP placed in a model of its own and not in the one that holds the reference. */
  inOtherModels: number
  models: number
  pairCount: number
}

export interface RegisterToReferenceOptions {
  ctx: ColmapContext
  workDir: string
  /** The reference cache's database and model, which are only read: the database is copied, the model is the mapper's `--input_path`. */
  reference: { dbPath: string; modelDir: string; session: SfmSessionInput }
  session: SfmSessionInput
  /** Pairs to match, each with at least one photograph of the new session: the reference's own pairs were matched when it was built. */
  pairs: readonly ImagePair[]
}

/**
 * Registers one new session against the frozen reference: the reference database is copied into the work directory, the new
 * session's features are extracted into the copy with its own camera, the pairs are matched, and `mapper` is run with the
 * reference model as its input and its frames held fixed. The result is read back from the one model the mapper writes. A session
 * whose photographs register none is `ok` with `registered: 0`: that is an answer ("too few registered"), not a failure of COLMAP.
 */
export async function registerToReference(options: RegisterToReferenceOptions): Promise<SessionRegistered | ColmapFailure> {
  const { ctx, workDir, reference, session } = options
  const offered = session.frames.length
  const step = createStepRunner(ctx.spawn, ctx.bin, ctx.logs)

  const db = `${workDir}/db.db`
  await fs.mkdir(workDir, { recursive: true })
  await fs.copyFile(reference.dbPath, db)
  // The reference's frames are not extracted again, because their features are in the copied database already: only the new session
  // has a list. The mapper finds the pictures it colours the points from where their sessions keep them.
  const listPath = await writeImageList(workDir, session)
  const imagesDir = ctx.imageRoot

  let err = await step(
    'feature_extractor',
    featureExtractorArgs(ctx.params, db, imagesDir, jointReaderArgs(listPath, session.prior)),
  )
  if (err) return failureOf(err)

  const pairsPath = `${workDir}/pairs.txt`
  await fs.writeFile(pairsPath, formatMatchList(options.pairs))
  err = await step('matches_importer', matchesImporterArgs(ctx.params, db, pairsPath))
  if (err) return failureOf(err)

  const out = `${workDir}/registered`
  await fs.mkdir(out, { recursive: true })
  err = await step(
    'mapper(register)',
    [...growMapperArgs(db, imagesDir, reference.modelDir, out), '--Mapper.fix_existing_frames', '1'],
  )
  if (err) return failureOf(err)

  const models = (await listModels(out)).sort((a, b) => byName(a.dir, b.dir))
  // The model that holds the reference's photographs is the one the new session is registered in: not the largest, because a
  // session COLMAP could not tie in can be written as a model of its own that is bigger than the reference's, and reading that one as
  // the registration would put "the reference's cameras moved" on a session that was never added to it. The cameras the reference
  // model had are the key: the most of them wins, and a tie goes to the larger model.
  const referenceNames = new Set((await readModelImages(reference.modelDir)).map((image) => image.name))
  const held = (model: { names: ReadonlySet<string> }): number => {
    let n = 0
    for (const name of model.names) if (referenceNames.has(name)) n++
    return n
  }
  const holder = models.reduce<(typeof models)[number] | null>((best, model) => {
    if (!best) return model
    const [mine, theirs] = [held(model), held(best)]
    return mine > theirs || (mine === theirs && model.count > best.count) ? model : best
  }, null)
  if (!holder || held(holder) === 0) {
    // No model holds any of the reference's photographs: nothing of the new session is in the reference's model, wherever COLMAP
    // wrote it. Its photographs in other models are counted as such.
    const names = session.frames.map((frame) => frameKey(session.sessionId, frame.file))
    const counts = countSessionModels(new Map([[session.sessionId, names]]), new Set(), models.map((model) => model.names))
    return {
      ok: true,
      images: [],
      modelDir: out,
      offered,
      registered: 0,
      inOtherModels: counts.get(session.sessionId)?.inOtherModels ?? 0,
      models: models.length,
      pairCount: options.pairs.length,
    }
  }
  const images = await readModelImages(holder.dir)
  const names = session.frames.map((frame) => frameKey(session.sessionId, frame.file))
  const counts = countSessionModels(new Map([[session.sessionId, names]]), new Set(images.map((image) => image.name)), models.map((model) => model.names))
  const mine = counts.get(session.sessionId)
  return {
    ok: true,
    images,
    modelDir: holder.dir,
    offered,
    registered: mine?.registered ?? 0,
    inOtherModels: mine?.inOtherModels ?? 0,
    models: models.length,
    pairCount: options.pairs.length,
  }
}
