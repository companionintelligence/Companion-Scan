package com.companionintelligence.scan.quest.upload

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    private fun ok(input: String) = (ServerAddress.parse(input) as ServerAddress.Parsed.Ok).baseUrl.toString()

    private fun refused(input: String) = (ServerAddress.parse(input) as ServerAddress.Parsed.Refused).reason

    @Test
    fun httpsAddressesAreKept() {
        assertEquals("https://scan.example.ts.net/", ok("https://scan.example.ts.net"))
        assertEquals("https://scan.example.ts.net:8443/", ok("  HTTPS://scan.example.ts.net:8443/  "))
    }

    @Test
    fun aBareHostGetsHttps() {
        assertEquals("https://scan.example.ts.net/", ok("scan.example.ts.net"))
    }

    @Test
    fun httpIsRefusedNotUpgraded() {
        assertTrue(refused("http://scan.example.ts.net").contains("http://"))
        assertTrue(refused("HTTP://scan.example.ts.net").contains("http://"))
        refused("ftp://scan.example.ts.net")
        refused("ws://scan.example.ts.net")
    }

    @Test
    fun credentialsQueriesAndBlanksAreRefused() {
        refused("https://user:secret@scan.example.ts.net")
        refused("https://scan.example.ts.net/?token=abc")
        refused("https://scan.example.ts.net/#x")
        refused("")
        refused("   ")
        refused("https://")
    }

    @Test
    fun aPathPrefixIsKeptAndRoutesGoUnderIt() {
        val base = ok("https://scan.example.ts.net/api")
        assertEquals("https://scan.example.ts.net/api/", base)
        assertEquals(
            "https://scan.example.ts.net/api/sessions/sess%20a/keyframes",
            ServerAddress.route(base.toHttpUrl(), "sessions", "sess a", "keyframes").toString(),
        )
        assertEquals(
            "https://scan.example.ts.net/sessions",
            ServerAddress.route("https://scan.example.ts.net/".toHttpUrl(), "sessions").toString(),
        )
    }

    @Test
    fun aSessionIdCannotEscapeItsSegment() {
        val url = ServerAddress.route("https://h.example/".toHttpUrl(), "sessions", "../scans", "finalize")
        assertEquals(listOf("sessions", "..%2Fscans", "finalize"), url.encodedPathSegments)
    }
}
