#!/usr/bin/env python3
"""IntelliCenter equipment and wiring report.

Builds, from the live panel inventory, a list of every device grouped by
kind (relays, lights, water features and firepits, valves, pumps, heater
and chemistry, sensors, panel hardware) with the physical output it is
connected to as reported by the panel, plus how the pool app uses it.

Only what the panel reports is shown; nothing is inferred about wiring.
"""

from __future__ import annotations

import datetime as dt
import html
from typing import Any

MODULE_TYPES = {
    "I5P": "i5P personality board",
    "I5PS": "i5PS personality board",
    "I8P": "i8P personality board",
    "I8PS": "i8PS personality board",
    "I10P": "i10P personality board",
    "I10PS": "i10PS personality board",
    "I10X": "i10X expansion board",
    "VALVEXP": "valve expansion module",
}
LIGHT_SUBTYPES = {"INTELLI", "LIGHT", "GLOW", "GLOWT", "MAGIC2", "CLRCASC", "SAML",
                  "SAMMOD", "PHOTON", "COLORW", "DIMMER"}
PUMP_TYPES = {"SPEED": "IntelliFlo VS", "VSF": "IntelliFlo VSF", "FLOW": "IntelliFlo VF",
              "SINGLE": "Single-speed", "DUAL": "Two-speed"}
SENSOR_TYPES = {"POOL": "Water temperature", "SOLAR": "Solar temperature",
                "AIR": "Air temperature"}


def _attr(obj: dict[str, Any], key: str) -> str:
    return str((obj.get("attrs") or {}).get(key) or "").strip()


def _parent(obj: dict[str, Any]) -> str:
    value = _attr(obj, "PARENT")
    return "" if value in ("", "00000") else value


def _app_roles(resolved: dict[str, Any]) -> dict[str, list[str]]:
    roles: dict[str, list[str]] = {}

    def add(objnam: Any, label: str) -> None:
        if objnam:
            roles.setdefault(str(objnam), []).append(label)

    for key, objnam in (resolved.get("bodies") or {}).items():
        add(objnam, "%s water body" % key.capitalize())
    for key, objnam in (resolved.get("modes") or {}).items():
        add(objnam, "%s mode" % key.capitalize())
    for key, objnam in (resolved.get("pumps") or {}).items():
        add(objnam, "Main pump" if key == "main" else "Water features pump")
    for key, objnam in (resolved.get("pump_programs") or {}).items():
        add(objnam, "%s pump speed setting" % ("Main" if key == "main" else "Features"))
    for jet, spec in (resolved.get("deck_jets") or {}).items():
        for field, objnam in (spec or {}).items():
            add(objnam, "%s floor jet%s" % (jet.upper(), "" if field == "water" else " " + field))
    for basket, spec in (resolved.get("firebaskets") or {}).items():
        labels = {"water": "pool spillway", "spa_water": "spa spillway", "burner": "burner",
                  "spillway_pool_led": "pool spillway light",
                  "spillway_spa_led": "spa spillway light"}
        for field, objnam in (spec or {}).items():
            add(objnam, "%s firepit - %s" % (basket.capitalize(), labels.get(field, field)))
    add((resolved.get("blower") or {}).get("circuit"), "Spa blower")
    for body, objnam in (resolved.get("lights") or {}).items():
        add(objnam, "%s light" % body.capitalize())
    heater = resolved.get("heater") or {}
    add(heater.get("circuit"), "Heater (on/off)")
    add(heater.get("device"), "Heater")
    for key, objnam in (resolved.get("valves") or {}).items():
        add(objnam, "Pool/spa %s valve" % ("intake" if key == "drain" else key))
    return roles


def build(inventory: dict[str, Any], resolved: dict[str, Any],
          connection: dict[str, Any] | None = None) -> dict[str, Any]:
    objects = inventory.get("objects") or []
    by_id = {o["objnam"]: o for o in objects}
    roles = _app_roles(resolved or {})

    def name(objnam: str) -> str:
        obj = by_id.get(objnam)
        return (obj.get("name") or objnam) if obj else objnam

    def module_text(objnam: str) -> str:
        module = by_id.get(objnam)
        if not module:
            return objnam
        kind = MODULE_TYPES.get(str(module.get("subtype") or "").upper(),
                                str(module.get("subtype") or "module"))
        return "%s (%s)" % (objnam, kind)

    # Cross references
    valves_for: dict[str, list[str]] = {}
    for valve in (o for o in objects if o["objtype"] == "VALVE"):
        circuit = _attr(valve, "CIRCUIT")
        if circuit:
            valves_for.setdefault(circuit, []).append(
                "%s %s" % (valve["objnam"], valve.get("name") or ""))
    pump_runs: dict[str, list[str]] = {}
    programs_for: dict[str, list[str]] = {}
    for prog in (o for o in objects if o["objtype"] == "PMPCIRC"):
        pump, circuit = _attr(prog, "PARENT"), _attr(prog, "CIRCUIT")
        unit = "RPM" if _attr(prog, "SELECT").upper() == "RPM" else "GPM"
        speed = "%s %s" % (_attr(prog, "SPEED") or "?", unit)
        if circuit:
            pump_runs.setdefault(circuit, []).append("%s at %s" % (name(pump), speed))
            programs_for.setdefault(pump, []).append("%s: %s" % (name(circuit), speed))
    buttons_for: dict[str, list[str]] = {}
    for btn in (o for o in objects if o["objtype"] == "REMBTN"):
        circuit = _attr(btn, "CIRCUIT")
        if circuit and circuit != "00000":
            remote = _attr(btn, "PARENT")
            number = btn["objnam"][-1:]
            buttons_for.setdefault(circuit, []).append("%s button %s" % (name(remote), number))
    schedules_for: dict[str, list[str]] = {}
    for sched in (o for o in objects if o["objtype"] == "SCHED"):
        circuit = _attr(sched, "CIRCUIT")
        if circuit:
            schedules_for.setdefault(circuit, []).append("schedule \"%s\"" % (sched.get("name") or sched["objnam"]))

    def links(objnam: str) -> list[str]:
        notes = []
        if valves_for.get(objnam):
            notes.append("Opens valve " + ", ".join(valves_for[objnam]))
        if pump_runs.get(objnam):
            notes.append("Runs " + ", ".join(pump_runs[objnam]))
        if buttons_for.get(objnam):
            notes.append("Controlled by " + ", ".join(buttons_for[objnam]))
        if schedules_for.get(objnam):
            notes.append("On " + ", ".join(schedules_for[objnam]))
        return notes

    def row(obj: dict[str, Any], output: str, kind: str, notes: list[str] | None = None) -> dict[str, Any]:
        status = obj.get("status")
        if obj["objtype"] == "PUMP":  # pumps report 10 when running, 4 when off
            status = {"10": "ON", "4": "OFF"}.get(str(status), status)
        return {
            "id": obj["objnam"],
            "name": obj.get("name") or obj["objnam"],
            "type": kind,
            "output": output,
            "status": "" if status in (None, "PERMIT") else str(status),
            "app": ", ".join(roles.get(obj["objnam"], [])),
            "notes": (notes or []) + links(obj["objnam"]),
        }

    def relay_output(obj: dict[str, Any]) -> str:
        parent = _parent(obj)
        relay = _attr(obj, "HNAME") or obj["objnam"]
        return "%s relay on %s" % (relay, module_text(parent)) if parent else ""

    circuits = [o for o in objects if o["objtype"] == "CIRCUIT"]
    relays, lights, features, virtual = [], [], [], []
    for c in circuits:
        sub = str(c.get("subtype") or "").upper()
        if _parent(c):
            kind = {"POOL": "Pool body circuit", "SPA": "Spa body circuit"}.get(sub, "Relay circuit (%s)" % sub.lower())
            (lights if sub in LIGHT_SUBTYPES else relays).append(
                row(c, relay_output(c), "Color light (%s)" % sub if sub in LIGHT_SUBTYPES else kind))
        elif c["objnam"].startswith("FTR"):
            features.append(row(c, "No relay of its own (feature circuit)", "Water feature"))
        else:
            label = {"ALL": "Light group button", "FRZ": "Freeze protection"}.get(sub, "Panel button / virtual circuit")
            virtual.append(row(c, "None (virtual)", label))

    valves = [row(v, "Valve port %s on %s" % (_attr(v, "HNAME") or v["objnam"], module_text(_parent(v)))
                  if _parent(v) else _attr(v, "HNAME"),
                  "Valve actuator (%s)" % str(v.get("subtype") or "").lower(),
                  ["Driven by %s (%s)" % (name(_attr(v, "CIRCUIT")), _attr(v, "CIRCUIT"))]
                  if _attr(v, "CIRCUIT") else [])
              for v in objects if v["objtype"] == "VALVE"]

    pumps = []
    for p in (o for o in objects if o["objtype"] == "PUMP"):
        kind = PUMP_TYPES.get(str(p.get("subtype") or "").upper(), str(p.get("subtype") or "Pump"))
        live = "%s RPM, %s GPM, %s W" % (_attr(p, "RPM") or "0", _attr(p, "GPM") or "0", _attr(p, "PWR") or "0")
        notes = ["Now: " + live, "Range %s-%s RPM" % (_attr(p, "MIN") or "?", _attr(p, "MAX") or "?")]
        notes += ["Speed for " + s for s in programs_for.get(p["objnam"], [])]
        pumps.append(row(p, "Communication cable to the panel (not a relay)", kind, notes))

    heat_chem = []
    for h in (o for o in objects if o["objtype"] == "HEATER"):
        parent = _parent(h)
        heat_chem.append(row(h, "Assigned to %s" % module_text(parent) if parent else "",
                             "Heater (%s)" % str(h.get("subtype") or "").lower()))
    for c in (o for o in objects if o["objtype"] == "CHEM"):
        notes = ["Salt %s ppm" % _attr(c, "SALT")] if _attr(c, "SALT") else []
        bodies = [name(b) for b in _attr(c, "BODY").split()]
        if bodies:
            notes.append("Serves " + " and ".join(bodies))
        heat_chem.append(row(c, "Communication cable to the panel (not a relay)", "Salt chlorinator (%s)" % str(c.get("subtype") or "").lower(), notes))

    sensors = [row(s, "Temperature sensor input",
                   SENSOR_TYPES.get(str(s.get("subtype") or "").upper(), "Sensor"))
               for s in objects if s["objtype"] == "SENSE"]

    hardware = []
    for p in (o for o in objects if o["objtype"] == "PANEL"):
        hardware.append(row(p, "Load center", "Panel (%s)" % str(p.get("subtype") or "").lower()))
    for m in (o for o in objects if o["objtype"] == "MODULE"):
        kind = MODULE_TYPES.get(str(m.get("subtype") or "").upper(), str(m.get("subtype") or "Module"))
        children = [o["objnam"] for o in objects if _parent(o) == m["objnam"]]
        notes = ["Firmware %s" % _attr(m, "VER")] if _attr(m, "VER") else []
        if children:
            notes.append("Connected: " + ", ".join("%s %s" % (c, name(c)) for c in sorted(children)))
        hardware.append(row(m, "In %s" % (_parent(m) or "panel"), kind[:1].upper() + kind[1:], notes))
    for r in (o for o in objects if o["objtype"] == "REMOTE"):
        buttons = [b for b in objects if b["objtype"] == "REMBTN" and _parent(b) == r["objnam"]]
        notes = ["Button %s: %s" % (b["objnam"][-1:], name(_attr(b, "CIRCUIT")))
                 for b in sorted(buttons, key=lambda b: b["objnam"])
                 if _attr(b, "CIRCUIT") not in ("", "00000")]
        hardware.append(row(r, "Remote on panel bus", "Spa-side remote (%s)" % str(r.get("subtype") or "").lower(), notes))
    for x in (o for o in objects if o["objtype"] == "EXTINSTR"):
        body = name(_attr(x, "BODY")) if _attr(x, "BODY") else ""
        hardware.append(row(x, "Input on %s" % (_parent(x) or "panel"),
                            "%s input" % str(x.get("subtype") or "").capitalize(),
                            ["For %s" % body] if body else []))

    def by_output(rows):
        return sorted(rows, key=lambda r: (r["output"], r["name"].lower()))

    sections = [
        {"title": "Relays (Pool, Spa and AUX outputs)", "rows": by_output(relays)},
        {"title": "Lights", "rows": by_output(lights)},
        {"title": "Water features and firepits", "rows": sorted(features, key=lambda r: r["name"].lower())},
        {"title": "Valves", "rows": sorted(valves, key=lambda r: r["id"])},
        {"title": "Pumps", "rows": pumps},
        {"title": "Heater and chemistry", "rows": heat_chem},
        {"title": "Sensors", "rows": sensors},
        {"title": "Panel, modules and remotes", "rows": hardware},
        {"title": "Panel buttons and virtual circuits (no physical output)",
         "rows": sorted(virtual, key=lambda r: r["name"].lower())},
    ]
    system = inventory.get("system") or {}
    return {
        "panel": system.get("name") or "IntelliCenter",
        "version": system.get("version") or "",
        "host": (connection or {}).get("host") or "",
        "connected": bool((connection or {}).get("connected")),
        "generated": dt.datetime.now().strftime("%B %d, %Y %I:%M %p"),
        "sections": [s for s in sections if s["rows"]],
        "total": sum(len(s["rows"]) for s in sections),
    }


def render_tables(report: dict[str, Any]) -> str:
    e = html.escape
    parts = []
    for section in report["sections"]:
        parts.append('<section class="wiring-section"><h3>%s <span class="wiring-count">%d</span></h3>'
                     % (e(section["title"]), len(section["rows"])))
        parts.append('<table class="wiring-table"><thead><tr><th>Device</th><th>Type</th>'
                     '<th>Connected to (IntelliCenter output)</th><th>Status</th>'
                     '<th>Used in app as</th><th>Details</th></tr></thead><tbody>')
        for r in section["rows"]:
            notes = "".join("<div>%s</div>" % e(n) for n in r["notes"])
            parts.append(
                '<tr><td><strong>%s</strong><div class="wiring-id">%s</div></td><td>%s</td>'
                '<td>%s</td><td>%s</td><td>%s</td><td class="wiring-notes">%s</td></tr>'
                % (e(r["name"]), e(r["id"]), e(r["type"]), e(r["output"] or "-"),
                   e(r["status"] or "-"), e(r["app"] or "-"), notes or "-"))
        parts.append("</tbody></table></section>")
    return "".join(parts)


PRINT_PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111;
         margin: 24px; font-size: 12px; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
           border-bottom: 2px solid #0b6e7f; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h3 { font-size: 14px; margin: 18px 0 6px; color: #0b6e7f; }
  .meta { color: #444; line-height: 1.5; }
  .wiring-count { color: #666; font-weight: normal; font-size: 12px; }
  table { width: 100%%; border-collapse: collapse; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { border: 1px solid #c8d3d6; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #e8f3f5; font-size: 11px; }
  .wiring-id { color: #666; font-size: 10px; font-family: monospace; }
  td:first-child { white-space: nowrap; }
  .wiring-notes div + div { margin-top: 2px; }
  button { font-size: 14px; padding: 8px 14px; cursor: pointer; }
  @media print { .no-print { display: none; } body { margin: 0; } @page { margin: 12mm; size: landscape; } }
</style></head><body>
<header>
  <div><h1>%(title)s</h1>
  <div class="meta">%(subtitle)s</div></div>
  <div class="no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
</header>
%(tables)s
<script>if (location.search.indexOf("print=1") !== -1) window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });</script>
</body></html>"""


def render_page(report: dict[str, Any], site_name: str = "Lighthouse Pool") -> str:
    e = html.escape
    subtitle = "%s &middot; %d devices &middot; Panel %s%s%s &middot; Generated %s" % (
        e(report["panel"]), report["total"],
        e(report["host"]) or "not connected",
        " (firmware %s)" % e(report["version"]) if report["version"] else "",
        "" if report["connected"] else " &middot; <b>panel offline: showing last known data</b>",
        e(report["generated"]))
    return PRINT_PAGE % {
        "title": e("%s - IntelliCenter Equipment & Wiring" % site_name),
        "subtitle": subtitle,
        "tables": render_tables(report),
    }
