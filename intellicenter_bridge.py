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
        CHEM_TYPE,
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
    BODY_TYPE = "BODY"
    CHEM_TYPE = "CHEM"
    CIRCUIT_TYPE = "CIRCUIT"
    HEATER_TYPE = "HEATER"
    PMPCIRC_TYPE = "PMPCIRC"
    PUMP_TYPE = "PUMP"
    VALVE_TYPE = "VALVE"
else:
    PYIC_IMPORT_ERROR = None


SAFE_ATTRS = {
    "STATUS", "SNAME", "SUBTYP", "OBJTYP", "PARENT", "CIRCUIT", "SPEED",
    "SELECT", "RPM", "GPM", "PWR", "TEMP", "LSTTMP", "LOTMP", "HITMP",
    "MODE", "HTMODE", "HEATING", "COOLING", "READY", "ACT", "USE", "MIN",
    "MAX", "MINF", "MAXF", "BODY", "LISTORD", "FEATR", "AVAIL", "ENABLE",
    "NORMAL", "TIME", "DAY", "VACFLO", "VACTIM", "SINDEX", "HNAME", "VER",
    "PROPNAME", "FREEZE", "SUPER", "BOOST",
    "SALT", "SALINITY", "PH", "ORP", "TDS", "ALK", "CALC", "CYA",
    "CHLOR", "CHLORREQ", "SALTREQ", "PHREQ", "ORPREQ",
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
        ic = self.ic_config
        self._port = int(ic.get("port", 6681))
        self._transport = ic.get("transport", "tcp")
        self._last_error = None if PYIC_AVAILABLE else PYIC_IMPORT_ERROR
        self._last_connect = 0.0
        self._inventory: dict[str, Any] = self._empty_inventory()
        self._resolved: dict[str, Any] = self._resolve_mappings(self._inventory)
        self._started = False
        self.updated = threading.Event()

    @property
    def ic_config(self) -> dict[str, Any]:
        if isinstance(self.config.get("intellicenter"), dict):
            return self.config["intellicenter"]
        return self.config

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
            ic = self.ic_config
            ic["host"] = (host or "").strip()
            if port:
                self._port = int(port)
                ic["port"] = self._port
            if transport in ("tcp", "websocket"):
                self._transport = transport
                ic["transport"] = transport
            self._host = ic["host"]
        self._restart.set()

    def remap(self) -> None:
        """Re-resolve config friendly names against the current panel model."""
        loop = self._loop
        controller = self._controller
        if loop is not None and controller is not None:
            try:
                loop.call_soon_threadsafe(
                    lambda: self._publish_from_controller(controller)
                )
            except Exception:
                LOG.debug("Unable to schedule IntelliCenter remap", exc_info=True)
        else:
            with self._lock:
                self._resolved = self._resolve_mappings(self._inventory)

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def mode(self) -> str:
        return "panel" if self._connected else "simulation"

    @property
    def web_url(self) -> str:
        with self._lock:
            host = (self._host or (self.ic_config.get("host") or "")).strip()
            if not host:
                return ""
            if host.startswith(("http://", "https://")):
                return host
            return f"http://{host}"

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "connected": self._connected,
                "mode": self.mode,
                "host": self._host,
                "web_url": self.web_url,
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
                "web_url": self.web_url,
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
            LOG.warning("IntelliCenter write failed (%s): %s %s", reason, exc, ops)
            with self._lock:
                self._last_error = str(exc)
            return False, str(exc)

    def set_device_state(
        self,
        objnam: str,
        on: bool | None = None,
        speed: int | None = None,
        effect: str | None = None,
        setpoint: int | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        """Turn on/off or set params on any IntelliCenter device."""
        with self._lock:
            target_obj = None
            for obj in self._inventory.get("objects", []):
                if obj.get("objnam") == objnam:
                    target_obj = obj
                    break

            changes: dict[str, Any] = dict(params or {})
            objtype = target_obj.get("objtype") if target_obj else ""

            if on is not None:
                if objtype == "PUMP":
                    changes["STATUS"] = "10" if on else "4"
                elif objtype == "HEATER":
                    changes["MODE"] = "2" if on else "1"
                else:
                    changes["STATUS"] = "ON" if on else "OFF"

            if speed is not None:
                speed_val = str(int(speed))
                changes["SPEED"] = speed_val
                changes["RPM"] = speed_val
                changes["SELECT"] = "RPM"

            if effect is not None:
                effect_str = str(effect).upper()
                changes["ACT"] = effect_str
                changes["USE"] = effect_str

            if setpoint is not None:
                changes["LOTMP"] = str(int(setpoint))

            # Optimistically apply to local inventory object
            if target_obj:
                target_obj.setdefault("attrs", {}).update(changes)
                if "STATUS" in changes:
                    target_obj["status"] = changes["STATUS"]

                # If pump, sync corresponding pump circuit or vice-versa
                if objtype == "PUMP" and ("SPEED" in changes or "STATUS" in changes):
                    for pc in self._inventory.get("pump_circuits", []):
                        if pc.get("attrs", {}).get("PARENT") == objnam or pc.get("name") == target_obj.get("name"):
                            pc.setdefault("attrs", {}).update(changes)
                            if "STATUS" in changes:
                                pc["status"] = "ON" if changes["STATUS"] == "10" else "OFF"
                elif objtype == "PMPCIRC" and ("SPEED" in changes or "STATUS" in changes):
                    parent_id = target_obj.get("attrs", {}).get("PARENT")
                    for p in self._inventory.get("pumps", []):
                        if p.get("objnam") == parent_id or p.get("name") == target_obj.get("name"):
                            p.setdefault("attrs", {}).update(changes)
                            if "STATUS" in changes:
                                p["status"] = "10" if changes["STATUS"] == "ON" else "4"

            # Persist custom device state
            for cd in self.config.get("custom_devices", []):
                if cd.get("objnam") == objnam:
                    cd.setdefault("attrs", {}).update(changes)
                    if "STATUS" in changes:
                        cd["status"] = changes["STATUS"]

        if self._connected:
            return self.write({objnam: changes}, reason=f"device_{objnam}")
        return True, f"Device {objnam} set (simulation)"

    def edit_device(
        self,
        objnam: str,
        name: str | None = None,
        subtype: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        """Edit friendly name, subtype, or properties of an IntelliCenter device."""
        with self._lock:
            target_obj = None
            for obj in self._inventory.get("objects", []):
                if obj.get("objnam") == objnam:
                    target_obj = obj
                    break
            if not target_obj:
                return False, f"Device {objnam} not found"

            changes: dict[str, Any] = dict(params or {})
            if name is not None:
                name_str = str(name).strip()
                changes["SNAME"] = name_str
                target_obj["name"] = name_str
            if subtype is not None:
                sub_str = str(subtype).strip().upper()
                changes["SUBTYP"] = sub_str
                target_obj["subtype"] = sub_str

            target_obj.setdefault("attrs", {}).update(changes)

            for key in ("circuits", "pumps", "pump_circuits", "bodies", "heaters", "valves", "chemistry"):
                for item in self._inventory.get(key, []):
                    if item.get("objnam") == objnam:
                        if name:
                            item["name"] = name_str
                        if subtype:
                            item["subtype"] = sub_str
                        item.setdefault("attrs", {}).update(changes)

            for cd in self.config.get("custom_devices", []):
                if cd.get("objnam") == objnam:
                    if name:
                        cd["name"] = name_str
                    if subtype:
                        cd["subtype"] = sub_str
                    cd.setdefault("attrs", {}).update(changes)

            self._resolved = self._resolve_mappings(self._inventory)

        if self._connected:
            ok, msg = self.write({objnam: changes}, reason=f"edit_device_{objnam}")
            return ok, msg
        return True, f"Device {objnam} updated"

    def add_device(
        self,
        objtype: str,
        name: str,
        subtype: str = "GENERIC",
        params: dict[str, Any] | None = None,
    ) -> tuple[bool, str, dict[str, Any]]:
        """Add a new valve, circuit, relay, pump, or device."""
        objtype = str(objtype).strip().upper()
        if objtype not in ("CIRCUIT", "VALVE", "PUMP", "PMPCIRC", "HEATER", "CHEM", "BODY"):
            objtype = "CIRCUIT"
        subtype = str(subtype or "GENERIC").strip().upper()
        name = str(name).strip()
        if not name:
            name = f"New {objtype.capitalize()}"

        prefix_map = {
            "CIRCUIT": "C",
            "VALVE": "V",
            "PUMP": "P",
            "PMPCIRC": "PC",
            "HEATER": "H",
            "CHEM": "CH",
            "BODY": "B",
        }
        prefix = prefix_map.get(objtype, "C")

        with self._lock:
            existing = {obj.get("objnam") for obj in self._inventory.get("objects", [])}
            idx = 100
            while f"{prefix}{idx:04d}" in existing:
                idx += 1
            new_id = f"{prefix}{idx:04d}"

            attrs = {
                "OBJTYP": objtype,
                "SUBTYP": subtype,
                "SNAME": name,
                "STATUS": "OFF",
                **(params or {})
            }
            if objtype == "PUMP":
                attrs.setdefault("SPEED", "2200")
                attrs.setdefault("RPM", "2200")
                attrs.setdefault("SELECT", "RPM")
                attrs["STATUS"] = "4"

            new_obj = {
                "objnam": new_id,
                "objtype": objtype,
                "subtype": subtype,
                "name": name,
                "status": attrs["STATUS"],
                "attrs": attrs,
                "custom": True,
            }

            self._inventory["objects"].append(new_obj)
            cat_map = {
                "CIRCUIT": "circuits",
                "VALVE": "valves",
                "PUMP": "pumps",
                "PMPCIRC": "pump_circuits",
                "HEATER": "heaters",
                "CHEM": "chemistry",
                "BODY": "bodies",
            }
            cat = cat_map.get(objtype)
            if cat and cat in self._inventory:
                self._inventory[cat].append(new_obj)
                self._inventory[cat].sort(key=lambda o: ((o.get("name") or "").lower(), o.get("objnam")))

            self.config.setdefault("custom_devices", []).append(new_obj)
            self._resolved = self._resolve_mappings(self._inventory)

        if self._connected:
            self.write({new_id: attrs}, reason=f"add_device_{new_id}")
        return True, f"Device {name} ({new_id}) created", new_obj

    def delete_device(self, objnam: str) -> tuple[bool, str]:
        """Delete a custom device."""
        with self._lock:
            self._inventory["objects"] = [
                o for o in self._inventory.get("objects", []) if o.get("objnam") != objnam
            ]
            for cat in ("circuits", "valves", "pumps", "pump_circuits", "heaters", "chemistry", "bodies"):
                if cat in self._inventory:
                    self._inventory[cat] = [
                        o for o in self._inventory[cat] if o.get("objnam") != objnam
                    ]
            customs = self.config.get("custom_devices", [])
            self.config["custom_devices"] = [
                cd for cd in customs if cd.get("objnam") != objnam
            ]
            self._resolved = self._resolve_mappings(self._inventory)
            return True, f"Device {objnam} removed"

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

        cfg = self.ic_config
        self._host = str(cfg.get("host") or "").strip()
        self._port = int(cfg.get("port") or 6681)
        self._transport = cfg.get("transport") or "tcp"

        while not self._stop:
            if self._restart.is_set():
                await self._teardown_handler()
                self._restart.clear()
                cfg = self.ic_config
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
                discovery_timeout=float(self.ic_config.get("discovery_timeout", 6))
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
        # Re-read body temps and salt from the panel on a timer so the UI is
        # never more than a minute stale; pyintellicenter allows 30-900 s.
        telemetry_seconds = float(self.ic_config.get("telemetry_seconds", 30))
        controller = ICModelController(
            self._host,
            model,
            port=self._port,
            transport=self._transport,
            telemetry_reconcile_interval=max(30.0, min(900.0, telemetry_seconds)),
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
            self.updated.set()

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
            # Merge any user-added custom devices
            for cd in self.config.get("custom_devices", []):
                if not any(o.get("objnam") == cd.get("objnam") for o in inventory.get("objects", [])):
                    inventory["objects"].append(cd)
                    cat_map = {
                        "CIRCUIT": "circuits",
                        "VALVE": "valves",
                        "PUMP": "pumps",
                        "PMPCIRC": "pump_circuits",
                        "HEATER": "heaters",
                        "CHEM": "chemistry",
                        "BODY": "bodies",
                    }
                    cat = cat_map.get(cd.get("objtype"))
                    if cat and cat in inventory:
                        inventory[cat].append(cd)
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
                "web_url": self.web_url,
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
        chemistry = pick(CHEM_TYPE)
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
            "chemistry": chemistry,
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
            if not objnam and isinstance(spec, str) and any(o["objnam"] == spec for o in objects):
                objnam = spec
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
            exact = [o for o in objects if _norm(o["name"]) == wanted or _norm(o["objnam"]) == wanted]
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
            "blower": {},
            "lights": {},
            "heater": {},
            "valves": {},
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
        blower = devices.get("blower") or {}
        blower_name = blower.get("circuit") if isinstance(blower, dict) else blower
        resolved["blower"]["circuit"] = find(blower_name, CIRCUIT_TYPE, circuits)
        heater = devices.get("heater") or {}
        # An on/off heater wired to a relay circuit (no thermostat).
        resolved["heater"]["circuit"] = find(heater.get("circuit"), CIRCUIT_TYPE, circuits)
        resolved["heater"]["body"] = find(
            heater.get("body"), BODY_TYPE, bodies
        )
        resolved["heater"]["device"] = find(
            heater.get("device"), HEATER_TYPE, inventory["heaters"]
        )
        for key, spec in (devices.get("valves") or {}).items():
            resolved["valves"][key] = find(spec, VALVE_TYPE, inventory.get("valves", [])) or find(spec, CIRCUIT_TYPE, circuits)
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
        objects = [
            # Water bodies
            {"objnam": "B1001", "objtype": BODY_TYPE, "subtype": "POOL", "name": "POOL", "status": "ON",
             "attrs": {"OBJTYP": BODY_TYPE, "SUBTYP": "POOL", "SNAME": "POOL", "LOTMP": "84", "TEMP": "84", "MODE": "1", "HTMODE": "OFF"}},
            {"objnam": "B1002", "objtype": BODY_TYPE, "subtype": "SPA", "name": "SPA", "status": "OFF",
             "attrs": {"OBJTYP": BODY_TYPE, "SUBTYP": "SPA", "SNAME": "SPA", "LOTMP": "102", "TEMP": "102", "MODE": "1", "HTMODE": "OFF"}},
            # Circuits & Relays
            {"objnam": "C0001", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "POOL", "status": "ON",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "POOL", "STATUS": "ON"}},
            {"objnam": "C0002", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "SPA", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "SPA", "STATUS": "OFF"}},
            {"objnam": "C0003", "objtype": CIRCUIT_TYPE, "subtype": "MAGIC2", "name": "NE Floor Jet", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "MAGIC2", "SNAME": "NE Floor Jet", "STATUS": "OFF"}},
            {"objnam": "C0004", "objtype": CIRCUIT_TYPE, "subtype": "MAGIC2", "name": "NW Floor Jet", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "MAGIC2", "SNAME": "NW Floor Jet", "STATUS": "OFF"}},
            {"objnam": "C0005", "objtype": CIRCUIT_TYPE, "subtype": "MAGIC2", "name": "SE Floor Jet", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "MAGIC2", "SNAME": "SE Floor Jet", "STATUS": "OFF"}},
            {"objnam": "C0006", "objtype": CIRCUIT_TYPE, "subtype": "MAGIC2", "name": "SW Floor Jet", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "MAGIC2", "SNAME": "SW Floor Jet", "STATUS": "OFF"}},
            {"objnam": "C0007", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "Pool Fountain E", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "Pool Fountain E", "STATUS": "OFF"}},
            {"objnam": "C0008", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "Spa Fountain E", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "Spa Fountain E", "STATUS": "OFF"}},
            {"objnam": "C0009", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "Pool Fountain W", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "Pool Fountain W", "STATUS": "OFF"}},
            {"objnam": "C0010", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "Spa Fountain W", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "Spa Fountain W", "STATUS": "OFF"}},
            {"objnam": "C0011", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "Blower", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "Blower", "STATUS": "OFF"}},
            {"objnam": "C0012", "objtype": CIRCUIT_TYPE, "subtype": "INTELLI", "name": "POOL LIGHT", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "INTELLI", "SNAME": "POOL LIGHT", "STATUS": "OFF", "ACT": "BLUER", "USE": "BLUER"}},
            {"objnam": "C0013", "objtype": CIRCUIT_TYPE, "subtype": "INTELLI", "name": "SPA LIGHT", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "INTELLI", "SNAME": "SPA LIGHT", "STATUS": "OFF", "ACT": "BLUER", "USE": "BLUER"}},
            {"objnam": "C0014", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "Aux Relay 1", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "Aux Relay 1", "STATUS": "OFF"}},
            {"objnam": "C0015", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "Aux Relay 2", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "Aux Relay 2", "STATUS": "OFF"}},
            {"objnam": "C0016", "objtype": CIRCUIT_TYPE, "subtype": "LIGHT", "name": "Deck Jets Light", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "LIGHT", "SNAME": "Deck Jets Light", "STATUS": "OFF"}},
            {"objnam": "C0017", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "East Firepit Burner", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "East Firepit Burner", "STATUS": "OFF"}},
            {"objnam": "C0018", "objtype": CIRCUIT_TYPE, "subtype": "GENERIC", "name": "West Firepit Burner", "status": "OFF",
             "attrs": {"OBJTYP": CIRCUIT_TYPE, "SUBTYP": "GENERIC", "SNAME": "West Firepit Burner", "STATUS": "OFF"}},
            # Variable-Speed Pumps
            {"objnam": "P1001", "objtype": PUMP_TYPE, "subtype": "VS", "name": "MAIN PUMP", "status": "4",
             "attrs": {"OBJTYP": PUMP_TYPE, "SUBTYP": "VS", "SNAME": "MAIN PUMP", "STATUS": "4", "SPEED": "2200", "RPM": "2200", "GPM": "45", "PWR": "480", "SELECT": "RPM"}},
            {"objnam": "P1002", "objtype": PUMP_TYPE, "subtype": "VS", "name": "FEATURES PUMP", "status": "4",
             "attrs": {"OBJTYP": PUMP_TYPE, "SUBTYP": "VS", "SNAME": "FEATURES PUMP", "STATUS": "4", "SPEED": "2800", "RPM": "2800", "GPM": "62", "PWR": "860", "SELECT": "RPM"}},
            # Pump Circuits
            {"objnam": "PC101", "objtype": PMPCIRC_TYPE, "subtype": "PMPCIRC", "name": "MAIN PUMP", "status": "ON",
             "attrs": {"OBJTYP": PMPCIRC_TYPE, "SUBTYP": "PMPCIRC", "SNAME": "MAIN PUMP", "STATUS": "ON", "SPEED": "2200", "SELECT": "RPM", "PARENT": "P1001"}},
            {"objnam": "PC102", "objtype": PMPCIRC_TYPE, "subtype": "PMPCIRC", "name": "FEATURES PUMP", "status": "OFF",
             "attrs": {"OBJTYP": PMPCIRC_TYPE, "SUBTYP": "PMPCIRC", "SNAME": "FEATURES PUMP", "STATUS": "OFF", "SPEED": "2800", "SELECT": "RPM", "PARENT": "P1002"}},
            # Valves
            {"objnam": "V1001", "objtype": VALVE_TYPE, "subtype": "VALVE", "name": "Pool/Spa Drain Valve", "status": "ON",
             "attrs": {"OBJTYP": VALVE_TYPE, "SUBTYP": "VALVE", "SNAME": "Pool/Spa Drain Valve", "STATUS": "ON", "CIRCUIT": "POOL", "POSIT": "POOL"}},
            {"objnam": "V1002", "objtype": VALVE_TYPE, "subtype": "VALVE", "name": "Pool/Spa Return Valve", "status": "ON",
             "attrs": {"OBJTYP": VALVE_TYPE, "SUBTYP": "VALVE", "SNAME": "Pool/Spa Return Valve", "STATUS": "ON", "CIRCUIT": "POOL", "POSIT": "SPA"}},
            {"objnam": "V1003", "objtype": VALVE_TYPE, "subtype": "VALVE", "name": "Solar Valve", "status": "OFF",
             "attrs": {"OBJTYP": VALVE_TYPE, "SUBTYP": "VALVE", "SNAME": "Solar Valve", "STATUS": "OFF", "CIRCUIT": "SOLAR", "POSIT": "OFF"}},
            {"objnam": "V1004", "objtype": VALVE_TYPE, "subtype": "VALVE", "name": "Water Feature 3-Way Valve", "status": "OFF",
             "attrs": {"OBJTYP": VALVE_TYPE, "SUBTYP": "VALVE", "SNAME": "Water Feature 3-Way Valve", "STATUS": "OFF", "CIRCUIT": "FEATURES", "POSIT": "OFF"}},
            # Heater
            {"objnam": "H1001", "objtype": HEATER_TYPE, "subtype": "GAS", "name": "HEATER", "status": "OFF",
             "attrs": {"OBJTYP": HEATER_TYPE, "SUBTYP": "GAS", "SNAME": "HEATER", "STATUS": "OFF", "MODE": "1", "LOTMP": "84", "BODY": "B1001"}},
            # Chemistry
            {"objnam": "CH101", "objtype": CHEM_TYPE, "subtype": "CHLOR", "name": "IntelliChlor SCG", "status": "ON",
             "attrs": {"OBJTYP": CHEM_TYPE, "SUBTYP": "CHLOR", "SNAME": "IntelliChlor SCG", "STATUS": "ON", "SALT": "3200", "QUALTY": "GOOD"}},
        ]

        # Merge custom devices from config
        for cd in self.config.get("custom_devices", []):
            if not any(o.get("objnam") == cd.get("objnam") for o in objects):
                objects.append(cd)

        def pick(objtype):
            return sorted(
                (o for o in objects if o["objtype"] == objtype),
                key=lambda o: ((o.get("name") or "").lower(), o.get("objnam")),
            )

        return {
            "system": {
                "name": "IntelliCenter Pool",
                "version": "1.064",
                "metric": False,
            },
            "objects": objects,
            "circuits": pick(CIRCUIT_TYPE),
            "pumps": pick(PUMP_TYPE),
            "pump_circuits": pick(PMPCIRC_TYPE),
            "bodies": pick(BODY_TYPE),
            "heaters": pick(HEATER_TYPE),
            "chemistry": pick(CHEM_TYPE),
            "valves": pick(VALVE_TYPE),
            "updated": time.time(),
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
