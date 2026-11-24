package com.companionintelligence.scan.quest.auth

import com.companionintelligence.scan.quest.upload.HttpsTestServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

/** The sign-in state in memory, as the tests keep it (the app keeps it in AppSettings). */
class MemoryStore : SignInStore {
    override var pending: PendingSignIn? = null
    override var session: ShellSession? = null
    override var seenCodes: List<String> = emptyList()
}

class PkceTest {
    @Test
    fun theChallengeIsRfc7636sOwnExample() {
        // RFC 7636, Appendix B: the verifier made from its 32 example octets, and the S256 challenge of it.
        val pkce = Pkce.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkce.challenge)
    }

    @Test
    fun aNewPairHasTheShapeTheServerChecks() {
        // server/portal_auth.ts PKCE_SHAPE is /^[A-Za-z0-9_-]{43}$/, for the challenge and the verifier alike.
        val shape = Regex("^[A-Za-z0-9_-]{43}$")
        val seen = HashSet<String>()
        repeat(20) {
            val pkce = Pkce.create()
            assertTrue(pkce.verifier, shape.matches(pkce.verifier))
            assertTrue(pkce.challenge, shape.matches(pkce.challenge))
            assertEquals(Pkce.challengeOf(pkce.verifier), pkce.challenge)
            assertTrue("a verifier is never made twice", seen.add(pkce.verifier))
        }
    }
}

class SignInReturnTest {
    private val code = "A".repeat(21) + "-_" + "z".repeat(20)

    @Test
    fun theCodeIsReadFromTheServersReturn() {
        assertEquals(43, code.length)
        assertEquals(code, SignInReturn.codeOf("com.companionintelligence.scan.quest://auth?code=$code"))
        assertEquals(code, SignInReturn.codeOf("com.companionintelligence.scan.quest://auth?x=1&code=$code"))
    }

    @Test
    fun anythingElseIsNotAReturn() {
        // The phone app's scheme, the desktop app's, another host, no code, and codes of another shape.
        assertNull(SignInReturn.codeOf("com.companionintelligence.scan://auth?code=$code"))
        assertNull(SignInReturn.codeOf("computer.ci.scan.desktop://auth?code=$code"))
        assertNull(SignInReturn.codeOf("com.companionintelligence.scan.quest://other?code=$code"))
        assertNull(SignInReturn.codeOf("com.companionintelligence.scan.quest://auth"))
        assertNull(SignInReturn.codeOf("com.companionintelligence.scan.quest://auth?code="))
        assertNull(SignInReturn.codeOf("com.companionintelligence.scan.quest://auth?code=${code}x"))
        assertNull(SignInReturn.codeOf("com.companionintelligence.scan.quest://auth?code=${code.dropLast(1)}!"))
        assertNull(SignInReturn.codeOf("https://scan.example/authenticate?code=$code"))
    }
}

class QuestSignInTest {
    private val https = HttpsTestServer()
    private val store = MemoryStore()
    private var now = 1_000_000L
    private val signIn = QuestSignIn(store, https.client, clockMs = { now }, random = SecureRandom())
    private val code = "c".repeat(43)
    private val back = "com.companionintelligence.scan.quest://auth?code=$code"

    @After
    fun tearDown() = https.close()

    private fun json(code: Int, body: String) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun beginOpensTheServersSignInWithShellQuestAndTheChallenge() {
        val server = https.server.url("/scan/")
        val url = signIn.begin(server)
        assertEquals("/scan/authenticate/oidc", url.encodedPath)
        assertEquals("quest", url.queryParameter("shell"))
        val pending = store.pending!!
        assertEquals(Pkce.challengeOf(pending.verifier), url.queryParameter("challenge"))
        assertEquals(server.toString(), pending.server)
        assertTrue(signIn.waiting())
    }

    @Test
    fun theReturnIsTradedForTheSessionTokenWithTheVerifier() {
        val server = https.server.url("/")
        signIn.begin(server)
        val verifier = store.pending!!.verifier
        https.server.enqueue(json(200, """{"token":"signed.session.token","email":"person@example.com","name":null}"""))

        val result = signIn.finish(back)
        assertEquals(QuestSignIn.Finished.SignedIn("person@example.com"), result)
        assertEquals(ShellSession("signed.session.token", server.toString(), "person@example.com"), store.session)
        assertNull("the verifier is used once", store.pending)

        val request = https.server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/authenticate/shell/exchange", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()) as JsonObject
        assertEquals(code, body["code"]!!.jsonPrimitive.content)
        assertEquals(verifier, body["verifier"]!!.jsonPrimitive.content)
    }

    @Test
    fun aRefusedExchangeSaysWhyAndKeepsNoSession() {
        signIn.begin(https.server.url("/"))
        https.server.enqueue(json(400, """{"error":"Sign-in expired. Start again."}"""))
        val result = signIn.finish(back) as QuestSignIn.Finished.Failed
        assertTrue(result.reason, result.reason.contains("HTTP 400") && result.reason.contains("Sign-in expired"))
        assertNull(store.session)
    }

    @Test
    fun aReplayedCodeAStaleSignInAndALinkWithoutACodeChangeNothing() {
        signIn.begin(https.server.url("/"))
        https.server.enqueue(json(200, """{"token":"t1","email":null}"""))
        assertTrue(signIn.finish(back) is QuestSignIn.Finished.SignedIn)

        // The same return handed over again (an activity re-created with its old intent) is not a second sign-in.
        signIn.begin(https.server.url("/"))
        val waiting = store.pending
        assertEquals(QuestSignIn.Finished.Ignored, signIn.finish(back))
        assertEquals("the sign-in in progress is left as it was", waiting, store.pending)

        // A link any page could open, without a real code, cancels nothing either.
        assertEquals(QuestSignIn.Finished.Ignored, signIn.finish("com.companionintelligence.scan.quest://auth?code=nope"))
        assertEquals(waiting, store.pending)

        // A return after ten minutes is for a sign-in the app has given up on.
        now += QuestSignIn.PENDING_TTL_MS + 1
        assertEquals(QuestSignIn.Finished.Ignored, signIn.finish("com.companionintelligence.scan.quest://auth?code=${"d".repeat(43)}"))
        assertEquals("only the first sign-in reached the server", 1, https.server.requestCount)
    }

    @Test
    fun aReturnWithNoSignInWaitingIsIgnored() {
        assertEquals(QuestSignIn.Finished.Ignored, signIn.finish(back))
        assertEquals(0, https.server.requestCount)
    }

    @Test
    fun theLatestTenCodesAreRemembered() {
        repeat(12) { i -> signIn.finish("com.companionintelligence.scan.quest://auth?code=${i.toString().padStart(43, 'k')}") }
        assertEquals(QuestSignIn.CODES_KEPT, store.seenCodes.size)
        assertEquals("11".padStart(43, 'k'), store.seenCodes.first())
    }

}

class SessionBearerTest {
    private val https = HttpsTestServer()
    private val store = MemoryStore()
    private val client = https.client.newBuilder().addInterceptor(SessionBearer(store)).build()

    @After
    fun tearDown() = https.close()

    private fun get(path: String, auth: String? = null) =
        client.newCall(
            Request.Builder().url(https.server.url(path)).apply { if (auth != null) header("Authorization", auth) }.build(),
        ).execute().use { it.code }

    @Test
    fun theTokenGoesToItsServerAndNoOtherOrigin() {
        store.session = ShellSession("tok", https.server.url("/").toString(), null)
        https.server.enqueue(MockResponse().setResponseCode(200))
        get("/sessions")
        assertEquals("Bearer tok", https.server.takeRequest().getHeader("Authorization"))

        // The same host on another port is another origin.
        val elsewhere = https.server.url("/").newBuilder().port(https.server.port + 1).build().toString()
        store.session = ShellSession("tok", elsewhere, null)
        https.server.enqueue(MockResponse().setResponseCode(200))
        get("/scans/a.splat.ply")
        assertNull(https.server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun aRequestsOwnAuthorizationIsKept() {
        store.session = ShellSession("tok", https.server.url("/").toString(), null)
        https.server.enqueue(MockResponse().setResponseCode(200))
        get("/sessions", auth = "Bearer other")
        assertEquals("Bearer other", https.server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun aRefusedTokenIsForgottenButARefusedAccountIsNot() {
        val mine = ShellSession("tok", https.server.url("/").toString(), "person@example.com")
        store.session = mine
        https.server.enqueue(MockResponse().setResponseCode(403))
        assertEquals(403, get("/sessions"))
        assertEquals("a 403 is the account, and a new sign-in would not change it", mine, store.session)
        https.server.enqueue(MockResponse().setResponseCode(401))
        assertEquals(401, get("/sessions"))
        assertNull("a 401 is the token: it no longer signs in", store.session)
    }

    @Test
    fun originsAreSchemeHostAndPort() {
        assertTrue(SessionBearer.sameOrigin("https://scan.example/scan/sessions".toHttpUrl(), "https://scan.example/scan/"))
        assertTrue(!SessionBearer.sameOrigin("https://scan.example:8443/sessions".toHttpUrl(), "https://scan.example/"))
        assertTrue(!SessionBearer.sameOrigin("https://other.example/sessions".toHttpUrl(), "https://scan.example/"))
        assertTrue(!SessionBearer.sameOrigin("https://scan.example/sessions".toHttpUrl(), "not a url"))
    }
}
