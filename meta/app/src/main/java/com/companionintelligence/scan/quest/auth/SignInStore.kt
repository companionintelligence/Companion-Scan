package com.companionintelligence.scan.quest.auth

/** A sign-in the app started: its verifier, the server it was started against, and when. */
data class PendingSignIn(val verifier: String, val server: String, val startedAtMs: Long)

/**
 * The session a sign-in ended in: the server's signed session token, valid for seven days, and the server that issued it,
 * as the base address the person saved. The token is sent only to that server's origin (SessionBearer).
 */
data class ShellSession(val token: String, val server: String, val email: String?)

/**
 * Where the sign-in state is kept between launches. The app keeps it in its private preferences (AppSettings), which the
 * manifest leaves out of backup, as the phone shells keep theirs in the WebView's storage. The tests keep it in memory.
 * Move the token to the Android Keystore before a store build, as mobile/README.md says of the phone shells.
 */
interface SignInStore {
    var pending: PendingSignIn?
    var session: ShellSession?

    /** The latest return codes the app was handed, most recent first, so that none is used twice. */
    var seenCodes: List<String>
}
