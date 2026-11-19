#!/usr/bin/env python3
"""High-level pool and spa control logic.

Translates the Pool UI / voice assistant / Alexa intents into IntelliCenter
circuit writes, keeps an optimistic logical model for the 3D UI, and runs the
main variable-speed pump schedule.
"""

from __future__ import annotations

import copy
import datetime as dt
import logging
import threading
import time
from typing import Any, Callable
from zoneinfo import ZoneInfo

LOG = logging.getLogger("pool.controller")

try:
    from pyintellicenter import LIGHT_EFFECTS, HeaterType

    LIGHT_EFFECTS = dict(LIGHT_EFFECTS)
except Exception:  # pragma: no cover
    HeaterType = None
    LIGHT_EFFECTS = {
        "SAMMOD": "SAm", "PARTY": "Party Mode", "CARIB": "Caribbean",
        "SSET": "Sunset", "ROMAN": "Romance", "AMERCA": "American",
        "ROYAL": "Royal", "WHITER": "White", "REDR": "Red", "BLUER": "Blue",
        "GREENR": "Green", "MAGNTAR": "Magenta",
    }

DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
FEATURE_LABELS = {
    "ne": "NE Floor Jet", "nw": "NW Floor Jet",
    "se": "SE Floor Jet", "sw": "SW Floor Jet",
}
FIREBASKET_LABELS = {"east": "East Firebasket", "west": "West Firebasket"}
FIREBASKET_FOUNTAIN_LABELS = {
    "east": ("Pool Fountain E", "Spa Fountain E"),
    "west": ("Pool Fountain W", "Spa Fountain W"),
}


class PoolController:
    """Logical equipment model and IntelliCenter command dispatcher."""

    def __init__(self, config: dict[str, Any], bridge: Any,
                 save_config: Callable[[dict], None] | None = None) -> None:
        self.config = config
        self.bridge = bridge
        self.save_config = save_config or (lambda cfg: None)
        self.lock = threading.RLock()
        self._objtypes: dict[str, str] = {}
        self._startup_applied = False
        self._last_scan: dict[str, Any] = {}
        self._last_schedule_active: bool | None = None
        self._last_schedule_key: str | None = None
        self._last_message = ""
        self._last_message_at = 0.0
        self._stop = False
        self._thread: threading.Thread | None = None
        self._led_sent: dict[str, tuple[bool, float]] = {}

        defaults = config.get("defaults", {})
        self._default_rpm = int(defaults.get("main_rpm", 2200))
        self._features_rpm = int(defaults.get("features_rpm", 2800))
        self._pool_setpoint = int(defaults.get("pool_setpoint", 84))
        self._salt_ppm = int(defaults.get("salt_ppm", 3200))
        self._default_effect = str(defaults.get("light_effect", "BLUER")).upper()
        if self._default_effect not in LIGHT_EFFECTS:
            self._default_effect = "BLUER"
        self._spillway_effect = str(defaults.get("spillway_effect", "BLUER")).upper()
        if self._spillway_effect not in LIGHT_EFFECTS:
            self._spillway_effect = "BLUER"

        self.state_data: dict[str, Any] = {
            "mode": defaults.get("mode", "pool"),
            "bodies": {
                "pool": {"temp": None, "setpoint": self._pool_setpoint, "heating": False},
                "spa": {"temp": None, "setpoint": 102, "heating": False},
            },
            "pumps": {
                "main": {"on": False, "rpm": self._default_rpm},
                "features": {"on": False, "rpm": self._features_rpm},
            },
            "deck_jets": {
                jet: {"on": False, "light": False, "thumper": True}
                for jet in FEATURE_LABELS
            },
            "firebaskets": {
                basket: {
                    "on": False, "water": False, "spa_water": False,
                    "spillway_pool_led": False, "spillway_spa_led": False,
                }
                for basket in FIREBASKET_LABELS
            },
            "blower": {"on": False},
            "lights": {
                "pool": {"on": False, "effect": self._default_effect},
                "spa": {"on": False, "effect": self._default_effect},
            },
            "spillway_effect": self._spillway_effect,
            "chemistry": {"salt": self._salt_ppm, "source": "configured"},
            "heater": {"on": False, "setpoint": self._pool_setpoint},
        }
        self._apply_mode_derived_locks()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self) -> None:
        self._thread = threading.Thread(target=self._tick_loop, name="pool-schedule",
                                        daemon=True)
        self._thread.start()
        threading.Thread(target=self._spillway_led_loop, name="spillway-leds",
                         daemon=True).start()
        # Scan IntelliCenter and apply required adjustments on server startup
        try:
            self.scan_and_adjust(reason="server_startup")
        except Exception:
            LOG.exception("Startup IntelliCenter scan failed")

    def stop(self) -> None:
        self._stop = True

    def _tick_loop(self) -> None:
        while not self._stop:
            try:
                self.tick()
            except Exception:
                LOG.exception("Pool controller tick failed")
            time.sleep(10)

    def _spillway_led_loop(self) -> None:
        while not self._stop:
            self.bridge.updated.wait(timeout=10)
            self.bridge.updated.clear()
            try:
                self.sync_spillway_leds()
            except Exception:
                LOG.exception("Spillway LED sync failed")

    def sync_spillway_leds(self) -> None:
        """Keep the spillway LED relays following the spillway water circuits.

        Works from live panel status, so circuits switched at the panel, by
        panel schedules, or from any other app are followed too.
        """
        if not self.bridge.connected:
            return
        resolved = self.bridge.resolved()
        status = {o["objnam"]: o.get("status")
                  for o in self.bridge.inventory().get("circuits", [])}
        wanted: dict[str, bool] = {}
        for spec in (resolved.get("firebaskets") or {}).values():
            for led, water in (("spillway_pool_led", "water"),
                               ("spillway_spa_led", "spa_water")):
                if spec.get(led):
                    wanted[spec[led]] = (wanted.get(spec[led], False)
                                         or status.get(spec.get(water)) == "ON")
        now = time.time()
        changes: dict[str, dict[str, Any]] = {}
        for objnam, on in wanted.items():
            if objnam not in status or (status[objnam] == "ON") == on:
                continue
            last = self._led_sent.get(objnam)
            if last and last[0] == on and now - last[1] < 5:
                continue
            self._led_sent[objnam] = (on, now)
            self._power(changes, objnam, on)
        if changes:
            self._send(changes, "spillway_led_follow")

    def tick(self) -> None:
        if self.bridge.connected and not self._startup_applied:
            self._startup_applied = True
            try:
                self.scan_and_adjust(reason="panel_connect_startup")
            except Exception:
                LOG.exception("Connected IntelliCenter scan failed")
        self._merge_panel_state()
        self._run_schedule()

    def scan_status(self) -> dict[str, Any]:
        with self.lock:
            if not self._last_scan:
                return {
                    "ok": True,
                    "scanned": False,
                    "summary": "Startup scan pending",
                    "counts": {},
                    "discovered": {},
                    "adjustments": [],
                }
            return copy.deepcopy(self._last_scan)

    def scan_and_adjust(self, reason: str = "server_startup", force: bool = False) -> dict[str, Any]:
        """Scan IntelliCenter for valves, pumps, circuits, aux relays, etc. and apply required adjustments."""
        start_time = time.time()
        LOG.info("Scanning IntelliCenter hardware & checking required adjustments (reason: %s)...", reason)

        # 1. Remap and retrieve hardware inventory
        self.bridge.remap()
        inventory = self.bridge.inventory()
        resolved = self.bridge.resolved()
        connected = self.bridge.connected
        panel_mode = self.bridge.mode

        objects = inventory.get("objects", [])
        circuits = inventory.get("circuits", [])
        pumps = inventory.get("pumps", [])
        pump_circuits = inventory.get("pump_circuits", [])
        valves = inventory.get("valves", [])
        heaters = inventory.get("heaters", [])
        bodies = inventory.get("bodies", [])
        chemistry = inventory.get("chemistry", [])

        # Filter Aux Relays from circuits
        aux_relays = [
            c for c in circuits
            if "AUX" in (c.get("subtype") or "").upper()
            or "RELAY" in (c.get("subtype") or "").upper()
            or "aux" in (c.get("name") or "").lower()
            or "relay" in (c.get("name") or "").lower()
        ]

        adjustments: list[dict[str, Any]] = []

        with self.lock:
            # 2. Adjustments:
            # A. Mode and Valve Adjustments
            desired_mode = self.config.get("defaults", {}).get("mode", "pool")
            should_apply_mode = bool(self.config.get("intellicenter", {}).get("apply_pool_mode_on_start", True)) or force
            if should_apply_mode:
                mode_res = self.set_mode(desired_mode, reason=f"{reason}_mode")
                valves_info = self._valves_for_mode(desired_mode)
                adjustments.append({
                    "category": "valves",
                    "target": "mode_valves",
                    "action": f"Set {desired_mode.upper()} mode valves",
                    "details": f"Drain Valve: {valves_info['drain']}, Return Valve: {valves_info['return']}",
                    "result": mode_res.get("message", "applied"),
                })

            # B. Main Pump & Schedule Adjustments
            now = self._now()
            active_run = self._active_run(now)
            schedule_enabled = bool(self.config.get("schedule", {}).get("enabled", True))

            if schedule_enabled and active_run:
                target_rpm = int(active_run.get("rpm", self._default_rpm))
                pump_res = self.set_pump("main", on=True, rpm=target_rpm, reason=f"{reason}_schedule")
                adjustments.append({
                    "category": "pumps",
                    "target": "main_pump",
                    "action": f"Active schedule '{active_run['name']}': Main pump ON at {target_rpm} RPM",
                    "result": pump_res.get("message", "applied"),
                })
            elif self.config.get("schedule", {}).get("apply_at_startup", False):
                pump_res = self.set_pump("main", on=False, reason=f"{reason}_off_hours")
                adjustments.append({
                    "category": "pumps",
                    "target": "main_pump",
                    "action": "Schedule off-hours: Main pump idle/off",
                    "result": pump_res.get("message", "applied"),
                })
            else:
                if not self.state_data["pumps"]["main"]["on"]:
                    pump_res = self.set_pump("main", on=True, rpm=self._default_rpm, reason=f"{reason}_default_rpm")
                    adjustments.append({
                        "category": "pumps",
                        "target": "main_pump",
                        "action": f"Main pump initialized at default {self._default_rpm} RPM",
                        "result": pump_res.get("message", "applied"),
                    })

            # C. Water Features Pump Adjustment
            jets_on = any(j.get("on") for j in self.state_data["deck_jets"].values())
            baskets_on = any(b.get("water") or b.get("spa_water")
                             for b in self.state_data["firebaskets"].values())
            if not (jets_on or baskets_on):
                feat_res = self.set_pump("features", on=False, reason=f"{reason}_features_off")
                adjustments.append({
                    "category": "pumps",
                    "target": "features_pump",
                    "action": "Features pump OFF (0 water features active)",
                    "result": feat_res.get("message", "applied"),
                })
            else:
                feat_res = self.set_pump("features", on=True, rpm=self._features_rpm, reason=f"{reason}_features_on")
                adjustments.append({
                    "category": "pumps",
                    "target": "features_pump",
                    "action": f"Features pump ON at {self._features_rpm} RPM",
                    "result": feat_res.get("message", "applied"),
                })

            # D. Safety & Circuit Lockout Adjustments
            if self.state_data["mode"] == "pool" and self.state_data["blower"].get("on"):
                blow_res = self.set_blower(False)
                adjustments.append({
                    "category": "circuits",
                    "target": "blower",
                    "action": "Safety Interlock: Spa blower turned OFF while in pool mode",
                    "result": blow_res.get("message", "applied"),
                })

            heater_active = self.state_data["heater"].get("on") or any(
                b.get("heating") for b in self.state_data["bodies"].values()
            )
            if heater_active and (not self.state_data["pumps"]["main"]["on"] or self.state_data["pumps"]["main"]["rpm"] < 1500):
                safe_rpm = max(2200, self._default_rpm)
                heat_res = self.set_pump("main", on=True, rpm=safe_rpm, reason="heater_flow_safety")
                adjustments.append({
                    "category": "heaters",
                    "target": "heater_flow_switch",
                    "action": f"Safety Interlock: Main pump boosted to {safe_rpm} RPM for heater flow switch",
                    "result": heat_res.get("message", "applied"),
                })

            # E. Setpoints & Chemistry Sync
            self.state_data["bodies"]["pool"]["setpoint"] = self._pool_setpoint
            self.state_data["bodies"]["spa"]["setpoint"] = 102
            self.state_data["chemistry"]["salt"] = self._salt_ppm
            adjustments.append({
                "category": "setpoints",
                "target": "setpoints",
                "action": f"Synchronized pool setpoint {self._pool_setpoint}°F, spa setpoint 102°F, salt {self._salt_ppm} ppm",
                "result": "synced",
            })

            self._merge_panel_state()

        scan_record = {
            "ok": True,
            "scanned": True,
            "reason": reason,
            "connected": connected,
            "mode": panel_mode,
            "host": inventory.get("host", ""),
            "scanned_at": time.time(),
            "scan_duration_ms": round((time.time() - start_time) * 1000, 2),
            "summary": f"Scanned {len(objects)} devices: {len(valves)} valves, {len(pumps)} pumps ({len(pump_circuits)} circuits), {len(circuits)} circuits ({len(aux_relays)} aux relays), {len(heaters)} heaters. Applied {len(adjustments)} adjustments.",
            "counts": {
                "valves": len(valves),
                "pumps": len(pumps),
                "pump_circuits": len(pump_circuits),
                "circuits": len(circuits),
                "aux_relays": len(aux_relays),
                "heaters": len(heaters),
                "bodies": len(bodies),
                "chemistry": len(chemistry),
                "total_objects": len(objects),
            },
            "discovered": {
                "valves": [{"objnam": v.get("objnam"), "name": v.get("name"), "status": v.get("status")} for v in valves],
                "pumps": [{"objnam": p.get("objnam"), "name": p.get("name"), "status": p.get("status"), "rpm": p.get("attrs", {}).get("RPM") or p.get("attrs", {}).get("SPEED")} for p in pumps],
                "circuits": [{"objnam": c.get("objnam"), "name": c.get("name"), "status": c.get("status"), "subtype": c.get("subtype")} for c in circuits],
                "aux_relays": [{"objnam": a.get("objnam"), "name": a.get("name"), "status": a.get("status")} for a in aux_relays],
                "heaters": [{"objnam": h.get("objnam"), "name": h.get("name"), "status": h.get("status")} for h in heaters],
            },
            "adjustments": adjustments,
        }

        with self.lock:
            self._last_scan = scan_record

        LOG.info("IntelliCenter scan & adjustment complete: %s", scan_record["summary"])
        return scan_record

    # ------------------------------------------------------------------
    # State snapshot
    # ------------------------------------------------------------------
    def state(self) -> dict[str, Any]:
        with self.lock:
            data = copy.deepcopy(self.state_data)
            schedule = self._schedule_status()
            resolved = self.bridge.resolved()
            inventory = self.bridge.inventory()
            connection = self.bridge.status()
            mode = data["mode"]
            active_body = "spa" if mode == "spa" else "pool"
            data["mode"] = mode
            data["active_body"] = active_body
            data["modes"] = {"pool": mode == "pool", "spa": mode == "spa"}
            data["valves"] = self._valves_for_mode(mode)
            data["heater"]["active"] = data["heater"]["on"]
            # A relay-switched heater is plain on/off with no thermostat.
            data["heater"]["thermostat"] = not (resolved.get("heater") or {}).get("circuit")
            data["heater"]["heating"] = bool(
                data["bodies"].get(active_body, {}).get("heating")
            )
            data["schedule"] = schedule
            data["connection"] = connection
            data["light_effects"] = LIGHT_EFFECTS
            data["resolved"] = resolved
            data["inventory"] = {
                "objects": inventory.get("objects", []),
                "circuits": inventory.get("circuits", []),
                "pumps": inventory.get("pumps", []),
                "pump_circuits": inventory.get("pump_circuits", []),
                "bodies": inventory.get("bodies", []),
                "heaters": inventory.get("heaters", []),
                "chemistry": inventory.get("chemistry", []),
                "valves": inventory.get("valves", []),
                "system": inventory.get("system"),
                "updated": inventory.get("updated"),
            }
            data["labels"] = {
                "deck_jets": FEATURE_LABELS,
                "firebaskets": FIREBASKET_LABELS,
            }
            data["last_message"] = self._last_message
            data["last_message_at"] = self._last_message_at
            data["last_scan"] = self.scan_status()
            data["time"] = time.time()
            data["local_time"] = self._now().strftime("%Y-%m-%d %H:%M:%S")
            return data

    def _schedule_status(self) -> dict[str, Any]:
        cfg = self.config.get("schedule", {})
        active_run = self._active_run(self._now())
        return {
            "enabled": bool(cfg.get("enabled", True)),
            "apply_at_startup": bool(cfg.get("apply_at_startup", False)),
            "runs": copy.deepcopy(cfg.get("runs", [])),
            "active": bool(active_run),
            "active_run": active_run.get("name") if active_run else None,
            "next": self._next_run_text(),
        }

    # ------------------------------------------------------------------
    # Command entry point
    # ------------------------------------------------------------------
    def command(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        action = (action or "").strip().lower()
        try:
            if action == "set_mode":
                return self.set_mode(payload.get("mode", "pool"))
            if action == "set_pump":
                return self.set_pump(
                    payload.get("pump", "main"),
                    on=payload.get("on"),
                    rpm=payload.get("rpm"),
                )
            if action in ("set_deck_jet", "set_feature"):
                if action == "set_feature":
                    kind = payload.get("kind", "deck_jet")
                    if kind == "firebasket":
                        return self.set_firebasket(
                            payload.get("id", "east"), bool(payload.get("on"))
                        )
                return self.set_deck_jet(
                    payload.get("id", "ne"),
                    on=payload.get("on"),
                    light=payload.get("light"),
                    thumper=payload.get("thumper"),
                )
            if action == "set_firebasket":
                return self.set_firebasket(
                    payload.get("id", "east"),
                    on=payload.get("on"),
                    water=payload.get("water"),
                    spa_water=payload.get("spa_water"),
                )
            if action == "set_all_features":
                return self.set_all_features(bool(payload.get("on")))
            if action == "set_blower":
                return self.set_blower(bool(payload.get("on")))
            if action == "set_spillway_color":
                return self.set_spillway_color(payload.get("effect"))
            if action == "set_all_lights":
                return self.set_all_lights(
                    on=payload.get("on", True),
                    effect=payload.get("effect"),
                )
            if action == "set_light":
                return self.set_light(
                    payload.get("body", "pool"),
                    on=payload.get("on"),
                    effect=payload.get("effect"),
                )
            if action == "set_heater":
                return self.set_heater(
                    on=payload.get("on"), setpoint=payload.get("setpoint")
                )
            if action == "set_schedule":
                return self.set_schedule(
                    enabled=payload.get("enabled"), runs=payload.get("runs")
                )
            if action == "system_off":
                return self.system_off()
            if action == "ic_set_device":
                return self.ic_set_device(
                    payload.get("objnam", ""),
                    on=payload.get("on"),
                    speed=payload.get("speed"),
                    effect=payload.get("effect"),
                    setpoint=payload.get("setpoint"),
                    params=payload.get("params"),
                )
            if action == "ic_edit_device":
                return self.ic_edit_device(
                    payload.get("objnam", ""),
                    name=payload.get("name"),
                    subtype=payload.get("subtype"),
                    params=payload.get("params"),
                )
            if action == "ic_add_device":
                return self.ic_add_device(
                    payload.get("objtype", "CIRCUIT"),
                    name=payload.get("name", ""),
                    subtype=payload.get("subtype", "GENERIC"),
                    params=payload.get("params"),
                )
            if action == "ic_delete_device":
                return self.ic_delete_device(payload.get("objnam", ""))
            if action == "save_animation_mapping":
                return self.save_animation_mapping(payload.get("devices") or {})
            if action in ("open_host_page", "open_intellicenter", "open_host"):
                return self.open_host_page(
                    launch_browser=bool(payload.get("launch") or payload.get("browser"))
                )
            if action in ("ic_scan", "scan"):
                return self.scan_and_adjust(reason="user_command", force=bool(payload.get("force", True)))
            if action in ("ic_set_chlorinator", "set_chlorinator", "set_intellichlor"):
                return self.ic_set_chlorinator(
                    output_percent=payload.get("output_percent"),
                    super_chlorinate=payload.get("super_chlorinate"),
                    salt_ppm=payload.get("salt_ppm"),
                )
            if action in ("ic_set_valve", "set_valve"):
                return self.ic_set_valve(
                    objnam=payload.get("objnam", "V1001"),
                    position=payload.get("position"),
                    on=payload.get("on"),
                )
            if action == "refresh":
                self._merge_panel_state()
                return self._result(True, "State refreshed")
            return self._result(False, "Unknown action: %s" % action)
        except Exception as exc:
            LOG.exception("Command failed: %s %s", action, payload)
            return self._result(False, str(exc))

    # ------------------------------------------------------------------
    # Mode / valves
    # ------------------------------------------------------------------
    def set_mode(self, mode: str, reason: str = "mode") -> dict[str, Any]:
        mode = "spa" if str(mode).lower() == "spa" else "pool"
        with self.lock:
            self.state_data["mode"] = mode
            self._apply_mode_derived_locks()
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            modes = resolved.get("modes", {})
            if modes.get("pool"):
                self._power(changes, modes["pool"], mode == "pool")
            if modes.get("spa"):
                self._power(changes, modes["spa"], mode == "spa")

            main = resolved.get("pumps", {}).get("main")
            if main:
                self._power(changes, main, True)
            self.state_data["pumps"]["main"]["on"] = True
            program = resolved.get("pump_programs", {}).get("main")
            self._speed(changes, program, self.state_data["pumps"]["main"]["rpm"])

            if self.state_data["heater"]["on"]:
                self._heater_changes(changes, resolved)

        ok, msg = self._send(changes, reason)
        return self._result(ok, "%s mode" % mode.capitalize(), msg)

    def _apply_mode_derived_locks(self) -> None:
        # IntelliCenter drives the 3-way actuators automatically. We mirror the
        # requested valve positions for the 3D view.
        return

    def _valves_for_mode(self, mode: str) -> dict[str, Any]:
        if mode == "spa":
            drain = {"spa": 80, "pool": 20}
            ret = {"pool": 80, "spa": 20}
            label = "Spa: spa drain open, pool return open"
        else:
            drain = {"pool": 80, "spa": 20}
            ret = {"spa": 80, "pool": 20}
            label = "Pool: pool drain open, spa return open"
        resolved = self.bridge.resolved()
        valves = resolved.get("valves", {})
        return {
            "drain": drain,
            "return": ret,
            "label": label,
            "drain_valve": valves.get("drain"),
            "return_valve": valves.get("return"),
        }

    # ------------------------------------------------------------------
    # IntelliCenter Device Control & Animation Mapping
    # ------------------------------------------------------------------
    def ic_set_device(
        self,
        objnam: str,
        on: bool | None = None,
        speed: int | None = None,
        effect: str | None = None,
        setpoint: int | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not objnam:
            return self._result(False, "No device objnam specified")

        ok, msg = self.bridge.set_device_state(
            objnam, on=on, speed=speed, effect=effect, setpoint=setpoint, params=params
        )

        with self.lock:
            resolved = self.bridge.resolved()

            # Sync logical animation state if this device is mapped
            # 1. Main pump
            if objnam == resolved.get("pumps", {}).get("main"):
                if on is not None:
                    self.state_data["pumps"]["main"]["on"] = bool(on)
                if speed is not None:
                    self.state_data["pumps"]["main"]["rpm"] = max(450, min(3450, int(speed)))
            elif objnam == resolved.get("pump_programs", {}).get("main"):
                if speed is not None:
                    self.state_data["pumps"]["main"]["rpm"] = max(450, min(3450, int(speed)))

            # 2. Features pump
            if objnam == resolved.get("pumps", {}).get("features"):
                if on is not None:
                    self.state_data["pumps"]["features"]["on"] = bool(on)
                if speed is not None:
                    self.state_data["pumps"]["features"]["rpm"] = max(450, min(3450, int(speed)))
            elif objnam == resolved.get("pump_programs", {}).get("features"):
                if speed is not None:
                    self.state_data["pumps"]["features"]["rpm"] = max(450, min(3450, int(speed)))

            # 3. Modes
            if objnam == resolved.get("modes", {}).get("pool") and on:
                self.state_data["mode"] = "pool"
            elif objnam == resolved.get("modes", {}).get("spa") and on:
                self.state_data["mode"] = "spa"

            # 4. Blower
            if objnam == (resolved.get("blower") or {}).get("circuit"):
                if on is not None:
                    self.state_data["blower"]["on"] = bool(on)

            # 5. Lights
            for body in ("pool", "spa"):
                if objnam == resolved.get("lights", {}).get(body):
                    if on is not None:
                        self.state_data["lights"][body]["on"] = bool(on)
                    if effect and str(effect).upper() in LIGHT_EFFECTS:
                        self.state_data["lights"][body]["effect"] = str(effect).upper()

            # 6. Heater
            if objnam in (
                (resolved.get("heater") or {}).get("circuit"),
                (resolved.get("heater") or {}).get("device"),
                (resolved.get("heater") or {}).get("body"),
            ):
                if on is not None:
                    self.state_data["heater"]["on"] = bool(on)
                if setpoint is not None:
                    self.state_data["heater"]["setpoint"] = max(40, min(104, int(setpoint)))

            # 7. Deck jets
            for jet, spec in resolved.get("deck_jets", {}).items():
                if objnam == spec.get("water") and on is not None:
                    self.state_data["deck_jets"][jet]["on"] = bool(on)
                if objnam == spec.get("light") and on is not None:
                    self.state_data["deck_jets"][jet]["light"] = bool(on)
                if objnam == spec.get("thumper") and on is not None:
                    self.state_data["deck_jets"][jet]["thumper"] = bool(on)

            # 8. Firebaskets
            for basket, spec in resolved.get("firebaskets", {}).items():
                if objnam == spec.get("water") and on is not None:
                    self.state_data["firebaskets"][basket]["water"] = bool(on)
                if objnam == spec.get("spa_water") and on is not None:
                    self.state_data["firebaskets"][basket]["spa_water"] = bool(on)
                if objnam == spec.get("burner") and on is not None:
                    self.state_data["firebaskets"][basket]["on"] = bool(on)

            # Ensure features pump runs if water features are on
            if any(j["on"] for j in self.state_data["deck_jets"].values()) or any(
                f.get("water") or f.get("spa_water") for f in self.state_data["firebaskets"].values()
            ):
                self.state_data["pumps"]["features"]["on"] = True

        return self._result(ok, f"Device {objnam} set", msg)

    def ic_edit_device(
        self,
        objnam: str,
        name: str | None = None,
        subtype: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not objnam:
            return self._result(False, "No device objnam specified")
        ok, msg = self.bridge.edit_device(objnam, name=name, subtype=subtype, params=params)
        self.save_config(self.config)
        self._merge_panel_state()
        return self._result(ok, msg)

    def ic_add_device(
        self,
        objtype: str,
        name: str,
        subtype: str = "GENERIC",
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ok, msg, new_obj = self.bridge.add_device(objtype, name=name, subtype=subtype, params=params)
        self.save_config(self.config)
        self._merge_panel_state()
        res = self._result(ok, msg)
        res["device"] = new_obj
        return res

    def ic_delete_device(self, objnam: str) -> dict[str, Any]:
        if not objnam:
            return self._result(False, "No device objnam specified")
        ok, msg = self.bridge.delete_device(objnam)
        self.save_config(self.config)
        self._merge_panel_state()
        return self._result(ok, msg)

    def save_animation_mapping(self, devices_mapping: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(devices_mapping, dict):
            return self._result(False, "Invalid devices mapping format")
        with self.lock:
            self.config["devices"] = devices_mapping
            self.save_config(self.config)
            self.bridge.remap()
            self._merge_panel_state()
        return self._result(True, "Animation mapping saved successfully")

    def open_host_page(self, launch_browser: bool = False) -> dict[str, Any]:
        """Resolve and optionally open the IntelliCenter host web page."""
        url = getattr(self.bridge, "web_url", "")
        if not url:
            host = (self.config.get("intellicenter", {}).get("host") or "").strip()
            if host:
                url = host if host.startswith(("http://", "https://")) else f"http://{host}"
        if not url:
            return self._result(False, "IntelliCenter host is not configured or discovered yet")

        launched = False
        if launch_browser:
            try:
                import webbrowser
                launched = bool(webbrowser.open(url))
            except Exception as exc:
                LOG.warning("Could not launch browser on host: %s", exc)

        res = self._result(True, f"IntelliCenter host page: {url}")
        res["url"] = url
        res["launched"] = launched
        return res

    def ic_set_chlorinator(
        self,
        output_percent: int | None = None,
        super_chlorinate: bool | None = None,
        salt_ppm: int | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            inventory = self.bridge.inventory()
            chems = inventory.get("chemistry", [])
            chem_objnam = chems[0]["objnam"] if chems else "CH101"
            params: dict[str, Any] = {}
            if output_percent is not None:
                pct = max(0, min(100, int(output_percent)))
                params["CHLOR"] = str(pct)
                params["CHLORREQ"] = str(pct)
            if salt_ppm is not None:
                ppm = max(1000, min(6000, int(salt_ppm)))
                params["SALT"] = str(ppm)
                self._salt_ppm = ppm
                self.state_data["chemistry"]["salt"] = ppm
            if super_chlorinate is not None:
                params["SUPER"] = "ON" if super_chlorinate else "OFF"

            ok, msg = self.bridge.set_device_state(chem_objnam, params=params)
            self._merge_panel_state()
            return self._result(ok, "IntelliChlor settings updated", msg)

    def ic_set_valve(
        self,
        objnam: str,
        position: str | None = None,
        on: bool | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            params: dict[str, Any] = {}
            if position:
                pos_upper = str(position).upper()
                params["POSIT"] = pos_upper
                params["CIRCUIT"] = pos_upper
                on_val = pos_upper != "OFF"
            else:
                on_val = bool(on)
            ok, msg = self.bridge.set_device_state(objnam, on=on_val, params=params)
            self._merge_panel_state()
            return self._result(ok, f"Valve {objnam} adjusted", msg)

    # ------------------------------------------------------------------
    # Pumps
    # ------------------------------------------------------------------
    def set_pump(self, pump: str, on: bool | None = None,
                 rpm: int | None = None, reason: str = "") -> dict[str, Any]:
        pump = "features" if str(pump).lower() in ("features", "secondary", "feature") else "main"
        with self.lock:
            state = self.state_data["pumps"][pump]
            if on is not None:
                state["on"] = bool(on)
            if rpm is not None:
                state["rpm"] = max(450, min(3450, int(rpm)))
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            target = resolved.get("pumps", {}).get(pump)
            if target:
                self._power(changes, target, state["on"])
            program = resolved.get("pump_programs", {}).get(pump)
            self._speed(changes, program, state["rpm"])
        ok, msg = self._send(changes, reason or ("set_%s_pump" % pump))
        return self._result(ok, "%s pump %s at %s RPM" % (
            pump.capitalize(), "on" if state["on"] else "off", state["rpm"]), msg)

    def _ensure_features_pump(self, changes: dict[str, dict[str, Any]]) -> None:
        any_on = any(j["on"] for j in self.state_data["deck_jets"].values()) or any(
            f.get("water") or f.get("spa_water") for f in self.state_data["firebaskets"].values()
        )
        pump = self.state_data["pumps"]["features"]
        pump["on"] = any_on
        resolved = self.bridge.resolved()
        target = resolved.get("pumps", {}).get("features")
        if target:
            self._power(changes, target, any_on)
        program = resolved.get("pump_programs", {}).get("features")
        self._speed(changes, program, pump["rpm"])

    def _firebasket_outputs(self, changes: dict[str, dict[str, Any]],
                            resolved: dict[str, Any]) -> None:
        """Burner and spillway LED relays, which may be shared by both baskets.

        A shared relay stays on while any basket using it needs it.
        """
        wanted: dict[str, bool] = {}
        for basket, spec in (resolved.get("firebaskets") or {}).items():
            state = self.state_data["firebaskets"].get(basket, {})
            for field, needed in (("burner", state.get("on")),
                                  ("spillway_pool_led", state.get("water")),
                                  ("spillway_spa_led", state.get("spa_water"))):
                objnam = spec.get(field)
                if objnam:
                    wanted[objnam] = wanted.get(objnam, False) or bool(needed)
        for basket in self.state_data["firebaskets"].values():
            basket["spillway_pool_led"] = bool(basket.get("water"))
            basket["spillway_spa_led"] = bool(basket.get("spa_water"))
        for objnam, on in wanted.items():
            self._power(changes, objnam, on)

    def _is_color_light(self, objnam: str) -> bool:
        for obj in self.bridge.inventory().get("objects", []):
            if obj.get("objnam") == objnam:
                return str(obj.get("subtype") or "").upper() in (
                    "INTELLI", "GLOW", "GLOWT", "MAGIC2", "CLRCASC", "SAML",
                    "SAMMOD", "PHOTON", "COLORW")
        return False

    # ------------------------------------------------------------------
    # Water features
    # ------------------------------------------------------------------
    def set_deck_jet(self, jet: str, on: bool | None = None,
                     light: bool | None = None,
                     thumper: bool | None = None) -> dict[str, Any]:
        jet = jet if jet in FEATURE_LABELS else "ne"
        with self.lock:
            state = self.state_data["deck_jets"][jet]
            if on is not None:
                state["on"] = bool(on)
                if state["on"]:
                    if light is None:
                        state["light"] = True
                    if thumper is None:
                        state["thumper"] = True
                else:
                    if light is None:
                        state["light"] = False
            if light is not None:
                state["light"] = bool(light)
            if thumper is not None:
                state["thumper"] = bool(thumper)

            resolved = self.bridge.resolved()
            spec = resolved.get("deck_jets", {}).get(jet, {})
            changes: dict[str, dict[str, Any]] = {}
            if spec.get("water"):
                self._power(changes, spec["water"], state["on"])
            if spec.get("light"):
                self._power(changes, spec["light"], state["light"] and state["on"])
            if spec.get("thumper"):
                self._power(changes, spec["thumper"], state["thumper"] and state["on"])
            self._ensure_features_pump(changes)

        ok, msg = self._send(changes, "deck_jet_%s" % jet)
        return self._result(ok, "%s %s" % (FEATURE_LABELS[jet],
                                           "on" if state["on"] else "off"), msg)

    def set_firebasket(
        self,
        basket: str,
        on: bool | None = None,
        water: bool | None = None,
        spa_water: bool | None = None,
    ) -> dict[str, Any]:
        basket = basket if basket in FIREBASKET_LABELS else "east"
        with self.lock:
            state = self.state_data["firebaskets"][basket]
            if water is not None:
                state["water"] = bool(water)
            if spa_water is not None:
                state["spa_water"] = bool(spa_water)
            resolved = self.bridge.resolved()
            specs = resolved.get("firebaskets", {})
            spec = specs.get(basket, {})
            if on is not None:
                # Burners are separate from the spillways; baskets that share
                # a burner relay light and go out together.
                for other, other_spec in specs.items():
                    if other == basket or (spec.get("burner")
                                           and other_spec.get("burner") == spec.get("burner")):
                        self.state_data["firebaskets"][other]["on"] = bool(on)
                state["on"] = bool(on)

            changes: dict[str, dict[str, Any]] = {}
            if spec.get("water"):
                self._power(changes, spec["water"], state["water"])
            if spec.get("spa_water"):
                self._power(changes, spec["spa_water"], state["spa_water"])
            self._firebasket_outputs(changes, resolved)
            self._ensure_features_pump(changes)

        ok, msg = self._send(changes, "firebasket_%s" % basket)
        desc = []
        if state["on"]:
            desc.append("burner")
        if state["water"]:
            desc.append("pool spillway")
        if state["spa_water"]:
            desc.append("spa spillway")
        summary = " and ".join(desc) if desc else "off"
        return self._result(
            ok,
            "%s: %s" % (FIREBASKET_LABELS[basket], summary),
            msg,
        )

    def set_all_features(self, on: bool) -> dict[str, Any]:
        on = bool(on)
        with self.lock:
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            for jet in FEATURE_LABELS:
                state = self.state_data["deck_jets"][jet]
                state["on"] = on
                state["light"] = on
                if on:
                    state["thumper"] = True
                spec = resolved.get("deck_jets", {}).get(jet, {})
                for field in ("water", "light", "thumper"):
                    if spec.get(field):
                        self._power(changes, spec[field], on)
            for basket in FIREBASKET_LABELS:
                state = self.state_data["firebaskets"][basket]
                state.update({"on": on, "water": on, "spa_water": on})
                spec = resolved.get("firebaskets", {}).get(basket, {})
                for field in ("water", "spa_water"):
                    if spec.get(field):
                        self._power(changes, spec[field], on)
            self._firebasket_outputs(changes, resolved)
            self.state_data["blower"]["on"] = on
            blower = (resolved.get("blower") or {}).get("circuit")
            if blower:
                self._power(changes, blower, on)
            self._ensure_features_pump(changes)
        ok, msg = self._send(changes, "all_features_%s" % ("on" if on else "off"))
        return self._result(ok, "All water features %s" % ("on" if on else "off"), msg)

    def set_blower(self, on: bool) -> dict[str, Any]:
        on = bool(on)
        with self.lock:
            self.state_data["blower"]["on"] = on
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            target = (resolved.get("blower") or {}).get("circuit")
            if target:
                self._power(changes, target, on)
        ok, msg = self._send(changes, "blower_%s" % ("on" if on else "off"))
        return self._result(ok, "Blower %s" % ("on" if on else "off"), msg)

    def set_spillway_color(self, effect: str | None = None) -> dict[str, Any]:
        effect = str(effect or "BLUER").upper()
        if effect not in LIGHT_EFFECTS:
            return self._result(False, "Unknown spillway color: %s" % effect)
        with self.lock:
            self.state_data["spillway_effect"] = effect
            self.config.setdefault("defaults", {})["spillway_effect"] = effect
            self.save_config(self.config)
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            for basket, spec in resolved.get("firebaskets", {}).items():
                state = self.state_data["firebaskets"].get(basket, {})
                for field, flowing in (("spillway_pool_led", state.get("water")),
                                       ("spillway_spa_led", state.get("spa_water"))):
                    # Plain relays (e.g. AUX 6/7) are on/off only; no color.
                    if flowing and spec.get(field) and self._is_color_light(spec[field]):
                        self._power_led(changes, spec[field], True, effect)
        name = LIGHT_EFFECTS.get(effect, effect)
        ok, msg = self._send(changes, "spillway_color")
        return self._result(ok, "Spillway LEDs set to %s" % name, msg)

    # ------------------------------------------------------------------
    # Lights
    # ------------------------------------------------------------------
    def set_light(self, body: str, on: bool | None = None,
                  effect: str | None = None) -> dict[str, Any]:
        body = "spa" if str(body).lower() == "spa" else "pool"
        with self.lock:
            state = self.state_data["lights"][body]
            if effect:
                effect = str(effect).upper()
                if effect not in LIGHT_EFFECTS:
                    return self._result(False, "Unknown light effect: %s" % effect)
                state["effect"] = effect
            if on is not None:
                state["on"] = bool(on)
            resolved = self.bridge.resolved()
            target = resolved.get("lights", {}).get(body)
            changes: dict[str, dict[str, Any]] = {}
            if target:
                params = {"STATUS": "ON" if state["on"] else "OFF"}
                if state["on"]:
                    params["ACT"] = state["effect"]
                changes[target] = params
        name = LIGHT_EFFECTS.get(state["effect"], state["effect"])
        ok, msg = self._send(changes, "light_%s" % body)
        return self._result(ok, "%s light %s" % (
            body.capitalize(), "on - " + name if state["on"] else "off"), msg)

    def set_all_lights(self, on: bool | None = True,
                       effect: str | None = None) -> dict[str, Any]:
        """Set every color light at once, e.g. party mode or all blue."""
        if effect:
            effect = str(effect).upper()
            if effect not in LIGHT_EFFECTS:
                return self._result(False, "Unknown light effect: %s" % effect)
        with self.lock:
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            for body in ("pool", "spa"):
                state = self.state_data["lights"][body]
                if effect:
                    state["effect"] = effect
                if on is not None:
                    state["on"] = bool(on)
                target = resolved.get("lights", {}).get(body)
                if target:
                    params = {"STATUS": "ON" if state["on"] else "OFF"}
                    if state["on"]:
                        params["ACT"] = state["effect"]
                    changes[target] = params
            shown = self.state_data["lights"]["pool"]
        name = LIGHT_EFFECTS.get(shown["effect"], shown["effect"])
        ok, msg = self._send(changes, "all_lights")
        return self._result(ok, "All lights %s" % (
            "on - " + name if shown["on"] else "off"), msg)

    # ------------------------------------------------------------------
    # Heater
    # ------------------------------------------------------------------
    def set_heater(self, on: bool | None = None,
                   setpoint: int | None = None) -> dict[str, Any]:
        with self.lock:
            heater = self.state_data["heater"]
            if on is not None:
                heater["on"] = bool(on)
            relay = (self.bridge.resolved().get("heater") or {}).get("circuit")
            if setpoint is not None and not relay:
                value = max(40, min(104, int(setpoint)))
                heater["setpoint"] = value
                self.state_data["bodies"]["pool"]["setpoint"] = value
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            self._heater_changes(changes, resolved)
        ok, msg = self._send(changes, "heater")
        return self._result(ok, "Heater %s" % ("on" if heater["on"] else "off"), msg)

    def _heater_changes(self, changes: dict[str, dict[str, Any]],
                        resolved: dict[str, Any]) -> None:
        heater = self.state_data["heater"]
        relay = (resolved.get("heater") or {}).get("circuit")
        if relay:
            # On/off heater on a relay: just switch it; there is no thermostat.
            self._power(changes, relay, heater["on"])
            return
        mode = self.state_data["mode"]
        active = "spa" if mode == "spa" else "pool"
        active_body = resolved.get("bodies", {}).get(active)
        other_body = resolved.get("bodies", {}).get("pool" if active == "spa" else "spa")
        if active_body:
            if heater["on"]:
                mode_value = int(getattr(HeaterType, "HEATER", 2)) if HeaterType else 2
                changes.setdefault(active_body, {}).update({
                    "MODE": str(mode_value),
                    "LOTMP": str(heater["setpoint"]),
                })
            else:
                changes.setdefault(active_body, {}).update({"MODE": "1"})
        if heater["on"] and other_body:
            changes.setdefault(other_body, {}).update({"MODE": "1"})
        device = resolved.get("heater", {}).get("device")
        if device:
            self._power(changes, device, heater["on"])

    # ------------------------------------------------------------------
    # Schedule
    # ------------------------------------------------------------------
    def set_schedule(self, enabled: bool | None = None,
                     runs: list[dict] | None = None) -> dict[str, Any]:
        with self.lock:
            schedule = self.config.setdefault("schedule", {})
            if enabled is not None:
                schedule["enabled"] = bool(enabled)
            if isinstance(runs, list):
                cleaned = []
                for run in runs:
                    if not isinstance(run, dict):
                        continue
                    start = str(run.get("start", "08:00"))
                    end = str(run.get("end", "18:00"))
                    if not _valid_hhmm(start) or not _valid_hhmm(end):
                        continue
                    days = [d for d in run.get("days", DAY_NAMES)
                            if str(d).lower()[:3] in DAY_NAMES]
                    cleaned.append({
                        "name": str(run.get("name") or "Main VSR run"),
                        "days": [str(d).lower()[:3] for d in days] or DAY_NAMES,
                        "start": start,
                        "end": end,
                        "rpm": max(450, min(3450, int(run.get("rpm", self._default_rpm)))),
                    })
                schedule["runs"] = cleaned
            self.save_config(self.config)
            self._last_schedule_key = None
        return self._result(True, "Schedule saved")

    def _run_schedule(self) -> None:
        schedule = self.config.get("schedule", {})
        if not schedule.get("enabled", True):
            self._last_schedule_active = False
            return
        now = self._now()
        run = self._active_run(now)
        active = run is not None
        key = None
        if run:
            key = "%s|%s|%s|%s" % (
                run.get("name"), run.get("start"), run.get("end"), run.get("rpm")
            )
        if self._last_schedule_active is None:
            if active:
                self._schedule_on(run)
            elif schedule.get("apply_at_startup"):
                self._schedule_off()
            self._last_schedule_active = active
            self._last_schedule_key = key
            return
        if active != self._last_schedule_active or key != self._last_schedule_key:
            if active:
                self._schedule_on(run)
            else:
                self._schedule_off()
            self._last_schedule_active = active
            self._last_schedule_key = key

    def _schedule_on(self, run: dict[str, Any]) -> None:
        with self.lock:
            rpm = int(run.get("rpm", self._default_rpm))
            self.state_data["pumps"]["main"].update({"on": True, "rpm": rpm})
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            target = resolved.get("pumps", {}).get("main")
            if target:
                self._power(changes, target, True)
            program = resolved.get("pump_programs", {}).get("main")
            self._speed(changes, program, rpm)
        ok, msg = self._send(changes, "schedule_start")
        self._note("Schedule started main pump at %s RPM%s" % (
            rpm, "" if ok else " (simulation)"))

    def _schedule_off(self) -> None:
        with self.lock:
            self.state_data["pumps"]["main"]["on"] = False
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            target = resolved.get("pumps", {}).get("main")
            if target:
                self._power(changes, target, False)
        ok, msg = self._send(changes, "schedule_stop")
        self._note("Schedule stopped main pump%s" % ("" if ok else " (simulation)"))

    def _active_run(self, now: dt.datetime) -> dict[str, Any] | None:
        schedule = self.config.get("schedule", {})
        if not schedule.get("enabled", True):
            return None
        day = DAY_NAMES[now.weekday()]
        minutes = now.hour * 60 + now.minute
        for run in schedule.get("runs", []):
            days = [str(d).lower()[:3] for d in run.get("days", DAY_NAMES)]
            if day not in days:
                continue
            start = _hhmm_minutes(run.get("start", "00:00"))
            end = _hhmm_minutes(run.get("end", "00:00"))
            if start is None or end is None:
                continue
            if start <= end:
                if start <= minutes < end:
                    return run
            else:
                if minutes >= start or minutes < end:
                    return run
        return None

    def _next_run_text(self) -> str | None:
        schedule = self.config.get("schedule", {})
        if not schedule.get("enabled", True):
            return None
        now = self._now()
        best = None
        for offset in range(0, 8):
            day_dt = now + dt.timedelta(days=offset)
            day = DAY_NAMES[day_dt.weekday()]
            for run in schedule.get("runs", []):
                days = [str(d).lower()[:3] for d in run.get("days", DAY_NAMES)]
                if day not in days:
                    continue
                start = _hhmm_minutes(run.get("start", "00:00"))
                if start is None:
                    continue
                candidate = day_dt.replace(hour=start // 60, minute=start % 60,
                                           second=0, microsecond=0)
                if candidate <= now:
                    continue
                if best is None or candidate < best[0]:
                    best = (candidate, run)
        if not best:
            return None
        when, run = best
        return "%s %s (%s)" % (when.strftime("%a %I:%M %p"), run.get("name", "run"),
                               run.get("rpm", self._default_rpm))

    # ------------------------------------------------------------------
    # All off / panel merge
    # ------------------------------------------------------------------
    def system_off(self) -> dict[str, Any]:
        self.set_all_features(False)
        with self.lock:
            self.state_data["heater"]["on"] = False
            self.state_data["blower"]["on"] = False
            self.state_data["lights"]["pool"]["on"] = False
            self.state_data["lights"]["spa"]["on"] = False
            resolved = self.bridge.resolved()
            changes: dict[str, dict[str, Any]] = {}
            target = (resolved.get("blower") or {}).get("circuit")
            if target:
                self._power(changes, target, False)
            for body in ("pool", "spa"):
                target = resolved.get("lights", {}).get(body)
                if target:
                    self._power(changes, target, False)
            self._heater_changes(changes, resolved)
            for pump in ("main", "features"):
                self.state_data["pumps"][pump]["on"] = False
                target = resolved.get("pumps", {}).get(pump)
                if target:
                    self._power(changes, target, False)
        ok, msg = self._send(changes, "system_off")
        return self._result(ok, "All pool equipment off", msg)

    def _merge_panel_state(self) -> None:
        inventory = self.bridge.inventory()
        if not self.bridge.connected:
            return
        resolved = self.bridge.resolved()
        circuits = {o["objnam"]: o for o in inventory.get("circuits", [])}
        pumps = {o["objnam"]: o for o in inventory.get("pumps", [])}
        programs = {o["objnam"]: o for o in inventory.get("pump_circuits", [])}
        bodies = {o["objnam"]: o for o in inventory.get("bodies", [])}
        with self.lock:
            self._objtypes = {
                o["objnam"]: o["objtype"] for o in inventory.get("objects", [])
            }
            modes = resolved.get("modes", {})
            def on(objnam):
                return objnam and circuits.get(objnam, {}).get("status") == "ON"

            if on(modes.get("spa")):
                self.state_data["mode"] = "spa"
            elif on(modes.get("pool")):
                self.state_data["mode"] = "pool"

            for jet, spec in resolved.get("deck_jets", {}).items():
                state = self.state_data["deck_jets"].setdefault(
                    jet, {"on": False, "light": False, "thumper": True})
                if spec.get("water"):
                    state["on"] = on(spec["water"])
                if spec.get("light"):
                    state["light"] = on(spec["light"])
                if spec.get("thumper"):
                    state["thumper"] = on(spec["thumper"])

            for basket, spec in resolved.get("firebaskets", {}).items():
                state = self.state_data["firebaskets"].setdefault(
                    basket, {"on": False, "water": False, "spa_water": False,
                             "spillway_pool_led": False, "spillway_spa_led": False})
                if spec.get("water"):
                    state["water"] = on(spec["water"])
                if spec.get("spa_water"):
                    state["spa_water"] = on(spec["spa_water"])
                state["spillway_pool_led"] = state["water"]
                state["spillway_spa_led"] = state["spa_water"]
                state["on"] = bool(spec.get("burner") and on(spec["burner"]))

            blower = (resolved.get("blower") or {}).get("circuit")
            if blower:
                self.state_data["blower"]["on"] = on(blower)

            for body, objnam in resolved.get("lights", {}).items():
                state = self.state_data["lights"].setdefault(
                    body, {"on": False, "effect": "PARTY"})
                circuit = circuits.get(objnam)
                if circuit:
                    state["on"] = circuit.get("status") == "ON"
                    effect = circuit["attrs"].get("USE") or circuit["attrs"].get("ACT")
                    if effect in LIGHT_EFFECTS:
                        state["effect"] = effect

            for pump in ("main", "features"):
                objnam = resolved.get("pumps", {}).get(pump)
                pump_obj = pumps.get(objnam)
                if pump_obj:
                    self.state_data["pumps"][pump]["on"] = (
                        pump_obj.get("status") == "10"
                        or pump_obj["attrs"].get("STATUS") == "10"
                    )
                program = programs.get(resolved.get("pump_programs", {}).get(pump))
                if program:
                    speed = program["attrs"].get("SPEED")
                    try:
                        if speed:
                            self.state_data["pumps"][pump]["rpm"] = int(speed)
                    except (TypeError, ValueError):
                        pass

            for body in ("pool", "spa"):
                objnam = resolved.get("bodies", {}).get(body)
                body_obj = bodies.get(objnam)
                if not body_obj:
                    continue
                attrs = body_obj["attrs"]
                state = self.state_data["bodies"][body]
                for key, attr in (("temp", "TEMP"), ("setpoint", "LOTMP")):
                    try:
                        if attrs.get(attr) not in (None, ""):
                            state[key] = int(attrs[attr])
                    except (TypeError, ValueError):
                        pass
                state["heating"] = attrs.get("HTMODE") not in (None, "0", "", "OFF")

            chemistry = inventory.get("chemistry", [])
            salt = None
            for chem in chemistry:
                value = chem.get("attrs", {}).get("SALT")
                if value not in (None, ""):
                    try:
                        salt = int(float(value))
                        break
                    except (TypeError, ValueError):
                        pass
            if salt is not None:
                self.state_data["chemistry"] = {"salt": salt, "source": "panel"}

            active_body = "spa" if self.state_data["mode"] == "spa" else "pool"
            body_objnam = resolved.get("bodies", {}).get(active_body)
            body_obj = bodies.get(body_objnam)
            heater_relay = (resolved.get("heater") or {}).get("circuit")
            if heater_relay:
                self.state_data["heater"]["on"] = bool(on(heater_relay))
            elif body_obj:
                mode = body_obj["attrs"].get("MODE")
                self.state_data["heater"]["on"] = mode not in (None, "0", "1", "")
                try:
                    sp = body_obj["attrs"].get("LOTMP")
                    if sp not in (None, ""):
                        self.state_data["heater"]["setpoint"] = int(sp)
                except (TypeError, ValueError):
                    pass

            if any(j["on"] for j in self.state_data["deck_jets"].values()) or any(
                    f.get("water") or f.get("spa_water")
                    for f in self.state_data["firebaskets"].values()):
                self.state_data["pumps"]["features"]["on"] = True

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _power(self, changes: dict[str, dict[str, Any]], objnam: str,
               on: bool) -> None:
        if not objnam:
            return
        objtype = self._objtypes.get(objnam)
        pumps = (self.bridge.resolved().get("pumps") or {}).values()
        if objtype == "PUMP" or objnam in pumps:
            # IntelliCenter rejects STATUS writes to pumps (error 404); pumps
            # run automatically whenever a circuit they serve is on.
            return
        changes.setdefault(objnam, {})["STATUS"] = "ON" if on else "OFF"

    def _power_led(self, changes: dict[str, dict[str, Any]], objnam: str,
                   on: bool, effect: str | None = None) -> None:
        if not objnam:
            return
        params = changes.setdefault(objnam, {})
        params["STATUS"] = "ON" if on else "OFF"
        if on and effect:
            params["ACT"] = effect

    def _speed(self, changes: dict[str, dict[str, Any]], objnam: str | None,
               rpm: int) -> None:
        if not objnam:
            return
        params = changes.setdefault(objnam, {})
        params["SELECT"] = "RPM"
        params["SPEED"] = str(int(rpm))

    def _send(self, changes: dict[str, dict[str, Any]],
              reason: str) -> tuple[bool, str]:
        if not changes:
            return True, "no panel mappings; logical state only"
        return self.bridge.write(changes, reason)

    def _result(self, ok: bool, message: str,
                detail: str | None = None) -> dict[str, Any]:
        if ok:
            self._note(message)
        else:
            self._note(message + (": " + detail if detail else ""))
        return {
            "ok": bool(ok),
            "message": message if ok else message + (": " + detail if detail else ""),
            "detail": detail,
            "state": self.state(),
        }

    def _note(self, message: str) -> None:
        self._last_message = message
        self._last_message_at = time.time()
        LOG.info(message)

    def _now(self) -> dt.datetime:
        tzname = self.config.get("timezone")
        try:
            tz = ZoneInfo(tzname) if tzname else None
        except Exception:
            tz = None
        return dt.datetime.now(tz)


def _valid_hhmm(value: str) -> bool:
    return _hhmm_minutes(value) is not None


def _hhmm_minutes(value: Any) -> int | None:
    try:
        parts = str(value).split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError):
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute
