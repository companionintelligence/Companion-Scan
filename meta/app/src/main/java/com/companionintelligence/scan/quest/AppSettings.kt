package com.companionintelligence.scan.quest

import android.content.Context

/**
 * What the person sets on the panel, kept in the app's private preferences on the headset. The server address
 * is whatever they typed and saved; nothing is preset. The manifest sets allowBackup="false", so these are not
 * copied off the device by Android backup.
 */
class AppSettings(context: Context) {
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

    private companion object {
        const val KEY_SERVER = "serverAddress"
        const val KEY_DATASET = "recordLocalDataset"
        const val KEY_MIRROR = "mirrorSplat"
        const val KEY_SPLAT = "splatInput"
    }
}
