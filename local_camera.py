#!/usr/bin/env python3
"""Local webcam capture for Iggy's eyes."""

from __future__ import annotations

import glob
import logging
import os
import subprocess
import time
from typing import Any

LOG = logging.getLogger("pool.camera")

_SKIP_NAMES = ("rpi-hevc-dec", "pispbe", "bcm2835", "unicam")


class LocalCamera:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self._last_error = ""
        self._last_capture = 0.0
        self._active_device = ""

    def _cfg(self) -> dict[str, Any]:
        return (self.config.get("camera") or {}).get("local") or {}

    def reconfigure(self) -> None:
        self._last_error = ""

    def _name_for(self, device: str) -> str:
        name_file = "/sys/class/video4linux/%s/name" % os.path.basename(device)
        try:
            with open(name_file, "r", encoding="utf-8") as fh:
                return fh.read().strip()
        except OSError:
            return os.path.basename(device)

    def _is_capture_candidate(self, device: str) -> bool:
        name = self._name_for(device).lower()
        if any(skip in name for skip in _SKIP_NAMES):
            return False
        index_file = "/sys/class/video4linux/%s/index" % os.path.basename(device)
        try:
            with open(index_file, "r", encoding="utf-8") as fh:
                if fh.read().strip() not in ("", "0"):
                    return False
        except OSError:
            pass
        return True

    def devices(self) -> list[dict[str, str]]:
        found = []
        for device in sorted(glob.glob("/dev/video*")):
            if not self._is_capture_candidate(device):
                continue
            found.append({"id": device, "name": "%s (%s)" % (self._name_for(device), device)})
        return found

    def status(self) -> dict[str, Any]:
        return {
            "available": bool(self.devices()),
            "device": self._active_device or self._cfg().get("device", "auto"),
            "last_capture": self._last_capture,
            "last_error": self._last_error,
            "vision_on_voice": self._cfg().get("vision_on_voice", True),
        }

    def _try_capture(self, device: str) -> bytes | None:
        width = int(self._cfg().get("width", 1280) or 1280)
        height = max(240, int(round(width * 9 / 16.0)))
        base = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "v4l2", "-i", device, "-frames:v", "1",
            "-vf", "scale=%d:-2" % width,
            "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
        ]
        sized = base[:5] + ["-video_size", "%dx%d" % (width, height)] + base[5:]
        last_detail = "no frame"
        for cmd in (sized, base):
            try:
                result = subprocess.run(cmd, capture_output=True, timeout=12.0)
            except Exception as exc:
                self._last_error = "Camera %s failed: %s" % (device, exc)
                return None
            if result.returncode == 0 and result.stdout:
                self._active_device = device
                self._last_capture = time.time()
                self._last_error = ""
                return result.stdout
            detail = (result.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            last_detail = detail[-1] if detail else "no frame"
        self._last_error = "Camera %s unavailable: %s" % (device, last_detail)
        return None

    def capture(self) -> bytes | None:
        configured = str(self._cfg().get("device") or "auto")
        if configured and configured != "auto":
            return self._try_capture(configured)
        for item in self.devices():
            image = self._try_capture(item["id"])
            if image:
                return image
        if not self.devices():
            self._last_error = "No local camera found"
        return None
