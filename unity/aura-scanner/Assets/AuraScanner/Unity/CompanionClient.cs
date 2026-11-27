using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using AuraScanner.Core;
using UnityEngine;
using UnityEngine.Networking;

namespace AuraScanner.Runtime
{
    /// The outcome of one request. Status is the HTTP status, or 0 when no response arrived.
    public struct ApiResult
    {
        public bool Ok;
        public long Status;
        public string Error;

        public static ApiResult From(UnityWebRequest request)
        {
            return new ApiResult
            {
                Ok = request.result == UnityWebRequest.Result.Success,
                Status = request.responseCode,
                Error = request.error ?? "",
            };
        }

        public string Describe()
        {
            if (Ok) return "ok";
            string status = Status > 0 ? "HTTP " + Status : "no response";
            return Error.Length > 0 ? status + " (" + Error + ")" : status;
        }
    }

    /// The reply to POST /sessions. Only the id is read.
    [Serializable]
    public sealed class SessionRecord
    {
        public string sessionId;
    }

    /// The Companion Scan server's capture-session routes (server/main.ts). Each call is a coroutine on the main thread,
    /// and its result goes back through a callback. Routes and field names follow src/capture/keyframes.ts.
    public sealed class CompanionClient
    {
        private const int UploadAttempts = 3;
        private const int UploadTimeoutSeconds = 20;
        private const int ControlTimeoutSeconds = 10;

        private readonly string _baseUrl;
        private readonly string _bearerToken;
        private UnityWebRequest _inflight;
        private int _cancelGeneration;

        public CompanionClient(string baseUrl, string bearerToken)
        {
            _baseUrl = (baseUrl ?? "").TrimEnd('/');
            _bearerToken = bearerToken ?? "";
        }

        /// POST /sessions with an empty body, as the web client sends it. Calls back with the new session id on success.
        public IEnumerator CreateSession(Action<ApiResult, string> done)
        {
            using (var request = new UnityWebRequest(Url("/sessions"), UnityWebRequest.kHttpVerbPOST))
            {
                request.downloadHandler = new DownloadHandlerBuffer();
                request.timeout = ControlTimeoutSeconds;
                Authorize(request);
                yield return request.SendWebRequest();

                ApiResult result = ApiResult.From(request);
                string sessionId = null;
                if (result.Ok)
                {
                    sessionId = ParseSessionId(request.downloadHandler.text);
                    if (string.IsNullOrEmpty(sessionId))
                    {
                        result.Ok = false;
                        result.Error = "no sessionId in the reply";
                    }
                }
                done(result, sessionId);
            }
        }

        /// POST /sessions/:id/keyframes as multipart { image, meta }. A failed attempt is retried only when UploadPolicy
        /// allows it, with the web client's back-off. Calls back once, with the last attempt's result.
        public IEnumerator UploadKeyframe(string sessionId, int index, byte[] jpeg, string metaJson, Action<ApiResult> done)
        {
            int generation = _cancelGeneration;
            ApiResult result = default;
            for (int attempt = 0; attempt < UploadAttempts; attempt++)
            {
                var form = new List<IMultipartFormSection>
                {
                    new MultipartFormFileSection("image", jpeg, "kf-" + index + ".jpg", "image/jpeg"),
                    new MultipartFormDataSection("meta", metaJson),
                };
                using (UnityWebRequest request = UnityWebRequest.Post(Url("/sessions/" + sessionId + "/keyframes"), form))
                {
                    request.timeout = UploadTimeoutSeconds;
                    Authorize(request);
                    _inflight = request;
                    yield return request.SendWebRequest();
                    _inflight = null;
                    result = ApiResult.From(request);
                }

                if (result.Ok || generation != _cancelGeneration || !UploadPolicy.IsRetryable(result.Status)) break;
                yield return new WaitForSeconds(0.5f * (1 << attempt));
            }
            done(result);
        }

        /// POST /sessions/:id/finalize with an empty JSON object: the server counts the keyframes it holds.
        public IEnumerator FinalizeSession(string sessionId, Action<ApiResult> done)
        {
            using (var request = new UnityWebRequest(Url("/sessions/" + sessionId + "/finalize"), UnityWebRequest.kHttpVerbPOST))
            {
                request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes("{}"));
                request.downloadHandler = new DownloadHandlerBuffer();
                request.SetRequestHeader("Content-Type", "application/json");
                request.timeout = ControlTimeoutSeconds;
                Authorize(request);
                yield return request.SendWebRequest();
                done(ApiResult.From(request));
            }
        }

        /// DELETE /sessions/:id, which removes that session's frames. This is the consent withdrawal. A 404 means the
        /// session is already gone.
        public IEnumerator DeleteSession(string sessionId, Action<ApiResult> done)
        {
            using (var request = new UnityWebRequest(Url("/sessions/" + sessionId), UnityWebRequest.kHttpVerbDELETE))
            {
                request.downloadHandler = new DownloadHandlerBuffer();
                request.timeout = ControlTimeoutSeconds;
                Authorize(request);
                yield return request.SendWebRequest();
                done(ApiResult.From(request));
            }
        }

        /// Aborts the upload in flight, and stops any upload from retrying. Used when consent is withdrawn.
        public void CancelUploads()
        {
            _cancelGeneration++;
            if (_inflight != null) _inflight.Abort();
        }

        private string Url(string path)
        {
            return _baseUrl + path;
        }

        private void Authorize(UnityWebRequest request)
        {
            if (_bearerToken.Length > 0) request.SetRequestHeader("Authorization", "Bearer " + _bearerToken);
        }

        private static string ParseSessionId(string json)
        {
            try
            {
                return JsonUtility.FromJson<SessionRecord>(json)?.sessionId;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }
    }
}
