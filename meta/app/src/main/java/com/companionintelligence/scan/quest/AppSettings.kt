package com.companionintelligence.scan.quest

import android.content.Context
import com.companionintelligence.scan.quest.auth.PendingSignIn
import com.companionintelligence.scan.quest.auth.ShellSession
import com.companionintelligence.scan.quest.auth.SignInStore

/**
 * What the person sets on the panel, kept in the app's private preferences on the headset. The server address
 * is whatever they typed and saved; nothing is preset. The manifest sets allowBackup="false", so these are not
 * copied off the device by Android backup.
 *
 * It is also where a sign-in waits for the browser and where its session token is kept (SignInStore). Those are
 * written with commit(), not apply(): the verifier must be on disk before the browser opens, since the system may
 * stop the app while the person signs in.
 */
class AppSettings(context: Context) : SignInStore {
    private val prefs = context.getSharedPreferences("companion-scan-quest", Context.MODE_PRIVATE)

    var serverAddress: String
        get() = prefs.getString(KEY_SERVER, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SERVER, value).apply()

    var recordLocalDataset: Boolean
        get() = prefs.getBoolean(KEY_DATASET, false)
        set(value) = prefs.edit().putBoolean(KEY_DATASET, value).apply()

    var mirrorSplat: Boolean
        get() = prefs.getBoolean(KEY_MIRROR, true)
        set(value) = prefs.edit().putBoolean(KEY_MIRROR, value).apply()

    var splatInput: String
        get() = prefs.getString(KEY_SPLAT, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SPLAT, value).apply()

    override var pending: PendingSignIn?
        get() {
            val verifier = prefs.getString(KEY_PENDING_VERIFIER, null) ?: return null
            val server = prefs.getString(KEY_PENDING_SERVER, null) ?: return null
            return PendingSignIn(verifier, server, prefs.getLong(KEY_PENDING_AT, 0L))
        }
        set(value) {
            val edit = prefs.edit()
            if (value == null) {
                edit.remove(KEY_PENDING_VERIFIER).remove(KEY_PENDING_SERVER).remove(KEY_PENDING_AT)
            } else {
                edit.putString(KEY_PENDING_VERIFIER, value.verifier)
                    .putString(KEY_PENDING_SERVER, value.server)
                    .putLong(KEY_PENDING_AT, value.startedAtMs)
            }
            edit.commit()
        }

    override var session: ShellSession?
        get() {
            val token = prefs.getString(KEY_TOKEN, null) ?: return null
            val server = prefs.getString(KEY_TOKEN_SERVER, null) ?: return null
            return ShellSession(token, server, prefs.getString(KEY_TOKEN_EMAIL, null))
        }
        set(value) {
            val edit = prefs.edit()
            if (value == null) {
                edit.remove(KEY_TOKEN).remove(KEY_TOKEN_SERVER).remove(KEY_TOKEN_EMAIL)
            } else {
                edit.putString(KEY_TOKEN, value.token)
                    .putString(KEY_TOKEN_SERVER, value.server)
                    .putString(KEY_TOKEN_EMAIL, value.email)
            }
            edit.commit()
        }

    /** Base64url codes hold no comma, so the list is kept as one comma-separated string. */
    override var seenCodes: List<String>
        get() = (prefs.getString(KEY_CODES, "") ?: "").split(',').filter { it.isNotEmpty() }
        set(value) {
            prefs.edit().putString(KEY_CODES, value.joinToString(",")).commit()
        }

    private companion object {
        const val KEY_SERVER = "serverAddress"
        const val KEY_DATASET = "recordLocalDataset"
        const val KEY_MIRROR = "mirrorSplat"
        const val KEY_SPLAT = "splatInput"
        const val KEY_PENDING_VERIFIER = "signInVerifier"
        const val KEY_PENDING_SERVER = "signInServer"
        const val KEY_PENDING_AT = "signInStartedAt"
        const val KEY_TOKEN = "sessionToken"
        const val KEY_TOKEN_SERVER = "sessionServer"
        const val KEY_TOKEN_EMAIL = "sessionEmail"
        const val KEY_CODES = "signInCodesSeen"
    }
}
