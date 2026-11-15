#!/usr/bin/env python3
"""Unit tests for opening IntelliCenter Host page in a browser."""

import json
import unittest
from unittest.mock import MagicMock, patch

from intellicenter_bridge import IntelliCenterBridge
from pool_controller import PoolController
from gemini_bridge import GeminiPoolBridge


class TestIntelliCenterHost(unittest.TestCase):
    def setUp(self):
        self.config = {
            "intellicenter": {
                "host": "",
                "port": 6681,
                "transport": "tcp",
                "discovery": True,
            },
            "devices": {},
            "defaults": {},
            "schedule": {"runs": []},
            "custom_devices": [],
        }

    def test_bridge_web_url_empty(self):
        bridge = IntelliCenterBridge(self.config)
        self.assertEqual(bridge.web_url, "")
        status = bridge.status()
        self.assertIn("web_url", status)
        self.assertEqual(status["web_url"], "")

    def test_bridge_web_url_from_config(self):
        self.config["intellicenter"]["host"] = "192.168.1.50"
        bridge = IntelliCenterBridge(self.config)
        self.assertEqual(bridge.web_url, "http://192.168.1.50")
        status = bridge.status()
        self.assertEqual(status["web_url"], "http://192.168.1.50")

    def test_bridge_web_url_with_scheme(self):
        self.config["intellicenter"]["host"] = "https://my-panel.local:8443"
        bridge = IntelliCenterBridge(self.config)
        self.assertEqual(bridge.web_url, "https://my-panel.local:8443")

    def test_bridge_web_url_reconfigure(self):
        bridge = IntelliCenterBridge(self.config)
        self.assertEqual(bridge.web_url, "")
        bridge.reconfigure(host="10.0.0.120")
        self.assertEqual(bridge.web_url, "http://10.0.0.120")

    def test_controller_open_host_page_no_host(self):
        bridge = IntelliCenterBridge(self.config)
        controller = PoolController(self.config, bridge)
        res = controller.open_host_page(launch_browser=False)
        self.assertFalse(res["ok"])
        self.assertIn("not configured", res["message"])

    def test_controller_open_host_page_with_host(self):
        self.config["intellicenter"]["host"] = "192.168.1.75"
        bridge = IntelliCenterBridge(self.config)
        controller = PoolController(self.config, bridge)
        res = controller.open_host_page(launch_browser=False)
        self.assertTrue(res["ok"])
        self.assertEqual(res["url"], "http://192.168.1.75")
        self.assertFalse(res["launched"])

    @patch("webbrowser.open")
    def test_controller_open_host_page_launch_browser(self, mock_browser_open):
        mock_browser_open.return_value = True
        self.config["intellicenter"]["host"] = "192.168.1.75"
        bridge = IntelliCenterBridge(self.config)
        controller = PoolController(self.config, bridge)
        res = controller.open_host_page(launch_browser=True)
        self.assertTrue(res["ok"])
        self.assertEqual(res["url"], "http://192.168.1.75")
        self.assertTrue(res["launched"])
        mock_browser_open.assert_called_once_with("http://192.168.1.75")

    def test_controller_command_open_host_page(self):
        self.config["intellicenter"]["host"] = "192.168.1.99"
        bridge = IntelliCenterBridge(self.config)
        controller = PoolController(self.config, bridge)
        res = controller.command("open_host_page", {})
        self.assertTrue(res["ok"])
        self.assertEqual(res["url"], "http://192.168.1.99")

    def test_gemini_tool_action(self):
        gemini = GeminiPoolBridge()
        action = gemini._action_for("pool_open_host_page", {"launch": True})
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "open_host_page")
        self.assertEqual(action["payload"], {"launch": True})

    def test_controller_scan_and_adjust(self):
        bridge = IntelliCenterBridge(self.config)
        controller = PoolController(self.config, bridge)
        res = controller.scan_and_adjust(reason="test_scan", force=True)
        self.assertTrue(res["ok"])
        self.assertTrue(res["scanned"])
        self.assertIn("counts", res)
        self.assertGreaterEqual(res["counts"]["valves"], 1)
        self.assertGreaterEqual(res["counts"]["pumps"], 1)
        self.assertGreaterEqual(res["counts"]["circuits"], 1)
        self.assertGreaterEqual(len(res["adjustments"]), 1)
        status = controller.scan_status()
        self.assertTrue(status["scanned"])
        self.assertEqual(status["counts"]["valves"], res["counts"]["valves"])


class TestServerEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import http.server
        import socket
        import threading
        import urllib.request
        from server import PoolHandler, CONFIG, BRIDGE, CONTROLLER

        cls.original_host = CONFIG.get("intellicenter", {}).get("host", "")
        CONFIG.setdefault("intellicenter", {})["host"] = "192.168.1.88"
        BRIDGE.reconfigure(host="192.168.1.88")

        # Start a local server on an ephemeral port
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PoolHandler)
        cls.port = cls.httpd.server_address[1]
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        from server import CONFIG, BRIDGE
        CONFIG.setdefault("intellicenter", {})["host"] = cls.original_host
        BRIDGE.reconfigure(host=cls.original_host)
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_get_intellicenter_open_json(self):
        import urllib.request
        url = f"http://127.0.0.1:{self.port}/api/intellicenter/open"
        with urllib.request.urlopen(url) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("ok"))
            self.assertEqual(data.get("url"), "http://192.168.1.88")

    def test_post_intellicenter_open_json(self):
        import urllib.request
        url = f"http://127.0.0.1:{self.port}/api/intellicenter/open"
        req = urllib.request.Request(
            url,
            data=json.dumps({"launch": False}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("ok"))
            self.assertEqual(data.get("url"), "http://192.168.1.88")

    def test_redirect_intellicenter_host(self):
        import urllib.request

        class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
            def http_error_302(self, req, fp, code, msg, headers):
                return fp
            def http_error_307(self, req, fp, code, msg, headers):
                return fp

        opener = urllib.request.build_opener(NoRedirectHandler)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/intellicenter/host")
        try:
            resp = opener.open(req)
            self.assertEqual(resp.status, 307)
            self.assertEqual(resp.headers.get("Location"), "http://192.168.1.88")
        except urllib.error.HTTPError as err:
            self.assertEqual(err.code, 307)
            self.assertEqual(err.headers.get("Location"), "http://192.168.1.88")

    def test_get_intellicenter_scan_endpoint(self):
        import urllib.request
        url = f"http://127.0.0.1:{self.port}/api/intellicenter/scan"
        with urllib.request.urlopen(url) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("ok"))
            self.assertIn("counts", data)

    def test_post_intellicenter_scan_endpoint(self):
        import urllib.request
        url = f"http://127.0.0.1:{self.port}/api/intellicenter/scan"
        req = urllib.request.Request(
            url,
            data=json.dumps({"force": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("ok"))
            self.assertTrue(data.get("scanned"))
            self.assertIn("adjustments", data)


if __name__ == "__main__":
    unittest.main()
