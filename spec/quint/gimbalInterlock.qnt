// -*- mode: Bluespec; -*-
/**
 * The gimbal's motion interlock and its BLE link levels, as subsystems/osmo-ble implements them.
 *
 * What is modelled, and where it lives in the code:
 *
 *  - The link level (protocol/link_state.mjs deriveLinkState): disconnected, connecting, linked, and
 *    streaming, which needs a notification in the last STREAM_STALE_MS. One model tick is one second.
 *  - The interlock state server/backend.mjs keeps: whether a grid capture runs (gridRunning), whether it is
 *    parked between stations (stationGate), and the outside moves and probes holding the motors
 *    (externalMotions).
 *  - The rules it asks: motionRefusal and moveRefusal (protocol/motion_gate.mjs) for every outside frame,
 *    move-to and arc probe, and the inline door checks of POST /api/grid-capture and POST /api/grid-advance.
 *  - Two controllers on the same motors: the capture's own closed loop, and up to two outside controllers
 *    (a move-to or arc probe, or a test command probe), plus open-loop POST /api/command frames.
 *  - The link events and what backend.mjs does on them: connect (its first write is a stop), a drop
 *    (every outside motion is cancelled and released), and POST /api/disconnect (a stop, then the teardown).
 *
 * Each action is one stretch of the code between two awaits, because that is where other requests and
 * timers can run. Three gaps between a check and the act it guards are kept on purpose, as the code has them:
 *
 *  - POST /api/move-to and POST /api/arc-probe check the link before they read the request body, and the
 *    interlock after it, so a move can be admitted after the link it was checked against has gone
 *    (moveAdmittedAfterItsLinkWent).
 *  - POST /api/disconnect writes its stop and then awaits that write before the teardown, so a drive loop's
 *    speed pulse can land between the two (latchedAtOperatorDisconnect).
 *  - The capture's own closed loop sends its frames to the transport directly, not through buildAndSend, so
 *    the interlock never judges them; the door rules are what keep a second controller away from it.
 *
 * Not modelled: the arc measurement, the pan and tilt arithmetic, photos, the access gate, and noble itself.
 * A move ends (converges, times out or jams) at a moment the environment picks.
 */
module gimbalInterlockModel {
  // ── Parameter ────────────────────────────────────────────────────────────────────────────────────

  /**
   * F5-1: while a scan is parked, a move or probe the backend started is still driving the motors, so a
   * second one is refused. True is the code. False is the planted bug (the rule before F5-1), kept in the
   * module gimbalInterlockBug below, which the gate requires to fail.
   */
  const PARKED_REFUSES_SECOND_DRIVER: bool

  // ── Constants, from the code ─────────────────────────────────────────────────────────────────────

  /** STREAM_STALE_MS (protocol/link_state.mjs) in seconds: streaming needs a notification this recent. */
  pure val STALE_S = 3
  /** NO_TELEMETRY_ABORT_MS (server/backend.mjs, STREAM_STALE_MS * 2) in seconds. */
  pure val ABORT_S = 6
  /** Notification ages above STALE_S all read alike, so the model keeps none larger than this. */
  pure val AGE_CAP = STALE_S + 1
  /** The outside controller slots: two, so two controllers can contend. */
  pure val SLOTS = Set(1, 2)

  // ── Frames ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * The frames an outside caller can send, as protocol/motion_gate.mjs classes them by their decoded bytes:
   * a zero-speed stop, a speed, a recenter, a mount mode change, the stick turned on or off, and a frame
   * outside the gimbal command set (a pairing frame, for one).
   */
  type Frame = Stop | Speed | Recenter | SetMode | StickOn | StickOff | NonGimbal
  pure val FRAMES = Set(Stop, Speed, Recenter, SetMode, StickOn, StickOff, NonGimbal)

  /** isMotionFrame: every gimbal-function frame but the stick turned off. */
  pure def isMotionFrame(f: Frame): bool = match f {
    | StickOff => false
    | NonGimbal => false
    | _ => true
  }

  /** isStopFrame: a speed command that is zero on every axis. */
  pure def isStopFrame(f: Frame): bool = f == Stop

  /** A frame the interlock refuses while it holds: motion that is not a stop. */
  pure def isDrive(f: Frame): bool = isMotionFrame(f) and not(isStopFrame(f))

  /** The speed command is a latch (server/backend.mjs stopMotors): a speed holds until a stop. */
  pure def latchAfter(latched: bool, f: Frame): bool = match f {
    | Speed => true
    | Stop => false
    | _ => latched
  }

  // ── The link ─────────────────────────────────────────────────────────────────────────────────────

  type Level = Disconnected | Connecting | Linked | Streaming

  type Link = {
    /** A GATT handle with its subscriptions: peripheral.state is 'connected'. */
    up: bool,
    /** transport._connecting: a connect attempt is between acquiring a handle and subscribing. */
    connecting: bool,
    /** A notification has arrived on this link (lastNotifyAt is not 0). */
    notified: bool,
    /** Seconds since the last notification, capped at AGE_CAP. */
    age: int,
    /** How many links have gone: one more each time a live link is torn down. */
    epoch: int,
    /** POST /api/disconnect has sent its stop and not yet torn the link down. */
    disconnecting: bool,
    /** levelOf the fields above, kept in the state so a trace carries it (levelIsDerived). */
    level: Level,
  }

  /** deriveLinkState, with one subscription whenever there is a handle (a connect that subscribes nothing tears down). */
  pure def levelOf(l: Link): Level =
    if (l.connecting) Connecting
    else if (not(l.up)) Disconnected
    else if (not(l.notified)) Linked
    else if (l.age <= STALE_S) Streaming
    else Linked

  pure def isLinked(l: Link): bool = levelOf(l) == Linked or levelOf(l) == Streaming
  pure def isStreaming(l: Link): bool = levelOf(l) == Streaming

  /** A link with its level brought up to date: every change to the link goes through this. */
  pure def withLevel(l: Link): Link = { ...l, level: levelOf(l) }

  /** _resetLinkState on a live link: everything about it is forgotten, and one more link has gone. */
  pure def tornDown(l: Link): Link =
    withLevel({ ...l, up: false, connecting: false, notified: false, age: AGE_CAP, epoch: l.epoch + 1 })

  // ── The capture and the outside controllers ──────────────────────────────────────────────────────

  /** gridRunning and stationGate: not running, sweeping a station, or parked between stations. */
  type CapPhase = CapIdle | CapSweep | CapParked

  /**
   * One closed-loop move (driveClosedLoop): none running, at the top of a tick, or with a speed pulse out
   * (between the speed write and the zero-speed write that ends the tick).
   */
  type Loop = NoMove | TopOfTick | PulseOut

  type Capture = {
    phase: CapPhase,
    loop: Loop,
    /** Seconds the current move has waited at the top of a tick for a streaming link. */
    noTel: int,
    /** gridCancelRequested. */
    cancel: bool,
  }

  /** A move-to or arc probe (closed loop, many ticks), or a test command probe (one frame, a wait, a stop). */
  type CtlKind = Mover | Prober

  /**
   * Where an outside request is: no request, past its link check and reading its body (Checked), in its drive
   * loop (TopOfTickCtl, PulseOutCtl), waiting after its probe frame (ProbeWait), or in its finally blocks.
   */
  type CtlPhase = Free | Checked | TopOfTickCtl | PulseOutCtl | ProbeWait | Finishing

  type Ctl = {
    kind: CtlKind,
    phase: CtlPhase,
    /** In externalMotions. */
    registered: bool,
    /** motion.cancelled: its link went while it was registered. */
    cancelled: bool,
    /** Link.epoch when it was registered. */
    epoch: int,
    /** Link.epoch when its route checked the link. */
    checkedEpoch: int,
    /** Seconds its current tick has waited for a streaming link. */
    noTel: int,
    /** It was admitted to drive the motors: a move, or a probe whose frame is motion and not a stop. */
    driver: bool,
  }

  pure val FREE_CTL: Ctl =
    { kind: Mover, phase: Free, registered: false, cancelled: false, epoch: 0, checkedEpoch: 0, noTel: 0, driver: false }

  // ── What went on the wire ────────────────────────────────────────────────────────────────────────

  /** Who wrote a frame. The capture's loop and an outside move's loop write to the transport directly. */
  type Source =
    | NoSource
    | Command
    | ProbeFrame
    | OutsideLoop
    | CaptureLoop
    | CaptureOwn
    | CaptureStop
    | ConnectStop
    | DisconnectStop
    | OutsideStop

  /** The last frame written, with the state it was written in. Invariants read it, so every write is judged. */
  type Sent = {
    src: Source,
    frame: Frame,
    slot: int,
    level: Level,
    capPhase: CapPhase,
    /** The writer was an outside controller whose motion had been cancelled. */
    fromCancelled: bool,
    /** Outside drivers registered and not cancelled, other than the writer. */
    otherDrivers: int,
    /** For a closed-loop speed pulse: the writer's link generation is the current one. */
    sameLink: bool,
  }

  pure val NOTHING_SENT: Sent =
    { src: NoSource, frame: Stop, slot: 0, level: Disconnected, capPhase: CapIdle, fromCancelled: false, otherDrivers: 0, sameLink: true }

  type Wire = {
    /** A nonzero speed is latched on the gimbal. */
    latched: bool,
    /** Frames written on the current link. */
    onLink: int,
    /** The first frame written on the current link. */
    firstOnLink: Frame,
    last: Sent,
  }

  /** What the last step did, beyond the state: for the witnesses and the trace replay. */
  type Event =
    | Quiet
    | Refused(Source)
    | AdvanceRefused
    | StartRefused
    | MoveRefused
    | NoTelemetryAbort
    | LatchedAtTeardown
    | Delivered

  // ── State ────────────────────────────────────────────────────────────────────────────────────────

  var link: Link
  var cap: Capture
  var ctl: int -> Ctl
  var wire: Wire
  var event: Event

  // ── Derived ──────────────────────────────────────────────────────────────────────────────────────

  val level = levelOf(link)
  val linked = isLinked(link)
  val streaming = isStreaming(link)
  val scanRunning = cap.phase != CapIdle
  val parked = cap.phase == CapParked
  /** externalMotions.size > 0 */
  val outsideMotion = SLOTS.exists(s => ctl.get(s).registered)
  def otherRegistered(slot: int): bool = SLOTS.exists(s => s != slot and ctl.get(s).registered)
  def isActiveDriver(s: int): bool = ctl.get(s).registered and ctl.get(s).driver and not(ctl.get(s).cancelled)
  val activeDrivers = SLOTS.filter(s => isActiveDriver(s)).size()
  def otherDrivers(slot: int): int = SLOTS.filter(s => s != slot and isActiveDriver(s)).size()

  // ── The rules, as protocol/motion_gate.mjs and the routes state them ─────────────────────────────

  /**
   * motionRefusal: refused only when a scan runs, the frame is not the scan's own, the scan is not parked
   * with nothing else driving, the frame is motion and it is not a stop.
   */
  def motionRefused(f: Frame, runOwned: bool, others: bool): bool =
    if (not(scanRunning) or runOwned) false
    else if (parked and (not(others) or not(PARKED_REFUSES_SECOND_DRIVER))) false
    else isDrive(f)

  /** moveRefusal: a running scan refuses a move unless it is parked with no other move or probe holding the motors. */
  def moveRefused(others: bool): bool =
    if (not(scanRunning)) false
    else if (not(parked)) true
    else others and PARKED_REFUSES_SECOND_DRIVER

  /** POST /api/grid-capture: the link streams, no capture runs, and no move or probe holds the motors. */
  val captureStartAllowed = streaming and not(scanRunning) and not(outsideMotion)

  /** POST /api/grid-advance: the capture is parked, the link streams, and no move or probe holds the motors. */
  val advanceAllowed = parked and streaming and not(outsideMotion)

  // ── Writing a frame ──────────────────────────────────────────────────────────────────────────────

  def sentRecord(src: Source, f: Frame, slot: int, fromCancelled: bool, sameLink: bool): Sent =
    { src: src, frame: f, slot: slot, level: level, capPhase: cap.phase, fromCancelled: fromCancelled, otherDrivers: otherDrivers(slot), sameLink: sameLink }

  def wrote(src: Source, f: Frame, slot: int, fromCancelled: bool, sameLink: bool): Wire =
    { latched: latchAfter(wire.latched, f), onLink: wire.onLink + 1, firstOnLink: if (wire.onLink == 0) f else wire.firstOnLink, last: sentRecord(src, f, slot, fromCancelled, sameLink) }

  /** stopMotors(): a zero-speed write, only when the link is linked. Never throws. */
  def stopMotorsWire(src: Source): Wire = if (linked) wrote(src, Stop, 0, false, true) else wire

  /** The capture's finally block: stop the motors, clear the gate, and let go of the gimbal. */
  pure val CAP_IDLE: Capture = { phase: CapIdle, loop: NoMove, noTel: 0, cancel: false }

  // ── Init ─────────────────────────────────────────────────────────────────────────────────────────

  action init = all {
    link' = withLevel({ up: false, connecting: false, notified: false, age: AGE_CAP, epoch: 0, disconnecting: false, level: Disconnected }),
    cap' = CAP_IDLE,
    ctl' = SLOTS.mapBy(_ => FREE_CTL),
    wire' = { latched: false, onLink: 0, firstOnLink: Stop, last: NOTHING_SENT },
    event' = Quiet,
  }

  // ── The link ─────────────────────────────────────────────────────────────────────────────────────

  /** Every registered outside motion is cancelled and released: the 'disconnect' handler, cancelExternalMotions(). */
  def cancelledAll: int -> Ctl =
    ctl.keys().mapBy(s => if (ctl.get(s).registered) { ...ctl.get(s), registered: false, cancelled: true } else ctl.get(s))

  /**
   * POST /api/connect begins. A connect waits for a disconnect still in progress. Over a link that is up, noble
   * refuses the handle as already connected and the transport drops it first, which announces 'disconnect'.
   */
  action connectBegin = all {
    not(link.connecting),
    not(link.disconnecting),
    link' = withLevel({ ...(if (link.up) tornDown(link) else link), connecting: true, up: false, notified: false, age: AGE_CAP }),
    ctl' = if (link.up) cancelledAll else ctl,
    cap' = cap,
    wire' = if (link.up) { ...wire, onLink: 0 } else wire,
    event' = Quiet,
  }

  /**
   * The connect finishes with its subscriptions up; a notification may already have landed during setup. The
   * route then calls stopMotors() before anything else can write, so the first frame on a new link is a stop.
   */
  action connectDoneWith(notifiedDuringSetup: bool): bool = all {
    link.connecting,
    val linkUp = withLevel({ ...link, up: true, connecting: false, notified: notifiedDuringSetup, age: 0 })
    all {
      link' = linkUp,
      wire' = { latched: false, onLink: 1, firstOnLink: Stop, last: { src: ConnectStop, frame: Stop, slot: 0, level: levelOf(linkUp), capPhase: cap.phase, fromCancelled: false, otherDrivers: 0, sameLink: true } },
      cap' = cap,
      ctl' = ctl,
      event' = Delivered,
    },
  }

  action connectDone = { nondet notifiedDuringSetup = oneOf(Set(true, false)) connectDoneWith(notifiedDuringSetup) }

  /** A connect that fails tears its half-open handle down, which announces 'disconnect'. */
  action connectFail = all {
    link.connecting,
    link' = tornDown(link),
    ctl' = cancelledAll,
    cap' = cap,
    wire' = { ...wire, onLink: 0 },
    event' = Quiet,
  }

  /** A notification arrives: lastNotifyAt is stamped. */
  action notify = all {
    link.up,
    not(link.connecting),
    link' = withLevel({ ...link, notified: true, age: 0 }),
    cap' = cap,
    ctl' = ctl,
    wire' = wire,
    event' = Quiet,
  }

  /** The gimbal side drops the link: peripheral 'disconnect', then _resetLinkState and the 'disconnect' event. */
  action drop = all {
    link.up,
    not(link.connecting),
    link' = tornDown(link),
    ctl' = cancelledAll,
    cap' = cap,
    wire' = { ...wire, onLink: 0 },
    event' = Quiet,
  }

  /** POST /api/disconnect, first half: the zero-speed write goes out while the link is still linked. */
  action disconnectBegin = all {
    link.up,
    not(link.connecting),
    not(link.disconnecting),
    link' = withLevel({ ...link, disconnecting: true }),
    wire' = stopMotorsWire(DisconnectStop),
    cap' = cap,
    ctl' = ctl,
    event' = Delivered,
  }

  /**
   * POST /api/disconnect, second half, after the stop write returned: _teardown(), which announces 'disconnect'.
   * When the gimbal dropped the link meanwhile, the handle is already gone and the teardown announces nothing.
   */
  action disconnectEnd = all {
    link.disconnecting,
    if (link.up) all {
      link' = withLevel({ ...tornDown(link), disconnecting: false }),
      ctl' = cancelledAll,
      wire' = { ...wire, onLink: 0 },
      event' = if (wire.latched) LatchedAtTeardown else Quiet,
      cap' = cap,
    } else all {
      link' = withLevel({ ...link, disconnecting: false }),
      ctl' = ctl,
      wire' = wire,
      event' = Quiet,
      cap' = cap,
    },
  }

  /**
   * What must happen before another second passes: a loop that has waited ABORT_S seconds for telemetry gives up,
   * and a cancelled motion at the top of its tick returns (its loop checks every tickMs, well under a second).
   */
  val urgent =
    (cap.loop == TopOfTick and cap.noTel >= ABORT_S)
    or SLOTS.exists(s => ctl.get(s).phase == TopOfTickCtl and (ctl.get(s).cancelled or ctl.get(s).noTel >= ABORT_S))

  /** One second passes. A loop at the top of a tick with no streaming link counts it; a streaming link resets it. */
  action tick = all {
    not(urgent),
    link' = withLevel({ ...link, age: if (link.age >= AGE_CAP) AGE_CAP else link.age + 1 }),
    cap' = if (cap.loop == TopOfTick) { ...cap, noTel: if (streaming) 0 else cap.noTel + 1 } else cap,
    ctl' = ctl.keys().mapBy(s =>
      if (ctl.get(s).phase == TopOfTickCtl) { ...ctl.get(s), noTel: if (streaming) 0 else ctl.get(s).noTel + 1 } else ctl.get(s)),
    wire' = wire,
    event' = Quiet,
  }

  // ── Open-loop commands: POST /api/command and the page's own controls ────────────────────────────

  /**
   * POST /api/command reads its body, then needs only a linked link ('write': a stop must go out over a link that
   * stopped reporting), then buildAndSend judges the frame. Not registered as a motion.
   */
  action commandWith(f: Frame): bool = all {
    linked,
    if (motionRefused(f, false, outsideMotion)) all {
      link' = link, cap' = cap, ctl' = ctl, wire' = wire, event' = Refused(Command),
    } else all {
      link' = link, cap' = cap, ctl' = ctl, wire' = wrote(Command, f, 0, false, true), event' = Delivered,
    },
  }

  action command = { nondet f = oneOf(FRAMES) commandWith(f) }

  // ── The capture: POST /api/grid-capture, its run loop, POST /api/grid-advance and /api/grid-stop ───

  /** The door: after the body, linkRefusal('stream'), then no capture, then no move or probe, with no await between. */
  action captureStart = all {
    not(scanRunning),
    if (captureStartAllowed) all {
      cap' = { phase: CapSweep, loop: NoMove, noTel: 0, cancel: false },
      link' = link, ctl' = ctl, wire' = wire, event' = Quiet,
    } else all {
      cap' = cap, link' = link, ctl' = ctl, wire' = wire, event' = StartRefused,
    },
  }

  /** The run starts a closed-loop move: a grid position, or one step of its own arc probe. */
  action captureMoveBegin = all {
    cap.phase == CapSweep,
    cap.loop == NoMove,
    not(cap.cancel),
    cap' = { ...cap, loop: TopOfTick, noTel: 0 },
    link' = link, ctl' = ctl, wire' = wire, event' = Quiet,
  }

  /** A tick of the capture's move with a streaming link: the speed write, straight to the transport. */
  action capturePulse = all {
    cap.loop == TopOfTick,
    streaming,
    cap' = { ...cap, loop: PulseOut, noTel: 0 },
    wire' = wrote(CaptureLoop, Speed, 0, false, true),
    link' = link, ctl' = ctl, event' = Delivered,
  }

  /** The end of the tick: the zero-speed write. With no link the write throws, the move throws, and the run ends. */
  action capturePulseEnd = all {
    cap.loop == PulseOut,
    if (linked) all {
      cap' = { ...cap, loop: TopOfTick },
      wire' = wrote(CaptureLoop, Stop, 0, false, true),
      link' = link, ctl' = ctl, event' = Delivered,
    } else all {
      cap' = CAP_IDLE,
      wire' = wire,
      link' = link, ctl' = ctl, event' = Quiet,
    },
  }

  /** The move ends at the top of a tick: converged, timed out or jammed. The run goes on. */
  action captureMoveEnd = all {
    cap.loop == TopOfTick,
    cap.noTel < ABORT_S,
    cap' = { ...cap, loop: NoMove, noTel: 0 },
    link' = link, ctl' = ctl, wire' = wire, event' = Quiet,
  }

  /** The move waited ABORT_S seconds with no streaming link: noTelemetry, which ends the run as faulted. */
  action captureAbort = all {
    cap.loop == TopOfTick,
    cap.noTel >= ABORT_S,
    cap' = CAP_IDLE,
    wire' = stopMotorsWire(CaptureStop),
    link' = link, ctl' = ctl, event' = NoTelemetryAbort,
  }

  /** The run's own mount mode change (bothOrientations), sent with runOwned. With no link the write throws and the run ends. */
  action captureOwnFrame = all {
    cap.phase == CapSweep,
    cap.loop == NoMove,
    if (linked and not(motionRefused(SetMode, true, outsideMotion))) all {
      wire' = wrote(CaptureOwn, SetMode, 0, false, true), cap' = cap, link' = link, ctl' = ctl, event' = Delivered,
    } else all {
      wire' = stopMotorsWire(CaptureStop), cap' = CAP_IDLE, link' = link, ctl' = ctl, event' = Quiet,
    },
  }

  /** Between stations the run parks (awaitStation): a stop, then the gate. */
  action capturePark = all {
    cap.phase == CapSweep,
    cap.loop == NoMove,
    not(cap.cancel),
    cap' = { ...cap, phase: CapParked },
    wire' = stopMotorsWire(CaptureStop),
    link' = link, ctl' = ctl, event' = Quiet,
  }

  /** The park's heartbeat: another stop every STATION_HEARTBEAT_MS. */
  action parkHeartbeat = all {
    cap.phase == CapParked,
    wire' = stopMotorsWire(CaptureStop),
    cap' = cap, link' = link, ctl' = ctl, event' = Quiet,
  }

  /** The run ends: every station swept, or a stop request seen between positions. Its finally block stops the motors. */
  action captureFinish = all {
    cap.phase == CapSweep,
    cap.loop == NoMove,
    cap' = CAP_IDLE,
    wire' = stopMotorsWire(CaptureStop),
    link' = link, ctl' = ctl, event' = Quiet,
  }

  /** POST /api/grid-advance. The run then checks the link once more, in the same instant. */
  action gridAdvance = all {
    parked,
    if (advanceAllowed) all {
      cap' = { ...cap, phase: CapSweep, loop: NoMove, noTel: 0 },
      link' = link, ctl' = ctl, wire' = wire, event' = Quiet,
    } else all {
      cap' = cap, link' = link, ctl' = ctl, wire' = wire, event' = AdvanceRefused,
    },
  }

  /** POST /api/grid-stop: parked, it releases the gate and the run ends; sweeping, it asks the loop to stop. */
  action gridStop = all {
    scanRunning,
    if (parked) all {
      cap' = CAP_IDLE, wire' = stopMotorsWire(CaptureStop), link' = link, ctl' = ctl, event' = Quiet,
    } else all {
      cap' = { ...cap, cancel: true }, wire' = wire, link' = link, ctl' = ctl, event' = Quiet,
    },
  }

  /** STATION_WAIT_MAX_MS passed with no answer: the run ends with the stations it has. */
  action parkTimeout = all {
    parked,
    cap' = CAP_IDLE,
    wire' = stopMotorsWire(CaptureStop),
    link' = link, ctl' = ctl, event' = Quiet,
  }

  // ── Outside moves and probes ─────────────────────────────────────────────────────────────────────

  /** POST /api/move-to or /api/arc-probe: linkRefusal('stream') comes first, before the body is read. */
  action moveRequest(s: int): bool = all {
    ctl.get(s).phase == Free,
    streaming,
    ctl' = ctl.set(s, { ...FREE_CTL, kind: Mover, phase: Checked, checkedEpoch: link.epoch }),
    link' = link, cap' = cap, wire' = wire, event' = Quiet,
  }

  /**
   * The body has arrived: moveRefusal (the arc probe's own "capture owns the gimbal" answer is the same case),
   * then asExternalMotion registers it, with no await between.
   */
  action moveAdmit(s: int): bool = all {
    ctl.get(s).phase == Checked,
    if (moveRefused(outsideMotion)) all {
      ctl' = ctl.set(s, FREE_CTL), link' = link, cap' = cap, wire' = wire, event' = MoveRefused,
    } else all {
      ctl' = ctl.set(s, { ...ctl.get(s), phase: TopOfTickCtl, registered: true, cancelled: false, epoch: link.epoch, noTel: 0, driver: true }),
      link' = link, cap' = cap, wire' = wire, event' = Quiet,
    },
  }

  /**
   * A tick of the move's loop: a cancelled motion returns at the top of the tick; with a streaming link it writes
   * its speed straight to the transport.
   */
  action outsidePulse(s: int): bool = all {
    ctl.get(s).phase == TopOfTickCtl,
    not(ctl.get(s).cancelled),
    streaming,
    ctl' = ctl.set(s, { ...ctl.get(s), phase: PulseOutCtl, noTel: 0 }),
    wire' = wrote(OutsideLoop, Speed, s, false, ctl.get(s).epoch == link.epoch),
    link' = link, cap' = cap, event' = Delivered,
  }

  /**
   * The end of the tick: sendStop. With a link it writes a stop, even for a motion cancelled meanwhile (its link
   * went and another came). With none the write throws, and a move with a motion reads that as cancelled.
   */
  action outsidePulseEnd(s: int): bool = all {
    ctl.get(s).phase == PulseOutCtl,
    if (linked) all {
      ctl' = ctl.set(s, { ...ctl.get(s), phase: TopOfTickCtl }),
      wire' = wrote(OutsideStop, Stop, s, ctl.get(s).cancelled, true),
      link' = link, cap' = cap, event' = Delivered,
    } else all {
      ctl' = ctl.set(s, { ...ctl.get(s), phase: Finishing }),
      wire' = wire, link' = link, cap' = cap, event' = Quiet,
    },
  }

  /** At the top of a tick: cancelled (cancelledOutcome), converged, timed out, jammed, or ABORT_S without telemetry. */
  action outsideMoveEnd(s: int): bool = all {
    ctl.get(s).phase == TopOfTickCtl,
    ctl' = ctl.set(s, { ...ctl.get(s), phase: Finishing }),
    link' = link, cap' = cap, wire' = wire,
    event' = if (ctl.get(s).noTel >= ABORT_S) NoTelemetryAbort else Quiet,
  }

  /**
   * POST /api/test/command-probe: the body, then linkRefusal('stream'), then asExternalMotion and buildAndSend
   * with no await between. Its motion is not counted against its own frame.
   */
  action probeSendWith(s: int, f: Frame): bool = all {
    ctl.get(s).phase == Free,
    streaming,
    if (motionRefused(f, false, otherRegistered(s))) all {
      ctl' = ctl, link' = link, cap' = cap, wire' = wire, event' = Refused(ProbeFrame),
    } else all {
      ctl' = ctl.set(s, { ...FREE_CTL, kind: Prober, phase: ProbeWait, registered: true, epoch: link.epoch, checkedEpoch: link.epoch, driver: isDrive(f) }),
      wire' = wrote(ProbeFrame, f, s, false, true),
      link' = link, cap' = cap, event' = Delivered,
    },
  }

  action probeSend(s: int): bool = { nondet f = oneOf(FRAMES) probeSendWith(s, f) }

  /** After waitMs the probe sends its zero-speed stop through buildAndSend: stops always pass. No link: the write throws. */
  action probeStop(s: int): bool = all {
    ctl.get(s).phase == ProbeWait,
    ctl' = ctl.set(s, { ...ctl.get(s), phase: Finishing }),
    wire' = if (linked) wrote(OutsideStop, Stop, s, ctl.get(s).cancelled, true) else wire,
    link' = link, cap' = cap,
    event' = if (linked) Delivered else Quiet,
  }

  /** The finally blocks: moveToClosedLoop's stopMotors() for a move, then asExternalMotion's delete. */
  action outsideFinish(s: int): bool = all {
    ctl.get(s).phase == Finishing,
    ctl' = ctl.set(s, FREE_CTL),
    wire' = if (ctl.get(s).kind == Mover) stopMotorsWire(OutsideStop) else wire,
    link' = link, cap' = cap, event' = Quiet,
  }

  // ── Step ─────────────────────────────────────────────────────────────────────────────────────────

  action step = any {
    connectBegin,
    connectDone,
    connectFail,
    notify,
    drop,
    disconnectBegin,
    disconnectEnd,
    tick,
    command,
    captureStart,
    captureMoveBegin,
    capturePulse,
    capturePulseEnd,
    captureMoveEnd,
    captureAbort,
    captureOwnFrame,
    capturePark,
    parkHeartbeat,
    captureFinish,
    gridAdvance,
    gridStop,
    parkTimeout,
    nondet s = oneOf(SLOTS)
    any {
      moveRequest(s),
      moveAdmit(s),
      outsidePulse(s),
      outsidePulseEnd(s),
      outsideMoveEnd(s),
      probeSend(s),
      probeStop(s),
      outsideFinish(s),
    },
  }

  // ── Invariants ───────────────────────────────────────────────────────────────────────────────────

  val sent = wire.last
  val fromOutside = sent.src == Command or sent.src == ProbeFrame or sent.src == OutsideLoop

  /** While a scan sweeps (gridRunning, not parked), no outside frame that drives the motors goes out. */
  invariant noOutsideDriveWhileScanSweeps =
    (fromOutside and isDrive(sent.frame)) implies sent.capPhase != CapSweep

  /** A sweeping scan has no outside driver registered: the doors and the interlock keep a second controller off. */
  invariant sweepingScanHasNoOutsideDriver = cap.phase == CapSweep implies activeDrivers == 0

  /** While a scan is parked, at most one outside move or probe drives the motors. */
  invariant parkedScanHasAtMostOneOutsideDriver = parked implies activeDrivers <= 1

  /** While parked, an outside frame that drives goes out only when no other outside driver holds the motors. */
  invariant parkedOutsideDriveIsAlone =
    (fromOutside and isDrive(sent.frame) and sent.capPhase == CapParked) implies sent.otherDrivers == 0

  /** A closed-loop speed pulse (the capture's or an outside move's) goes out only over a streaming link. */
  invariant closedLoopNeedsStreaming =
    ((sent.src == CaptureLoop or sent.src == OutsideLoop) and sent.frame == Speed) implies sent.level == Streaming

  /** Every frame goes out over a linked link: nothing is written while disconnected or connecting. */
  invariant writesNeedALink = sent.src != NoSource implies (sent.level == Linked or sent.level == Streaming)

  /** A motion that was cancelled when its link went writes nothing but stops afterwards. */
  invariant cancelledMotionSendsOnlyStops = sent.fromCancelled implies sent.frame == Stop

  /**
   * A lost link always releases the interlock: when a live link goes, every motion registered on it is cancelled
   * and released, so each registered motion belongs to the current link.
   */
  invariant registeredMotionsAreOnTheCurrentLink =
    SLOTS.forall(s => ctl.get(s).registered implies (ctl.get(s).epoch == link.epoch and not(ctl.get(s).cancelled)))

  /** A closed-loop pulse is written by a loop registered on the current link (the capture's own loop has no motion). */
  invariant pulsesAreOnTheirOwnLink = sent.src == OutsideLoop implies sent.sameLink

  /** The first frame on every link is the connect route's stop. */
  invariant firstFrameOnALinkIsAStop = wire.onLink > 0 implies wire.firstOnLink == Stop

  /** No loop keeps waiting for telemetry past ABORT_S: it gives up, so a lost link ends the move. */
  invariant noLoopWaitsPastTheAbort =
    cap.noTel <= ABORT_S and SLOTS.forall(s => ctl.get(s).noTel <= ABORT_S)

  /** The link reads streaming only within STALE_S of a notification. */
  invariant streamingMeansRecentTelemetry = streaming implies (link.notified and link.age <= STALE_S)

  /** The level a trace carries is the one the fields give. */
  invariant levelIsDerived = link.level == levelOf(link)

  /** A stop is never refused: whatever the interlock's state, an outside stop goes out over a linked link. */
  invariant stopsAreNeverRefused = not(motionRefused(Stop, false, true)) and not(motionRefused(Stop, false, false))

  // ── Witnesses: each invariant's antecedent, and the gaps the code has ────────────────────────────

  /** A scan sweeps: the antecedent of the sweeping invariants. */
  observation scanSweeps = cap.phase == CapSweep and cap.loop == PulseOut
  /** An outside frame that drives was refused while the scan swept. */
  observation outsideDriveRefusedWhileSweeping = event == Refused(Command) and cap.phase == CapSweep
  /** An outside move drives while the scan is parked (the operator carrying the rig). */
  observation outsideMoveWhileParked = parked and sent.src == OutsideLoop and sent.frame == Speed
  /** A second outside driver was refused while the scan was parked (F5-1). */
  observation secondDriverRefusedWhileParked = parked and activeDrivers == 1 and event == MoveRefused
  /** The advance was refused because a move or probe still holds the motors. */
  observation advanceRefusedWhileOutsideHolds = event == AdvanceRefused and outsideMotion and streaming
  /** A capture could not start because a move or probe holds the motors. */
  observation startRefusedWhileOutsideHolds = event == StartRefused and outsideMotion and streaming
  /** The link went while an outside move was registered: it was cancelled and released. */
  observation linkLostUnderAMove = SLOTS.exists(s => ctl.get(s).cancelled and ctl.get(s).phase != Free)
  /** A cancelled move wrote a stop on the next link. */
  observation cancelledMoveStopsOnTheNextLink = sent.fromCancelled and sent.frame == Stop
  /** A move gave up after ABORT_S seconds with no telemetry. */
  observation moveGaveUpWithoutTelemetry = event == NoTelemetryAbort
  /** A second frame went out on a link after the connect route's stop. */
  observation framesAfterTheConnectStop = wire.onLink >= 2
  /** A closed-loop move waited at the top of a tick for a streaming link. */
  observation moveWaitedForTelemetry = cap.noTel > 0 or SLOTS.exists(s => ctl.get(s).noTel > 0)
  /** With no scan running the interlock does not apply: two outside moves can drive at once. */
  observation twoOutsideDriversWithoutAScan = not(scanRunning) and activeDrivers == 2
  /** A move was admitted after the link its route had checked went (the link check is before the body). */
  observation moveAdmittedAfterItsLinkWent = SLOTS.exists(s => ctl.get(s).registered and ctl.get(s).checkedEpoch < ctl.get(s).epoch)
  /** A speed pulse landed between POST /api/disconnect's stop and its teardown, so the latch outlived the link. */
  observation latchedAtOperatorDisconnect = event == LatchedAtTeardown
}

/** The code. */
module gimbalInterlock {
  import gimbalInterlockModel(PARKED_REFUSES_SECOND_DRIVER = true).*
}

/** The planted bug: a parked scan lets a second outside driver in, as before F5-1. The gate requires it to fail. */
module gimbalInterlockBug {
  import gimbalInterlockModel(PARKED_REFUSES_SECOND_DRIVER = false).*
}
