#!/usr/bin/env python3
"""Unit tests for scripts/grounding_dino_server.py, the Grounding DINO detection service.

They run with the standard library alone: no torch, transformers or Pillow. Under -I the run
goes through discover:

    python3 -I -B -m unittest discover -s tests/unit/python -p test_grounding_dino_server.py

The server is loaded by path. Its module-level imports are standard library only; the model is
imported inside GroundingDinoDetector, which these tests replace with a fake.

What is pinned:
- the request of the avatar prototype's ZeroShot client (prompt, threshold, max_detections,
  image_base64), and what is refused, with which status;
- boxes leave as [x, y, w, h] pixels inside the frame, best first, capped;
- over a real socket: the reply's shape, the bearer token, the body limit, the 503 while the
  model loads, and a load that fails and is retried.
"""
import base64
import http.client
import importlib.util
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

SERVER = Path(__file__).resolve().parents[3] / "scripts" / "grounding_dino_server.py"


def load_server():
    spec = importlib.util.spec_from_file_location("grounding_dino_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look the module up while they build DetectRequest
    spec.loader.exec_module(module)
    return module


gd = load_server()
IMAGE_BYTES = b"\xff\xd8\xff a JPEG, as far as these tests care"
IMAGE = base64.b64encode(IMAGE_BYTES).decode()


def body(**fields):
    payload = {"prompt": "a cup", "image_base64": IMAGE}
    payload.update(fields)
    return payload


class ParseLabelsTest(unittest.TestCase):
    def test_commas_full_stops_semicolons_and_new_lines_separate_phrases(self):
        self.assertEqual(
            gd.parse_labels("a cat, a dog. the remote;a mug\nchair"),
            ["a cat", "a dog", "the remote", "a mug", "chair"],
        )

    def test_phrases_are_lower_case_single_spaced_and_each_given_once(self):
        self.assertEqual(gd.parse_labels("  A   Cup , a cup,CUP.  "), ["a cup", "cup"])

    def test_a_prompt_of_separators_names_nothing(self):
        self.assertEqual(gd.parse_labels(" , . ; \n"), [])


class ParseRequestTest(unittest.TestCase):
    def test_the_zeroshot_client_request_parses_with_its_values(self):
        request = gd.parse_request(body(prompt="a cat, a remote control", threshold=0.3, max_detections=50))
        self.assertEqual(request.labels, ["a cat", "a remote control"])
        self.assertEqual(request.threshold, 0.3)
        self.assertEqual(request.text_threshold, gd.DEFAULT_TEXT_THRESHOLD)
        self.assertEqual(request.max_detections, 50)
        self.assertEqual(request.image, IMAGE_BYTES)

    def test_defaults_fill_what_the_client_leaves_out(self):
        request = gd.parse_request(body())
        self.assertEqual(request.threshold, gd.DEFAULT_THRESHOLD)
        self.assertEqual(request.max_detections, gd.DEFAULT_MAX_DETECTIONS)

    def test_a_data_url_and_line_wrapped_base64_are_accepted(self):
        wrapped = "\n".join(IMAGE[i : i + 8] for i in range(0, len(IMAGE), 8))
        for encoded in (f"data:image/jpeg;base64,{IMAGE}", wrapped):
            with self.subTest(encoded=encoded[:24]):
                self.assertEqual(gd.parse_request(body(image_base64=encoded)).image, IMAGE_BYTES)

    def test_a_whole_number_sent_as_a_float_is_accepted(self):
        self.assertEqual(gd.parse_request(body(max_detections=50.0)).max_detections, 50)

    def test_each_refusal_is_a_400_that_names_the_field(self):
        cases = [
            ([], "JSON object"),
            (body(prompt=None), "prompt must be a string"),
            (body(prompt=" , "), "names nothing"),
            (body(prompt="x" * (gd.MAX_PROMPT_CHARS + 1)), "longer than"),
            (body(prompt=", ".join(f"thing {i}" for i in range(gd.MAX_LABELS + 1))), "more than"),
            (body(threshold="0.3"), "threshold must be a number"),
            (body(threshold=True), "threshold must be a number"),
            (body(threshold=1.5), "threshold must be between 0 and 1"),
            (body(threshold=float("nan")), "threshold must be between 0 and 1"),
            (body(text_threshold=-0.1), "text_threshold must be between 0 and 1"),
            (body(max_detections=50.5), "whole number"),
            (body(max_detections=0), "between 1 and"),
            (body(max_detections=gd.MAX_DETECTIONS_LIMIT + 1), "between 1 and"),
            (body(image_base64=None), "image_base64 is missing"),
            (body(image_base64="   "), "image_base64 is missing"),
            (body(image_base64="not base64!"), "not valid base64"),
            (body(image_base64="data:image/jpeg;base64,"), "image_base64 is empty"),
        ]
        for payload, fragment in cases:
            with self.subTest(payload=str(payload)[:70]):
                with self.assertRaises(gd.RequestError) as caught:
                    gd.parse_request(payload)
                self.assertEqual(caught.exception.status, 400)
                self.assertIn(fragment, caught.exception.message)


class BoxesTest(unittest.TestCase):
    def test_corners_become_x_y_width_height_clamped_to_the_frame(self):
        self.assertEqual(gd.to_xywh([-10, 20, 110.04, 60], 100, 50), [0.0, 20.0, 100.0, 30.0])

    def test_a_box_with_no_area_or_a_corner_that_is_not_finite_is_dropped(self):
        for box in ([10, 10, 10, 40], [120, 0, 150, 10], [0, 0, float("nan"), 5], [0, 0, float("inf"), 5]):
            with self.subTest(box=box):
                self.assertIsNone(gd.to_xywh(box, 100, 50))

    def test_detections_are_named_best_first_and_capped(self):
        found = gd.shape_detections(
            scores=[0.4, 0.9, 0.7, 0.8, float("nan")],
            boxes=[[0, 0, 10, 10], [10, 10, 30, 30], [5, 5, 6, 6], [1, 1, 1, 9], [0, 0, 5, 5]],
            labels=["cup", "laptop", "cup", "mug", "pen"],
            width=100,
            height=100,
            max_detections=2,
        )
        self.assertEqual(
            found,
            [
                {"label": "laptop", "confidence": 0.9, "bbox": [10.0, 10.0, 20.0, 20.0]},
                {"label": "cup", "confidence": 0.7, "bbox": [5.0, 5.0, 1.0, 1.0]},
            ],
        )

    def test_a_box_the_model_could_not_name_is_dropped(self):
        self.assertEqual(gd.shape_detections([0.9], [[0, 0, 5, 5]], [""], 10, 10, 5), [])


class AuthorizedTest(unittest.TestCase):
    def test_with_no_token_configured_every_request_is_let_in(self):
        self.assertTrue(gd.authorized(None, None))

    def test_the_token_must_come_as_a_bearer_token(self):
        self.assertTrue(gd.authorized("Bearer s3cret", "s3cret"))
        self.assertTrue(gd.authorized("bearer s3cret", "s3cret"))
        for header in (None, "", "s3cret", "Bearer wrong", "Basic s3cret"):
            with self.subTest(header=header):
                self.assertFalse(gd.authorized(header, "s3cret"))


class ConfigurationTest(unittest.TestCase):
    def test_a_certificate_without_its_key_stops_the_start(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(gd.main(["--cert-file", "box.crt"]), 2)

    def test_a_port_that_is_not_a_number_stops_the_start_with_its_name(self):
        with mock.patch.dict(os.environ, {"GDINO_PORT": "eighty"}):
            with self.assertRaises(SystemExit) as caught:
                gd._env_int("GDINO_PORT", gd.DEFAULT_PORT)
        self.assertIn("GDINO_PORT", str(caught.exception))


class FakeDetector:
    device_label = "fake (test, fp32)"

    def __init__(self):
        self.calls = []

    def detect(self, image, labels, threshold, text_threshold):
        self.calls.append((image, labels, threshold, text_threshold))
        if image == b"not an image":
            raise gd.RequestError(400, "image_base64 is not an image this service can read")
        return 640, 480, [0.45, 0.8], [[0, 0, 5, 5], [10, 20, 110, 220]], [labels[0], labels[-1]]


def wait_for(condition, seconds=5.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False


class ServiceTest(unittest.TestCase):
    def serve(self, holder, token=None, max_body=1 << 20):
        server = gd.DetectServer(("127.0.0.1", 0), holder, token, max_body)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def ready(self, detector=None):
        holder = gd.ModelHolder("fake/model", lambda: detector or FakeDetector())
        holder.load_until_ready()
        return holder

    def call(self, port, method, path, payload=None, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        self.addCleanup(connection.close)
        data = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
        connection.request(method, path, body=data, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        return response.status, json.loads(response.read() or b"null")

    def test_a_detection_round_trip_has_the_zeroshot_reply_shape(self):
        detector = FakeDetector()
        port = self.serve(self.ready(detector))
        status, reply = self.call(port, "POST", "/detect", body(prompt="a cup, a laptop", threshold=0.3, text_threshold=0.2))
        self.assertEqual(status, 200)
        self.assertEqual((reply["frame_width"], reply["frame_height"]), (640, 480))
        self.assertEqual(
            reply["detections"],
            [
                {"label": "a laptop", "confidence": 0.8, "bbox": [10.0, 20.0, 100.0, 200.0]},
                {"label": "a cup", "confidence": 0.45, "bbox": [0.0, 0.0, 5.0, 5.0]},
            ],
        )
        self.assertEqual(reply["model"], "fake/model")
        self.assertEqual(reply["device"], "fake (test, fp32)")
        self.assertIsInstance(reply["inference_ms"], int)
        self.assertEqual(detector.calls, [(IMAGE_BYTES, ["a cup", "a laptop"], 0.3, 0.2)])

    def test_health_says_loading_and_detect_answers_503_until_the_model_is_ready(self):
        holder = gd.ModelHolder("fake/model", FakeDetector)
        port = self.serve(holder)
        status, health = self.call(port, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual((health["ready"], health["state"], health["device"]), (False, "loading", None))
        status, reply = self.call(port, "POST", "/detect", body())
        self.assertEqual(status, 503)
        self.assertIn("still loading", reply["error"])
        holder.load_until_ready()
        _, health = self.call(port, "GET", "/health")
        self.assertEqual((health["ready"], health["state"], health["device"]), (True, "ready", "fake (test, fp32)"))

    def test_a_failed_load_is_reported_then_retried(self):
        attempts = []
        release = threading.Event()

        def load():
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("no GPU yet")
            release.wait(5)
            return FakeDetector()

        holder = gd.ModelHolder("fake/model", load, retry_seconds=0.01)
        holder.start()
        self.assertTrue(wait_for(lambda: holder.snapshot()["state"] == "retrying"))
        self.assertIn("no GPU yet", holder.snapshot()["error"])
        port = self.serve(holder)
        status, reply = self.call(port, "POST", "/detect", body())
        self.assertEqual(status, 503)
        self.assertIn("no GPU yet", reply["error"])
        release.set()
        self.assertTrue(wait_for(lambda: holder.snapshot()["ready"]))
        self.assertEqual((len(attempts), holder.snapshot()["error"]), (2, None))

    def test_a_configured_token_is_required(self):
        port = self.serve(self.ready(), token="s3cret")
        self.assertEqual(self.call(port, "POST", "/detect", body())[0], 401)
        self.assertEqual(self.call(port, "POST", "/detect", body(), {"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.call(port, "POST", "/detect", body(), {"Authorization": "Bearer s3cret"})[0], 200)

    def test_a_body_over_the_limit_is_refused_unread(self):
        port = self.serve(self.ready(), max_body=100)
        status, reply = self.call(port, "POST", "/detect", body(prompt="cup " * 400))
        self.assertEqual(status, 413)
        self.assertIn("larger than 100 bytes", reply["error"])

    def test_bad_json_unknown_paths_and_a_detector_refusal(self):
        port = self.serve(self.ready())
        status, reply = self.call(port, "POST", "/detect", raw=b"{not json")
        self.assertEqual((status, reply["error"]), (400, "the body is not JSON"))
        self.assertEqual(self.call(port, "GET", "/nope")[0], 404)
        self.assertEqual(self.call(port, "POST", "/nope", body())[0], 404)
        not_an_image = base64.b64encode(b"not an image").decode()
        status, reply = self.call(port, "POST", "/detect", body(image_base64=not_an_image))
        self.assertEqual(status, 400)
        self.assertIn("not an image", reply["error"])


if __name__ == "__main__":
    unittest.main()
