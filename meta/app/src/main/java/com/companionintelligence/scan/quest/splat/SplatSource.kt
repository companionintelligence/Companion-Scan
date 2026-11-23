package com.companionintelligence.scan.quest.splat

import com.companionintelligence.scan.quest.upload.ServerAddress
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Which splat files the viewer will try, and where to fetch one.
 *
 * meta-spatial-sdk-splat 0.15.0 declares `enum class SplatFormat(val extension: String) { PLY("ply"),
 * SPZ("spz"), UNKNOWN("unknown") }` and its SplatSystem has `isPlyFile` and `isSpzFile` checks, so a `.ply`
 * (3D Gaussian Splatting point layout, as far as anyone can tell from the stubs) or an `.spz` file. The server
 * serves three splat files beside a scan (server/main.ts, SPLAT_ARTIFACT_MIME): `<scan>.splat.ply`,
 * `<scan>.compressed.ply` and `<scan>.sog`. Only the first is plausibly readable here: `.sog` is a ZIP container
 * the SDK does not list, and `.compressed.ply` uses PlayCanvas's packed layout, which a 3DGS PLY reader cannot
 * decode. Neither claim has been tried on a headset.
 */
object SplatSource {
    val ACCEPTED_SUFFIXES = listOf(".ply", ".spz")

    sealed interface Resolved {
        data class Remote(val url: HttpUrl, val fileName: String) : Resolved
        data class Refused(val reason: String) : Resolved
    }

    /**
     * [input] is either a full https URL, or the file name of a splat the server serves under GET
     * /scans/:filename (for example `kitchen.splat.ply`), resolved against [server].
     */
    fun resolve(input: String, server: HttpUrl?): Resolved {
        val text = input.trim()
        if (text.isEmpty()) return Resolved.Refused("Enter a splat file name or an https:// URL")
        val url: HttpUrl = when {
            text.startsWith("http://", ignoreCase = true) ->
                return Resolved.Refused("http:// is refused; splats are downloaded over HTTPS only")
            text.contains("://") -> {
                if (!text.startsWith("https://", ignoreCase = true)) return Resolved.Refused("Only https:// URLs are accepted")
                text.toHttpUrlOrNull() ?: return Resolved.Refused("That is not a valid URL")
            }
            else -> {
                if (server == null) return Resolved.Refused("Save the server address first, or enter a full https:// URL")
                if (text.contains('/') || text.contains('\\') || text.startsWith(".")) {
                    return Resolved.Refused("Enter just the file name, as GET /scans/:filename serves it")
                }
                ServerAddress.route(server, "scans", text)
            }
        }
        if (!url.isHttps) return Resolved.Refused("Only https:// URLs are accepted")
        val name = url.pathSegments.lastOrNull { it.isNotEmpty() }
            ?: return Resolved.Refused("The URL does not name a file")
        acceptance(name)?.let { return Resolved.Refused(it) }
        return Resolved.Remote(url, safeFileName(name))
    }

    /** Null when [fileName] has a suffix the viewer will try, otherwise why not. */
    fun acceptance(fileName: String): String? {
        val lower = fileName.lowercase()
        return when {
            lower.endsWith(".compressed.ply") ->
                "PlayCanvas compressed PLY is not a format the SDK lists; use the .splat.ply file"
            lower.endsWith(".sog") -> "SOG is not a format the SDK lists; use the .splat.ply file"
            ACCEPTED_SUFFIXES.none { lower.endsWith(it) } -> "The SDK's Splat component reads .ply and .spz files only"
            else -> null
        }
    }

    /** A local file name made only of safe characters, keeping the suffix. */
    fun safeFileName(name: String): String {
        val cleaned = name.map { if (it.isLetterOrDigit() || it == '.' || it == '-' || it == '_') it else '_' }
            .joinToString("")
            .trimStart('.')
        return cleaned.ifEmpty { "splat.ply" }.take(120)
    }
}
