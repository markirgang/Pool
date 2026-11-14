#!/usr/bin/env python3
"""Alexa Smart Home directive handler for the Pool controller.

Expose the endpoint at ``POST /alexa`` and point an Alexa Smart Home skill at
``https://pool.shobots.party/alexa``. No vendor cloud is involved: Alexa calls
the Cloudflare-protected Pi endpoint directly.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

MANUFACTURER = "Shobots"
DESCRIPTION_PREFIX = "Shobots Pool"

POWER = {
    "type": "AlexaInterface",
    "interface": "Alexa.PowerController",
    "version": "3",
    "properties": {
        "supported": [{"name": "powerState"}],
        "proactivelyReported": False,
        "retrievable": True,
    },
}
COLOR = {
    "type": "AlexaInterface",
    "interface": "Alexa.ColorController",
    "version": "3",
    "properties": {
        "supported": [{"name": "color"}],
        "proactivelyReported": False,
        "retrievable": True,
    },
}
THERMOSTAT = {
    "type": "AlexaInterface",
    "interface": "Alexa.ThermostatController",
    "version": "3",
    "properties": {
        "supported": [{"name": "targetSetpoint"}, {"name": "thermostatMode"}],
        "proactivelyReported": False,
        "retrievable": True,
    },
}
TEMPERATURE = {
    "type": "AlexaInterface",
    "interface": "Alexa.TemperatureSensor",
    "version": "3",
    "properties": {
        "supported": [{"name": "temperature"}],
        "proactivelyReported": False,
        "retrievable": True,
    },
}
ALEXA_INTERFACE = {"type": "AlexaInterface", "interface": "Alexa", "version": "3"}


def _endpoint(endpoint_id: str, name: str, category: str, capabilities: list,
              description: str) -> dict[str, Any]:
    return {
        "endpointId": endpoint_id,
        "manufacturerName": MANUFACTURER,
        "friendlyName": name,
        "description": description,
        "displayCategories": [category],
        "cookie": {},
        "capabilities": capabilities + [ALEXA_INTERFACE],
    }


def _endpoints() -> list[dict[str, Any]]:
    endpoints = [
        _endpoint("pool_mode", "Pool Mode", "SWITCH", [POWER],
                  "Switches the pool between pool mode and spa mode"),
        _endpoint("spa_mode", "Spa Mode", "SWITCH", [POWER],
                  "Switches the pool between spa mode and pool mode"),
        _endpoint("all_features", "All Water Features", "SWITCH", [POWER],
                  "All four floor jets, both firebaskets and the spa blower"),
        _endpoint("main_pump", "Main Pool Pump", "SWITCH", [POWER],
                  "Main variable speed pool and spa pump"),
        _endpoint("features_pump", "Water Features Pump", "SWITCH", [POWER],
                  "Secondary variable speed water feature pump"),
        _endpoint("pool_light", "Pool Light", "LIGHT", [POWER, COLOR],
                  "Pentair color LED pool light"),
        _endpoint("spa_light", "Spa Light", "LIGHT", [POWER, COLOR],
                  "Pentair color LED spa light"),
        _endpoint("pool_heater", "Pool Heater", "SWITCH", [POWER], "Pool heater"),
    ]
    for jet, label in (("ne", "NE Floor Jet"), ("nw", "NW Floor Jet"),
                       ("se", "SE Floor Jet"), ("sw", "SW Floor Jet")):
        endpoints.append(_endpoint("deck_jet_%s" % jet, label, "SWITCH", [POWER],
                                   "Laminar floor jet"))
    for basket, label in (("east", "East Firebasket"), ("west", "West Firebasket")):
        endpoints.append(_endpoint("firebasket_%s" % basket, label, "SWITCH", [POWER],
                                   "Firebasket with pool and spa fountains"))
    endpoints.append(_endpoint("spa_blower", "Blower", "SWITCH", [POWER],
                               "Blower"))
    return endpoints


def _header(namespace: str, name: str, message_id: str | None = None) -> dict:
    return {
        "namespace": namespace,
        "name": name,
        "payloadVersion": "3",
        "messageId": message_id or str(uuid.uuid4()),
    }


def _property(namespace: str, name: str, value: Any) -> dict:
    return {
        "namespace": namespace,
        "name": name,
        "value": value,
        "timeOfSample": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uncertaintyInMilliseconds": 500,
    }


def _response(request: dict[str, Any], name: str = "Response",
              payload: dict | None = None, properties: list | None = None) -> dict:
    event = {
        "header": _header("Alexa", name),
        "payload": payload or {},
    }
    result = {"event": event}
    if properties is not None:
        result["context"] = {"properties": properties}
    return result


def _power_state(endpoint_id: str, state: dict[str, Any]) -> str:
    mode = state.get("mode")
    if endpoint_id == "pool_mode":
        return "ON" if mode == "pool" else "OFF"
    if endpoint_id == "spa_mode":
        return "ON" if mode == "spa" else "OFF"
    if endpoint_id == "main_pump":
        return "ON" if state["pumps"]["main"]["on"] else "OFF"
    if endpoint_id == "features_pump":
        return "ON" if state["pumps"]["features"]["on"] else "OFF"
    if endpoint_id == "all_features":
        on = any(j["on"] for j in state["deck_jets"].values()) or any(
            f["on"] for f in state["firebaskets"].values()
        ) or (state.get("blower") or {}).get("on")
        return "ON" if on else "OFF"
    if endpoint_id.startswith("deck_jet_"):
        jet = endpoint_id.rsplit("_", 1)[1]
        return "ON" if state["deck_jets"].get(jet, {}).get("on") else "OFF"
    if endpoint_id.startswith("firebasket_"):
        basket = endpoint_id.rsplit("_", 1)[1]
        return "ON" if state["firebaskets"].get(basket, {}).get("on") else "OFF"
    if endpoint_id == "spa_blower":
        return "ON" if (state.get("blower") or {}).get("on") else "OFF"
    if endpoint_id.endswith("_light"):
        body = endpoint_id.split("_", 1)[0]
        return "ON" if state["lights"].get(body, {}).get("on") else "OFF"
    if endpoint_id == "pool_heater":
        return "ON" if state["heater"]["on"] else "OFF"
    return "OFF"


def _properties(endpoint_id: str, state: dict[str, Any]) -> list[dict]:
    props = [_property("Alexa.PowerController", "powerState",
                       _power_state(endpoint_id, state))]
    if endpoint_id == "pool_heater":
        temperature = state["bodies"].get("pool", {}).get("temp")
        props = [
            _property("Alexa.ThermostatController", "targetSetpoint",
                      {"value": state["heater"]["setpoint"], "scale": "FAHRENHEIT"}),
            _property("Alexa.ThermostatController", "thermostatMode",
                      {"value": "HEAT" if state["heater"]["on"] else "OFF"}),
            _property("Alexa.TemperatureSensor", "temperature",
                      {"value": temperature if temperature is not None else 0,
                       "scale": "FAHRENHEIT"}),
        ]
    return props


def _effect_from_color(color: dict[str, Any]) -> str:
    try:
        hue = float(color.get("hue", 0)) % 360
        sat = float(color.get("saturation", 1))
    except (TypeError, ValueError):
        return "PARTY"
    if sat < 0.15:
        return "WHITER"
    if hue < 20 or hue >= 340:
        return "REDR"
    if hue < 45:
        return "REDR"
    if hue < 70:
        return "SSET"
    if hue < 160:
        return "GREENR"
    if hue < 200:
        return "CARIB"
    if hue < 260:
        return "BLUER"
    if hue < 300:
        return "ROYAL"
    return "MAGNTAR"


def _run(command, state, **kwargs) -> dict:
    try:
        return command(**kwargs)
    except Exception:
        return {"ok": False, "state": state, "message": "command failed"}


def handle_request(request: dict[str, Any], controller: Any) -> dict[str, Any]:
    directive = request.get("directive") or request
    header = directive.get("header") or {}
    namespace = header.get("namespace")
    name = header.get("name")
    endpoint = (directive.get("endpoint") or {}).get("endpointId", "")
    payload = directive.get("payload") or {}
    state = controller.state()

    if namespace == "Alexa.Discovery" and name == "Discover":
        return _response(request, "Discover.Response",
                         {"endpoints": _endpoints()})

    if namespace == "Alexa" and name in ("ReportState", "StateReport"):
        return _response(request, "StateReport", {},
                         _properties(endpoint, state))

    if namespace == "Alexa.PowerController":
        on = name == "TurnOn"
        result = _handle_power(endpoint, on, controller)
        state = result.get("state", state)
        return _response(request, payload={}, properties=_properties(endpoint, state))

    if namespace == "Alexa.ColorController" and name == "SetColor":
        body = endpoint.split("_", 1)[0] if endpoint.endswith("_light") else "pool"
        effect = _effect_from_color(payload.get("color") or {})
        result = controller.command("set_light", {
            "body": body, "on": True, "effect": effect,
        })
        state = result.get("state", state)
        props = _properties(endpoint, state)
        props.append(_property("Alexa.ColorController", "color", {
            "hue": 0, "saturation": 0, "brightness": 1,
        }))
        return _response(request, payload={}, properties=props)

    if namespace == "Alexa.ThermostatController":
        if name == "SetTargetTemperature":
            target = payload.get("targetSetpoint") or {}
            value = target.get("value")
            result = controller.command("set_heater", {"setpoint": value})
        elif name == "AdjustTargetTemperature":
            delta = (payload.get("targetSetpointDelta") or {}).get("value", 0)
            result = controller.command("set_heater", {
                "setpoint": state["heater"]["setpoint"] + float(delta or 0),
            })
        elif name == "SetThermostatMode":
            mode = str((payload.get("thermostatMode") or {}).get("value", "OFF")).upper()
            result = controller.command("set_heater", {"on": mode == "HEAT"})
        else:
            result = {"ok": False, "state": state}
        state = result.get("state", state)
        return _response(request, payload={}, properties=_properties(endpoint, state))

    return {
        "event": {
            "header": _header("Alexa", "ErrorResponse"),
            "payload": {
                "type": "INVALID_DIRECTIVE",
                "message": "Unsupported directive: %s/%s" % (namespace, name),
            },
        }
    }


def _handle_power(endpoint: str, on: bool, controller: Any) -> dict:
    if endpoint == "pool_mode":
        return controller.command("set_mode", {"mode": "pool" if on else "spa"})
    if endpoint == "spa_mode":
        return controller.command("set_mode", {"mode": "spa" if on else "pool"})
    if endpoint == "all_features":
        return controller.command("set_all_features", {"on": on})
    if endpoint == "main_pump":
        return controller.command("set_pump", {"pump": "main", "on": on})
    if endpoint == "features_pump":
        return controller.command("set_pump", {"pump": "features", "on": on})
    if endpoint.startswith("deck_jet_"):
        return controller.command("set_deck_jet", {
            "id": endpoint.rsplit("_", 1)[1], "on": on,
        })
    if endpoint.startswith("firebasket_"):
        return controller.command("set_firebasket", {
            "id": endpoint.rsplit("_", 1)[1], "on": on,
        })
    if endpoint == "spa_blower":
        return controller.command("set_blower", {"on": on})
    if endpoint.endswith("_light"):
        return controller.command("set_light", {
            "body": endpoint.split("_", 1)[0], "on": on,
        })
    if endpoint == "pool_heater":
        return controller.command("set_heater", {"on": on})
    return {"ok": False}


def alexa_devices_preview(controller: Any) -> dict[str, Any]:
    """Return a browser-friendly inventory of the Alexa endpoints."""
    state = controller.state()
    return {
        "skill": "Shobots Pool",
        "endpoint": "/alexa",
        "devices": [
            {
                "endpointId": endpoint["endpointId"],
                "friendlyName": endpoint["friendlyName"],
                "category": endpoint["displayCategories"][0],
                "state": _power_state(endpoint["endpointId"], state),
            }
            for endpoint in _endpoints()
        ],
    }
