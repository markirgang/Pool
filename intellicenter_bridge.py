#!/usr/bin/env python3
"""Local-network bridge between the Pool web app and a Pentair IntelliCenter.

The bridge runs pyintellicenter on a dedicated asyncio event loop and exposes a
small, thread-safe API to the HTTP server. When no panel can be reached the
bridge reports ``simulation`` mode so the UI, schedule and 3D visualization
remain fully usable.

The IntelliCenter is discovered with mDNS when no host is configured, or the
configured IP/hostname is used directly. Circuit friendly names are resolved
against the live panel model using the mappings in config.json.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from typing import Any

LOG = logging.getLogger("pool.intellicenter")

try:  # pyintellicenter is optional so the UI still runs on a plain desktop.
    from pyintellicenter import (
        BODY_TYPE,
        CIRCUIT_TYPE,
        HEATER_TYPE,
        PMPCIRC_TYPE,
        PUMP_TYPE,
        VALVE_TYPE,
        ICConnectionHandler,
        ICModelController,
        PoolModel,
        discover_intellicenter_units,
    )

    PYIC_AVAILABLE = True
except Exception as exc:  # pragma: no cover - depends on the host
    PYIC_AVAILABLE = False
    PYIC_IMPORT_ERROR = str(exc)
else:
    PYIC_IMPORT_ERROR = None


SAFE_ATTRS = {
    "STATUS", "SNAME", "SUBTYP", "OBJTYP", "PARENT", "CIRCUIT", "SPEED",
    "SELECT", "RPM", "GPM", "PWR", "TEMP", "LSTTMP", "LOTMP", "HITMP",
    "MODE", "HTMODE", "HEATING", "COOLING", "READY", "ACT", "USE", "MIN",
    "MAX", "MINF", "MAXF", "BODY", "LISTORD", "FEATR", "AVAIL", "ENABLE",
    "NORMAL", "TIME", "DAY", "VACFLO", "VACTIM", "SINDEX", "HNAME", "VER",
    "PROPNAME", "FREEZE", "SUPER", "BOOST",
}

_REDACT = {"PASSWRD", "PASSWORD", "EMAIL", "EMAIL2", "PHONE", "PHONE2", "NAME"}
_RE_WS = re.compile(r"[^A-Z0-9]+")


def _norm(value: Any) -> str:
    return _RE_WS.sub("", str(value or "").upper())


def _tokens(value: Any) -> set[str]:
    return set(re.findall(r"[A-Z0-9]+", str(value or "").upper()))


def _spec_name(spec: Any) -> str | None:
    if isinstance(spec, str):
        return spec
    if isinstance(spec, dict):
        return spec.get("name")
    return None


def _spec_objnam(spec: Any) -> str | None:
    if isinstance(spec, dict):
        return spec.get("objnam")
    return None


class IntelliCenterBridge:
    """Thread-safe IntelliCenter connection and inventory cache."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._controller: Any = None
        self._handler: Any = None
        self._stop = False
        self._restart = threading.Event()
        self._connected = False
        self._host = ""
        self._port = int(config.get("port", 6681))
        self._transport = config.get("transport", "tcp")
        self._last_error = None if PYIC_AVAILABLE else PYIC_IMPORT_ERROR
        self._last_connect = 0.0
        self._inventory: dict[str, Any] = self._empty_inventory()
        self._resolved: dict[str, Any] = {}
        self._started = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            self._stop = False
        self._thread = threading.Thread(target=self._thread_main, name="intellicenter", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._stop = True
        self._restart.set()
        loop = self._loop
        if loop:
            try:
                loop.call_soon_threadsafe(lambda: None)
            except Exception:
                pass

    def reconfigure(self, host: str | None = None, port: int | None = None,
                    transport: str | None = None) -> None:
        with self._lock:
            self.config["host"] = (host or "").strip()
            if port:
                self._port = int(port)
                self.config["port"] = self._port
            if transport in ("tcp", "websocket"):
                self._transport = transport
                self.config["transport"] = transport
            self._host = self.config["host"]
        self._restart.set()

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def mode(self) -> str:
        return "panel" if self._connected else "simulation"

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "connected": self._connected,
                "mode": self.mode,
                "host": self._host,
                "port": self._port,
                "transport": self._transport,
                "pyintellicenter": PYIC_AVAILABLE,
                "last_error": self._last_error,
                "last_connect": self._last_connect,
                "resolved_count": sum(
                    1 for value in self._flat_resolved(self._resolved) if value
                ),
            }

    def inventory(self) -> dict[str, Any]:
        with self._lock:
            return {
                **self._inventory,
                "connected": self._connected,
                "mode": self.mode,
                "host": self._host,
                "port": self._port,
                "last_error": self._last_error,
            }

    def resolved(self) -> dict[str, Any]:
        with self._lock:
            return _deep_copy(self._resolved)

    def write(self, changes: dict[str, dict[str, Any]], reason: str = "") -> tuple[bool, str]:
        """Write object params to the panel. Returns ``(ok, message)``."""
        if not changes:
            return True, "nothing to do"
        if not self._connected or self._controller is None or self._loop is None:
            return False, "IntelliCenter is offline; command applied in simulation only"
        ops = [{"objnam": objnam, "params": params} for objnam, params in changes.items()]
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._write_async(ops, reason), self._loop
            )
            result = future.result(timeout=12)
            LOG.info("IntelliCenter write (%s): %s", reason, ops)
            return True, result
        except Exception as exc:
            LOG.warning("IntelliCenter write failed (%s): %s", reason, exc)
            with self._lock:
                self._last_error = str(exc)
            return False, str(exc)

    # ------------------------------------------------------------------
    # Async connection lifecycle
    # ------------------------------------------------------------------
    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(self._async_main())
            loop.run_forever()
        except Exception:
            LOG.exception("IntelliCenter thread stopped")
        finally:
            try:
                loop.close()
            except Exception:
                pass

    async def _async_main(self) -> None:
        if not PYIC_AVAILABLE:
            self._set_error(PYIC_IMPORT_ERROR or "pyintellicenter is not installed")
            return

        cfg = self.config
        self._host = str(cfg.get("host") or "").strip()
        self._port = int(cfg.get("port") or 6681)
        self._transport = cfg.get("transport") or "tcp"

        while not self._stop:
            if self._restart.is_set():
                await self._teardown_handler()
                self._restart.clear()
                cfg = self.config
                self._host = str(cfg.get("host") or "").strip()
                self._port = int(cfg.get("port") or 6681)
                self._transport = cfg.get("transport") or "tcp"

            if not self._host and cfg.get("discovery", True):
                found = await self._discover()
                if found:
                    self._host, self._port = found
                    LOG.info("Discovered IntelliCenter at %s:%s", self._host, self._port)
                else:
                    self._set_error("No IntelliCenter found via mDNS discovery")
                    await asyncio.sleep(20)
                    continue

            if not self._host:
                self._set_error("No IntelliCenter host configured")
                await asyncio.sleep(10)
                continue

            await self._run_handler()

    async def _discover(self) -> tuple[str, int] | None:
        try:
            units = await discover_intellicenter_units(
                discovery_timeout=float(self.config.get("discovery_timeout", 6))
            )
        except Exception as exc:
            LOG.warning("IntelliCenter discovery failed: %s", exc)
            return None
        if not units:
            return None
        unit = units[0]
        return unit.host, int(unit.port or 6681)

    async def _run_handler(self) -> None:
        model = PoolModel()
        controller = ICModelController(
            self._host,
            self._port,
            transport=self._transport,
        )
        handler = ICConnectionHandler(controller)
        self._controller = controller
        self._handler = handler

        def on_started(ctrl):
            with self._lock:
                self._connected = True
                self._last_error = None
                self._last_connect = time.time()
            LOG.info("Connected to IntelliCenter at %s", self._host)
            self._publish_from_controller(ctrl)

        def on_reconnected(ctrl):
            on_started(ctrl)

        def on_disconnected(ctrl, exc):
            with self._lock:
                self._connected = False
                self._last_error = str(exc) if exc else "disconnected"
            LOG.warning("IntelliCenter disconnected: %s", exc)
            self._publish_inventory()

        def on_retrying(delay):
            with self._lock:
                self._last_error = "reconnecting in %ss" % delay

        def on_updated(ctrl, updates):
            self._publish_from_controller(ctrl)

        handler.on_started = on_started
        handler.on_reconnected = on_reconnected
        handler.on_disconnected = on_disconnected
        handler.on_retrying = on_retrying
        handler.on_updated = on_updated

        try:
            await handler.start()
        except Exception as exc:
            # The handler keeps retrying in the background after the first
            # failure; stay alive so those reconnects can succeed.
            with self._lock:
                self._connected = False
                self._last_error = str(exc)
            LOG.warning("IntelliCenter first connection failed: %s", exc)
            self._publish_inventory()

        while not self._stop and not self._restart.is_set():
            await asyncio.sleep(1)

        await self._teardown_handler()

    async def _teardown_handler(self) -> None:
        handler = self._handler
        self._handler = None
        self._controller = None
        if handler is not None:
            try:
                await handler.astop()
            except Exception:
                LOG.debug("Error stopping IntelliCenter handler", exc_info=True)
        with self._lock:
            self._connected = False
        self._publish_inventory()

    async def _write_async(self, ops: list[dict[str, Any]], reason: str) -> str:
        controller = self._controller
        if controller is None or not controller.connected:
            raise RuntimeError("IntelliCenter is not connected")
        await controller.send_cmd("SETPARAMLIST", {"objectList": ops})
        return "sent %d object change(s)" % len(ops)

    # ------------------------------------------------------------------
    # Inventory / name resolution
    # ------------------------------------------------------------------
    def _publish_from_controller(self, controller: Any) -> None:
        try:
            inventory = self._build_inventory(controller)
            resolved = self._resolve_mappings(inventory)
        except Exception:
            LOG.exception("Unable to read IntelliCenter model")
            return
        with self._lock:
            self._inventory = inventory
            self._resolved = resolved

    def _publish_inventory(self) -> None:
        with self._lock:
            self._inventory = {
                **self._inventory,
                "connected": self._connected,
                "mode": self.mode,
                "host": self._host,
                "last_error": self._last_error,
            }

    def _build_inventory(self, controller: Any) -> dict[str, Any]:
        model = controller.model if hasattr(controller, "model") else controller._model
        objects = []
        for obj in model:
            attrs = {}
            for key in obj.attribute_keys:
                if key in _REDACT:
                    continue
                if key not in SAFE_ATTRS:
                    continue
                value = obj[key]
                if isinstance(value, (str, int, float, bool)) or value is None:
                    attrs[key] = value
            objects.append({
                "objnam": obj.objnam,
                "objtype": obj.objtype,
                "subtype": obj.subtype,
                "name": obj.sname or obj.objnam,
                "status": obj.status,
                "attrs": attrs,
            })

        def pick(objtype):
            return sorted(
                (o for o in objects if o["objtype"] == objtype),
                key=lambda o: ((o["name"] or "").lower(), o["objnam"]),
            )

        circuits = pick(CIRCUIT_TYPE)
        pumps = pick(PUMP_TYPE)
        pump_circuits = pick(PMPCIRC_TYPE)
        bodies = pick(BODY_TYPE)
        heaters = pick(HEATER_TYPE)
        valves = pick(VALVE_TYPE)
        system = None
        if getattr(controller, "system_info", None):
            info = controller.system_info
            system = {
                "name": getattr(info, "prop_name", None),
                "version": getattr(info, "sw_version", None),
                "metric": getattr(info, "uses_metric", None),
            }

        return {
            "system": system,
            "objects": objects,
            "circuits": circuits,
            "pumps": pumps,
            "pump_circuits": pump_circuits,
            "bodies": bodies,
            "heaters": heaters,
            "valves": valves,
            "updated": time.time(),
        }

    def _resolve_mappings(self, inventory: dict[str, Any]) -> dict[str, Any]:
        devices = self.config.get("devices", {})

        def find(spec, objtype=None, pool=None):
            objects = pool if pool is not None else inventory["objects"]
            if objtype:
                objects = [o for o in objects if o["objtype"] == objtype]
            objnam = _spec_objnam(spec)
            if objnam:
                for obj in objects:
                    if obj["objnam"] == objnam:
                        return obj["objnam"]
                return None
            name = _spec_name(spec)
            if not name:
                return None
            wanted = _norm(name)
            if not wanted:
                return None
            exact = [o for o in objects if _norm(o["name"]) == wanted]
            if exact:
                return exact[0]["objnam"]
            wt = _tokens(name)
            scored = []
            for obj in objects:
                nt = _tokens(obj["name"])
                if not nt:
                    continue
                if wt and wt.issubset(nt):
                    extra = len(nt - wt)
                    scored.append((extra, len(obj["name"] or ""), obj["objnam"]))
            if scored:
                scored.sort()
                return scored[0][2]
            return None

        circuits = inventory["circuits"]
        pumps = inventory["pumps"]
        pump_circuits = inventory["pump_circuits"]
        bodies = inventory["bodies"]

        def find_pump_circuit(spec, pump_objnam=None):
            objnam = _spec_objnam(spec)
            if objnam:
                for obj in pump_circuits:
                    if obj["objnam"] == objnam:
                        return obj["objnam"]
            name = _spec_name(spec)
            if name:
                found = find(name, PMPCIRC_TYPE, pump_circuits)
                if found:
                    return found
            if pump_objnam:
                for obj in pump_circuits:
                    if obj["attrs"].get("PARENT") == pump_objnam:
                        return obj["objnam"]
            return None

        resolved: dict[str, Any] = {
            "bodies": {},
            "modes": {},
            "pumps": {},
            "pump_programs": {},
            "deck_jets": {},
            "firebaskets": {},
            "lights": {},
            "heater": {},
        }

        for key, spec in (devices.get("bodies") or {}).items():
            resolved["bodies"][key] = find(spec, BODY_TYPE, bodies)
        for key, spec in (devices.get("modes") or {}).items():
            resolved["modes"][key] = find(spec, CIRCUIT_TYPE, circuits)
        for key, spec in (devices.get("pumps") or {}).items():
            resolved["pumps"][key] = find(spec, PUMP_TYPE, pumps)
        for key, spec in (devices.get("pump_programs") or {}).items():
            resolved["pump_programs"][key] = find_pump_circuit(
                spec, resolved["pumps"].get(key)
            )
        for jet, spec in (devices.get("deck_jets") or {}).items():
            resolved["deck_jets"][jet] = {
                field: find(value, CIRCUIT_TYPE, circuits)
                for field, value in (spec or {}).items()
            }
        for basket, spec in (devices.get("firebaskets") or {}).items():
            resolved["firebaskets"][basket] = {
                field: find(value, CIRCUIT_TYPE, circuits)
                for field, value in (spec or {}).items()
            }
        for body, spec in (devices.get("lights") or {}).items():
            resolved["lights"][body] = find(spec, CIRCUIT_TYPE, circuits)
        heater = devices.get("heater") or {}
        resolved["heater"]["body"] = find(
            heater.get("body"), BODY_TYPE, bodies
        )
        resolved["heater"]["device"] = find(
            heater.get("device"), HEATER_TYPE, inventory["heaters"]
        )
        return resolved

    @staticmethod
    def _flat_resolved(resolved: dict[str, Any]):
        for value in (resolved or {}).values():
            if isinstance(value, dict):
                for inner in value.values():
                    if isinstance(inner, dict):
                        yield from inner.values()
                    else:
                        yield inner
            else:
                yield value

    def _empty_inventory(self) -> dict[str, Any]:
        return {
            "system": None,
            "objects": [],
            "circuits": [],
            "pumps": [],
            "pump_circuits": [],
            "bodies": [],
            "heaters": [],
            "valves": [],
            "updated": 0,
        }

    def _set_error(self, message: str | None) -> None:
        with self._lock:
            self._last_error = message


def _deep_copy(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _deep_copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy(v) for v in value]
    return value
