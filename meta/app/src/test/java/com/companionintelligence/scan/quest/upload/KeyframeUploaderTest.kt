package com.companionintelligence.scan.quest.upload

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Collections

class KeyframeUploaderTest {
    private val https = HttpsTestServer()
    private val sleeps: MutableList<Long> = Collections.synchronizedList(ArrayList())
    private var uploader: KeyframeUploader? = null

    @After
    fun tearDown() {
        uploader?.close()
        https.close()
    }

    private fun newUploader(maxQueued: Int = 4) =
        KeyframeUploader(maxQueuedFrames = maxQueued, sleeper = { sleeps.add(it) }).also { uploader = it }

    private fun json(code: Int, body: String = "{}") =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun awaitState(u: KeyframeUploader, vararg states: KeyframeUploader.State): KeyframeUploader.Status {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            val s = u.status()
            if (s.state in states) return s
            Thread.sleep(10)
        }
        fail("uploader never reached ${states.toList()}; status ${u.status()}")
        error("unreachable")
    }

    private fun metaIndex(request: RecordedRequest): Int {
        val body = request.body.readUtf8()
        val start = body.indexOf("{\"index\"")
        val text = body.substring(start, body.indexOf('}', start) + 1)
        return (Json.parseToJsonElement(text) as JsonObject)["index"]!!.jsonPrimitive.int
    }

    @Test
    fun opensSendsInOrderAndFinalizes() {
        https.server.enqueue(json(201, """{"sessionId":"sess-1"}"""))
        https.server.enqueue(json(200, """{"ok":true,"index":0}"""))
        https.server.enqueue(json(200, """{"ok":true,"index":1}"""))
        https.server.enqueue(json(200, """{"sessionId":"sess-1","keyframeCount":2}"""))
        val u = newUploader()
        assertTrue(u.start(https.scanClient()))
        assertTrue(u.offer(byteArrayOf(1)) { i -> """{"index":$i}""" })
        assertTrue(u.offer(byteArrayOf(2)) { i -> """{"index":$i}""" })
        u.finish()
        val status = awaitState(u, KeyframeUploader.State.FINISHED, KeyframeUploader.State.FAILED)
        assertEquals(KeyframeUploader.State.FINISHED, status.state)
        assertEquals(2, status.sent)
        assertTrue(status.finalized)
        assertEquals("sess-1", status.sessionId)

        assertEquals("/sessions", https.server.takeRequest().path)
        val first = https.server.takeRequest()
        assertEquals("/sessions/sess-1/keyframes", first.path)
        assertEquals(0, metaIndex(first))
        assertEquals(1, metaIndex(https.server.takeRequest()))
        assertEquals("/sessions/sess-1/finalize", https.server.takeRequest().path)
    }

    @Test
    fun retriesWithExponentialBackoff() {
        https.server.enqueue(json(201, """{"sessionId":"sess-2"}"""))
        https.server.enqueue(json(503))
        https.server.enqueue(json(503))
        https.server.enqueue(json(200, """{"ok":true,"index":0}"""))
        https.server.enqueue(json(200))
        val u = newUploader()
        u.start(https.scanClient())
        u.offer(byteArrayOf(1)) { i -> """{"index":$i}""" }
        u.finish()
        val status = awaitState(u, KeyframeUploader.State.FINISHED, KeyframeUploader.State.FAILED)
        assertEquals(1, status.sent)
        assertEquals(0, status.failed)
        assertEquals(listOf(500L, 1000L), sleeps.toList())
        assertEquals(5, https.server.requestCount)
    }

    @Test
    fun aServerWithSignInOnStopsTheCapture() {
        https.server.enqueue(json(401, """{"error":"A Companion session is required"}"""))
        val u = newUploader()
        u.start(https.scanClient())
        val status = awaitState(u, KeyframeUploader.State.FAILED)
        assertTrue(status.signInRequired)
        assertEquals(ScanServerClient.SIGN_IN_MESSAGE, status.lastError)
        assertFalse("nothing more is accepted", u.offer(byteArrayOf(1)) { i -> """{"index":$i}""" })
        assertEquals("no retries for a 4xx", 1, https.server.requestCount)
    }

    @Test
    fun aFullSessionStopsOfferingButStillFinalizes() {
        https.server.enqueue(json(201, """{"sessionId":"sess-3"}"""))
        https.server.enqueue(json(413, """{"error":"session keyframes would exceed 2147483648 bytes"}"""))
        https.server.enqueue(json(200))
        val u = newUploader()
        u.start(https.scanClient())
        u.offer(byteArrayOf(1)) { i -> """{"index":$i}""" }
        val deadline = System.currentTimeMillis() + 15_000
        while (u.status().failed == 0 && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertFalse(u.hasRoom())
        assertFalse(u.offer(byteArrayOf(2)) { i -> """{"index":$i}""" })
        u.finish()
        val status = awaitState(u, KeyframeUploader.State.FINISHED, KeyframeUploader.State.FAILED)
        assertEquals(KeyframeUploader.State.FINISHED, status.state)
        assertTrue(status.lastError!!.contains("would exceed"))
        assertEquals(3, https.server.requestCount)
    }

    @Test
    fun theIndexStopsAt1999() {
        https.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path == "/sessions") json(201, """{"sessionId":"sess-4"}""") else json(200)
        }
        val u = newUploader(maxQueued = 2_100)
        u.start(https.scanClient())
        val indexes = ArrayList<Int>()
        repeat(KeyframeMeta.MAX_INDEX + 1) {
            assertTrue(u.offer(byteArrayOf(1)) { i -> indexes.add(i); """{"index":$i}""" })
        }
        assertFalse(u.offer(byteArrayOf(1)) { i -> """{"index":$i}""" })
        assertEquals((0..1999).toList(), indexes)
        assertTrue(u.status().lastError!!.contains("2000"))
        u.finish()
        val status = awaitState(u, KeyframeUploader.State.FINISHED, KeyframeUploader.State.FAILED)
        assertEquals(2000, status.sent)
    }

    @Test
    fun anotherCaptureCannotStartWhileOneIsOpen() {
        https.server.enqueue(json(201, """{"sessionId":"sess-5"}"""))
        https.server.enqueue(json(200))
        val u = newUploader()
        assertTrue(u.start(https.scanClient()))
        assertFalse(u.start(https.scanClient()))
        u.finish()
        awaitState(u, KeyframeUploader.State.FINISHED, KeyframeUploader.State.FAILED)
        https.server.enqueue(json(201, """{"sessionId":"sess-6"}"""))
        assertTrue("a finished capture can be followed by a new one", u.start(https.scanClient()))
    }
}
