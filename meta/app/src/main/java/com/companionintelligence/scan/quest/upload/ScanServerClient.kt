package com.companionintelligence.scan.quest.upload

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.ConnectionSpec
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** The result of one call to the server. */
sealed interface CallResult<out T> {
    data class Ok<T>(val value: T) : CallResult<T>

    /** Worth another try: no response, a timeout, 408, 429 or a 5xx. */
    data class Retry(val reason: String) : CallResult<Nothing>

    /** Not worth another try. */
    data class Fail(val reason: String, val httpCode: Int?, val kind: FailKind) : CallResult<Nothing>
}

enum class FailKind {
    /** 401 or 403: the server has sign-in on, which this app does not do yet. */
    SIGN_IN_REQUIRED,

    /** 413: the frame is over UPLOAD_MAX_FRAME_BYTES or the session over KEYFRAME_SESSION_MAX_BYTES. */
    TOO_LARGE,

    /** 404: the session is gone (deleted, or a different server). */
    NOT_FOUND,

    /** Any other 4xx. */
    REJECTED,

    /** A 2xx whose body is not what the route promises. */
    BAD_RESPONSE,
}

/**
 * The three existing routes the capture uses, and nothing else (server/main.ts):
 *
 *     POST /sessions                  {}                      → 201 { sessionId, … }
 *     POST /sessions/:id/keyframes    multipart image + meta  → { ok, index }
 *     POST /sessions/:id/finalize     {}                      → the session record
 *
 * Finalizing starts nothing new: the server's existing reconstruction and splat-train WorldJobs work from the
 * session's keyframes. All calls block, so they run on the uploader's own thread, never the render thread.
 */
class ScanServerClient(val baseUrl: HttpUrl, private val http: OkHttpClient) {
    init {
        require(baseUrl.isHttps) { "the server address must be https" }
    }

    fun openSession(): CallResult<String> = call(
        Request.Builder().url(ServerAddress.route(baseUrl, "sessions")).post(EMPTY_JSON.toRequestBody(JSON)).build(),
    ) { body ->
        val id = (runCatching { Json.parseToJsonElement(body) }.getOrNull() as? JsonObject)
            ?.get("sessionId")
            ?.let { it as? JsonPrimitive }
            ?.takeIf { it.isString }
            ?.content
        if (id.isNullOrBlank()) {
            CallResult.Fail("POST /sessions answered without a sessionId", null, FailKind.BAD_RESPONSE)
        } else {
            CallResult.Ok(id)
        }
    }

    fun postKeyframe(sessionId: String, index: Int, jpeg: ByteArray, metaJson: String): CallResult<Unit> {
        val form = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("image", "kf-$index.jpg", jpeg.toRequestBody(JPEG))
            .addFormDataPart("meta", metaJson)
            .build()
        val request = Request.Builder()
            .url(ServerAddress.route(baseUrl, "sessions", sessionId, "keyframes"))
            .post(form)
            .build()
        return call(request) { CallResult.Ok(Unit) }
    }

    fun finalizeSession(sessionId: String): CallResult<Unit> = call(
        Request.Builder()
            .url(ServerAddress.route(baseUrl, "sessions", sessionId, "finalize"))
            .post(EMPTY_JSON.toRequestBody(JSON))
            .build(),
    ) { CallResult.Ok(Unit) }

    private fun <T> call(request: Request, onSuccess: (String) -> CallResult<T>): CallResult<T> = try {
        http.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (response.isSuccessful) onSuccess(body) else classify(response.code, body)
        }
    } catch (e: IOException) {
        CallResult.Retry(e.message ?: e.javaClass.simpleName)
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val JPEG = "image/jpeg".toMediaType()
        private const val EMPTY_JSON = "{}"

        /** Sign-in is out of scope for this pass; this is what the panel says when a server asks for it. */
        const val SIGN_IN_MESSAGE =
            "The server has sign-in on (HTTP 401/403). This app has no sign-in yet, so that server refuses its uploads."

        fun classify(code: Int, body: String): CallResult<Nothing> {
            val detail = errorText(body)
            return when {
                code == 401 || code == 403 -> CallResult.Fail(SIGN_IN_MESSAGE, code, FailKind.SIGN_IN_REQUIRED)
                code == 408 || code == 429 || code >= 500 -> CallResult.Retry("HTTP $code${detail?.let { ": $it" } ?: ""}")
                code == 413 -> CallResult.Fail("HTTP 413: ${detail ?: "too large"}", code, FailKind.TOO_LARGE)
                code == 404 -> CallResult.Fail("HTTP 404: ${detail ?: "not found"}", code, FailKind.NOT_FOUND)
                else -> CallResult.Fail("HTTP $code${detail?.let { ": $it" } ?: ""}", code, FailKind.REJECTED)
            }
        }

        /** The `error` string of a JSON error body, if there is one. */
        private fun errorText(body: String): String? =
            ((runCatching { Json.parseToJsonElement(body) }.getOrNull() as? JsonObject)?.get("error") as? JsonPrimitive)
                ?.takeIf { it.isString }
                ?.content
                ?.take(200)

        /**
         * An OkHttp client that cannot speak plain HTTP: TLS connection specs only (no CLEARTEXT), and no redirect
         * that changes scheme. The manifest also sets usesCleartextTraffic="false".
         */
        fun httpsOnlyClientBuilder(): OkHttpClient.Builder = OkHttpClient.Builder()
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
            .followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
    }
}
