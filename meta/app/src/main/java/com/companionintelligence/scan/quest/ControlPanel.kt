package com.companionintelligence.scan.quest

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The 2D panel: server address and sign-in, start and stop, counters and upload state, local dataset switch, the
 * vision hook's status and the splat viewer. Plain Android views built in code, hosted by a Spatial SDK
 * ViewPanelRegistration (ImmersiveActivity.registerPanels). [render] must run on the main thread.
 */
class ControlPanel(private val actions: Actions) {

    interface Actions {
        fun onSaveAddress(text: String)
        fun onSignIn()
        fun onStartCapture()
        fun onStopCapture()
        fun onRecordDatasetChanged(on: Boolean)
        fun onLoadSplat(input: String)
        fun onShowLocalSplat()
        fun onHideSplat()
        fun onMirrorChanged(on: Boolean)
        fun onRecallPanel()
    }

    /** Everything the panel shows, as text. */
    data class Snapshot(
        val message: String?,
        val camera: String,
        val cameraError: Boolean,
        /** Whether the app holds a Companion Account session for the saved server, and for whom. */
        val signIn: String,
        val headPose: String,
        val capture: String,
        val upload: String,
        val signInRequired: Boolean,
        val dataset: String,
        val vision: String,
        val splat: String,
        val warnings: List<String>,
        val capturing: Boolean,
    )

    private var message: TextView? = null
    private var camera: TextView? = null
    private var signIn: TextView? = null
    private var headPose: TextView? = null
    private var capture: TextView? = null
    private var upload: TextView? = null
    private var dataset: TextView? = null
    private var vision: TextView? = null
    private var splat: TextView? = null
    private var warnings: TextView? = null
    private var start: Button? = null
    private var stop: Button? = null
    private var last: Snapshot? = null

    fun build(context: Context, settings: AppSettings): View {
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
            setBackgroundColor(Color.rgb(24, 26, 30))
        }

        column.addView(text(context, "Companion Scan for Quest", 26f, bold = true))
        column.addView(
            text(
                context,
                "Scans the room with the left passthrough camera and sends keyframes to your Companion Scan server " +
                    "over HTTPS. If your server has sign-in on, sign in with your Companion Account first.",
                15f,
            ).apply { setTextColor(Color.rgb(180, 186, 196)) },
        )

        column.addView(section(context, "Server"))
        val address = EditText(context).apply {
            setText(settings.serverAddress)
            hint = "https:// address of your Companion Scan server"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_DONE
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            textSize = 18f
        }
        column.addView(address)
        column.addView(button(context, "Save address") { actions.onSaveAddress(address.text.toString()) })
        column.addView(button(context, "Sign in with Companion Account") { actions.onSignIn() })
        signIn = status(context).also { column.addView(it) }

        column.addView(section(context, "Capture"))
        column.addView(
            CheckBox(context).apply {
                text = "Also record a local dataset (mq3drecon legacy layout, raw YUV, about 5 MB/s)"
                isChecked = settings.recordLocalDataset
                setTextColor(Color.WHITE)
                textSize = 16f
                setOnCheckedChangeListener { _, on -> actions.onRecordDatasetChanged(on) }
            },
        )
        val buttons = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        start = button(context, "Start capture") { actions.onStartCapture() }.also { buttons.addView(it) }
        stop = button(context, "Stop capture") { actions.onStopCapture() }.also { buttons.addView(it) }
        buttons.addView(button(context, "Bring panel here") { actions.onRecallPanel() })
        column.addView(buttons)

        message = text(context, "", 16f).apply { setTextColor(Color.rgb(255, 214, 102)) }.also { column.addView(it) }
        camera = status(context).also { column.addView(it) }
        headPose = status(context).also { column.addView(it) }
        capture = status(context).also { column.addView(it) }
        upload = status(context).also { column.addView(it) }
        dataset = status(context).also { column.addView(it) }
        warnings = status(context).apply { setTextColor(Color.rgb(255, 150, 120)) }.also { column.addView(it) }

        column.addView(section(context, "On-device vision"))
        vision = status(context).also { column.addView(it) }

        column.addView(section(context, "Splat"))
        val splatInput = EditText(context).apply {
            setText(settings.splatInput)
            hint = "kitchen.splat.ply, or an https:// URL"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            textSize = 18f
        }
        column.addView(splatInput)
        val splatButtons = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        splatButtons.addView(button(context, "Download and show") { actions.onLoadSplat(splatInput.text.toString()) })
        splatButtons.addView(button(context, "Show newest local") { actions.onShowLocalSplat() })
        splatButtons.addView(button(context, "Hide") { actions.onHideSplat() })
        column.addView(splatButtons)
        column.addView(
            CheckBox(context).apply {
                text = "Mirror Z (the splat is right-handed, the scene left-handed)"
                isChecked = settings.mirrorSplat
                setTextColor(Color.WHITE)
                textSize = 16f
                setOnCheckedChangeListener { _, on -> actions.onMirrorChanged(on) }
            },
        )
        splat = status(context).also { column.addView(it) }

        last?.let { render(it) }
        return ScrollView(context).apply { addView(column) }
    }

    fun render(s: Snapshot) {
        last = s
        set(message, s.message.orEmpty())
        set(camera, "Camera: ${s.camera}")
        set(signIn, "Sign-in: ${s.signIn}")
        camera?.setTextColor(if (s.cameraError) Color.rgb(255, 150, 120) else Color.WHITE)
        set(headPose, "Head pose: ${s.headPose}")
        set(capture, "Capture: ${s.capture}")
        set(upload, "Upload: ${s.upload}")
        upload?.setTextColor(if (s.signInRequired) Color.rgb(255, 150, 120) else Color.WHITE)
        set(dataset, "Local dataset: ${s.dataset}")
        set(warnings, s.warnings.joinToString("\n"))
        set(vision, s.vision)
        set(splat, s.splat)
        start?.isEnabled = !s.capturing
        stop?.isEnabled = s.capturing
    }

    private fun set(view: TextView?, value: String) {
        if (view != null && view.text.toString() != value) view.text = value
    }

    private fun text(context: Context, value: String, size: Float, bold: Boolean = false) = TextView(context).apply {
        text = value
        textSize = size
        setTextColor(Color.WHITE)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 6, 0, 6)
    }

    private fun section(context: Context, title: String) = text(context, title, 20f, bold = true).apply {
        setPadding(0, 22, 0, 4)
    }

    private fun status(context: Context) = text(context, "", 15f)

    private fun button(context: Context, label: String, onClick: () -> Unit) = Button(context).apply {
        text = label
        textSize = 16f
        isAllCaps = false
        setOnClickListener { onClick() }
    }
}
