package com.companionintelligence.scan.quest.auth

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/**
 * The return from a sign-in: the server's callback redirects to `com.companionintelligence.scan.quest://auth?code=…` with
 * a one-time code that lasts 60 seconds, and AndroidManifest.xml routes that scheme to ImmersiveActivity. The return URL
 * is fixed on the server, chosen by `shell=quest`, never read from the request (wave 13, ticket 0010; server/portal_auth.ts).
 * Keep [PREFIX] in step with it, as src/shared/shell-sign-in.ts keeps the phone and desktop prefixes.
 *
 * java.net, not android.net, so the JVM tests read it the way the app does.
 */
object SignInReturn {
    const val SCHEME = "com.companionintelligence.scan.quest"
    const val HOST = "auth"
    const val PREFIX = "$SCHEME://$HOST"

    /** The value a sign-in sends as `shell`, which makes the server return here. */
    const val SHELL = "quest"

    /** 32 random bytes in base64url, as the server makes a code; anything else is not a code it sent. */
    private val CODE_SHAPE = Regex("^[A-Za-z0-9_-]{43}$")

    /**
     * The one-time code in [url], or null when [url] is not a return the server makes: another scheme or host, no code, or
     * a code of another shape. Any web page can open a link to this scheme, so a link without a real code must change nothing.
     */
    fun codeOf(url: String): String? {
        if (!url.startsWith("$PREFIX?")) return null
        val query = try {
            URI(url).rawQuery
        } catch (_: URISyntaxException) {
            return null
        } ?: return null
        val raw = query.split('&')
            .map { it.split('=', limit = 2) }
            .firstOrNull { it.size == 2 && it[0] == "code" }
            ?.get(1)
            ?: return null
        val code = try {
            URLDecoder.decode(raw, "UTF-8")
        } catch (_: IllegalArgumentException) {
            return null
        }
        return code.takeIf { CODE_SHAPE.matches(it) }
    }
}
