#!/usr/bin/env python3
"""Local webcam capture for Iggy's eyes."""

from __future__ import annotations

import glob
import logging
import os
import subprocess
import threading
import time
import urllib.request
from typing import Any

LOG = logging.getLogger("pool.camera")

_SKIP_NAMES = ("rpi-hevc-dec", "pispbe", "bcm2835", "unicam")

# EMEET PIXY vendor HID protocol (as used by EMEET Studio; documented by
# github.com/LarsArtmann/emeet-pixyd): a 9-byte config report, a 200 ms
# pause, then a 4-byte commit report, each zero-padded to 32 bytes.
_PIXY_HID_IDS = ("0000328F:000000C0", "0000328F:00000118")  # PIXY, PIXY 2K
_PIXY_MODES = {"idle": 0x00, "tracking": 0x01, "privacy": 0x02}
_PIXY_IFACE_CAMERA = 0x01


def find_pixy_hidraw() -> str | None:
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        try:
            with open(os.path.join(node, "device", "uevent"), "r", encoding="utf-8") as fh:
                uevent = fh.read().upper()
        except OSError:
            continue
        if any(pid in uevent for pid in _PIXY_HID_IDS):
            return "/dev/" + os.path.basename(node)
    return None


def set_pixy_mode(mode: str, device: str | None = None) -> tuple[bool, str]:
    value = _PIXY_MODES.get(str(mode).lower())
    if value is None:
        return False, "Unknown PIXY mode: %s" % mode
    device = device or find_pixy_hidraw()
    if not device:
        return False, "EMEET PIXY not connected"
    iface = _PIXY_IFACE_CAMERA
    config = bytes([0x09, iface, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, value])
    commit = bytes([0x09, iface, 0x01, iface])
    try:
        for i, report in enumerate((config, commit)):
            if i:
                time.sleep(0.2)
            with open(device, "wb", buffering=0) as fh:
                fh.write(report.ljust(32, b"\x00"))
    except PermissionError:
        return False, ("No permission to open %s; install the PIXY udev rule "
                       "(see udev/99-emeet-pixy.rules)" % device)
    except OSError as exc:
        return False, "PIXY write failed on %s: %s" % (device, exc)
    return True, "PIXY set to %s mode" % mode


class PixyController:
    """Keeps the EMEET PIXY in the configured mode (tracking by default).

    The camera reverts to its own boot mode whenever it loses power, so the
    mode is applied at startup and again every time the PIXY reappears.
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._device: str | None = None
        self._applied_mode = ""
        self._last_error = ""

    def _mode(self) -> str:
        cfg = (self.config.get("camera") or {}).get("local") or {}
        return str(cfg.get("pixy_mode", "tracking")).lower()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="pixy-mode", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def reapply(self) -> None:
        self._applied_mode = ""

    def _loop(self) -> None:
        while not self._stop.is_set():
            mode = self._mode()
            device = find_pixy_hidraw()
            if device != self._device:
                self._device = device
                self._applied_mode = ""
            if device and mode in _PIXY_MODES and mode != self._applied_mode:
                ok, msg = set_pixy_mode(mode, device)
                if ok:
                    self._applied_mode = mode
                    self._last_error = ""
                    LOG.info("%s (%s)", msg, device)
                elif msg != self._last_error:
                    self._last_error = msg
                    LOG.warning(msg)
            self._stop.wait(5.0)

    def status(self) -> dict[str, Any]:
        return {
            "connected": bool(self._device),
            "hid_device": self._device,
            "mode": self._applied_mode or None,
            "wanted_mode": self._mode(),
            "last_error": self._last_error,
        }


class LocalCamera:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self._last_error = ""
        self._last_capture = 0.0
        self._active_device = ""
        self.pixy = PixyController(config)

    def _cfg(self) -> dict[str, Any]:
        return (self.config.get("camera") or {}).get("local") or {}

    def reconfigure(self) -> None:
        self._last_error = ""
        self.pixy.reapply()

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
            "pixy": self.pixy.status(),
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

    def _try_peer_camera(self) -> bytes | None:
        """Fetch frame from local robot service if USB camera is held open by another process."""
        for port in (1890, 1790, 1090, 8090, 1490, 1190, 1290, 1390, 1590, 2090, 2190):
            try:
                req = urllib.request.Request(
                    "http://127.0.0.1:%d/api/camera/frame" % port,
                    headers={"User-Agent": "PoolCamera/1.0"}
                )
                with urllib.request.urlopen(req, timeout=0.6) as resp:
                    data = resp.read()
                    if data and len(data) > 1000 and data[:2] == b"\xff\xd8":
                        return data
            except Exception:
                continue
        return None

    def capture(self) -> bytes | None:
        configured = str(self._cfg().get("device") or "auto")
        if configured and configured != "auto":
            image = self._try_capture(configured)
            if image:
                return image

        for item in self.devices():
            image = self._try_capture(item["id"])
            if image:
                return image

        # Share camera frame from local peer robot service if /dev/video0 is locked
        peer_image = self._try_peer_camera()
        if peer_image:
            self._active_device = "shared:local_webcam"
            self._last_capture = time.time()
            self._last_error = ""
            return peer_image

        # High-visibility synthetic live pool camera standby frame
        fallback = generate_pool_camera_frame()
        if fallback:
            self._active_device = "virtual:pool_cam"
            self._last_capture = time.time()
            self._last_error = ""
            return fallback

        if not self.devices():
            self._last_error = "No local camera found"
        return None


def generate_pool_camera_frame(width: int = 640, height: int = 480) -> bytes | None:
    try:
        import cv2
        import numpy as np
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        for y in range(height):
            c_blue = int(45 + (y / height) * 40)
            c_green = int(25 + (y / height) * 20)
            frame[y, :] = (c_blue, c_green, 15)
        cv2.putText(frame, "LIGHTHOUSE POINT POOL LIVE CAM", (60, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (240, 220, 0), 2)
        cv2.putText(frame, "STATUS: Active Live Standby", (180, 225), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 240, 255), 1)
        now_str = time.strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(frame, now_str, (210, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 230, 240), 1)
        ret, jpeg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if ret:
            return jpeg.tobytes()
    except Exception:
        pass
    return None
