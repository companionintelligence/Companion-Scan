#!/usr/bin/env python3
"""Open-vocabulary object detection over HTTP: Grounding DINO on this box's GPU.

A client sends a camera frame and the names of the things to find, and gets boxes back. This is
the self-hosted stand-in for NVIDIA's hosted NV-Grounding-DINO, which the Unity-MetaXR-AI-ZeroShot
reference project calls, so frames stay on the tailnet instead of going to a cloud API.

  POST /detect
    {"prompt": "a cup, a laptop", "threshold": 0.3, "max_detections": 50,
     "image_base64": "<a JPEG or PNG, base64>"}
  -> {"frame_width": 1280, "frame_height": 960,
      "detections": [{"label": "cup", "confidence": 0.61, "bbox": [x, y, w, h]}],
      "model": "IDEA-Research/grounding-dino-base", "device": "cuda (NVIDIA CUDA, fp16 autocast)",
      "inference_ms": 92}

  GET /health
  -> {"status": "ok", "ready": true, "state": "ready", "model": ..., "device": ..., "error": null}

The request, and the first three fields of the reply, are what the ZeroShot detector in the Unity
avatar prototype sends and reads: Assets/Scripts/ZeroShot/ZeroShotDetector.cs on the pr/scaffold2
branch of companionintelligence/CI-Spatial-Agent-Unity. Point its ZeroShotBackendConfig's
endpointUrl here. With GDINO_TOKEN set, also turn on its useBearerAuth and put the token in
apiKey. The prototype's own development server can forward to this one too
(ZERO_SHOT_BACKEND=forward with GROUNDING_DINO_URL), but it sends no token, so only while
GDINO_TOKEN is unset.
`bbox` is [x, y, w, h] in pixels of the frame as sent, with the origin at the top left.
`threshold` is the cut-off for a box's score. An optional `text_threshold` (default 0.25) is the
cut-off for the words that name a box. In `prompt`, phrases are separated by commas, full stops,
semicolons or new lines.

Configuration comes from the environment. The command-line flags override it:

  GDINO_MODEL           Hugging Face model id. The default is IDEA-Research/grounding-dino-base.
                        IDEA-Research/grounding-dino-tiny is smaller and faster. Both are Apache-2.0.
  GDINO_HOST            Address to listen on. The default, 127.0.0.1, keeps the service on this box.
  GDINO_PORT            Port. The default is 8010.
  GDINO_DEVICE          auto | cpu | cuda | cuda:N | mps | xpu, resolved by _torch_device.py.
  GDINO_TOKEN           If set, POST /detect needs "Authorization: Bearer <token>".
  GDINO_CERT_FILE, GDINO_KEY_FILE
                        Serve HTTPS with this certificate and key. On a Tailscale box these are the
                        files `tailscale cert` writes. They are read again when they change, so a
                        renewed certificate needs no restart.
  GDINO_MAX_BODY_BYTES  The largest request accepted. The default is 16 MiB.

The service is deployed the way the other workers are: copy this file and _torch_device.py into
one folder, and run it with an interpreter that has torch, transformers and Pillow, such as
~/.venvs/cv-gpu (docs/operations/GPU_BACKENDS.md). The model loads in the background. Until it
is ready, /health says why and POST /detect answers 503. A failed load is retried every minute.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import hmac
import io
import json
import math
import os
import re
import ssl
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Protocol

DEFAULT_MODEL = "IDEA-Research/grounding-dino-base"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8010
DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024
DEFAULT_THRESHOLD = 0.3
DEFAULT_TEXT_THRESHOLD = 0.25
DEFAULT_MAX_DETECTIONS = 50
MAX_DETECTIONS_LIMIT = 200
MAX_PROMPT_CHARS = 1000
MAX_LABELS = 40
MAX_PIXELS = 40_000_000
LOAD_RETRY_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 30

_SEPARATORS = re.compile(r"[,.;\n]+")


def log(message: str) -> None:
    print(f"[gdino] {message}", file=sys.stderr, flush=True)


class RequestError(Exception):
    """A request the service refuses, with the HTTP status to answer it with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class DetectRequest:
    labels: list[str]
    threshold: float
    text_threshold: float
    max_detections: int
    image: bytes


def parse_labels(prompt: str) -> list[str]:
    """The phrases in a prompt: lower case, single-spaced, each once, in the order given.

    Grounding DINO itself separates phrases with full stops and expects lower case. Commas are
    accepted too, because that is how the ZeroShot client's prompt field is filled in.
    """
    labels: list[str] = []
    for part in _SEPARATORS.split(prompt):
        phrase = " ".join(part.split()).lower()
        if phrase and phrase not in labels:
            labels.append(phrase)
    return labels


def _fraction(payload: dict, key: str, default: float) -> float:
    value = payload.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestError(400, f"{key} must be a number")
    value = float(value)
    if not 0.0 <= value <= 1.0:  # also refuses NaN, which json.loads accepts
        raise RequestError(400, f"{key} must be between 0 and 1")
    return value


def parse_request(payload: Any) -> DetectRequest:
    """Check a decoded POST /detect body. Raises RequestError(400, ...) for anything wrong."""
    if not isinstance(payload, dict):
        raise RequestError(400, "the body must be a JSON object")

    prompt = payload.get("prompt", "")
    if not isinstance(prompt, str):
        raise RequestError(400, "prompt must be a string")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise RequestError(400, f"prompt is longer than {MAX_PROMPT_CHARS} characters")
    labels = parse_labels(prompt)
    if not labels:
        raise RequestError(400, "prompt names nothing to find")
    if len(labels) > MAX_LABELS:
        raise RequestError(400, f"prompt names more than {MAX_LABELS} things")

    threshold = _fraction(payload, "threshold", DEFAULT_THRESHOLD)
    text_threshold = _fraction(payload, "text_threshold", DEFAULT_TEXT_THRESHOLD)

    raw_max = payload.get("max_detections", DEFAULT_MAX_DETECTIONS)
    if (
        isinstance(raw_max, bool)
        or not isinstance(raw_max, (int, float))
        or (isinstance(raw_max, float) and not raw_max.is_integer())
    ):
        raise RequestError(400, "max_detections must be a whole number")
    max_detections = int(raw_max)
    if not 1 <= max_detections <= MAX_DETECTIONS_LIMIT:
        raise RequestError(400, f"max_detections must be between 1 and {MAX_DETECTIONS_LIMIT}")

    encoded = payload.get("image_base64")
    if not isinstance(encoded, str) or not encoded.strip():
        raise RequestError(400, "image_base64 is missing")
    if encoded.startswith("data:"):
        encoded = encoded.partition(",")[2]
    try:
        image = base64.b64decode("".join(encoded.split()), validate=True)
    except (binascii.Error, ValueError):
        raise RequestError(400, "image_base64 is not valid base64") from None
    if not image:
        raise RequestError(400, "image_base64 is empty")

    return DetectRequest(labels, threshold, text_threshold, max_detections, image)


def to_xywh(box: Any, width: int, height: int) -> list[float] | None:
    """[x, y, w, h] in pixels, clamped to the frame, from [x0, y0, x1, y1]. None if no area is left."""
    x0, y0, x1, y1 = (float(v) for v in box)
    if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
        return None
    x0, x1 = (min(max(v, 0.0), float(width)) for v in (x0, x1))
    y0, y1 = (min(max(v, 0.0), float(height)) for v in (y0, y1))
    if x1 <= x0 or y1 <= y0:
        return None
    return [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)]


def shape_detections(
    scores: list, boxes: list, labels: list, width: int, height: int, max_detections: int
) -> list[dict]:
    """The reply's detections: named, with a finite score and a box with area, best first."""
    found = []
    for score, box, label in zip(scores, boxes, labels):
        score = float(score)
        bbox = to_xywh(box, width, height)
        if bbox is None or not label or not math.isfinite(score):
            continue
        found.append({"label": str(label), "confidence": round(score, 4), "bbox": bbox})
    found.sort(key=lambda d: d["confidence"], reverse=True)
    return found[:max_detections]


def authorized(header: str | None, token: str | None) -> bool:
    if not token:
        return True
    scheme, _, value = (header or "").partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(value.strip().encode(), token.encode())


class Detector(Protocol):
    device_label: str

    def detect(
        self, image: bytes, labels: list[str], threshold: float, text_threshold: float
    ) -> tuple[int, int, list, list, list]:
        """(frame width, frame height, scores, [x0, y0, x1, y1] boxes, labels)."""
        ...


class ModelHolder:
    """Loads the detector on a background thread and retries until it works, so /health can say why."""

    def __init__(
        self, model_id: str, load: Callable[[], Detector], retry_seconds: float = LOAD_RETRY_SECONDS
    ) -> None:
        self.model_id = model_id
        self._load = load
        self._retry_seconds = retry_seconds
        self._lock = threading.Lock()
        self._detector: Detector | None = None
        self._state = "loading"
        self._error: str | None = None

    @property
    def detector(self) -> Detector | None:
        with self._lock:
            return self._detector

    def start(self) -> None:
        threading.Thread(target=self.load_until_ready, name="gdino-load", daemon=True).start()

    def load_until_ready(self) -> None:
        while True:
            try:
                detector = self._load()
            except Exception as exc:  # noqa: BLE001 - every failure is reported, then retried
                with self._lock:
                    self._state = "retrying"
                    self._error = f"{type(exc).__name__}: {exc}"
                log(f"loading {self.model_id} failed, retrying in {self._retry_seconds:g} s: {exc}")
                time.sleep(self._retry_seconds)
                continue
            with self._lock:
                self._detector = detector
                self._state = "ready"
                self._error = None
            log(f"ready: {self.model_id} on {detector.device_label}")
            return

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "ready": self._detector is not None,
                "state": self._state,
                "model": self.model_id,
                "device": self._detector.device_label if self._detector is not None else None,
                "error": self._error,
            }


class GroundingDinoDetector:
    """Grounding DINO through transformers, on the device _torch_device.py picks."""

    def __init__(self, model_id: str, requested_device: str | None) -> None:
        # Imported here, so the HTTP layer and its tests need neither torch nor transformers.
        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        try:
            from _torch_device import resolve_torch_device
        except ImportError as exc:
            raise RuntimeError(
                "_torch_device.py must sit next to this file: copy scripts/_torch_device.py beside it"
            ) from exc

        self._torch = torch
        device = resolve_torch_device(torch, requested_device)
        log(f"device {device.label}: {device.reason}")
        if device.wants_cudnn_workaround():
            torch.backends.cudnn.enabled = False  # the same cuDNN guard the panoptic worker uses
        self._device = device.device
        self._vendor = device.vendor
        self._autocast = device.use_autocast_fp16()
        self._processor = AutoProcessor.from_pretrained(model_id)
        self._model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(self._device).eval()
        self._lock = threading.Lock()
        self._warm_up()

    @property
    def device_label(self) -> str:
        return f"{self._device} ({self._vendor}, {'fp16 autocast' if self._autocast else 'fp32'})"

    def _warm_up(self) -> None:
        from PIL import Image

        blank = Image.new("RGB", (64, 64), (127, 127, 127))
        try:
            self._run(blank, ["object"], 0.5, 0.5)
        except Exception as exc:  # noqa: BLE001 - fall back once, then let a second failure raise
            if not self._autocast:
                raise
            log(f"fp16 autocast failed in the warm-up ({type(exc).__name__}: {exc}), so it runs in fp32")
            self._autocast = False
            self._run(blank, ["object"], 0.5, 0.5)

    def _run(self, frame: Any, labels: list[str], threshold: float, text_threshold: float) -> tuple:
        torch = self._torch
        with self._lock, torch.inference_mode():
            inputs = self._processor(images=frame, text=[labels], return_tensors="pt").to(self._device)
            autocast = (
                torch.autocast(device_type=self._device.split(":")[0], dtype=torch.float16)
                if self._autocast
                else contextlib.nullcontext()
            )
            with autocast:
                outputs = self._model(**inputs)
            result = self._processor.post_process_grounded_object_detection(
                outputs,
                inputs.input_ids,
                threshold=threshold,
                text_threshold=text_threshold,
                target_sizes=[(frame.height, frame.width)],
            )[0]
            return (
                result["scores"].float().tolist(),
                result["boxes"].float().tolist(),
                list(result["text_labels"]),
            )

    def detect(
        self, image: bytes, labels: list[str], threshold: float, text_threshold: float
    ) -> tuple[int, int, list, list, list]:
        from PIL import Image, UnidentifiedImageError

        try:
            with Image.open(io.BytesIO(image)) as opened:
                if opened.width * opened.height > MAX_PIXELS:
                    raise RequestError(413, f"the image has more than {MAX_PIXELS} pixels")
                frame = opened.convert("RGB")
        except RequestError:
            raise
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise RequestError(400, "image_base64 is not an image this service can read") from None

        out_of_memory = getattr(self._torch.cuda, "OutOfMemoryError", MemoryError)
        try:
            scores, boxes, names = self._run(frame, labels, threshold, text_threshold)
        except out_of_memory:
            self._torch.cuda.empty_cache()
            raise RequestError(503, "the GPU ran out of memory; try again") from None
        return frame.width, frame.height, scores, boxes, names


class _CertSource:
    """The TLS context, rebuilt when the certificate files change (`tailscale cert` renews them)."""

    def __init__(self, cert_file: str, key_file: str) -> None:
        self._files = (cert_file, key_file)
        self._lock = threading.Lock()
        self._stamp: tuple | None = None
        self._context: ssl.SSLContext | None = None
        self.context()  # a bad certificate fails at start-up, not at the first request

    def context(self) -> ssl.SSLContext:
        with self._lock:
            stamp = tuple(os.stat(path).st_mtime_ns for path in self._files)
            if stamp != self._stamp:
                try:
                    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                    context.minimum_version = ssl.TLSVersion.TLSv1_2
                    context.load_cert_chain(*self._files)
                except (OSError, ssl.SSLError) as exc:
                    if self._context is None:
                        raise
                    # Probably caught between the certificate and the key being rewritten.
                    log(f"keeping the previous certificate, the new files did not load: {exc}")
                    return self._context
                self._context, self._stamp = context, stamp
            assert self._context is not None
            return self._context


class DetectServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        holder: ModelHolder,
        token: str | None,
        max_body: int,
        certs: _CertSource | None = None,
    ) -> None:
        self.holder = holder
        self.token = token
        self.max_body = max_body
        self.certs = certs
        super().__init__(address, DetectHandler)

    def get_request(self) -> tuple:
        sock, address = super().get_request()
        if self.certs is not None:
            try:
                context = self.certs.context()
            except Exception as exc:  # noqa: BLE001 - drop this connection, keep serving
                sock.close()
                raise OSError(f"TLS is not available: {exc}") from exc
            # The handshake happens on the handler's thread, so a slow client cannot stall accept().
            sock = context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False)
        return sock, address

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc = sys.exc_info()[1]
        log(f"connection from {client_address[0]} failed: {type(exc).__name__}: {exc}")


class DetectHandler(BaseHTTPRequestHandler):
    server: DetectServer
    protocol_version = "HTTP/1.1"
    timeout = REQUEST_TIMEOUT_SECONDS
    server_version = "cscan-gdino"
    sys_version = ""

    def handle(self) -> None:
        if isinstance(self.connection, ssl.SSLSocket):
            try:
                self.connection.do_handshake()
            except (ssl.SSLError, OSError) as exc:
                log(f"TLS handshake with {self.client_address[0]} failed: {exc}")
                return
        super().handle()

    def log_message(self, format: str, *args: Any) -> None:
        return  # one line per request is written by do_POST, without any image data

    def _send(self, status: int, body: dict, headers: dict | None = None) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, message: str) -> None:
        self.close_connection = True  # an unread body may still be in the stream
        self._send(status, {"error": message}, {"Retry-After": "5"} if status == 503 else None)

    def _read_body(self) -> bytes:
        length = self.headers.get("Content-Length")
        if length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            size = int(length)
        except ValueError:
            raise RequestError(400, "Content-Length is not a number") from None
        if size < 0:
            raise RequestError(400, "Content-Length is negative")
        if size > self.server.max_body:
            raise RequestError(413, f"the body is larger than {self.server.max_body} bytes")
        body = self.rfile.read(size)
        if len(body) != size:
            raise RequestError(400, "the body ended early")
        return body

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/health":
            self._error(404, "not found")
            return
        self._send(200, {"status": "ok", **self.server.holder.snapshot()})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/detect":
            self._error(404, "not found")
            return
        if not authorized(self.headers.get("Authorization"), self.server.token):
            self._error(401, "a valid bearer token is required")
            return
        try:
            try:
                request = parse_request(json.loads(self._read_body()))
            except ValueError:  # JSONDecodeError and UnicodeDecodeError are both ValueErrors
                raise RequestError(400, "the body is not JSON") from None
            holder = self.server.holder
            detector = holder.detector
            if detector is None:
                error = holder.snapshot()["error"]
                raise RequestError(503, "the model is still loading" + (f" (last error: {error})" if error else ""))
            started = time.monotonic()
            width, height, scores, boxes, names = detector.detect(
                request.image, request.labels, request.threshold, request.text_threshold
            )
            inference_ms = round((time.monotonic() - started) * 1000)
            detections = shape_detections(scores, boxes, names, width, height, request.max_detections)
        except RequestError as exc:
            log(f"POST /detect {exc.status}: {exc.message}")
            self._error(exc.status, exc.message)
            return
        except Exception:  # noqa: BLE001 - answer 500 and keep serving
            log("POST /detect 500:\n" + traceback.format_exc())
            self._error(500, "detection failed")
            return
        log(
            f"POST /detect 200: {len(detections)} found for {len(request.labels)} phrases "
            f"in a {width}x{height} frame, {inference_ms} ms"
        )
        self._send(
            200,
            {
                "frame_width": width,
                "frame_height": height,
                "detections": detections,
                "model": holder.model_id,
                "device": detector.device_label,
                "inference_ms": inference_ms,
            },
        )


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(f"[gdino] {name} must be a whole number, not {raw!r}") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Grounding DINO detection service (POST /detect, GET /health).")
    parser.add_argument("--host", default=os.environ.get("GDINO_HOST") or DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=_env_int("GDINO_PORT", DEFAULT_PORT))
    parser.add_argument("--model", default=os.environ.get("GDINO_MODEL") or DEFAULT_MODEL)
    parser.add_argument("--device", default=os.environ.get("GDINO_DEVICE") or "auto")
    parser.add_argument("--cert-file", default=os.environ.get("GDINO_CERT_FILE") or None)
    parser.add_argument("--key-file", default=os.environ.get("GDINO_KEY_FILE") or None)
    args = parser.parse_args(argv)

    if bool(args.cert_file) != bool(args.key_file):
        log("set both a certificate and a key file, or neither")
        return 2
    certs = _CertSource(args.cert_file, args.key_file) if args.cert_file else None
    token = os.environ.get("GDINO_TOKEN") or None
    max_body = _env_int("GDINO_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)

    holder = ModelHolder(args.model, lambda: GroundingDinoDetector(args.model, args.device))
    server = DetectServer((args.host, args.port), holder, token, max_body, certs)
    holder.start()
    scheme = "https" if certs else "http"
    log(
        f"listening on {scheme}://{args.host}:{args.port} (POST /detect, GET /health), "
        f"bearer token {'required' if token else 'not required'}, loading {args.model}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
