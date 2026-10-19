from typing import Any

from protocol import safe_text


def value(source: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(source, dict) and name in source:
            return source[name]
        if hasattr(source, name):
            return getattr(source, name)
    return default


def as_list(value_source: Any) -> list[Any]:
    if isinstance(value_source, dict):
        return list(value_source.values())
    if isinstance(value_source, (list, tuple, set)):
        return list(value_source)
    return []


def as_bool(value_source: Any, default: bool = True) -> bool:
    if isinstance(value_source, bool):
        return value_source
    normalized = safe_text(value_source).lower()
    if normalized in {"true", "on", "online", "yes", "1", "available"}:
        return True
    if normalized in {"false", "off", "offline", "no", "0", "unavailable"}:
        return False
    return default


def category_for(device: Any) -> str:
    fields = [value(device, key, default="") for key in ("kind", "type", "product", "productType", "deviceType", "category", "role")]
    joined = " ".join(safe_text(field).lower() for field in fields)
    if any(term in joined for term in ("hub", "bridge", "gateway", "receiver")) and "heating" not in joined:
        return "infrastructure"
    if "water" in joined and "heat" in joined:
        return "hot_water"
    if any(term in joined for term in ("heat", "thermostat", "radiator", "trv", "climate", "boiler")):
        return "heating"
    if "light" in joined:
        return "light"
    if "plug" in joined or "switch" in joined:
        return "switch"
    if "sensor" in joined or "motion" in joined or "contact" in joined:
        return "sensor"
    return "unknown"


def map_device(device: Any) -> dict[str, Any]:
    state = value(device, "status", "state", default={})
    if not isinstance(state, dict):
        state = {}
    kind = category_for(device)
    cloud_id = safe_text(value(device, "cloudId", "hiveID", "device_id", "deviceId", "id", "zone_id", "zoneId", default=""))
    device_data = value(device, "deviceData", default={})
    if not isinstance(device_data, dict):
        device_data = {}
    online_value = value(device, "online", "available", default=value(device_data, "online", default=value(state, "online", default=True)))
    return {
        "cloudId": cloud_id,
        "parentId": safe_text(value(device, "parent_id", "parentId", "parentDevice", default="")) or None,
        "kind": kind,
        "role": safe_text(value(device, "role", "hiveType", "device_type", "deviceType", default="")) or None,
        "name": safe_text(value(device, "name", "hiveName", "haName", "name_by_user", "label", "zoneName", default="")),
        "manufacturer": "Hive",
        "model": safe_text(value(device, "model", "hiveType", "product", "product_type", "productType", default="")) or None,
        "online": as_bool(online_value),
        "capabilities": ["mode", "target_temperature", "current_temperature"] if kind == "heating" else [],
        "state": {
            "mode": safe_text(value(state, "mode", "hvac_mode", "system_mode", default="UNKNOWN")),
            "action": value(state, "action", "heating", "isHeating", default=value(state, "working", default=None)),
            "currentTemperature": value(state, "current_temperature", "currentTemperature", "current_temp", "temperature", default=None),
            "targetTemperature": value(state, "target_temperature", "targetTemperature", "target_temp", "temperature", "heat", default=None),
            "minimumTemperature": value(device, "min_temp", "minimumTemperature", default=value(state, "min_temp", default=None)),
            "maximumTemperature": value(device, "max_temp", "maximumTemperature", default=value(state, "max_temp", default=None)),
            "temperatureUnit": safe_text(value(device, "temperatureunit", "temperature_unit", default=value(state, "temperature_unit", default="C"))),
            "boost": value(state, "boost", default=False),
        },
    }


def map_snapshot(account_id: Any, devices: list[Any]) -> dict[str, Any]:
    mapped = [map_device(device) for device in devices]
    return {"accountId": safe_text(account_id, "unknown"), "devices": [device for device in mapped if device["cloudId"]]}


async def map_session_snapshot(hive: Any) -> dict[str, Any]:
    """Map only the library's logical climate list into our DTO."""
    climates = value(getattr(hive, "deviceList", {}), "climate", default=[])
    mapped = []
    for item in as_list(climates):
        if not isinstance(item, dict):
            continue
        current = item
        heating = getattr(hive, "heating", None)
        if heating is not None and hasattr(heating, "getClimate"):
            try:
                candidate = heating.getClimate(item)
                current = await candidate if hasattr(candidate, "__await__") else candidate
            except Exception:
                current = item
        if not isinstance(current, dict):
            current = item
        merged = {**item, **current}
        product_id = safe_text(value(item, "hiveID", "id", default=""))
        data = getattr(hive, "data", {})
        products = value(data, "products", default={})
        product = value(products, product_id, default={})
        if isinstance(product, dict):
            merged["product"] = product.get("type", "")
            merged["parentId"] = product.get("parent") or product.get("parent_id") or merged.get("parentId")
            merged["state"] = {**(product.get("state") or {}), **(merged.get("status") or {})}
            props = product.get("props") or {}
            if merged.get("min_temp") is None:
                merged["min_temp"] = props.get("minHeat")
            if merged.get("max_temp") is None:
                merged["max_temp"] = props.get("maxHeat")
        mapped.append(map_device(merged))
    user = value(getattr(hive, "data", {}), "user", default={})
    account_id = value(user, "id", "user_id", "userId", default="unknown")
    water_heaters = as_list(value(getattr(hive, "deviceList", {}), "water_heater", default=[]))
    return {"accountId": safe_text(account_id, "unknown"), "devices": [device for device in mapped if device["cloudId"]], "hotWaterDeviceCount": len(water_heaters)}
