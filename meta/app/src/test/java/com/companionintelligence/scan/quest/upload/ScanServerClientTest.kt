package com.companionintelligence.scan.quest.upload

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ScanServerClientTest {
    private val https = HttpsTestServer()

    @After
    fun tearDown() = https.close()

    private fun json(code: Int, body: String) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun openSessionPostsAnEmptyJsonObjectToSessions() {
        https.server.enqueue(json(201, """{"sessionId":"sess-abc","startedAt":"2026-11-23T10:00:00Z","keyframeCount":0}"""))
        val result = https.scanClient().openSession()
        assertEquals(CallResult.Ok("sess-abc"), result)
        val request = https.server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/sessions", request.path)
        assertEquals("{}", request.body.readUtf8())
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
    }

    @Test
    fun aKeyframeIsMultipartImageAndMeta() {
        https.server.enqueue(json(200, """{"ok":true,"index":3}"""))
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3, 0xFF.toByte(), 0xD9.toByte())
        val meta = """{"index":3,"pose":{}}"""
        assertEquals(CallResult.Ok(Unit), https.scanClient().postKeyframe("sess-abc", 3, jpeg, meta))
        val request = https.server.takeRequest()
        assertEquals("/sessions/sess-abc/keyframes", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        val body = request.body.readUtf8()
        assertTrue(body.contains("Content-Disposition: form-data; name=\"image\"; filename=\"kf-3.jpg\""))
        assertTrue(body.contains("Content-Type: image/jpeg"))
        assertTrue(body.contains("Content-Disposition: form-data; name=\"meta\""))
        assertTrue(body.contains(meta))
    }

    @Test
    fun finalizePostsAnEmptyJsonObject() {
        https.server.enqueue(json(200, """{"sessionId":"sess-abc","keyframeCount":2}"""))
        assertEquals(CallResult.Ok(Unit), https.scanClient().finalizeSession("sess-abc"))
        val request = https.server.takeRequest()
        assertEquals("/sessions/sess-abc/finalize", request.path)
        assertEquals("{}", request.body.readUtf8())
    }

    @Test
    fun aPathPrefixIsKept() {
        https.server.enqueue(json(201, """{"sessionId":"s1"}"""))
        https.scanClient("/scan/").openSession()
        assertEquals("/scan/sessions", https.server.takeRequest().path)
    }

    @Test
    fun responsesAreClassified() {
        https.server.enqueue(json(401, """{"error":"sign in"}"""))
        val signIn = https.scanClient().openSession() as CallResult.Fail
        assertEquals(FailKind.SIGN_IN_REQUIRED, signIn.kind)
        assertEquals(ScanServerClient.SIGN_IN_MESSAGE, signIn.reason)

        assertEquals(FailKind.SIGN_IN_REQUIRED, (ScanServerClient.classify(403, "") as CallResult.Fail).kind)
        assertTrue(ScanServerClient.classify(503, "") is CallResult.Retry)
        assertTrue(ScanServerClient.classify(500, """{"error":"x"}""") is CallResult.Retry)
        assertTrue(ScanServerClient.classify(429, "") is CallResult.Retry)
        assertTrue(ScanServerClient.classify(408, "") is CallResult.Retry)
        val tooLarge = ScanServerClient.classify(413, """{"error":"session keyframes would exceed 2147483648 bytes"}""") as CallResult.Fail
        assertEquals(FailKind.TOO_LARGE, tooLarge.kind)
        assertTrue(tooLarge.reason.contains("would exceed"))
        assertEquals(FailKind.NOT_FOUND, (ScanServerClient.classify(404, "") as CallResult.Fail).kind)
        assertEquals(FailKind.REJECTED, (ScanServerClient.classify(400, "") as CallResult.Fail).kind)
    }

    @Test
    fun aSessionWithoutAnIdIsABadResponse() {
        https.server.enqueue(json(201, """{"startedAt":"x"}"""))
        assertEquals(FailKind.BAD_RESPONSE, (https.scanClient().openSession() as CallResult.Fail).kind)
    }

    @Test
    fun noResponseIsRetryable() {
        val url = https.server.url("/")
        https.close()
        assertTrue(ScanServerClient(url, https.client).openSession() is CallResult.Retry)
    }

    @Test
    fun plainHttpIsImpossible() {
        assertThrows(IllegalArgumentException::class.java) {
            ScanServerClient("http://scan.example.ts.net/".toHttpUrl(), https.client)
        }
        // The client itself has no cleartext connection spec, so even a direct call to an http URL fails.
        val plain = https.server.url("/sessions").newBuilder().scheme("http").build()
        assertThrows(IOException::class.java) {
            https.client.newCall(Request.Builder().url(plain).build()).execute()
        }
    }
}
