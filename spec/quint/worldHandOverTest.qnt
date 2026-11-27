// -*- mode: Bluespec; -*-
/**
 * Tests for worldHandOver.qnt: scenarios for the hand-over and its clock, for the per-slug lock and the file
 * generations, and the progress tests that stand for "the hand-over never deadlocks the server".
 *
 * `quint run` ends a trace silently when nothing is enabled, so a deadlock passes it. The drain tests do not: they
 * finish what was started without starting anything new, and a drain step that is not enabled fails the run.
 * worldLockDeadlockTest runs the crossed hand-overs scenario against the planted variant that waits for the other
 * world's lock; the gate requires that test to fail.
 */
module handOverTest {
  import handOverModel(DROP_BEFORE_ADOPT = false).* from "./worldHandOver"

  pure val GOOD: Env = { busyB: false, brokenB: false, unreadableA: false, failSaveA: false, registryDown: false }
  pure val BUSY: Env = { ...GOOD, busyB: true }

  /** A free world is handed over to at once: one read, nothing to report, no timer. */
  run freeWorldIsHandedOverAtOnceTest =
    initWith(true, true)
      .then(routeStart(1))
      .expect(handedOverAtOnce and not(timer.armed) and worldB.rows.contains(1) and not(worldA.notes.contains(1)))

  /** A world that stays busy: every attempt with longer sleeps, the scan waits where it was, and the timer finishes it. */
  run busyWorldIsFinishedByTheTimerTest =
    initWith(true, true)
      .then(envBecomes(BUSY))
      .then(routeStart(1))
      .expect(routes.get(1).phase == Sleeping and routes.get(1).sleepMs == HAND_OVER_WAIT_MS)
      .then((HAND_OVER_ATTEMPTS - 2).reps(_ => routeWake(1)))
      .expect(routes.get(1).sleepMs == HAND_OVER_WAIT_MS * (HAND_OVER_ATTEMPTS - 1))
      .then(routeWake(1))
      .expect(usedEveryAttempt and routes.get(1).pending == 1 and timer.armed and timer.ms == HAND_OVER_RETRY_FIRST_MS)
      .expect(worldA.rows.contains(1) and worldA.notes.contains(1) and not(worldB.notes.contains(1)))
      .then(envBecomes(GOOD))
      .then(timerFires)
      .expect(timerHandedOver and not(timer.armed) and worldB.notes.contains(1))

  /** The timer doubles, gives up after HAND_OVER_RETRIES, and the next read still finishes the hand-over. */
  run timerGivesUpAndTheNextReadFinishesTest =
    initWith(false, true)
      .then(envBecomes({ ...GOOD, brokenB: true }))
      .then(routeStart(1))
      .then((HAND_OVER_ATTEMPTS - 1).reps(_ => routeWake(1)))
      .then((HAND_OVER_RETRIES - 1).reps(_ => timerFires))
      .expect(timerReachedItsLast and timer.ms == HAND_OVER_RETRY_FIRST_MS * 2 ^ (HAND_OVER_RETRIES - 1))
      .then(timerFires)
      .expect(not(timer.armed) and worldA.notes.contains(1))
      .then(envBecomes(GOOD))
      .then(otherRead)
      .expect(anotherReadFinishedIt and worldB.notes.contains(1) and worldA.placements.contains(1))

  /** A second route that finds the timer set sets none, and answers only about its own scan. */
  run secondRouteSetsNoSecondTimerTest =
    initWith(true, true)
      .then(envBecomes(BUSY))
      .then(routeStart(1))
      .then((HAND_OVER_ATTEMPTS - 1).reps(_ => routeWake(1)))
      .expect(timer.armed and timer.attempt == 0)
      .then(routeStart(2))
      .then((HAND_OVER_ATTEMPTS - 1).reps(_ => routeWake(2)))
      .expect(timer.armed and timer.attempt == 0 and routes.get(2).pending == 1)

  /** A restart forgets the waiting scans and the timer; the scans are still where they were, and a read finishes them. */
  run restartLosesNothingTest =
    initWith(true, false)
      .then(envBecomes(BUSY))
      .then(routeStart(1))
      .then(restart)
      .expect(restartLeftItInA and routes.get(1).phase == Abandoned and not(timer.armed) and waiting == Set())
      .then(otherRead)
      .expect(worldB.notes.contains(1) and not(worldA.rows.contains(1)))

  /** House A's save fails after House B took the scan: the next read hands it over again, and that changes nothing. */
  run failedSaveIsRepeatedHarmlesslyTest =
    initWith(true, true)
      .then(envBecomes({ ...GOOD, failSaveA: true }))
      .then(routeStart(1))
      .expect(routes.get(1).pending == 1 and worldB.notes.contains(1) and worldA.notes.contains(1))
      .then(envBecomes(GOOD))
      .then(otherRead)
      .expect(handedOverAgain and worldB.notes == Set(1) and not(worldA.notes.contains(1)))

  /** A scan not placed by its record keeps its placement where it was made, and the route says so once. */
  run keptPlacementIsReportedTest =
    initWith(false, true)
      .then(routeStart(1))
      .expect(answeredWithKeptPlacement and worldA.placements.contains(1) and not(worldB.placements.contains(1)) and kept == Set())

  /** From anywhere, once the world, the disk and the registry are fine, one read hands every filed scan over. */
  run drainsOnceThingsAreFineTest =
    init
      .then(25.reps(_ => step))
      .then(envBecomes(GOOD))
      .then(otherRead)
      .expect(filedUnderB.forall(s => worldB.notes.contains(s) and not(worldA.rows.contains(s))))
}

module worldLockTest {
  import worldLockModel(ATOMIC_WRITES = true, HAND_OVER_TAKES_THE_LOCK = true, HAND_OVER_NEVER_WAITS = true).* from "./worldHandOver"

  val allIdle = CYCLES.forall(c => cycles.get(c).phase == Idle)

  /** Finish what was started: no new cycle, no crash, no read by GET /worlds. */
  action drain = any {
    all { allIdle, files' = files, chains' = chains, cycles' = cycles, lastSave' = lastSave, sawPartial' = sawPartial, lastTry' = lastTry },
    nondet c = oneOf(CYCLES)
    any { read(c), readOther(c), writeTmpOther(c), renameOther(c), writeTmp(c), rename(c) },
  }

  /** Two cycles on one world take turns, and both changes are kept: two new generations. */
  run cyclesOnOneWorldTakeTurnsTest =
    init
      .then(start(1, 1))
      .then(start(2, 1))
      .expect(cycles.get(2).phase == Queued)
      .then(read(1)).then(writeTmp(1)).then(rename(1))
      .expect(cycles.get(2).phase == AtRead and files.get(1).version == 2)
      .then(read(2)).then(writeTmp(2)).then(rename(2))
      .expect(files.get(1).version == 3 and allIdle)

  /** A refresh that hands scans over finds the other world busy and goes on without it. */
  run handOverGoesOnWhenTheOtherWorldIsBusyTest =
    init
      .then(start(1, 2))
      .then(start(3, 1))
      .then(read(3))
      .expect(tryFoundTheOtherWorldBusy and cycles.get(3).phase == AtWriteTmp)

  /** A free other world is read and saved inside the refresh, one generation on. */
  run handOverSavesAFreeWorldTest =
    init
      .then(start(3, 1))
      .then(read(3))
      .expect(tryRanAtOnce)
      .then(readOther(3)).then(writeTmpOther(3)).then(renameOther(3))
      .expect(files.get(2).version == 2 and chains.get(2) == List() and cycles.get(3).phase == AtWriteTmp)

  /** Two refreshes, each holding the world the other hands scans to: neither waits, and both finish. */
  run crossedHandOversDrainTest =
    init
      .then(start(3, 1))
      .then(start(4, 2))
      .then(read(3))
      .then(read(4))
      .then(12.reps(_ => drain))
      .expect(allIdle)

  /** A crash between the temp file and the rename leaves the last whole generation. */
  run crashMidSaveKeepsTheLastGenerationTest =
    init
      .then(start(1, 1))
      .then(read(1))
      .then(writeTmp(1))
      .then(crash)
      .then(list(1))
      .expect(not(sawPartial) and files.get(1).version == 1)

  /** From anywhere a random walk reaches, finishing what was started leaves every lock free. */
  run drainsToIdleTest =
    init
      .then(30.reps(_ => step))
      .then(40.reps(_ => drain))
      .expect(allIdle and WORLDS.forall(w => chains.get(w) == List()))
}

/** The planted deadlock: the crossed hand-overs wait for each other's lock. The gate requires this test to fail. */
module worldLockDeadlockTest {
  import worldLockModel(ATOMIC_WRITES = true, HAND_OVER_TAKES_THE_LOCK = true, HAND_OVER_NEVER_WAITS = false).* from "./worldHandOver"

  val allIdle = CYCLES.forall(c => cycles.get(c).phase == Idle)

  action drain = any {
    all { allIdle, files' = files, chains' = chains, cycles' = cycles, lastSave' = lastSave, sawPartial' = sawPartial, lastTry' = lastTry },
    nondet c = oneOf(CYCLES)
    any { read(c), readOther(c), writeTmpOther(c), renameOther(c), writeTmp(c), rename(c) },
  }

  run crossedHandOversDrainTest =
    init
      .then(start(3, 1))
      .then(start(4, 2))
      .then(read(3))
      .then(read(4))
      .then(12.reps(_ => drain))
      .expect(allIdle)
}

module frameTest {
  import frameModel(CHECK_REVISION = true).* from "./worldHandOver"

  pure val GEN1: Frame = { id: 1, at: 1, named: false }
  pure val GEN2: Frame = { id: 2, at: 2, named: false }

  /** Two phones calibrate one Place: the second one's write is stale, then has to say what it replaces. */
  run racingPhonesTest =
    init
      .then(readPlace(1))
      .then(readPlace(2))
      .then(writeFrame(1, GEN1, NoReplaces))
      .expect(revision == 1 and held == GEN1)
      .then(writeFrame(2, GEN2, ReplacesId(0)))
      .expect(staleWriteRefused and held == GEN1)
      .then(readPlace(2))
      .then(writeFrame(2, GEN2, NoReplaces))
      .expect(replacementWithoutReplacesRefused)
      .then(writeFrame(2, GEN2, ReplacesId(2)))
      .expect(replacesNamingAnotherFrameRefused)
      .then(writeFrame(2, GEN2, ReplacesId(1)))
      .expect(replacedAndRecorded and held == GEN2 and revision == 2 and history == List({ id: 1, at: 1 }))
      .then(readPlace(1))
      .then(writeFrame(1, GEN1, ReplacesId(2)))
      .expect(reusedIdRefused and held == GEN2 and scansOfASupersededGenerationAreListed)

  /** The photos and names of a frame are added in its own generation; the same write again answers unchanged. */
  run photosStayInOneGenerationTest =
    init
      .then(readPlace(1))
      .then(writeFrame(1, GEN1, NoReplaces))
      .then(readPlace(1))
      .then(writeFrame(1, { ...GEN1, named: true }, NoReplaces))
      .expect(photosAddedInOneGeneration and revision == 2 and history == List())
      .then(writeFrame(1, { ...GEN1, named: true }, NoReplaces))
      .expect(replayAnsweredUnchanged and revision == 2)

  /** The held frame's id on a different frame is refused. */
  run sameIdOnAnotherFrameRefusedTest =
    init
      .then(readPlace(1))
      .then(writeFrame(1, GEN1, NoReplaces))
      .then(readPlace(1))
      .then(writeFrame(1, { ...GEN1, at: 2 }, NoReplaces))
      .expect(reusedIdRefused and held == GEN1)

  /** Frames written before ids replace each other as they always did, with nothing recorded. */
  run legacyFramesReplaceEachOtherTest =
    init
      .then(readPlace(1))
      .then(writeFrame(1, { id: 0, at: 1, named: false }, NoReplaces))
      .then(readPlace(1))
      .then(writeFrame(1, { id: 0, at: 2, named: false }, NoReplaces))
      .expect(legacyFrameReplacedWithoutARecord and revision == 2)
}
