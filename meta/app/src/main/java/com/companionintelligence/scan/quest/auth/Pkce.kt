package com.companionintelligence.scan.quest.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * A PKCE pair as RFC 7636 makes one with S256, and as the phone shells make theirs (src/shared/shell-sign-in.ts,
 * createShellPkce): a verifier of 32 random bytes, base64url without padding, and the base64url SHA-256 of it. Both are
 * 43 characters, the shape the server checks (server/portal_auth.ts, PKCE_SHAPE). Only this app holds the verifier, so a
 * code another app catches from the return URL is useless to it.
 */
data class Pkce(val verifier: String, val challenge: String) {
    companion object {
        private val encoder: Base64.Encoder = Base64.getUrlEncoder().withoutPadding()

        fun create(random: SecureRandom = SecureRandom()): Pkce {
            val bytes = ByteArray(32)
            random.nextBytes(bytes)
            return fromVerifier(encoder.encodeToString(bytes))
        }

        fun fromVerifier(verifier: String): Pkce = Pkce(verifier, challengeOf(verifier))

        fun challengeOf(verifier: String): String =
            encoder.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
    }
}
