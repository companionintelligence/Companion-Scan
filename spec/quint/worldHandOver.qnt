// -*- mode: Bluespec; -*-
/**
 * World files, their hand-over and the frame generations of a Place, as the server implements them (ADR 0004,
 * ADR 0011). Three models, each checked and replayed on its own:
 *
 *  - handOverModel: the hand-over of scans from the world of House A to the world of House B
 *    (server/world/world_hand_over.ts over server/world/scan_carry.ts), with its injected clock: the reads a route
 *    makes while the other world is busy (HAND_OVER_ATTEMPTS, sleeping HAND_OVER_WAIT_MS longer each time), the
 *    timer that finishes the job later (HAND_OVER_RETRIES, doubling from HAND_OVER_RETRY_FIRST_MS), and a restart,
 *    which forgets both. Replayed by tests/unit/server/world_hand_over_trace.test.ts.
 *  - worldLockModel: the per-slug lock (server/world/world_lock.ts) and the world file writes it guards
 *    (writeWorldUnlocked in server/main.ts: a temp file, then a rename). Each save is one more generation of the
 *    file. Replayed by tests/unit/server/world_lock_trace.test.ts.
 *  - frameModel: the frame a Place holds and its replacement by a new generation (applySpatialFrameWrite,
 *    server/wp-a-projects.ts, with decideReplacement from server/place_frames.ts). Replayed by
 *    tests/unit/server/frame_generations_trace.test.ts.
 *
 * Each action is one stretch of the code between two awaits. The planted bugs are kept as module instances at the
 * end of the file; the gate (spec/quint/check-world.mjs) requires each to fail.
 */

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// The hand-over
// ═════════════════════════════════════════════════════════════════════════════════════════════════

module handOverModel {
  /**
   * The planted bug: the scans' records are taken out of the world they leave whether or not the other world took
   * them. The code takes them out only after `editIfFree` answered true (handEvictedScansOver).
   */
  const DROP_BEFORE_ADOPT: bool

  // ── Constants, from server/world/world_hand_over.ts ──────────────────────────────────────────────

  pure val HAND_OVER_ATTEMPTS = 5
  pure val HAND_OVER_WAIT_MS = 40
  pure val HAND_OVER_RETRY_FIRST_MS = 1000
  pure val HAND_OVER_RETRIES = 6

  /** Two scans, both in House A's world at the start, each with a note and a hand-set placement. */
  pure val SCANS = Set(1, 2)
  /** Route r files scan r under House B (PATCH /projects/:id/scans/:scanId) and settles the hand-over. */
  pure val ROUTES = Set(1, 2)

  /**
   * What a world's file holds of the scans: their rows, their notes (the patches, comments and finished jobs that
   * always travel) and their hand-set placements (placement patches, which travel only with a scan placed by its
   * own record).
   */
  type Files = { rows: Set[int], notes: Set[int], placements: Set[int] }

  /** The stand-ins for the other world and the disk. */
  type Env = {
    /** House B's world has a critical section running or queued: tryWithWorldLock answers ran: false. */
    busyB: bool,
    /** House B's world cannot be read or saved: editIfFree rejects. */
    brokenB: bool,
    /** House A's world cannot be read: readWorld rejects before anything is evicted. */
    unreadableA: bool,
    /** House A's world can be read and not saved: the refresh's write rejects, after the other world was saved. */
    failSaveA: bool,
    /** The Places registry cannot be read: places() rejects, so every evicted scan stays. */
    registryDown: bool,
  }

  /** A route: not started, sleeping between two reads, answered, or cut off by a restart. */
  type RoutePhase = NotStarted | Sleeping | Answered | Abandoned

  type Route = {
    phase: RoutePhase,
    /** The read it made last (0 for the first). */
    attempt: int,
    /** What it asked deps.sleep for. */
    sleepMs: int,
    /** Its answer: handOver.pending and handOver.placementsKept. */
    pending: int,
    placementsKept: int,
  }

  /** retryLater's chain for House A's world: a timer set with deps.later, and which of HAND_OVER_RETRIES it is. */
  type Timer = { armed: bool, attempt: int, ms: int }

  type Reader = ByRoute | ByTimer | ByOther

  /** What the last step did, for the witnesses. */
  type Event =
    | Started
    | Read({ by: Reader, readable: bool, handed: Set[int], stayed: Set[int], again: Set[int] })
    | Restarted
    | EnvChanged

  // ── State ────────────────────────────────────────────────────────────────────────────────────────

  var worldA: Files
  var worldB: Files
  /** The scans whose record (sidecar) files them under House B. */
  var filedUnderB: Set[int]
  /** placedByRecord: the scan's sidecar has a usable projectTransform. Fixed at the start. */
  var byRecord: int -> bool
  /** createWorldHandOver's `waiting` entry for House A's world. */
  var waiting: Set[int]
  /** Its `kept` entry for House A's world: the scans handed over that left a placement there. */
  var kept: Set[int]
  var timer: Timer
  var routes: int -> Route
  var env: Env
  var event: Event

  // ── A read of House A's world ────────────────────────────────────────────────────────────────────

  type After = { a: Files, b: Files, waiting: Set[int], kept: Set[int], readable: bool, handed: Set[int], stayed: Set[int], again: Set[int] }

  /**
   * What deps.readWorld does for House A's world: loadWorld refreshes it (refreshWorldScans evicts the rows whose
   * record files them under another Place) and calls handOver, which tries House B's world once (editIfFree) and
   * puts back what could not be handed over; then the refresh saves House A's world when it changed.
   */
  pure def readWith(a0: Files, b0: Files, filed: Set[int], placed: int -> bool, kept0: Set[int], e: Env, dropFirst: bool): After =
    if (e.unreadableA)
      { a: a0, b: b0, waiting: Set(), kept: kept0, readable: false, handed: Set(), stayed: Set(), again: Set() }
    else
      val evicted = a0.rows.intersect(filed)
      val took = evicted != Set() and not(e.registryDown) and not(e.brokenB) and not(e.busyB)
      val handed = if (took) evicted else Set()
      val stayed = evicted.exclude(handed)
      val dropped = if (dropFirst) evicted else handed
      val travels = handed.filter(s => placed.get(s))
      val b = { rows: b0.rows.union(travels), notes: b0.notes.union(handed), placements: b0.placements.union(travels) }
      val a = {
        rows: a0.rows.exclude(evicted).union(stayed),
        notes: a0.notes.exclude(dropped),
        placements: a0.placements.exclude(dropped.filter(s => placed.get(s))),
      }
      // The refresh writes House A's world only when it changed: with nothing evicted there is nothing to save.
      val saved = evicted == Set() or not(e.failSaveA)
      {
        a: if (saved) a else a0,
        b: b,
        waiting: stayed,
        kept: kept0.union(handed.filter(s => not(placed.get(s)) and a0.placements.contains(s))),
        readable: saved,
        handed: handed,
        stayed: stayed,
        again: handed.intersect(b0.notes),
      }

  /**
   * An unreadable world leaves `waiting` as it was: read() catches the rejection before handOver runs. A failed save
   * of House A's world comes after handOver, which has already replaced House A's entry.
   */
  pure def waitingAfter(before: Set[int], after: After, e: Env): Set[int] = if (e.unreadableA) before else after.waiting

  // ── Init ─────────────────────────────────────────────────────────────────────────────────────────

  pure val IDLE_ROUTE: Route = { phase: NotStarted, attempt: 0, sleepMs: 0, pending: 0, placementsKept: 0 }

  action initWith(placed1: bool, placed2: bool): bool = all {
    byRecord' = Map(1 -> placed1, 2 -> placed2),
    worldA' = { rows: SCANS, notes: SCANS, placements: SCANS },
    worldB' = { rows: Set(), notes: Set(), placements: Set() },
    filedUnderB' = Set(),
    waiting' = Set(),
    kept' = Set(),
    timer' = { armed: false, attempt: 0, ms: 0 },
    routes' = ROUTES.mapBy(_ => IDLE_ROUTE),
    env' = { busyB: false, brokenB: false, unreadableA: false, failSaveA: false, registryDown: false },
    event' = Started,
  }

  action init = {
    nondet placed1 = oneOf(Set(true, false))
    nondet placed2 = oneOf(Set(true, false))
    initWith(placed1, placed2)
  }

  // ── Routes: settle ───────────────────────────────────────────────────────────────────────────────

  /** retryLater: one timer chain per world; a route that finds one running sets none. */
  def armedTimer(stillWaiting: bool): Timer =
    if (stillWaiting and not(timer.armed)) { armed: true, attempt: 0, ms: HAND_OVER_RETRY_FIRST_MS } else timer

  /**
   * One read of settle's loop for route r's scan, with the record as `filed` says, and what follows it with no await
   * between: the answer, when the world could not be read, the scan is no longer waiting or this was the last
   * attempt; otherwise a sleep.
   */
  action settleRead(r: int, attempt: int, filed: Set[int]): bool = all {
    val after = readWith(worldA, worldB, filed, byRecord, kept, env, DROP_BEFORE_ADOPT)
    val waitingNow = waitingAfter(waiting, after, env)
    val waits = after.readable and waitingNow.contains(r)
    val last = attempt + 1 >= HAND_OVER_ATTEMPTS
    // Still waiting when it answers: its scan when the world could not be read, else when it is in `waiting`.
    val pending = if (not(after.readable) or waits) 1 else 0
    all {
      if (waits and not(last)) all {
        routes' = routes.set(r, { ...routes.get(r), phase: Sleeping, attempt: attempt, sleepMs: HAND_OVER_WAIT_MS * (attempt + 1) }),
        timer' = timer,
        kept' = after.kept,
      } else all {
        routes' = routes.set(r, { phase: Answered, attempt: attempt, sleepMs: 0, pending: pending, placementsKept: if (after.kept.contains(r)) 1 else 0 }),
        timer' = armedTimer(pending > 0),
        // The route counts the kept placements of its scans once, and takes them out of `kept`.
        kept' = after.kept.exclude(Set(r)),
      },
      worldA' = after.a,
      worldB' = after.b,
      waiting' = waitingNow,
      filedUnderB' = filed,
      byRecord' = byRecord,
      env' = env,
      event' = Read({ by: ByRoute, readable: after.readable, handed: after.handed, stayed: after.stayed, again: after.again }),
    },
  }

  /** The route files its scan under House B, then settles: its first read is attempt 0. */
  action routeStart(r: int): bool = all {
    routes.get(r).phase == NotStarted,
    val filed = filedUnderB.union(Set(r))
    // A route settles the worlds that held a row of its scan; when none does, it answers with nothing to say.
    if (worldA.rows.contains(r)) settleRead(r, 0, filed)
    else all {
      routes' = routes.set(r, { ...IDLE_ROUTE, phase: Answered }),
      filedUnderB' = filed,
      worldA' = worldA, worldB' = worldB, waiting' = waiting, kept' = kept, timer' = timer,
      byRecord' = byRecord, env' = env, event' = Started,
    },
  }

  /** deps.sleep resolves: the route reads again. */
  action routeWake(r: int): bool = all {
    routes.get(r).phase == Sleeping,
    settleRead(r, routes.get(r).attempt + 1, filedUnderB),
  }

  // ── The timer and the other readers ──────────────────────────────────────────────────────────────

  /**
   * The timer deps.later set fires: it reads the world, and sets the next one, twice as long, while anything waits
   * there and HAND_OVER_RETRIES is not used up; otherwise the chain ends.
   */
  action timerFires = all {
    timer.armed,
    val after = readWith(worldA, worldB, filedUnderB, byRecord, kept, env, DROP_BEFORE_ADOPT)
    val waitingNow = waitingAfter(waiting, after, env)
    val again = waitingNow != Set() and timer.attempt + 1 < HAND_OVER_RETRIES
    all {
      timer' = if (again) { armed: true, attempt: timer.attempt + 1, ms: timer.ms * 2 } else { armed: false, attempt: 0, ms: 0 },
      worldA' = after.a,
      worldB' = after.b,
      waiting' = waitingNow,
      kept' = after.kept,
      routes' = routes,
      filedUnderB' = filedUnderB,
      byRecord' = byRecord,
      env' = env,
      event' = Read({ by: ByTimer, readable: after.readable, handed: after.handed, stayed: after.stayed, again: after.again }),
    },
  }

  /** Anybody else's read of House A's world (GET /worlds/:slug, the editor's poll): it hands over what it can. */
  action otherRead = all {
    val after = readWith(worldA, worldB, filedUnderB, byRecord, kept, env, DROP_BEFORE_ADOPT)
    all {
      worldA' = after.a,
      worldB' = after.b,
      waiting' = waitingAfter(waiting, after, env),
      kept' = after.kept,
      timer' = timer,
      routes' = routes,
      filedUnderB' = filedUnderB,
      byRecord' = byRecord,
      env' = env,
      event' = Read({ by: ByOther, readable: after.readable, handed: after.handed, stayed: after.stayed, again: after.again }),
    },
  }

  /**
   * The server restarts. The files and the records stay; `waiting`, `kept` and the timer do not ("the timer is not
   * kept across a restart"), a route that was sleeping never answers, and House B's lock holder is gone.
   */
  action restart = all {
    worldA' = worldA,
    worldB' = worldB,
    filedUnderB' = filedUnderB,
    byRecord' = byRecord,
    waiting' = Set(),
    kept' = Set(),
    timer' = { armed: false, attempt: 0, ms: 0 },
    routes' = routes.keys().mapBy(r => if (routes.get(r).phase == Sleeping) { ...routes.get(r), phase: Abandoned } else routes.get(r)),
    env' = { ...env, busyB: false },
    event' = Restarted,
  }

  /** The environment changes: House B's world becomes busy or free, or a disk or the registry fails or recovers. */
  action envBecomes(e: Env): bool = all {
    env' = e,
    worldA' = worldA, worldB' = worldB, filedUnderB' = filedUnderB, byRecord' = byRecord,
    waiting' = waiting, kept' = kept, timer' = timer, routes' = routes, event' = EnvChanged,
  }

  action envChanges = {
    nondet busyB = oneOf(Set(true, false))
    nondet brokenB = oneOf(Set(true, false))
    nondet unreadableA = oneOf(Set(true, false))
    nondet failSaveA = oneOf(Set(true, false))
    nondet registryDown = oneOf(Set(true, false))
    envBecomes({ busyB: busyB, brokenB: brokenB, unreadableA: unreadableA, failSaveA: failSaveA, registryDown: registryDown })
  }

  action step = any {
    timerFires,
    otherRead,
    restart,
    envChanges,
    nondet r = oneOf(ROUTES)
    routeStart(r),
    nondet r = oneOf(ROUTES)
    routeWake(r),
  }

  // ── Invariants ───────────────────────────────────────────────────────────────────────────────────

  /** A scan's notes are always in one of the two worlds' files: a hand-over that cannot be done loses nothing. */
  invariant notesAreNeverLost = SCANS.forall(s => worldA.notes.contains(s) or worldB.notes.contains(s))

  /** Nothing a person placed by hand is destroyed: the placement travels or is kept in the world it was made in. */
  invariant placementsAreNeverDestroyed = SCANS.forall(s => worldA.placements.contains(s) or worldB.placements.contains(s))

  /** A scan whose row left House A's world has its notes in House B's. */
  invariant aScanThatLeftHasArrived = SCANS.forall(s => not(worldA.rows.contains(s)) implies worldB.notes.contains(s))

  /** A scan that is waiting is still in House A's world, with its records. */
  invariant waitingScansStayWhereTheyWere = waiting.forall(s => worldA.rows.contains(s) and worldA.notes.contains(s))

  /** A route that answered with nothing pending did hand its scan over: its notes are in House B's world and not in A's. */
  invariant noPendingMeansHandedOver =
    ROUTES.forall(r => (routes.get(r).phase == Answered and routes.get(r).pending == 0)
      implies (worldB.notes.contains(r) and not(worldA.notes.contains(r)) and not(worldA.rows.contains(r))))

  /** A route that answered with a kept placement left that placement where it was. */
  invariant keptPlacementsAreThere =
    ROUTES.forall(r => (routes.get(r).phase == Answered and routes.get(r).placementsKept > 0)
      implies (worldA.placements.contains(r) and not(byRecord.get(r))))

  /** Every sleep is HAND_OVER_WAIT_MS times the attempt that follows it, and only before the last attempt. */
  invariant sleepsAreAsDocumented =
    ROUTES.forall(r => routes.get(r).phase == Sleeping
      implies (routes.get(r).sleepMs == HAND_OVER_WAIT_MS * (routes.get(r).attempt + 1) and routes.get(r).attempt + 1 < HAND_OVER_ATTEMPTS))

  /** The timer chain doubles from HAND_OVER_RETRY_FIRST_MS and stops after HAND_OVER_RETRIES. */
  invariant timerChainIsBounded =
    timer.armed implies (timer.attempt < HAND_OVER_RETRIES and timer.ms == HAND_OVER_RETRY_FIRST_MS * 2 ^ timer.attempt)

  /** The scans handed over with a kept placement are the ones not placed by their record, with their placement in A. */
  invariant keptIsKeptPlacements = kept.forall(s => not(byRecord.get(s)) and worldA.placements.contains(s))

  // ── Witnesses ────────────────────────────────────────────────────────────────────────────────────

  /** A route's first read handed its scan over. */
  observation handedOverAtOnce = ROUTES.exists(r => routes.get(r).phase == Answered and routes.get(r).attempt == 0 and routes.get(r).pending == 0 and worldB.notes.contains(r))
  /** A route slept and read again. */
  observation routeReadAgain = ROUTES.exists(r => routes.get(r).attempt >= 1)
  /** A route answered with its scan still waiting. */
  observation answeredPending = ROUTES.exists(r => routes.get(r).phase == Answered and routes.get(r).pending > 0)
  /** A route answered after all HAND_OVER_ATTEMPTS reads. */
  observation usedEveryAttempt = ROUTES.exists(r => routes.get(r).phase == Answered and routes.get(r).attempt == HAND_OVER_ATTEMPTS - 1)
  /** A route answered with a placement kept in House A's world. */
  observation answeredWithKeptPlacement = ROUTES.exists(r => routes.get(r).phase == Answered and routes.get(r).placementsKept > 0)
  /** The timer finished a hand-over nobody else read the world for. */
  observation timerHandedOver = match event { | Read(x) => x.by == ByTimer and x.handed != Set() | _ => false }
  /** The timer chain reached its last timer. */
  observation timerReachedItsLast = timer.armed and timer.attempt == HAND_OVER_RETRIES - 1
  /** Somebody else's read finished a hand-over that was waiting. */
  observation anotherReadFinishedIt = match event { | Read(x) => x.by == ByOther and x.handed != Set() | _ => false }
  /** A restart left a scan filed under House B in House A's world, with its records. */
  observation restartLeftItInA = event == Restarted and filedUnderB.exists(s => worldA.rows.contains(s) and worldA.notes.contains(s))
  /** A scan was handed over a second time, after House A's save had failed: adoption is idempotent. */
  observation handedOverAgain = match event { | Read(x) => x.again != Set() | _ => false }
  /** A read of an unreadable House A while scans waited. */
  observation readFailedWhileWaiting = match event { | Read(x) => not(x.readable) and waiting != Set() | _ => false }
}

/** The code. */
module handOver {
  import handOverModel(DROP_BEFORE_ADOPT = false).*
}

/** The planted bug: records are dropped from the world they leave before the other world has them. */
module handOverBug {
  import handOverModel(DROP_BEFORE_ADOPT = true).*
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// The per-slug lock and the world file generations
// ═════════════════════════════════════════════════════════════════════════════════════════════════

module worldLockModel {
  /** writeWorldUnlocked writes a temp file and renames it over the world file. False: it writes in place. */
  const ATOMIC_WRITES: bool
  /** editIfFree reads and writes the other world inside tryWithWorldLock. False: it touches it with no lock. */
  const HAND_OVER_TAKES_THE_LOCK: bool
  /** The hand-over only tries the other world's lock. False: it waits for it, holding its own. */
  const HAND_OVER_NEVER_WAITS: bool

  /** Two world files (two slugs). */
  pure val WORLDS = Set(1, 2)
  /** Cycles 1 and 2 are loadWorld, updateWorld or a mutateWorldFiles pass: read, change, save, under the lock. */
  pure val PLAIN = Set(1, 2)
  /**
   * Cycles 3 and 4 are refreshes that hand scans over (refreshWorldScans with handOver): read their own world, try
   * the other one (editIfFree: read it, adopt, save it), then save their own.
   */
  pure val HANDOVERS = Set(3, 4)
  pure val CYCLES = PLAIN.union(HANDOVERS)
  pure def otherWorld(w: int): int = 3 - w

  /**
   * Where a cycle is. Queued: its withWorldLock is chained behind another section on its world. AtRead, AtWriteTmp,
   * AtRename: inside its critical section, at the read, the temp file write and the rename of its own world.
   * QueuedOther and AtReadOther, AtWriteTmpOther, AtRenameOther: the same for the other world, inside its own.
   */
  type Phase = Idle | Queued | AtRead | AtWriteTmp | AtRename | QueuedOther | AtReadOther | AtWriteTmpOther | AtRenameOther

  type Cycle = {
    phase: Phase,
    world: int,
    /** The generation of its own world it read. */
    base: int,
    /** The generation of the other world it read. */
    baseOther: int,
  }

  /** A world file as a reader finds it: its generation (one more for every save), and whether it is half written. */
  type File = { version: int, partial: bool }

  type TryResult = NoTry | Ran | Busy

  var files: int -> File
  /** withWorldLock's chain per slug: the section running first, then the ones queued behind it, in order. */
  var chains: int -> List[int]
  var cycles: int -> Cycle
  /** The last save: which world, the generation its cycle read, the one on disk before, the one after. */
  var lastSave: { world: int, base: int, before: int, after: int }
  /** A read, locked or not, found a half-written file. */
  var sawPartial: bool
  /** What the last tryWithWorldLock answered. */
  var lastTry: TryResult

  pure val IDLE: Cycle = { phase: Idle, world: 0, base: 0, baseOther: 0 }

  action init = all {
    files' = WORLDS.mapBy(_ => { version: 1, partial: false }),
    chains' = WORLDS.mapBy(_ => List()),
    cycles' = CYCLES.mapBy(_ => IDLE),
    lastSave' = { world: 0, base: 0, before: 0, after: 1 },
    sawPartial' = false,
    lastTry' = NoTry,
  }

  // ── The lock ─────────────────────────────────────────────────────────────────────────────────────

  /** _chains.has(slug): a section running or queued. */
  def busy(w: int): bool = chains.get(w).length() > 0

  /**
   * A section ends and its world's chain moves on: the next queued section starts at once, at its read. The chain
   * entry goes when the last one is done.
   */
  def released(w: int, cs: int -> Cycle): { chains: int -> List[int], cycles: int -> Cycle } =
    val rest = chains.get(w).slice(1, chains.get(w).length())
    {
      chains: chains.set(w, rest),
      cycles: if (rest.length() == 0) cs else cs.set(rest[0], { ...cs.get(rest[0]), phase: if (cs.get(rest[0]).phase == QueuedOther) AtReadOther else AtRead }),
    }

  // ── Cycles ───────────────────────────────────────────────────────────────────────────────────────

  /** A cycle calls withWorldLock on world w: it runs now when the chain is empty, and queues otherwise. */
  action start(c: int, w: int): bool = all {
    cycles.get(c).phase == Idle,
    chains' = chains.set(w, chains.get(w).append(c)),
    cycles' = cycles.set(c, { ...IDLE, phase: if (busy(w)) Queued else AtRead, world: w }),
    files' = files, lastSave' = lastSave, sawPartial' = sawPartial, lastTry' = NoTry,
  }

  /**
   * It reads its world's file. A refresh that hands scans over then tries the other world, with no await between:
   * tryWithWorldLock answers ran: false at once when that world's chain is not empty.
   */
  action read(c: int): bool = all {
    cycles.get(c).phase == AtRead,
    val w = cycles.get(c).world
    val o = otherWorld(w)
    val readIt = { ...cycles.get(c), base: files.get(w).version }
    all {
      sawPartial' = (sawPartial or files.get(w).partial),
      files' = files,
      lastSave' = lastSave,
      if (not(HANDOVERS.contains(c))) all {
        cycles' = cycles.set(c, { ...readIt, phase: AtWriteTmp }), chains' = chains, lastTry' = NoTry,
      } else if (not(HAND_OVER_TAKES_THE_LOCK)) all {
        cycles' = cycles.set(c, { ...readIt, phase: AtReadOther }), chains' = chains, lastTry' = Ran,
      } else if (busy(o) and HAND_OVER_NEVER_WAITS) all {
        cycles' = cycles.set(c, { ...readIt, phase: AtWriteTmp }), chains' = chains, lastTry' = Busy,
      } else all {
        cycles' = cycles.set(c, { ...readIt, phase: if (busy(o)) QueuedOther else AtReadOther }),
        chains' = chains.set(o, chains.get(o).append(c)),
        lastTry' = Ran,
      },
    },
  }

  /** Inside the other world's section: it reads that world. */
  action readOther(c: int): bool = all {
    cycles.get(c).phase == AtReadOther,
    val o = otherWorld(cycles.get(c).world)
    all {
      cycles' = cycles.set(c, { ...cycles.get(c), phase: AtWriteTmpOther, baseOther: files.get(o).version }),
      sawPartial' = (sawPartial or files.get(o).partial),
      files' = files, chains' = chains, lastSave' = lastSave, lastTry' = NoTry,
    },
  }

  /** fs.writeFile of the temp file. Written in place, the world file itself is half written until the write ends. */
  def wroteTemp(w: int): int -> File = if (ATOMIC_WRITES) files else files.set(w, { ...files.get(w), partial: true })

  action writeTmpOther(c: int): bool = all {
    cycles.get(c).phase == AtWriteTmpOther,
    files' = wroteTemp(otherWorld(cycles.get(c).world)),
    cycles' = cycles.set(c, { ...cycles.get(c), phase: AtRenameOther }),
    chains' = chains, lastSave' = lastSave, sawPartial' = sawPartial, lastTry' = NoTry,
  }

  /** fs.rename: the other world's new generation. Its section ends, and the refresh goes on in its own. */
  action renameOther(c: int): bool = all {
    cycles.get(c).phase == AtRenameOther,
    val o = otherWorld(cycles.get(c).world)
    val saved = { version: cycles.get(c).baseOther + 1, partial: false }
    val cs = cycles.set(c, { ...cycles.get(c), phase: AtWriteTmp })
    val after = if (HAND_OVER_TAKES_THE_LOCK) released(o, cs) else { chains: chains, cycles: cs }
    all {
      files' = files.set(o, saved),
      lastSave' = { world: o, base: cycles.get(c).baseOther, before: files.get(o).version, after: saved.version },
      chains' = after.chains,
      cycles' = after.cycles,
      sawPartial' = sawPartial, lastTry' = NoTry,
    },
  }

  action writeTmp(c: int): bool = all {
    cycles.get(c).phase == AtWriteTmp,
    files' = wroteTemp(cycles.get(c).world),
    cycles' = cycles.set(c, { ...cycles.get(c), phase: AtRename }),
    chains' = chains, lastSave' = lastSave, sawPartial' = sawPartial, lastTry' = NoTry,
  }

  /** fs.rename: its own world's new generation. Its section ends, and the next queued one starts. */
  action rename(c: int): bool = all {
    cycles.get(c).phase == AtRename,
    val w = cycles.get(c).world
    val saved = { version: cycles.get(c).base + 1, partial: false }
    val after = released(w, cycles.set(c, IDLE))
    all {
      files' = files.set(w, saved),
      lastSave' = { world: w, base: cycles.get(c).base, before: files.get(w).version, after: saved.version },
      chains' = after.chains,
      cycles' = after.cycles,
      sawPartial' = sawPartial, lastTry' = NoTry,
    },
  }

  /** GET /worlds reads every world file with no lock. */
  action list(w: int): bool = all {
    sawPartial' = (sawPartial or files.get(w).partial),
    files' = files, chains' = chains, cycles' = cycles, lastSave' = lastSave, lastTry' = NoTry,
  }

  /** The server stops mid-cycle: the locks and the cycles are gone, the files are what the disk holds. */
  action crash = all {
    chains' = WORLDS.mapBy(_ => List()),
    cycles' = CYCLES.mapBy(_ => IDLE),
    files' = files, lastSave' = lastSave, sawPartial' = sawPartial, lastTry' = NoTry,
  }

  action step = any {
    nondet c = oneOf(CYCLES)
    nondet w = oneOf(WORLDS)
    start(c, w),
    nondet c = oneOf(CYCLES)
    any { read(c), readOther(c), writeTmpOther(c), renameOther(c), writeTmp(c), rename(c) },
    nondet w = oneOf(WORLDS)
    list(w),
    crash,
  }

  // ── Invariants ───────────────────────────────────────────────────────────────────────────────────

  /** A consumer never reads a partly written world: a save replaces the file whole (temp file, then rename). */
  invariant aReaderNeverSeesAPartlyWrittenWorld = not(sawPartial)

  /** Every save makes a newer generation of its world than the one on disk. */
  invariant generationsOnlyIncrease = lastSave.after > lastSave.before

  /** A save is made from the generation on disk: a cycle holding an older snapshot never writes over a newer one. */
  invariant aStaleSnapshotNeverOverwritesANewerGeneration = lastSave.base == lastSave.before

  def touches(c: int, w: int): bool = or {
    Set(AtRead, AtWriteTmp, AtRename).contains(cycles.get(c).phase) and cycles.get(c).world == w,
    Set(AtReadOther, AtWriteTmpOther, AtRenameOther).contains(cycles.get(c).phase) and otherWorld(cycles.get(c).world) == w,
  }

  /** Only the section at the head of a world's chain reads or writes that world's file. */
  invariant onlyTheLockHolderTouchesAWorld =
    WORLDS.forall(w => CYCLES.forall(c => touches(c, w) implies (busy(w) and chains.get(w)[0] == c)))

  /** A queued cycle is in its world's chain behind the head. */
  invariant queuedCyclesWaitTheirTurn =
    CYCLES.forall(c => cycles.get(c).phase == Queued
      implies (chains.get(cycles.get(c).world).indices().exists(i => i > 0 and chains.get(cycles.get(c).world)[i] == c)))

  // ── Witnesses ────────────────────────────────────────────────────────────────────────────────────

  /** A cycle waited for another on the same world. */
  observation aCycleWaitedItsTurn = CYCLES.exists(c => cycles.get(c).phase == Queued)
  /** A hand-over found the other world busy and went on without it. */
  observation tryFoundTheOtherWorldBusy = lastTry == Busy
  /** A hand-over took the other world's lock at once. */
  observation tryRanAtOnce = lastTry == Ran and HANDOVERS.exists(c => cycles.get(c).phase == AtReadOther)
  /** Two refreshes each hold their own world, the case where waiting for the other's lock would wait for good. */
  observation twoHandOversHoldEachOthersTarget =
    cycles.get(3).phase == AtRead and cycles.get(4).phase == AtRead and cycles.get(3).world != cycles.get(4).world
  /** A reader read a world while a save of it was between its temp file and its rename. */
  observation readMidSave = CYCLES.exists(c => cycles.get(c).phase == AtRename or cycles.get(c).phase == AtRenameOther)
  /** A world reached its fourth generation. */
  observation generationsAdvanced = WORLDS.exists(w => files.get(w).version >= 4)
}

/** The code. */
module worldLock {
  import worldLockModel(ATOMIC_WRITES = true, HAND_OVER_TAKES_THE_LOCK = true, HAND_OVER_NEVER_WAITS = true).*
}

/** Planted bug: the world file is written in place, so a reader can find it half written. */
module worldLockTornWrite {
  import worldLockModel(ATOMIC_WRITES = false, HAND_OVER_TAKES_THE_LOCK = true, HAND_OVER_NEVER_WAITS = true).*
}

/** Planted bug: the hand-over writes the other world without its lock (ADR 0004's lost update). */
module worldLockUnlockedHandOver {
  import worldLockModel(ATOMIC_WRITES = true, HAND_OVER_TAKES_THE_LOCK = false, HAND_OVER_NEVER_WAITS = true).*
}

/** Planted bug: the hand-over waits for the other world's lock while it holds its own. worldLockTest shows the deadlock. */
module worldLockWaitingHandOver {
  import worldLockModel(ATOMIC_WRITES = true, HAND_OVER_TAKES_THE_LOCK = true, HAND_OVER_NEVER_WAITS = false).*
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Frame generations
// ═════════════════════════════════════════════════════════════════════════════════════════════════

module frameModel {
  /** applySpatialFrameWrite refuses a write whose expectedRevision is not the Place's. False is the planted bug. */
  const CHECK_REVISION: bool

  /** FRAME_HISTORY_LIMIT (src/world/frame-generations.ts). */
  pure val FRAME_HISTORY_LIMIT = 20

  /**
   * A frame, by what the server compares: its id (0 for none, an unknown generation written before ids), the time it
   * was made (createdAt, which is all that tells two frames with no id apart), and whether it carries the photos and
   * names that a frame gains after it is first saved (the display parts, which may change within a generation).
   */
  type Frame = { id: int, at: int, named: bool }
  pure val NO_FRAME: Frame = { id: -1, at: 0, named: false }
  pure val IDS = Set(0, 1, 2, 3)
  pure val TIMES = Set(1, 2, 3)

  /** A row of Project.frameHistory: the replaced frame's id (0: none) and createdAt. */
  type Entry = { id: int, at: int }

  /** What a write says it replaces: nothing, or a frame id (0: the held frame has none). The reason is not modelled. */
  type Replaces = NoReplaces | ReplacesId(int)

  type Code = NoCode | Stale | ReplacesRequired | ReplacesMismatch | FrameIdReused

  type Write = {
    /** 0 before any write. */
    status: int,
    code: Code,
    stored: bool,
    unchanged: bool,
    expected: int,
    before: int,
    after: int,
  }

  /** Two phones calibrating one Place: what each read of it, and so the revision it will send. */
  type Client = { read: bool, frame: Frame, revision: int }

  var held: Frame
  var revision: int
  var history: List[Entry]
  var clients: int -> Client
  var lastWrite: Write
  /** The generations a scan was measured against: every frame id the Place has held. */
  var measured: Set[int]

  pure val CLIENTS = Set(1, 2)
  pure val NO_WRITE: Write = { status: 0, code: NoCode, stored: false, unchanged: false, expected: 0, before: 0, after: 0 }

  action init = all {
    held' = NO_FRAME,
    revision' = 0,
    history' = List(),
    clients' = CLIENTS.mapBy(_ => { read: false, frame: NO_FRAME, revision: 0 }),
    lastWrite' = NO_WRITE,
    measured' = Set(),
  }

  // ── The rules of src/world/frame-generations.ts and server/place_frames.ts ───────────────────────

  pure def holds(f: Frame): bool = f.id >= 0

  /** sameSpatialFrame: the whole record. */
  pure def sameRecord(a: Frame, b: Frame): bool = a == b

  /** sameFrameReference: everything but the display parts. */
  pure def sameReference(a: Frame, b: Frame): bool = a.id == b.id and a.at == b.at

  type Kind = SameGeneration | NewGeneration | LegacyReplacement

  /** classifyFrameWrite, for a Place that holds a frame. */
  pure def classify(h: Frame, n: Frame): Kind =
    if (h.id != 0 or n.id != 0) (if (h.id == n.id) SameGeneration else NewGeneration)
    else if (h.at == n.at) SameGeneration
    else LegacyReplacement

  /** decideReplacement: NoCode with an entry or without one (entry.at == 0), or the refusal. */
  pure def decide(h: Frame, n: Frame, r: Replaces, hist: List[Entry]): { code: Code, entry: Entry } =
    val kind = classify(h, n)
    val none = { id: 0, at: 0 }
    if (kind == SameGeneration)
      (if (h.id != 0 and not(sameReference(h, n))) { code: FrameIdReused, entry: none } else { code: NoCode, entry: none })
    else if (n.id != 0 and hist.indices().exists(i => hist[i].id == n.id)) { code: FrameIdReused, entry: none }
    else match r {
      | NoReplaces => if (kind == LegacyReplacement) { code: NoCode, entry: none } else { code: ReplacesRequired, entry: none }
      | ReplacesId(id) => if (id != h.id) { code: ReplacesMismatch, entry: none } else { code: NoCode, entry: { id: h.id, at: h.at } }
    }

  /** appendFrameHistory: at the end, keeping the newest FRAME_HISTORY_LIMIT. */
  pure def appended(hist: List[Entry], e: Entry): List[Entry] =
    val longer = hist.append(e)
    if (longer.length() > FRAME_HISTORY_LIMIT) longer.slice(longer.length() - FRAME_HISTORY_LIMIT, longer.length()) else longer

  // ── Actions ──────────────────────────────────────────────────────────────────────────────────────

  /** A phone reads the Place: its frame and revision (GET /projects/:id). */
  action readPlace(c: int): bool = all {
    clients' = clients.set(c, { read: true, frame: held, revision: revision }),
    held' = held, revision' = revision, history' = history, lastWrite' = NO_WRITE, measured' = measured,
  }

  /**
   * PUT /projects/:id/spatial-frame with the revision the phone last read, a frame and what it says it replaces,
   * judged as applySpatialFrameWrite judges it: a replay of the held frame first, then the revision, then the replace
   * rule. A stored frame's generation is one the Place's scans can then be measured against.
   */
  action writeFrame(c: int, f: Frame, r: Replaces): bool = all {
    val expected = clients.get(c).revision
    val outcome =
      if (holds(held) and sameRecord(held, f)) { status: 200, code: NoCode, stored: false, unchanged: true, entry: { id: 0, at: 0 } }
      else if (CHECK_REVISION and expected != revision) { status: 409, code: Stale, stored: false, unchanged: false, entry: { id: 0, at: 0 } }
      else if (not(holds(held))) { status: 200, code: NoCode, stored: true, unchanged: false, entry: { id: 0, at: 0 } }
      else
        val d = decide(held, f, r, history)
        if (d.code != NoCode) { status: 409, code: d.code, stored: false, unchanged: false, entry: d.entry }
        else { status: 200, code: NoCode, stored: true, unchanged: false, entry: d.entry }
    all {
      held' = if (outcome.stored) f else held,
      revision' = if (outcome.stored) revision + 1 else revision,
      history' = if (outcome.stored and outcome.entry.at != 0) appended(history, outcome.entry) else history,
      lastWrite' = { status: outcome.status, code: outcome.code, stored: outcome.stored, unchanged: outcome.unchanged, expected: expected, before: revision, after: if (outcome.stored) revision + 1 else revision },
      measured' = if (outcome.stored and f.id != 0) measured.union(Set(f.id)) else measured,
      clients' = clients,
    },
  }

  action step = any {
    nondet c = oneOf(CLIENTS)
    readPlace(c),
    nondet c = oneOf(CLIENTS)
    nondet id = oneOf(IDS)
    nondet at = oneOf(TIMES)
    nondet named = oneOf(Set(true, false))
    nondet replaces = oneOf(Set(NoReplaces).union(IDS.map(i => ReplacesId(i))))
    writeFrame(c, { id: id, at: at, named: named }, replaces),
  }

  // ── Invariants ───────────────────────────────────────────────────────────────────────────────────

  /** A Place's frame revision goes up by one with every frame it stores, and never otherwise. */
  invariant generationsOnlyIncrease =
    lastWrite.after == lastWrite.before + (if (lastWrite.stored) 1 else 0)

  /** A stale generation never overwrites a newer one: a write is stored only against the revision it read. */
  invariant aStaleWriteIsNeverStored = lastWrite.stored implies lastWrite.expected == lastWrite.before

  /** An id names one generation for good: the frame a Place holds is never one it held before. */
  invariant aSupersededGenerationNeverReturns =
    held.id > 0 implies not(history.indices().exists(i => history[i].id == held.id))

  /**
   * No scan stays placed against a superseded generation without being listed: every generation a scan can have been
   * measured against is the current one, or the chip calls it a previous reference (the current frame has an id
   * that differs, or the history names it).
   */
  invariant scansOfASupersededGenerationAreListed =
    measured.forall(g => g == held.id or held.id > 0 or history.indices().exists(i => history[i].id == g))

  // ── Witnesses ────────────────────────────────────────────────────────────────────────────────────

  observation staleWriteRefused = lastWrite.code == Stale
  observation replayAnsweredUnchanged = lastWrite.unchanged
  observation replacedAndRecorded = lastWrite.stored and history.length() > 0 and history[history.length() - 1].id > 0
  observation reusedIdRefused = lastWrite.code == FrameIdReused
  observation replacementWithoutReplacesRefused = lastWrite.code == ReplacesRequired
  observation replacesNamingAnotherFrameRefused = lastWrite.code == ReplacesMismatch
  observation legacyFrameReplacedWithoutARecord = lastWrite.stored and held.id == 0 and lastWrite.before > 0 and history.length() == 0
  observation photosAddedInOneGeneration = lastWrite.stored and lastWrite.before > 0 and held.named and history.length() == 0
  observation threeGenerations = measured.size() == 3
}

/** The code. */
module frames {
  import frameModel(CHECK_REVISION = true).*
}

/** The planted bug: the compare-and-swap is gone, so a phone holding an old read can write over a newer frame. */
module framesWithoutRevisionCheck {
  import frameModel(CHECK_REVISION = false).*
}
