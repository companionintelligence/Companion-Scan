namespace AuraScanner.Core
{
    /// Which failed keyframe uploads are worth another attempt. The same rule as keyframeUploadRetryable in
    /// src/capture/keyframes.ts: a network error (status 0) or a 5xx is retried, and so are 408 and 429, which HTTP defines
    /// as "try again later". Any other 4xx means the request itself is wrong, so a retry would only repeat the failure.
    /// Only meaningful for a failed response.
    public static class UploadPolicy
    {
        public static bool IsRetryable(long status)
        {
            if (status == 408 || status == 429) return true;
            return !(status >= 400 && status < 500);
        }
    }
}
