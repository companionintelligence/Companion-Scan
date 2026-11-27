using System;
using System.Collections;
using AuraScanner.Core;
using UnityEngine;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace AuraScanner.Runtime
{
    /// Runs one room scan on the Aura. Start opens a Companion Scan session. While the wearer walks, a pose-tagged keyframe
    /// goes up whenever they have moved or turned enough. Stop finalizes the session, and Withdraw deletes its frames on
    /// the server. The HUD is IMGUI, so no prefab is needed. Keyframe meta follows src/capture/keyframes.ts.
    public sealed class AuraScanController : MonoBehaviour
    {
        [Header("Server")]
        [Tooltip("Base URL of the Companion Scan server, with no trailing slash.")]
        [SerializeField] private string serverUrl = "http://localhost:8000";
        [Tooltip("Companion session token, sent as Authorization: Bearer. Needed when the server has sign-in on. Empty otherwise.")]
        [SerializeField] private string bearerToken = "";

        [Header("Keyframe trigger (as src/capture/keyframes.ts)")]
        [SerializeField] private float minIntervalSeconds = 1.2f;
        [SerializeField] private float minMoveMetres = 0.30f;
        [SerializeField] private float minTurnDegrees = 20f;

        [Header("Frames")]
        [Tooltip("Send generated JPEGs instead of camera frames. Tests the upload path only: those frames show no room.")]
        [SerializeField] private bool placeholderFrames = false;
        [SerializeField] private int requestedWidth = 1280;
        [SerializeField] private int requestedHeight = 720;
        [SerializeField] private int requestedFps = 15;
        [SerializeField, Range(1, 100)] private int jpegQuality = 80;
        [Tooltip("Vertical field of view written into the intrinsics. Not measured: calibrate on the device before relying on it.")]
        [SerializeField] private float fovYDegrees = 60f;

        /// The server refuses an index at or past this (server/main.ts, MAX_KEYFRAMES_PER_SESSION).
        private const int MaxKeyframesPerSession = 2000;
        /// After a failed upload, capture waits this long (the web client's OFFLINE_RETRY_MS).
        private const float RetryPauseSeconds = 10f;
        /// How long a stop lets the last upload land before it is cancelled (the web client drains for 5 s).
        private const float DrainSeconds = 5f;
        /// How long the camera permission prompt may take before the scan gives up.
        private const float PermissionWaitSeconds = 60f;

        private enum Phase { Idle, Opening, Recording, Finalizing, Withdrawing }

        private CompanionClient _client;
        private IFrameSource _frames;
        private KeyframeSchedule _schedule;
        private Phase _phase = Phase.Idle;
        /// Bumped by Start and by Withdraw, so a coroutine that has been overtaken knows to stop.
        private int _run;
        /// True from Start until the session is open or abandoned. Start is refused meanwhile.
        private bool _setupInFlight;
        private string _sessionId;
        private string _lastSessionId;
        private int _nextIndex;
        private int _epoch;
        private bool _hasTracked;
        private bool _trackingLost;
        private bool _uploadInFlight;
        private int _sent;
        private int _failed;
        private float _pausedUntil;
        private string _lastError = "";

        /// Starts a scan. Pressing Start is the wearer's yes: frames go to serverUrl until Stop, Withdraw or the app pauses.
        public void StartScan()
        {
            if (_phase != Phase.Idle || _setupInFlight) return;
            if (_uploadInFlight)
            {
                _lastError = "the last upload is still finishing; try again in a moment";
                return;
            }
            if (!TryGetServerBase(out string baseUrl, out string urlError))
            {
                _lastError = urlError;
                return;
            }
            _client = new CompanionClient(baseUrl, bearerToken);
            _schedule = new KeyframeSchedule(minIntervalSeconds, float.PositiveInfinity, minMoveMetres, minTurnDegrees);
            _lastError = "";
            _phase = Phase.Opening;
            _setupInFlight = true;
            _run++;
            StartCoroutine(Open(_run));
        }

        /// Ends the walk. The last upload gets up to DrainSeconds to land, then the session is finalized on the server.
        public void StopScan()
        {
            if (_phase != Phase.Recording) return;
            _phase = Phase.Finalizing;
            _lastSessionId = _sessionId;
            StartCoroutine(Finalize(_run, _sessionId));
        }

        /// Withdraws consent. Nothing more is sent, the upload in flight is cancelled, and the session's frames are deleted
        /// on the server.
        public void WithdrawConsent()
        {
            if (_phase == Phase.Idle && _lastSessionId == null) return;
            _run++;
            string target = _sessionId ?? _lastSessionId;
            _sessionId = null;
            _lastSessionId = target;
            _client?.CancelUploads();
            ReleaseFrames();
            _phase = Phase.Withdrawing;
            StartCoroutine(Delete(_run, target));
        }

        private IEnumerator Open(int run)
        {
            yield return Setup(run);
            _setupInFlight = false;
        }

        private IEnumerator Setup(int run)
        {
            CompanionClient client = _client;
            yield return PrepareFrames();
            if (run != _run)
            {
                ReleaseFrames();
                yield break;
            }
            if (_frames == null)
            {
                _phase = Phase.Idle;
                yield break;
            }

            ApiResult result = default;
            string sessionId = null;
            yield return client.CreateSession((r, id) =>
            {
                result = r;
                sessionId = id;
            });
            if (run != _run)
            {
                // Withdrawn while the session was being opened: its frames are deleted as soon as it exists.
                ReleaseFrames();
                if (!string.IsNullOrEmpty(sessionId)) yield return client.DeleteSession(sessionId, _ => { });
                yield break;
            }
            if (!result.Ok || string.IsNullOrEmpty(sessionId))
            {
                ReleaseFrames();
                _lastError = "could not open a session: " + result.Describe();
                _phase = Phase.Idle;
                yield break;
            }

            _sessionId = sessionId;
            _nextIndex = 0;
            _sent = 0;
            _failed = 0;
            _schedule.Reset();
            _phase = Phase.Recording;
        }

        /// Starts the frame source: generated frames when asked, otherwise the camera. Camera permission is requested on
        /// Android and the scan waits for the answer.
        private IEnumerator PrepareFrames()
        {
            if (placeholderFrames)
            {
                _frames = new PlaceholderFrame();
                _frames.Start(requestedWidth, requestedHeight, requestedFps);
                yield break;
            }
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Camera))
            {
                Permission.RequestUserPermission(Permission.Camera);
                float deadline = Time.realtimeSinceStartup + PermissionWaitSeconds;
                while (!Permission.HasUserAuthorizedPermission(Permission.Camera) && Time.realtimeSinceStartup < deadline)
                {
                    yield return null;
                }
            }
#endif
            var camera = new WebCamFrameSource();
            if (camera.Start(requestedWidth, requestedHeight, requestedFps))
            {
                _frames = camera;
            }
            else
            {
                camera.Dispose();
                _lastError = "no camera frames: no camera was found, or permission was refused (see the README)";
            }
        }

        private void Update()
        {
            if (_phase != Phase.Recording || _uploadInFlight || _frames == null) return;
            float now = Time.realtimeSinceStartup;
            if (now < _pausedUntil) return;
            if (_nextIndex >= MaxKeyframesPerSession)
            {
                _lastError = "the session reached the server's keyframe limit, so it was finalized";
                StopScan();
                return;
            }

            if (!HeadPoseSource.TryGetPose(out PoseF pose))
            {
                if (_hasTracked) _trackingLost = true;
                return;
            }
            if (_trackingLost)
            {
                // Tracking came back after a gap, possibly in a new coordinate frame: the epoch moves on.
                _epoch++;
                _trackingLost = false;
                _schedule.Reset();
            }
            _hasTracked = true;

            if (!_schedule.ShouldCapture(now, pose)) return;
            if (!_frames.TryCapture(jpegQuality, out byte[] jpeg, out int width, out int height))
            {
                _schedule.Reset();
                return;
            }

            int index = _nextIndex++;
            var intrinsics = new FrameIntrinsics
            {
                FovYDeg = fovYDegrees,
                Aspect = (float)width / height,
                Width = width,
                Height = height,
                SourceWidth = width,
                SourceHeight = height,
            };
            string meta = KeyframeRecord.ToJson(index, Time.realtimeSinceStartupAsDouble * 1000.0,
                                                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), _epoch, pose, intrinsics);
            _uploadInFlight = true;
            StartCoroutine(Upload(_sessionId, index, jpeg, meta));
        }

        private IEnumerator Upload(string sessionId, int index, byte[] jpeg, string meta)
        {
            ApiResult result = default;
            yield return _client.UploadKeyframe(sessionId, index, jpeg, meta, r => result = r);
            _uploadInFlight = false;
            if (sessionId != _sessionId) yield break; // stopped or withdrawn while this was in flight

            if (result.Ok)
            {
                _sent++;
            }
            else
            {
                _failed++;
                _lastError = "keyframe " + index + ": " + result.Describe();
                _pausedUntil = Time.realtimeSinceStartup + RetryPauseSeconds;
            }
        }

        private IEnumerator Finalize(int run, string sessionId)
        {
            float deadline = Time.realtimeSinceStartup + DrainSeconds;
            while (_uploadInFlight && run == _run && Time.realtimeSinceStartup < deadline) yield return null;
            if (run != _run) yield break; // withdrawn meanwhile: the withdrawal deletes the session

            if (_uploadInFlight) _client.CancelUploads();
            _sessionId = null;
            ReleaseFrames();
            ApiResult result = default;
            yield return _client.FinalizeSession(sessionId, r => result = r);
            if (run != _run) yield break;

            _phase = Phase.Idle;
            if (!result.Ok) _lastError = "finalize failed: " + result.Describe();
        }

        private IEnumerator Delete(int run, string sessionId)
        {
            if (!string.IsNullOrEmpty(sessionId))
            {
                ApiResult result = default;
                yield return _client.DeleteSession(sessionId, r => result = r);
                _lastError = result.Ok || result.Status == 404
                    ? "consent withdrawn: the session's frames are deleted on the server"
                    : "the server did not confirm the delete: " + result.Describe();
            }
            if (run != _run) yield break;

            _lastSessionId = null;
            _phase = Phase.Idle;
        }

        private void OnGUI()
        {
            GUILayout.BeginArea(new Rect(24f, 24f, 640f, 480f));
            GUILayout.Label("Aura room scanner: " + _phase);
            GUILayout.Label("server: " + serverUrl);
            GUILayout.Label("session: " + (_sessionId ?? _lastSessionId ?? "none"));
            GUILayout.Label("sent " + _sent + "   failed " + _failed + "   next index " + _nextIndex + "   epoch " + _epoch);
            if (_lastError.Length > 0) GUILayout.Label("last: " + _lastError);

            GUI.enabled = _phase == Phase.Idle && !_setupInFlight;
            if (GUILayout.Button("Start scan (frames go to the server above)")) StartScan();

            GUI.enabled = _phase == Phase.Recording;
            if (GUILayout.Button("Stop and finalize")) StopScan();

            GUI.enabled = _phase == Phase.Opening || _phase == Phase.Recording || _phase == Phase.Finalizing || _lastSessionId != null;
            if (GUILayout.Button("Withdraw consent: stop and delete this session's frames")) WithdrawConsent();

            GUI.enabled = true;
            GUILayout.EndArea();
        }

        private void OnApplicationPause(bool paused)
        {
            // Leaving the app ends the walk, so the session is finalized with the frames it holds.
            if (paused) StopScan();
        }

        private void OnDisable()
        {
            ReleaseFrames();
        }

        private void ReleaseFrames()
        {
            if (_frames != null) _frames.Dispose();
            _frames = null;
        }

        /// Camera frames and bearer credentials must not leave the device over cleartext HTTP. Loopback remains available
        /// for Editor-only development; every remote endpoint must use HTTPS. Query and fragment components are rejected
        /// so credentials cannot be placed in the URL instead of the Authorization header.
        private bool TryGetServerBase(out string baseUrl, out string error)
        {
            baseUrl = (serverUrl ?? "").Trim().TrimEnd('/');
            error = "";
            if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out Uri endpoint) ||
                (endpoint.Scheme != Uri.UriSchemeHttp && endpoint.Scheme != Uri.UriSchemeHttps))
            {
                error = "server URL must be an absolute HTTP or HTTPS URL";
                return false;
            }
            if (endpoint.UserInfo.Length > 0 || endpoint.Query.Length > 0 || endpoint.Fragment.Length > 0)
            {
                error = "server URL cannot contain credentials, a query or a fragment";
                return false;
            }
            if (endpoint.Scheme != Uri.UriSchemeHttps && !endpoint.IsLoopback)
            {
                error = "remote Companion Scan servers require HTTPS to protect camera frames and session tokens";
                return false;
            }
            return true;
        }
    }
}
