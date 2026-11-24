package com.companionintelligence.scan.quest.auth

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Sends the signed-in session as `Authorization: Bearer <token>` on every request to the server that issued it, as
 * installShellSession() does for the phone shells: the uploads, the finalize and the splat downloads alike. A request to
 * any other origin never gets the token: the splat viewer also fetches https:// URLs on other hosts. A request that sets
 * its own Authorization keeps it.
 *
 * An application interceptor, so it sees each call once, before redirects; OkHttp drops the Authorization header on a
 * redirect to another host, and the client follows no redirect that changes scheme (ScanServerClient).
 *
 * A 401 to a request that carried the token means the server no longer accepts it (expired after seven days, or signed
 * with an earlier session secret). The token is then forgotten, so the panel asks for a sign-in instead of sending it
 * again, but only that token: a sign-in that finished meanwhile stored a newer one. A 403 keeps it: the account is known
 * and not allowed, and signing in again would not change that.
 */
class SessionBearer(private val store: SignInStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val session = store.session
        if (session == null || request.header("Authorization") != null || !sameOrigin(request.url, session.server)) {
            return chain.proceed(request)
        }
        val response = chain.proceed(request.newBuilder().header("Authorization", "Bearer ${session.token}").build())
        if (response.code == 401) {
            synchronized(store) {
                if (store.session?.token == session.token) store.session = null
            }
        }
        return response
    }

    companion object {
        /** True when [url] is on the origin (scheme, host and port) of the server address [server]. */
        fun sameOrigin(url: HttpUrl, server: String): Boolean {
            val base = server.toHttpUrlOrNull() ?: return false
            return url.isHttps && url.scheme == base.scheme && url.host == base.host && url.port == base.port
        }
    }
}
