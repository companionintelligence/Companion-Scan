package com.companionintelligence.scan.quest.auth

import com.companionintelligence.scan.quest.upload.ServerAddress
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.SecureRandom

/**
 * Companion Account sign-in for the Quest app: the phone shells' flow (src/shared/shell-sign-in.ts), in Kotlin, against
 * the same routes (server/portal_auth.ts). ADR 0001: no new route or token type, only the Quest's own return URL.
 *
 *   1. [begin] makes a PKCE pair, keeps the verifier, and gives the address to open in the system browser:
 *      `GET <server>/authenticate/oidc?shell=quest&challenge=<S256 challenge>`.
 *   2. The server runs the usual Companion Account sign-in, then redirects to
 *      `com.companionintelligence.scan.quest://auth?code=<one-time code, 60 s>` (SignInReturn).
 *   3. [finish] trades the code and the verifier at `POST <server>/authenticate/shell/exchange {code, verifier}` for
 *      `{ token, email, name }`, the reply the phone and desktop shells get, and keeps the token.
 *   4. From then on SessionBearer sends `Authorization: Bearer <token>` on every request to that server's origin.
 *
 * A link to the app's scheme without a code of the server's shape, a code handed over before, or a code with no sign-in of
 * this app's waiting for it, is ignored and leaves a sign-in in progress as it was, as finishShellSignIn() does. A sign-in
 * that has not come back within [PENDING_TTL_MS] is abandoned.
 *
 * The server half of `shell=quest` is server-core's (wave 14). A server without it treats the request as a web sign-in and
 * never returns to the app. Not yet run on a headset.
 */
class QuestSignIn(
    private val store: SignInStore,
    private val http: OkHttpClient,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val random: SecureRandom = SecureRandom(),
) {
    sealed interface Finished {
        /** Not a return for a sign-in this app started: nothing changed. */
        data object Ignored : Finished

        data class SignedIn(val email: String?) : Finished

        data class Failed(val reason: String) : Finished
    }

    /** Starts a sign-in to [server], the saved base address, and returns the address to open in the system browser. */
    @Synchronized
    fun begin(server: HttpUrl): HttpUrl {
        val pkce = Pkce.create(random)
        store.pending = PendingSignIn(pkce.verifier, server.toString(), clockMs())
        return signInUrl(server, pkce.challenge)
    }

    /** True while a sign-in this app started is waiting for the browser to hand back. */
    fun waiting(): Boolean {
        val pending = store.pending ?: return false
        return clockMs() - pending.startedAtMs <= PENDING_TTL_MS
    }

    /** Finishes the sign-in that came back through [url]. Blocking (one HTTPS call), so it runs off the main thread. */
    @Synchronized
    fun finish(url: String): Finished {
        val code = SignInReturn.codeOf(url) ?: return Finished.Ignored
        if (seenBefore(code)) return Finished.Ignored
        val pending = store.pending ?: return Finished.Ignored
        if (clockMs() - pending.startedAtMs > PENDING_TTL_MS) {
            store.pending = null
            return Finished.Ignored
        }
        store.pending = null
        val server = pending.server.toHttpUrlOrNull()
            ?: return Finished.Failed("The sign-in was started against an address that is not valid; sign in again")
        return exchange(server, code, pending.verifier)
    }

    private fun exchange(server: HttpUrl, code: String, verifier: String): Finished {
        val body = buildJsonObject {
            put("code", code)
            put("verifier", verifier)
        }.toString()
        val request = Request.Builder()
            .url(ServerAddress.route(server, "authenticate", "shell", "exchange"))
            .post(body.toRequestBody(JSON))
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                val reply = runCatching { Json.parseToJsonElement(response.body?.string().orEmpty()) }.getOrNull() as? JsonObject
                val token = text(reply, "token")
                if (!response.isSuccessful || token.isNullOrBlank()) {
                    val why = text(reply, "error")?.take(200)
                    Finished.Failed("The sign-in did not finish (HTTP ${response.code})${why?.let { ": $it" } ?: ""}")
                } else {
                    // Signed in only once the token is kept: without it the app has no session to use.
                    val email = text(reply, "email")
                    store.session = ShellSession(token, server.toString(), email)
                    Finished.SignedIn(email)
                }
            }
        } catch (e: IOException) {
            Finished.Failed("The sign-in did not finish: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    /**
     * Notes [code] as handed to the app, and says whether it was handed over before. The latest [CODES_KEPT] are kept, the
     * most recent first, so a launch intent handed back again (an activity re-created with the same intent) is known.
     */
    private fun seenBefore(code: String): Boolean {
        val seen = store.seenCodes
        store.seenCodes = (listOf(code) + seen.filter { it != code }).take(CODES_KEPT)
        return code in seen
    }

    companion object {
        /** As src/shared/shell-sign-in.ts: a sign-in that has not come back to the app in this long is abandoned. */
        const val PENDING_TTL_MS = 10 * 60_000L

        /** As src/shared/shell-sign-in.ts: how many of the latest return codes the app remembers. */
        const val CODES_KEPT = 10

        private val JSON = "application/json; charset=utf-8".toMediaType()

        /** The server path that starts a Quest sign-in, with the app's PKCE challenge. */
        fun signInUrl(server: HttpUrl, challenge: String): HttpUrl =
            ServerAddress.route(server, "authenticate", "oidc").newBuilder()
                .addQueryParameter("shell", SignInReturn.SHELL)
                .addQueryParameter("challenge", challenge)
                .build()

        private fun text(reply: JsonObject?, key: String): String? =
            (reply?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}
