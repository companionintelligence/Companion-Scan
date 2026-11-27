using AuraScanner.Core;
using UnityEngine;
using UnityEngine.XR;

namespace AuraScanner.Runtime
{
    /// The wearer's head pose from OpenXR, read through Unity's XR input and converted to the convention the server stores.
    /// Reports no pose while position or rotation is not tracked: a pose taken then is not in the room's frame.
    public static class HeadPoseSource
    {
        private const InputTrackingState Required = InputTrackingState.Position | InputTrackingState.Rotation;

        public static bool TryGetPose(out PoseF pose)
        {
            pose = default;
            InputDevice head = InputDevices.GetDeviceAtXRNode(XRNode.Head);
            if (!head.isValid) return false;
            if (!head.TryGetFeatureValue(CommonUsages.trackingState, out InputTrackingState state)) return false;
            if ((state & Required) != Required) return false;
            if (!head.TryGetFeatureValue(CommonUsages.devicePosition, out Vector3 position)) return false;
            if (!head.TryGetFeatureValue(CommonUsages.deviceRotation, out Quaternion rotation)) return false;
            var unityPose = new PoseF(position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w);
            pose = PoseConvention.ToRightHanded(unityPose);
            return true;
        }
    }
}
