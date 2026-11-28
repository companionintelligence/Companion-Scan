# OpenVPS pilot for Scan and Compass

Companion Scan prepares a visual map from an owner's private Place. Companion
Compass uses a camera observation to locate itself against that map and align
its session to the same Place frame. Start with one opted-in test site, one
map revision and independent query captures on a phone with calibrated camera
access. See the [Open AR Cloud initiative](https://openarcloud.org/initiatives/openvps/).

## What the reference stack supports

Review pinned to OpenVPS [`dd8df87`](https://github.com/OpenArCloud/openvps/tree/dd8df87d756e1417a66d4ea76c19c18cb02d8812).
MapBuilder's shipped ingest expects a StrayScanner archive with RGB video,
camera calibration, odometry, IMU and depth/confidence folders. Its format
stage writes a COLMAP model and image directory. Its next stages filter the
reference images and run [HLOC](https://github.com/cvg/Hierarchical-Localization)
feature extraction, retrieval, matching and sparse reconstruction. A Scan
adapter can provide the formatted prior directly to the downstream pipeline.
This adapter must preserve distortion and image orientation. Canvas field of
view alone does not establish camera calibration. See the upstream
[format and build stages](https://github.com/OpenArCloud/openvps/blob/dd8df87d756e1417a66d4ea76c19c18cb02d8812/mapbuilder/Backend/src/processing/hloc/hlocStages.ts)
and [StrayScanner archive handling](https://github.com/OpenArCloud/openvps/blob/dd8df87d756e1417a66d4ea76c19c18cb02d8812/mapbuilder/scripts_mapping/stray_zip_extract.py).

MapLocalizer accepts `POST /localize/geopose` with
`Accept: application/vnd.oscp+json;version=2.0`, calibrated image parameters and
an image. The pinned worker accepts `X-OpenVPS-Map-Id` and supports a configured
resident map limit. Treat that header as a server-only routing detail. The
worker requires `transform.json` and can emit map-local `poses[]` with the
geodetic anchor fields omitted. Georeferenced maps can also emit `geoposes[]`.
Read the explicit pose arrays because the mandatory top-level GeoPose can be a
default placeholder. The framed pose covariance is `COV_NONE` in this revision.
See the [request handler](https://github.com/OpenArCloud/openvps/blob/dd8df87d756e1417a66d4ea76c19c18cb02d8812/maplocalizer/server/main.py),
[pose conversion](https://github.com/OpenArCloud/openvps/blob/dd8df87d756e1417a66d4ea76c19c18cb02d8812/maplocalizer/server/hloc_localizer.py)
and [response types](https://github.com/OpenArCloud/openvps/blob/dd8df87d756e1417a66d4ea76c19c18cb02d8812/maplocalizer/server/oscp/geoposeprotocol.py).

## First slice in this branch

Run the structural preflight on a local Scan server session after its Place
photo registration has produced a reference cache. Photo registration is
opt-in and requires a suitable calibrated capture, COLMAP and
`PLACE_REGISTER_SFM=1`. See [Place photo registration](../../server/register/place_register_sfm.ts)
and the [reference cache lifecycle](../../server/register/sfm_workspace.ts).

```sh
node scripts/openvps-preflight.mjs /path/to/scans/sessions/sess-example
```

The command prints counts and reason codes. Exit `0` means `candidate`, exit
`1` means `blocked`, and exit `2` means the command was invoked incorrectly.
It checks for the cached session/frame identity, sparse files, matching
registered-frame JPEG headers and dimensions, and the existing Scan minima of
six registered images, 60% registration and 100 sparse points. These are
structural filters reused from Scan's COLMAP code, with no OpenVPS accuracy
claim. Candidate status leaves source fingerprint, current Place generation,
metric fit, feature index building and localization to later gates. The command
only reads the local cache and source keyframes and prints no file paths,
images or Place identifiers.

## Delivery sequence

| Stage | Companion Scan | Companion Compass / service | Exit gate |
| --- | --- | --- | --- |
| 1. Qualify a capture | Walk translating through the same scene at different viewpoints. Choose one accepted Place frame and one retained keyframe session/epoch. Run the preflight. Record diversity and overlap evidence. | Pick a separate capture device or session and mark independent query checkpoints. | Local reference qualifies, query images are held out and independently measured checkpoints exist. |
| 2. Build a private feature map | Feed original JPEGs and sparse COLMAP intrinsics/extrinsics to the formatted-prior stage. Build HLOC artifacts in the owner's storage. Check exact JPEG orientation, camera IDs, dimensions and distortion. Pin upstream, feature/matcher/retrieval models, and image preprocessing. | Bring up a private NVIDIA-backed MapLocalizer behind the Companion gateway. Route one explicit immutable revision over the internal map header. | Reproducible build registers a private revision and `/localize/geopose` returns framed poses on held-out images. |
| 3. Register it to the Place | Fit a rigid rotation, translation and uniform scale from matching HLOC camera centers to the captured AR poses in the current Place frame. Reuse Scan's [Sim(3) chain](../../server/register/sim3_chain.ts). Refuse weak baselines, reflection, inconsistent gravity/frame epochs or poor held-out residuals. Bind the accepted fit to the exact Place frame generation. | Consume the same frame ID and revision, then compose the returned camera pose with app tracking at capture time. Convert OpenCV camera axes exactly once. Never infer metres from raw COLMAP coordinates. | Known translation and heading agree on the same reference markers when Scan and Compass reopen the Place. |
| 4. Review, share and revoke | Add an owner action to build a map with a clear status and to revoke it. Reuse the existing WorldJob system. Record source sessions, fingerprint, Place frame generation, map revision, feature config, fit quality and deletion linkage. Store a new revision for changed source or calibration. | Check auth on every query. Reject stale revisions, wrong provider frame IDs, ambiguous matches and stale responses. Fall back to manual setup or local co-location. | Session deletion, retention purge, Place frame replacement and revocation stop queries immediately. A deletion test verifies that files, derived features, queued work and loaded maps are removed. |
| 5. Extend to geographic use | Use the confirmed [Place georeference](../adr/0015-scene-convention-and-georeference.md) when it has a valid WGS84 ellipsoidal height and a measured bearing. Carry the anchor version, datum and uncertainty. | Distinguish global GeoPose from indoor `FramedPose` and record which was used. Start a separate device validation pass for Quest and Aura. | Check ENU axes, heights and rotation against surveyed outdoor points. Validate capture APIs and intrinsics on each target before enabling it. |

## Pilot acceptance

- Capture at least 30 held-out queries from three independent passes through the
  mapped Place. Include changed viewpoint/lighting and wrong-room/textureless
  queries. Report acceptance rate, P50/P95 latency, translation/heading error
  against independent checkpoints and wrong-map acceptances separately.
- Use these provisional targets for the first editor/navigation demo: at least
  80% of valid checkpoint queries accepted, zero wrong-room acceptances in the
  sample, P90 position error at most 0.5 m and heading error at most 10°, and P95
  response within 3 s on a warmed worker. Revisit the targets with real device
  data before making a user-facing accuracy claim.
- Require temporal and geometric agreement before offering an alignment. Keep
  the existing placement until the user accepts. Treat missing covariance as
  unknown, and preserve result provenance with request ID, camera timestamp,
  revision and frame generation.
- Keep localization query images transient on the owner's infrastructure.
  Treat feature vectors, sparse points and database files as camera-derived
  material with the same retention rules as source frames. Existing capture
  consent needs a separate opt-in for map building and query image submission.
  Keep Maps and their OpenVPS administrative routes private. Review the licenses
  of pinned feature weights before distributing a configured worker. See
  [Scan privacy and retention](../operations/PRIVACY.md) and [upstream licensing](https://github.com/OpenArCloud/openvps/blob/dd8df87d756e1417a66d4ea76c19c18cb02d8812/licenses-thirdparty.md).
