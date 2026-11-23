package com.companionintelligence.scan.quest.upload

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The Companion Scan server address the person types in. HTTPS only: the app sends camera frames of the
 * person's home, so an `http://` address is refused rather than upgraded or tried. No address, host name, token
 * or key is built into the app; the address lives only in the app's private preferences (AppSettings).
 *
 * Sign-in is not implemented in this app. A server with sign-in on (or SCAN_REQUIRE_AUTH=1) guards /sessions
 * (server/main.ts, SESSION_GUARDED_PATHS) and answers 401, which the uploader reports as "sign-in is on".
 */
object ServerAddress {
    sealed interface Parsed {
        data class Ok(val baseUrl: HttpUrl) : Parsed
        data class Refused(val reason: String) : Parsed
    }

    fun parse(input: String): Parsed {
        val text = input.trim()
        if (text.isEmpty()) return Parsed.Refused("Enter your Companion Scan server's https:// address")
        val schemeEnd = text.indexOf("://")
        val withScheme = if (schemeEnd < 0) {
            "https://$text"
        } else {
            val scheme = text.substring(0, schemeEnd).lowercase()
            if (scheme == "http") {
                return Parsed.Refused("http:// is refused. Camera frames are sent over HTTPS only; use https://")
            }
            if (scheme != "https") return Parsed.Refused("Only https:// addresses are accepted")
            text
        }
        val url = withScheme.toHttpUrlOrNull() ?: return Parsed.Refused("That is not a valid address")
        if (!url.isHttps) return Parsed.Refused("Only https:// addresses are accepted")
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) {
            return Parsed.Refused("Leave the user name and password out of the address")
        }
        if (url.query != null || url.fragment != null) {
            return Parsed.Refused("Leave the query (?…) and fragment (#…) out of the address")
        }
        // A base path is allowed (a server behind a path prefix); it always ends in a slash so routes resolve under it.
        val base = url.newBuilder().apply {
            val segments = url.pathSegments.filter { it.isNotEmpty() }
            encodedPath("/")
            for (s in segments) addPathSegment(s)
            if (segments.isNotEmpty()) addPathSegment("")
        }.build()
        return Parsed.Ok(base)
    }

    /** [base] + path segments, each encoded (a session id from the server is never spliced in raw). */
    fun route(base: HttpUrl, vararg segments: String): HttpUrl = base.newBuilder().apply {
        val existing = base.pathSegments.filter { it.isNotEmpty() }
        encodedPath("/")
        for (s in existing) addPathSegment(s)
        for (s in segments) addPathSegment(s)
    }.build()
}
