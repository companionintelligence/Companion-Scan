// -*- mode: Bluespec; -*-
/**
 * Tests for gimbalInterlock.qnt: one scenario per witness the random simulation reaches only rarely, and the
 * progress tests that stand for "the interlock never deadlocks the session".
 *
 * `quint run` ends a trace silently when nothing is enabled, and TLC runs with -deadlock, so neither would
 * report a stuck session. The progress tests do: from a state reached by a random walk, a drain that starts
 * nothing new (moves, probes, the capture and the link only finish what they started) must reach a quiet
 * session, where no capture runs and no move or probe holds the motors. A drain step that is not enabled
 * fails the run, which is what makes a deadlock visible.
 */
module gimbalInterlockTest {
  import gimbalInterlockModel(PARKED_REFUSES_SECOND_DRIVER = true).* from "./gimbalInterlock"

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

  /** The link comes up streaming: a connect whose setup saw a notification. */
  action linkStreaming = connectDoneWith(true)

  /** Leave everything as it is. */
  action idle = all { link' = link, cap' = cap, ctl' = ctl, wire' = wire, event' = event }

  /** A session with nothing in flight: no capture, no outside request, no disconnect half done. */
  val quiet = cap.phase == CapIdle and SLOTS.forall(s => ctl.get(s).phase == Free) and not(link.disconnecting)

  /** Do nothing, once the session is quiet. */
  action stayQuiet = all { quiet, link' = link, cap' = cap, ctl' = ctl, wire' = wire, event' = Quiet }

  /** One step that only finishes what was started: no new request, no new link, no new capture. */
  action drain = any {
    stayQuiet,
    disconnectEnd,
    connectFail,
    capturePulseEnd,
    captureMoveEnd,
    captureAbort,
    captureFinish,
    all { parked, gridStop },
    nondet s = oneOf(SLOTS)
    any { moveAdmit(s), outsidePulseEnd(s), outsideMoveEnd(s), probeStop(s), outsideFinish(s) },
  }

  // ── Scenarios ────────────────────────────────────────────────────────────────────────────────────

  /** A parked scan lets one outside move drive, refuses a second, and refuses the advance while the first holds. */
  run parkedScanAdmitsOneMoveTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(captureStart)
      .then(capturePark)
      .expect(parked)
      .then(moveRequest(1))
      .then(moveAdmit(1))
      .expect(activeDrivers == 1)
      .then(outsidePulse(1))
      .expect(outsideMoveWhileParked)
      .then(moveRequest(2))
      .then(moveAdmit(2))
      .expect(secondDriverRefusedWhileParked)
      .then(gridAdvance)
      .expect(event == AdvanceRefused and parked)
      .then(outsidePulseEnd(1))
      .then(outsideMoveEnd(1))
      .then(outsideFinish(1))
      .then(gridAdvance)
      .expect(cap.phase == CapSweep)

  /** While the scan sweeps, an outside speed, a move and a probe's drive frame are all refused; a stop goes out. */
  run sweepingScanRefusesOutsideDriveTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(captureStart)
      .then(captureMoveBegin)
      .then(capturePulse)
      .expect(scanSweeps)
      .then(moveRequest(1))
      .then(moveAdmit(1))
      .expect(event == MoveRefused and activeDrivers == 0)
      .then(probeSendWith(1, Speed))
      .expect(event == Refused(ProbeFrame) and not(outsideMotion))
      .then(commandWith(Recenter))
      .expect(outsideDriveRefusedWhileSweeping)
      .then(commandWith(StickOff))
      .expect(event == Delivered and wire.last.frame == StickOff)
      .then(commandWith(Speed))
      .expect(outsideDriveRefusedWhileSweeping and wire.last.frame == StickOff)

  /** An outside stop goes out over a linked link whatever the scan is doing. */
  run stopPassesWhileScanSweepsTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(captureStart)
      .then(commandWith(Stop))
      .expect(wire.last.src == Command and wire.last.frame == Stop and cap.phase == CapSweep)
      .then(probeSendWith(1, Stop))
      .expect(event == Delivered and ctl.get(1).registered and not(ctl.get(1).driver))

  /** A move that loses telemetry gives up after ABORT_S seconds rather than driving blind. */
  run moveGivesUpWithoutTelemetryTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(moveRequest(1))
      .then(moveAdmit(1))
      .then((STALE_S + 1).reps(_ => tick))
      .expect(ctl.get(1).noTel == 0 and not(streaming))
      .then(ABORT_S.reps(_ => tick))
      .expect(ctl.get(1).noTel == ABORT_S)
      .then(tick)
      .fail()

  /** The capture's move gives up the same way, and that ends the run. */
  run captureGivesUpWithoutTelemetryTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(captureStart)
      .then(captureMoveBegin)
      .then((STALE_S + 1 + ABORT_S).reps(_ => tick))
      .then(captureAbort)
      .expect(moveGaveUpWithoutTelemetry and cap.phase == CapIdle)

  /** A drop cancels the registered move; it stops on the next link and never drives again. */
  run dropCancelsTheMoveTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(moveRequest(1))
      .then(moveAdmit(1))
      .then(outsidePulse(1))
      .then(drop)
      .expect(linkLostUnderAMove and not(outsideMotion))
      .then(connectBegin)
      .then(linkStreaming)
      .expect(wire.firstOnLink == Stop and wire.onLink == 1)
      .then(outsidePulseEnd(1))
      .expect(cancelledMoveStopsOnTheNextLink)
      .then(outsidePulse(1))
      .fail()

  /** The link check of a move-to comes before its body: the move can be admitted on the next link. */
  run moveAdmittedOnTheNextLinkTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(moveRequest(1))
      .then(drop)
      .then(connectBegin)
      .then(linkStreaming)
      .then(moveAdmit(1))
      .expect(moveAdmittedAfterItsLinkWent and ctl.get(1).epoch == link.epoch)

  /** POST /api/disconnect's stop goes out, a move's next pulse follows it, and the teardown leaves that speed latched. */
  run pulseBetweenDisconnectStopAndTeardownTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(moveRequest(1))
      .then(moveAdmit(1))
      .then(disconnectBegin)
      .expect(not(wire.latched))
      .then(outsidePulse(1))
      .then(disconnectEnd)
      .expect(latchedAtOperatorDisconnect and wire.latched)
      .then(connectBegin)
      .then(linkStreaming)
      .expect(not(wire.latched))

  /** With no scan, the interlock lets two outside moves drive at once. */
  run twoMovesWithoutAScanTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(moveRequest(1))
      .then(moveRequest(2))
      .then(moveAdmit(1))
      .then(moveAdmit(2))
      .expect(twoOutsideDriversWithoutAScan)
      .then(captureStart)
      .expect(event == StartRefused)

  /** Streaming decays: STALE_S seconds after the last notification the link still streams; one more and it is linked. */
  run streamingDecaysTest =
    init
      .then(connectBegin)
      .then(linkStreaming)
      .then(STALE_S.reps(_ => tick))
      .expect(streaming)
      .then(tick)
      .expect(level == Linked)
      .then(notify)
      .expect(streaming)

  // ── Progress: the interlock never deadlocks the session ──────────────────────────────────────────

  /** From any state a random walk reaches, finishing what was started gives a quiet session. */
  run drainsToQuietTest =
    init
      .then(30.reps(_ => step))
      .then(30.reps(_ => drain))
      .expect(quiet)

  /** The same from a longer walk. */
  run drainsToQuietAfterALongWalkTest =
    init
      .then(80.reps(_ => step))
      .then(30.reps(_ => drain))
      .expect(quiet)

  /** Bring the link towards streaming without starting anything else: connect, finish the connect, or notify. */
  action towardsStreaming = any {
    all { link.connecting, linkStreaming },
    all { link.up, not(link.connecting), notify },
    all { not(link.up), not(link.connecting), not(link.disconnecting), connectBegin },
  }

  /** And from a quiet session a capture can start again once the link streams. */
  run quietSessionCanCaptureTest =
    init
      .then(40.reps(_ => step))
      .then(30.reps(_ => drain))
      .then(towardsStreaming)
      .then(any { towardsStreaming, all { streaming, idle } })
      .expect(quiet and streaming and captureStartAllowed)
}
