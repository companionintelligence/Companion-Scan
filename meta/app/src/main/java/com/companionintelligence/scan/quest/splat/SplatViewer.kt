package com.companionintelligence.scan.quest.splat

import android.net.Uri
import android.os.Handler
import android.util.Log
import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import com.meta.spatial.splat.Splat
import com.meta.spatial.splat.SplatLoadEventArgs
import com.meta.spatial.toolkit.Scale
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.Visible
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Shows one Gaussian splat with meta-spatial-sdk-splat's `Splat(path: Uri)` component.
 *
 * A remote splat is downloaded here, over HTTPS only (the client is ScanServerClient.httpsOnlyClientBuilder's),
 * into the app's files directory, and the component is given a file:// Uri. The SDK's SplatSystem would also
 * fetch an http:// or https:// Uri itself (`loadFileFromUri`: "file://, apk://, http://, https://"), which is why
 * it is never handed one. A local splat is the newest .ply or .spz in the app's external files directory,
 * `splats/` (for example copied there with adb push).
 *
 * Placement: a splat trained from this app's keyframes is in the Companion Scan frame (right-handed), the scene
 * is left-handed, so the entity sits at the scene origin with the Z mirror as its scale
 * (CoordinateConversions.SPLAT_MIRROR_SCALE). Whether the splat renderer honours a negative scale, and whether
 * the server's trainer keeps the keyframes' frame, are both unverified, so the mirror can be switched off.
 * Without the mirror the splat shows mirror-imaged.
 *
 * Entities are created and destroyed on the main thread only ([main]).
 */
class SplatViewer(
    private val downloadDir: File,
    private val localDir: File?,
    private val http: OkHttpClient,
    private val main: Handler,
) {
    @Volatile var status: String = "No splat shown"
        private set

    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "splat-download") }
    private var entity: Entity? = null
    private var shownFile: File? = null

    fun loadRemote(url: HttpUrl, fileName: String, mirror: Boolean) {
        if (!url.isHttps) {
            status = "Refused: not an https:// URL"
            return
        }
        status = "Downloading $fileName…"
        io.execute {
            val file = try {
                download(url, fileName)
            } catch (e: IOException) {
                status = "Download failed: ${e.message}"
                return@execute
            }
            main.post { show(file, mirror) }
        }
    }

    fun showNewestLocal(mirror: Boolean) {
        val dir = localDir
        val newest = dir?.listFiles { f -> f.isFile && SplatSource.acceptance(f.name) == null }?.maxByOrNull { it.lastModified() }
        if (newest == null) {
            status = "No .ply or .spz file in ${dir?.absolutePath ?: "the app's external files directory"}"
            return
        }
        main.post { show(newest, mirror) }
    }

    /** Re-shows the current splat with or without the mirror. */
    fun setMirror(mirror: Boolean) {
        val file = shownFile ?: return
        main.post { show(file, mirror) }
    }

    fun hide() {
        main.post {
            entity?.destroy()
            entity = null
            shownFile = null
            status = "No splat shown"
        }
    }

    fun shutdown() {
        io.shutdownNow()
    }

    private fun show(file: File, mirror: Boolean) {
        entity?.destroy()
        val m = CoordinateConversions.SPLAT_MIRROR_SCALE
        val scale = if (mirror) Vector3(m.x.toFloat(), m.y.toFloat(), m.z.toFloat()) else Vector3(1f, 1f, 1f)
        val created = Entity.create(
            listOf(
                Splat(Uri.fromFile(file)),
                Transform(Pose()),
                Scale(scale),
                Visible(true),
            ),
        )
        created.registerEventListener<SplatLoadEventArgs>(SplatLoadEventArgs.EVENT_NAME) { _, args ->
            status = if (args.success) {
                "Showing ${file.name}${if (mirror) " (Z mirrored)" else ""}"
            } else {
                "Splat did not load: ${args.errorMessage ?: "no reason given"}"
            }
        }
        entity = created
        shownFile = file
        status = "Loading ${file.name}…"
        Log.i(TAG, "splat entity created for ${file.name}, mirror=$mirror")
    }

    private fun download(url: HttpUrl, fileName: String): File {
        if (!downloadDir.isDirectory && !downloadDir.mkdirs()) throw IOException("cannot create $downloadDir")
        val target = File(downloadDir, fileName)
        val partial = File(downloadDir, "$fileName.part")
        try {
            fetchTo(url, partial)
        } catch (e: IOException) {
            partial.delete()
            throw e
        }
        if (target.exists() && !target.delete()) throw IOException("cannot replace $target")
        if (!partial.renameTo(target)) throw IOException("cannot move the download into place")
        return target
    }

    private fun fetchTo(url: HttpUrl, partial: File) {
        http.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
            if (response.code == 401 || response.code == 403) {
                throw IOException("the server has sign-in on (HTTP ${response.code}); this app has no sign-in yet")
            }
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body ?: throw IOException("empty response")
            val declared = body.contentLength()
            if (declared > MAX_SPLAT_BYTES) throw IOException("the file is ${declared / 1_000_000} MB, over the ${MAX_SPLAT_BYTES / 1_000_000} MB limit")
            var total = 0L
            body.byteStream().use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        total += n
                        if (total > MAX_SPLAT_BYTES) throw IOException("over the ${MAX_SPLAT_BYTES / 1_000_000} MB limit")
                        output.write(buffer, 0, n)
                    }
                }
            }
        }
    }

    companion object {
        private const val TAG = "SplatViewer"

        /** A trained room splat is usually well under this; the cap only stops a runaway download. */
        const val MAX_SPLAT_BYTES = 1_500_000_000L
    }
}
