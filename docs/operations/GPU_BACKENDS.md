# GPU backends for the CV server

This is the setup runbook for the box that runs the computer-vision stages: panoptic
segmentation, LingBot-Map reconstruction, Brush and Spirula splat training, and Ollama
vision inference. It says which GPU vendors can run which stage, what each vendor needs
installed, and which models are NVIDIA-only by design.

What was actually run, and on which hardware, is recorded in
[PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md#accelerators). This file describes setup only.

## The rule

One resolver decides the torch device: `scripts/_torch_device.py`. Model code never branches
on vendor. It asks the resolver for `device`, `dtype` and whether to autocast. The NVIDIA
path is the one that was measured first, and it stays unchanged. Apple, AMD and Intel are
reached through the same resolver, and each reports what it actually used.

## Support by stage

| Stage | NVIDIA (CUDA) | AMD (ROCm) | Apple (MPS) | Intel (XPU) | CPU |
| --- | --- | --- | --- | --- | --- |
| Ollama vision inference (`server/inference.ts`) | Supported | Supported (ROCm); Vulkan is opt-in | Supported (Metal) | Experimental (Vulkan, opt-in) | Supported |
| Panoptic segmentation, Mask2Former (`scripts/panoptic_worker.py`) | fp16. **Verified** on RTX 3070, 2026-11-12 | fp16 via ROCm torch. Unverified | fp16. Unverified | fp32 until measured. Unverified | fp32 |
| Detection service, Grounding DINO (`scripts/grounding_dino_server.py`) | fp16 autocast. **Verified** on RTX 3070, 2026-11-25: base model, 150–180 ms for a 512 px frame once warm, 1.9 GiB of GPU memory | fp16 autocast via ROCm torch. Unverified | fp32; autocast is not used on MPS. Unverified | fp16 autocast. Unverified | fp32. Unmeasured |
| LingBot-Map (`scripts/lingbot_map_worker.py`) | fp16 autocast. Unverified here (no checkpoint on this box) | fp16 autocast via ROCm torch. Unverified | fp32; autocast is not used on MPS | fp32 until measured. Unverified | fp32 |
| Brush splat training (wgpu) | Vulkan | Vulkan | Metal | Vulkan. Unverified | Not usable |
| Spirula splat training (wgpu) | Vulkan | Vulkan | No macOS build in this repo | Vulkan. Unverified | Not usable |
| 4DAnyone person capture | **NVIDIA only**, one device with at least 44 GiB, off-box (ADR 0006) | Not supported | Not supported | Not supported | Not supported |
| SenseNova Recon3D | **NVIDIA only** (CUDA 12.x, FlashAttention, `scripts/setup-sensenova-wsl.sh`) | Not supported | Not supported | Not supported | Not supported |

## Per-vendor setup

### NVIDIA

Keep the CUDA wheel. The version verified here is torch 2.11.0+cu128 on an RTX 3070
(driver 580.178.04).

```bash
uv venv --python 3.12 ~/.venvs/cv-gpu
uv pip install --python ~/.venvs/cv-gpu/bin/python torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python ~/.venvs/cv-gpu/bin/python transformers pillow numpy scipy
```

The resolver should report `cuda (NVIDIA CUDA, fp16)`.

### AMD (ROCm) — unverified

Install a ROCm torch wheel from the PyTorch install selector. A ROCm torch reports
`torch.cuda.is_available() == True` and uses the device string `cuda`. The resolver tells
it apart from NVIDIA by `torch.version.hip`, and labels it `AMD ROCm`.

- On a multi-GPU host, pick a device with `HIP_VISIBLE_DEVICES`.
- `server/splat/splat_detect.ts` passes `HIP_VISIBLE_DEVICES` to the analyzer only when it is
  set; unset (the default since wave 14) pins no device. Until then it defaulted to `1`, which was
  wrong on a single-GPU AMD box. See [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md#rocm-is-not-a-separate-branch-and-must-not-become-one).

### Apple Silicon (MPS) — unverified

The standard PyPI torch wheel includes MPS.

```bash
uv pip install --python ~/.venvs/cv-gpu/bin/python torch torchvision
```

- The panoptic and LingBot workers set `PYTORCH_ENABLE_MPS_FALLBACK=1`. An operator op that
  MPS lacks then falls back to CPU rather than aborting the run. Export a different value to
  override it.
- LingBot runs in fp32 on MPS. fp16 autocast is wired for CUDA and XPU only, because autocast
  on MPS has not been run in this repo.
- Spirula has no macOS build referenced here, so it is not an option on a Mac. Brush needs
  Metal. Untested.

### Intel GPU (XPU) — unverified

Install the Intel GPU driver first, then Intel's torch XPU wheel. PyTorch's Intel GPU guide
gives the stable command:

```bash
uv pip install --python ~/.venvs/cv-gpu/bin/python torch torchvision --index-url https://download.pytorch.org/whl/xpu
python3 -c "import torch; print(torch.xpu.is_available())"   # must print True
```

- The resolver reports `xpu (Intel XPU, fp32)`. fp32 is used until fp16 has been measured on
  Intel hardware. The reason is printed with the device.
- On a multi-GPU host, select the device with `ZE_AFFINITY_MASK` (the Level Zero selector).
  That is the standard Intel mechanism. It is not verified on this repo's hardware.
- Ollama on Intel uses its Vulkan path, which is experimental and opt-in:
  `OLLAMA_VULKAN=1 ollama serve`. Reports are mixed, so treat it as unverified.
- Brush and Spirula use Vulkan. Check that `vulkaninfo --summary` lists the Intel device;
  the capability probe reports the same thing.

### CPU only

Every worker degrades with a printed reason. Ollama and the panoptic and LingBot workers run
on CPU. Brush and Spirula are not usable on CPU.

## Check what a box will actually use

```bash
node server/capabilities.ts
```

The torch line reports the accelerator: `cuda`, `rocm`, `mps`, `xpu` or `cpu`.

```bash
cd scripts && ~/.venvs/cv-gpu/bin/python -c "import torch; from _torch_device import resolve_torch_device as r; d = r(torch); print(d.label, '—', d.reason)"
```

## Environment variables

| Variable | What it does |
| --- | --- |
| `PANOPTIC_DEVICE` | Panoptic device: `auto` (default), `cpu`, `cuda`, `cuda:N`, `mps`, `xpu`. Read by `server/panoptic/panoptic_scan.ts` |
| `LINGBOT_MAP_DEVICE` | LingBot device: `auto`, `cpu`, `cuda`, `mps`, `xpu`. Read by `server/lingbot-map/lingbot_map.ts` |
| `GDINO_DEVICE` | Detection service device: `auto` (default), `cpu`, `cuda`, `cuda:N`, `mps`, `xpu`. Read by `scripts/grounding_dino_server.py` |
| `PYTORCH_ENABLE_MPS_FALLBACK` | Set to `1` by the workers unless already exported. Unsupported MPS ops fall back to CPU |
| `HIP_VISIBLE_DEVICES` | AMD device selection (ROCm) |
| `ZE_AFFINITY_MASK` | Intel device selection (Level Zero) |
| `OLLAMA_VULKAN` | Ollama's experimental Vulkan path, for AMD and Intel |

`auto` is a request, not an answer. An unreachable backend is downgraded to CPU with a
reason. Read `params.resolvedDevice` and `params.deviceVendor` from the LingBot manifest to
see what ran.

## NVIDIA-only models, kept by design

- **4DAnyone** runs off-box on a CUDA device with at least 44 GiB. See ADR 0006 and
  [docs/pipelines/4d-person.md](../pipelines/4d-person.md).
- **SenseNova Recon3D** needs CUDA 12.x and FlashAttention, set up by
  `scripts/setup-sensenova-wsl.sh`. On a non-NVIDIA host leave `SENSENOVA_DIR` unset. The
  server then reports `skipped` with a remediation, and nothing crashes.

These are not ported. Making them run elsewhere would mean a different attention kernel and
different weights, which is a model decision, not a device one.

## The detection service (Grounding DINO)

`scripts/grounding_dino_server.py` serves open-vocabulary object detection over HTTP: an XR
client posts a camera frame and the names of the things to find, and gets boxes back. It runs
the open weights of Grounding DINO (`IDEA-Research/grounding-dino-base` by default, Apache-2.0)
through transformers, on the device `_torch_device.py` resolves. It stands in for NVIDIA's
hosted NV-Grounding-DINO, which the Unity-MetaXR-AI-ZeroShot reference calls, so frames stay on
the tailnet. The Scan server can use it as its `/infer` engine too (`INFERENCE_MODE=grounding-dino`, below).

- **Contract.** `POST /detect` takes `{"prompt", "threshold", "max_detections",
  "image_base64"}` and answers `{"frame_width", "frame_height", "detections": [{"label",
  "confidence", "bbox": [x, y, w, h]}]}` in pixels of the frame as sent, plus `model`, `device`
  and `inference_ms`. `GET /health` reports whether the model has loaded, and why not.
- **Clients.** The ZeroShot detector in the Unity avatar prototype sends and reads this contract
  ([`ZeroShotDetector.cs`](https://github.com/companionintelligence/CI-Spatial-Agent-Unity/blob/3a8b2b607bb1578d0793a6f1c646cd7f4f9f6ef1/Assets/Scripts/ZeroShot/ZeroShotDetector.cs),
  branch `pr/scaffold2`). Point its `ZeroShotBackendConfig`'s `endpointUrl` here. With
  `GDINO_TOKEN` set, also turn on its `useBearerAuth` and put the token in `apiKey`. The
  prototype's own development server can forward to this service (`ZERO_SHOT_BACKEND=forward`
  with `GROUNDING_DINO_URL`), but it sends no token.
- **Environment.** `GDINO_HOST` (default `127.0.0.1`), `GDINO_PORT` (default `8010`),
  `GDINO_MODEL`, `GDINO_DEVICE`, `GDINO_TOKEN` (a bearer token, if set), and
  `GDINO_CERT_FILE` / `GDINO_KEY_FILE` for HTTPS. Set them in `~/.config/cscan/env`.
- **Install.** It uses the NVIDIA venv above: `transformers` and `pillow` are already in it.
  `scripts/install-services.sh --with-gdino` adds the `cscan-gdino` user unit, which serves
  HTTPS with the box's Tailscale cert. The first start downloads the weights (933 MB for base,
  689 MB for `grounding-dino-tiny`) into the Hugging Face cache.
- **As the Scan server's engine.** Set `INFERENCE_MODE=grounding-dino` and `GDINO_URL` to the
  service's address (for example `https://<host>.<tailnet>.ts.net:8010`), and `GDINO_TOKEN` if the
  service has one: the same variable, so one env file serves both. `/infer` then sends each frame
  with the scanner's own labels (`CORE_LABELS` in `server/prompt.ts`) as the prompt, and the boxes
  go through the same label folding, confidence floor and cap as the Ollama engine's
  (`server/grounding_dino.ts`). It has no description to give, so each detection reads "A <label>".
  At start the server asks `GET /health`: a service that does not answer leaves the server without
  inference, as an unreachable Ollama does, and one that answers before its model is in is used
  anyway, with `/infer` passing on its 503 until the model loads. The capability report's
  `inference-engine` row shows the address and whether the model is ready.
- **Test.** `npm run test:python:gdino` covers the request rules and the HTTP layer with a fake
  model, so it needs no torch. `tests/unit/server/inference_grounding_dino.test.ts` covers the
  Scan server's side against a fake service.

## Sources for the vendor install commands

- PyTorch Intel GPU guide: <https://docs.pytorch.org/docs/stable/notes/get_start_xpu.md>
- Ollama GPU documentation, Vulkan path: <https://docs.ollama.com/gpu>
