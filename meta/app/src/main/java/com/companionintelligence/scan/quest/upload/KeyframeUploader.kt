package com.companionintelligence.scan.quest.upload

import java.io.Closeable
import java.util.concurrent.LinkedBlockingQueue

/**
 * Sends one capture's keyframes on a thread of its own: opens a session, posts JPEG keyframes in order, then
 * finalizes. Modelled on the web client's KeyframeStreamer (src/capture/keyframes.ts):
 *
 * - a bounded queue: a keyframe offered while [maxQueuedFrames] are waiting is skipped, not buffered;
 * - one request in flight, retried with exponential backoff, and a pause after a frame fails every attempt;
 * - a 4xx is final (a same-index retry would be safe, the server overwrites, but a 4xx will not change);
 *   408 and 429 are retried like a 5xx;
 * - a frame belongs to the capture it was taken in and is never sent to a later one.
 *
 * Nothing here runs on the render thread: [offer], [start], [finish] and [status] only touch the queue and a
 * lock. The listener-free design is deliberate: the panel polls [status].
 */
class KeyframeUploader(
    private val maxQueuedFrames: Int = 4,
    private val maxAttempts: Int = 4,
    private val baseBackoffMs: Long = 500,
    private val maxBackoffMs: Long = 8_000,
    private val pauseAfterFailureMs: Long = 10_000,
    private val drainTimeoutMs: Long = 20_000,
    private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) : Closeable {

    enum class State { IDLE, OPENING, ACTIVE, FINALIZING, FINISHED, FAILED }

    data class Status(
        val state: State,
        val sessionId: String?,
        val sent: Int,
        val queued: Int,
        val skipped: Int,
        val failed: Int,
        val lastError: String?,
        val signInRequired: Boolean,
        val finalized: Boolean,
    )

    private sealed interface Job {
        val generation: Int
    }

    private data class Open(override val generation: Int, val client: ScanServerClient) : Job
    private class Frame(override val generation: Int, val index: Int, val jpeg: ByteArray, val meta: String) : Job
    private data class Finalize(override val generation: Int) : Job
    private object Stop : Job {
        override val generation = -1
    }

    private val jobs = LinkedBlockingQueue<Job>()
    private val lock = Any()

    // Everything below is guarded by `lock`.
    private var generation = 0
    private var state = State.IDLE
    private var client: ScanServerClient? = null
    private var sessionId: String? = null
    private var nextIndex = 0
    private var queuedFrames = 0
    private var sent = 0
    private var skipped = 0
    private var failed = 0
    private var lastError: String? = null
    private var signInRequired = false
    private var finalized = false
    private var sessionFull = false
    private var pausedUntilMs = 0L
    private var drainDeadlineMs = Long.MAX_VALUE

    private val worker = Thread(::runLoop, "keyframe-uploader").apply {
        isDaemon = true
        start()
    }

    /** Begins a new capture against [client]. Refused (false) while a capture is still open or finalizing. */
    fun start(client: ScanServerClient): Boolean = synchronized(lock) {
        if (state == State.OPENING || state == State.ACTIVE || state == State.FINALIZING) return false
        generation++
        state = State.OPENING
        this.client = client
        sessionId = null
        nextIndex = 0
        queuedFrames = 0
        sent = 0
        skipped = 0
        failed = 0
        lastError = null
        signInRequired = false
        finalized = false
        sessionFull = false
        pausedUntilMs = 0
        drainDeadlineMs = Long.MAX_VALUE
        jobs.add(Open(generation, client))
        true
    }

    /** True when a keyframe offered now would be accepted. Cheap; the camera thread asks before copying a frame. */
    fun hasRoom(): Boolean = synchronized(lock) { acceptingLocked() && queuedFrames < maxQueuedFrames }

    /**
     * Queues a keyframe. [buildMeta] gets the index the frame will be sent under (0, 1, 2 … in offer order) and
     * returns the meta JSON. Returns false, counting the frame as skipped, when it cannot be queued.
     */
    fun offer(jpeg: ByteArray, buildMeta: (index: Int) -> String): Boolean {
        val index: Int
        val gen: Int
        synchronized(lock) {
            if (!acceptingLocked() || queuedFrames >= maxQueuedFrames) {
                if (state == State.OPENING || state == State.ACTIVE) skipped++
                return false
            }
            if (nextIndex > KeyframeMeta.MAX_INDEX) {
                skipped++
                lastError = "Keyframe limit reached (${KeyframeMeta.MAX_INDEX + 1} per session, server/main.ts)"
                return false
            }
            index = nextIndex++
            gen = generation
            queuedFrames++
        }
        val meta = try {
            buildMeta(index)
        } catch (e: IllegalArgumentException) {
            synchronized(lock) {
                queuedFrames--
                failed++
                lastError = "Keyframe $index not sent: ${e.message}"
            }
            return false
        }
        jobs.add(Frame(gen, index, jpeg, meta))
        return true
    }

    /** Ends the capture: frames already queued are sent (within [drainTimeoutMs]), then the session is finalized. */
    fun finish() {
        synchronized(lock) {
            if (state != State.OPENING && state != State.ACTIVE) return
            state = State.FINALIZING
            drainDeadlineMs = clockMs() + drainTimeoutMs
            jobs.add(Finalize(generation))
        }
    }

    fun status(): Status = synchronized(lock) {
        Status(state, sessionId, sent, queuedFrames, skipped, failed, lastError, signInRequired, finalized)
    }

    /**
     * Stops the worker once the jobs already queued are done, so a finalize queued by [finish] is still sent.
     * The worker is a daemon thread and does not keep the process alive.
     */
    override fun close() {
        jobs.add(Stop)
    }

    private fun acceptingLocked(): Boolean =
        (state == State.OPENING || state == State.ACTIVE) && !sessionFull && clockMs() >= pausedUntilMs

    private fun runLoop() {
        try {
            while (true) {
                when (val job = jobs.take()) {
                    is Stop -> return
                    is Open -> handleOpen(job)
                    is Frame -> handleFrame(job)
                    is Finalize -> handleFinalize(job)
                }
            }
        } catch (_: InterruptedException) {
            // close() was called.
        }
    }

    private fun isCurrent(job: Job): Boolean = synchronized(lock) { job.generation == generation }

    private fun handleOpen(job: Open) {
        if (!isCurrent(job)) return
        when (val result = withRetries { job.client.openSession() }) {
            is CallResult.Ok -> synchronized(lock) {
                if (job.generation != generation) return
                sessionId = result.value
                if (state == State.OPENING) state = State.ACTIVE
            }
            is CallResult.Fail -> failCapture(job.generation, result.reason, result.kind == FailKind.SIGN_IN_REQUIRED)
            is CallResult.Retry -> failCapture(job.generation, "Could not open a session: ${result.reason}", false)
        }
    }

    private fun handleFrame(job: Frame) {
        val (id, target) = synchronized(lock) {
            queuedFrames--
            val current = job.generation == generation
            val usable = current && (state == State.ACTIVE || state == State.FINALIZING) && !sessionFull
            if (!usable || sessionId == null) {
                if (current) failed++
                return
            }
            if (state == State.FINALIZING && clockMs() > drainDeadlineMs) {
                failed++
                lastError = "Stopped before every keyframe was sent"
                return
            }
            sessionId!! to client!!
        }
        val result = withRetries { target.postKeyframe(id, job.index, job.jpeg, job.meta) }
        synchronized(lock) {
            if (job.generation != generation) return
            when (result) {
                is CallResult.Ok -> sent++
                is CallResult.Retry -> {
                    failed++
                    lastError = "Keyframe ${job.index} not sent: ${result.reason}"
                    pausedUntilMs = clockMs() + pauseAfterFailureMs
                }
                is CallResult.Fail -> {
                    failed++
                    lastError = result.reason
                    when (result.kind) {
                        FailKind.SIGN_IN_REQUIRED -> {
                            signInRequired = true
                            state = State.FAILED
                        }
                        FailKind.NOT_FOUND -> state = State.FAILED
                        // The server says the session is over its byte budget (or this frame is over the cap):
                        // nothing later would fit either, so stop offering and still finalize.
                        FailKind.TOO_LARGE -> sessionFull = true
                        FailKind.REJECTED, FailKind.BAD_RESPONSE -> Unit
                    }
                }
            }
        }
    }

    private fun handleFinalize(job: Finalize) {
        val (id, target) = synchronized(lock) {
            if (job.generation != generation || state != State.FINALIZING) return
            val id = sessionId
            if (id == null) {
                state = State.FAILED
                return
            }
            id to client!!
        }
        val result = withRetries { target.finalizeSession(id) }
        synchronized(lock) {
            if (job.generation != generation) return
            when (result) {
                is CallResult.Ok -> {
                    finalized = true
                    state = State.FINISHED
                }
                is CallResult.Fail -> {
                    lastError = "Finalize failed: ${result.reason}"
                    if (result.kind == FailKind.SIGN_IN_REQUIRED) signInRequired = true
                    state = State.FAILED
                }
                is CallResult.Retry -> {
                    lastError = "Finalize failed: ${result.reason}"
                    state = State.FAILED
                }
            }
        }
    }

    private fun failCapture(gen: Int, reason: String, signIn: Boolean) = synchronized(lock) {
        if (gen != generation) return@synchronized
        state = State.FAILED
        lastError = reason
        if (signIn) signInRequired = true
    }

    /** Runs [attempt] up to [maxAttempts] times while it says Retry, sleeping 0.5 s, 1 s, 2 s … (capped) between. */
    private fun <T> withRetries(attempt: () -> CallResult<T>): CallResult<T> {
        var result = attempt()
        var n = 1
        while (result is CallResult.Retry && n < maxAttempts) {
            sleeper(minOf(maxBackoffMs, baseBackoffMs shl (n - 1)))
            result = attempt()
            n++
        }
        return result
    }
}
