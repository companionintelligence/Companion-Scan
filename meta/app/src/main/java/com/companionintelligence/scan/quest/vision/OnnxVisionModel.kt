package com.companionintelligence.scan.quest.vision

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.util.Log
import com.companionintelligence.scan.quest.capture.YuvFrame
import java.io.File
import java.nio.FloatBuffer
import java.util.Locale

/**
 * [VisionModel] on ONNX Runtime (com.microsoft.onnxruntime:onnxruntime-android). The app ships no weights and
 * downloads none: it loads the first `*.onnx` file in [modelDir] (`models/` in the app's internal files
 * directory) if a person has put one there, and otherwise reports that no model is installed. adb cannot write
 * to internal storage directly; on a debug build, push the file to /data/local/tmp and copy it in with
 * `adb shell run-as <package> cp /data/local/tmp/<name>.onnx files/models/`.
 *
 * The hook handles the common image-model shape, one float input of [1, 3, H, W] (RGB, 0…1); a dynamic H or W
 * is read as [DEFAULT_SIDE]. Anything else is reported as unsupported rather than guessed at. The CPU execution
 * provider with two threads is used; ONNX Runtime's NNAPI and XNNPACK providers exist but are untried here.
 */
class OnnxVisionModel(private val modelDir: File) : VisionModel {
    private var env: OrtEnvironment? = null
    private var session: OrtSession? = null
    private var inputName = ""
    private var inputWidth = 0
    private var inputHeight = 0

    @Volatile
    override var status: VisionStatus = VisionStatus.NotInstalled(File(modelDir, "<name>.onnx").path)
        private set

    @Synchronized
    override fun load() {
        if (session != null) return
        val file = modelDir.listFiles { f -> f.isFile && f.name.endsWith(".onnx", ignoreCase = true) }
            ?.minByOrNull { it.name }
        if (file == null) {
            status = VisionStatus.NotInstalled(File(modelDir, "<name>.onnx").path)
            return
        }
        try {
            val environment = OrtEnvironment.getEnvironment()
            // 1.32.0 ships a telemetry client; the manifest removes its start-up provider and this turns the
            // runtime's telemetry events off too. Frames and results stay on the headset.
            try {
                environment.setTelemetry(false)
            } catch (e: OrtException) {
                Log.w(TAG, "could not turn ONNX Runtime telemetry off", e)
            }
            val options = OrtSession.SessionOptions().apply { setIntraOpNumThreads(2) }
            val opened = environment.createSession(file.absolutePath, options)
            val inputs = opened.inputInfo
            val outputs = opened.outputInfo
            val describe = { m: Map<String, ai.onnxruntime.NodeInfo> ->
                m.entries.joinToString("; ") { (name, info) ->
                    val tensor = info.info as? TensorInfo
                    if (tensor == null) name else "$name ${tensor.type} ${tensor.shape.contentToString()}"
                }
            }
            val single = inputs.entries.singleOrNull()
            val tensor = single?.value?.info as? TensorInfo
            val shape = tensor?.shape
            if (single == null || tensor == null || tensor.type != OnnxJavaType.FLOAT || shape == null ||
                shape.size != 4 || (shape[0] != 1L && shape[0] != -1L) || shape[1] != 3L
            ) {
                opened.close()
                status = VisionStatus.Failed(
                    "${file.name}: the hook needs one float input shaped [1, 3, H, W]; this model has ${describe(inputs)}",
                )
                return
            }
            env = environment
            session = opened
            inputName = single.key
            inputHeight = if (shape[2] > 0) shape[2].toInt() else DEFAULT_SIDE
            inputWidth = if (shape[3] > 0) shape[3].toInt() else DEFAULT_SIDE
            status = VisionStatus.Ready(file.name, describe(inputs), describe(outputs))
        } catch (e: Exception) {
            status = VisionStatus.Failed("${file.name}: ${e.message ?: e.javaClass.simpleName}")
        } catch (e: UnsatisfiedLinkError) {
            status = VisionStatus.Failed("ONNX Runtime's native library did not load: ${e.message}")
        }
    }

    @Synchronized
    override fun analyze(frame: YuvFrame): VisionResult? {
        val environment = env ?: return null
        val opened = session ?: return null
        val started = System.nanoTime()
        val pixels = yuvToPlanarRgb(frame, inputWidth, inputHeight)
        val shape = longArrayOf(1, 3, inputHeight.toLong(), inputWidth.toLong())
        return OnnxTensor.createTensor(environment, FloatBuffer.wrap(pixels), shape).use { input ->
            opened.run(mapOf(inputName to input)).use { result ->
                val parts = result.take(MAX_OUTPUTS_REPORTED).map { (name, value) ->
                    val out = value as? OnnxTensor
                    if (out == null) {
                        name
                    } else {
                        "$name ${out.info.shape.contentToString()}${floatStats(out)}"
                    }
                }
                VisionResult(parts.joinToString("; "), (System.nanoTime() - started) / 1_000_000)
            }
        }
    }

    private fun floatStats(tensor: OnnxTensor): String {
        if (tensor.info.type != OnnxJavaType.FLOAT) return ""
        val buffer = tensor.floatBuffer ?: return ""
        val n = minOf(buffer.remaining(), MAX_VALUES_SUMMARISED)
        if (n == 0) return ""
        var min = Float.POSITIVE_INFINITY
        var max = Float.NEGATIVE_INFINITY
        var sum = 0.0
        for (i in 0 until n) {
            val v = buffer.get(i)
            if (v < min) min = v
            if (v > max) max = v
            sum += v
        }
        return String.format(Locale.ROOT, " min %.3g max %.3g mean %.3g", min, max, sum / n)
    }

    @Synchronized
    override fun close() {
        session?.close()
        session = null
        env = null
    }

    companion object {
        private const val TAG = "OnnxVisionModel"
        const val DEFAULT_SIDE = 256
        private const val MAX_OUTPUTS_REPORTED = 3
        private const val MAX_VALUES_SUMMARISED = 1_000_000
    }
}
