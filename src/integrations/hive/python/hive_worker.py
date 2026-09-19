#!/usr/bin/env python3
"""Small, unprivileged Hive adapter for Dinodia OS.

The process speaks only the Dinodia NDJSON protocol. It intentionally returns
an allow-listed DTO instead of exposing the upstream Hive response.
"""

import asyncio
import json
import logging
import sys
from typing import Any

from device_mapper import as_list, map_session_snapshot, value
from protocol import error_response, read_messages, response, safe_text

try:
    from apyhiveapi import Hive
    from apyhiveapi.helper.hive_exceptions import (
        HiveApiError,
        HiveInvalid2FACode,
        HiveInvalidPassword,
        HiveInvalidUsername,
        HiveReauthRequired,
    )
except ImportError:  # The Node bridge reports this as a disabled dependency.
    Hive = None
    HiveApiError = HiveInvalid2FACode = HiveInvalidPassword = HiveInvalidUsername = HiveReauthRequired = Exception

# The upstream library logs request diagnostics. The worker is deliberately a
# quiet boundary so credentials, account identifiers, and upstream payloads
# cannot reach the Node service log stream.
logging.disable(logging.CRITICAL)


class Worker:
    def __init__(self) -> None:
        self.hive = None
        self.username = ""
        self.password = ""
        self.tokens: dict[str, Any] = {}
        self.device_data: list[Any] = []
        self.challenge: dict[str, Any] = {}

    def ensure_dependency(self) -> None:
        if Hive is None:
            raise RuntimeError("Hive Python dependency is not installed")

    async def call(self, obj: Any, *names: str, args: tuple[Any, ...] = (), kwargs: dict[str, Any] | None = None) -> Any:
        for name in names:
            method = getattr(obj, name, None)
            if method is None:
                continue
            result = method(*args, **(kwargs or {}))
            if asyncio.iscoroutine(result):
                return await result
            return result
        raise RuntimeError(f"Hive operation is not supported: {names[0]}")

    async def login(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.ensure_dependency()
        await self.stop_hive()
        self.username = safe_text(payload.get("username"))
        self.password = str(payload.get("password") or "")
        self.hive = Hive(username=self.username, password=self.password)
        prior_device_data = payload.get("deviceData")
        if isinstance(prior_device_data, (list, tuple)) and len(prior_device_data) == 3:
            self.device_data = list(prior_device_data)
            self.hive.auth.device_group_key, self.hive.auth.device_key, self.hive.auth.device_password = self.device_data
        try:
            result = await self.hive.login()
        except HiveInvalidUsername as exc:
            raise RuntimeError("invalid_username") from exc
        except HiveInvalidPassword as exc:
            raise RuntimeError("invalid_password") from exc
        except HiveReauthRequired as exc:
            raise RuntimeError("reauth_required") from exc
        except HiveApiError as exc:
            raise RuntimeError("internet_unavailable") from exc
        self.challenge = result if isinstance(result, dict) and result.get("ChallengeName") == "SMS_MFA" else {}
        if self.challenge:
            return {"challenge": "SMS_MFA"}
        self.tokens = result if isinstance(result, dict) else {}
        return {"tokens": self.tokens, "registrationRequired": bool(self.tokens.get("AuthenticationResult", {}).get("NewDeviceMetadata")), "deviceData": self.current_device_data()}

    def current_device_data(self) -> list[Any]:
        auth = getattr(self.hive, "auth", None)
        values = [getattr(auth, "device_group_key", None), getattr(auth, "device_key", None), getattr(auth, "device_password", None)]
        return values if all(value is not None for value in values) else list(self.device_data)

    def current_tokens(self) -> dict[str, Any]:
        """Return the small token set needed to resume the library session."""
        token_state = getattr(getattr(self.hive, "tokens", None), "tokenData", None)
        if isinstance(token_state, dict):
            selected = {key: token_state[key] for key in ("token", "accessToken", "refreshToken") if token_state.get(key)}
            if selected:
                return selected
        return self.tokens if isinstance(self.tokens, dict) else {}

    async def submit_mfa(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.ensure_dependency()
        if self.hive is None or not self.challenge:
            raise RuntimeError("setup_session_expired")
        try:
            self.tokens = await self.hive.sms2fa(safe_text(payload.get("code")), self.challenge)
        except HiveInvalid2FACode as exc:
            raise RuntimeError("invalid_mfa_code") from exc
        except HiveApiError as exc:
            raise RuntimeError("internet_unavailable") from exc
        self.challenge = {}
        return {"tokens": self.tokens, "registrationRequired": bool(self.tokens.get("AuthenticationResult", {}).get("NewDeviceMetadata")), "deviceData": self.current_device_data()}

    async def register(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.ensure_dependency()
        if self.hive is None:
            raise RuntimeError("setup_session_expired")
        try:
            await self.call(self.hive.auth, "device_registration", args=(safe_text(payload.get("deviceName"), "Dinodia OS"),))
            device_data = await self.call(self.hive.auth, "get_device_data")
        except Exception as exc:
            raise RuntimeError("client_registration_failed") from exc
        self.device_data = list(device_data) if isinstance(device_data, (list, tuple)) else []
        return {"deviceData": self.device_data}

    async def start_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.ensure_dependency()
        self.tokens = payload.get("tokens") if isinstance(payload.get("tokens"), dict) else self.tokens
        self.username = safe_text(payload.get("username"), self.username)
        self.password = str(payload.get("password") or self.password)
        if self.hive is None:
            self.hive = Hive(username=self.username, password=self.password)
        device_data = payload.get("deviceData")
        if isinstance(device_data, (list, tuple)) and len(device_data) == 3:
            self.device_data = list(device_data)
        config = {"username": self.username, "password": self.password, "tokens": self.tokens}
        if len(self.device_data) == 3:
            config["device_data"] = self.device_data
        await self.call(self.hive, "startSession", args=(config,))
        return {"ready": True}

    def raw_devices(self) -> list[Any]:
        if self.hive is None:
            return []
        session = getattr(self.hive, "session", None)
        device_list = getattr(session, "deviceList", None)
        if device_list:
            values: list[Any] = []
            if isinstance(device_list, dict):
                for group in device_list.values():
                    values.extend(as_list(group))
            else:
                values.extend(as_list(device_list))
            return values
        data = getattr(session, "data", None)
        return as_list(value(data, "devices", default={}))

    async def snapshot(self) -> dict[str, Any]:
        self.ensure_dependency()
        if self.hive is None:
            raise RuntimeError("session_not_started")
        updated = await self.call(self.hive, "getDevices", args=("No_ID",))
        if updated is False:
            raise RuntimeError("internet_unavailable")
        await self.call(self.hive, "createDevices")
        mapped = await map_session_snapshot(self.hive)
        mapped["tokens"] = self.current_tokens()
        return mapped

    async def command(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.ensure_dependency()
        if self.hive is None:
            raise RuntimeError("session_not_started")
        cloud_id = safe_text(payload.get("cloudId"))
        device_list = getattr(self.hive, "deviceList", {})
        device = next((item for item in as_list(value(device_list, "climate", default=[])) if safe_text(value(item, "hiveID", "device_id", "deviceId", "id", "zone_id", "zoneId", default="")) == cloud_id), None)
        if device is None:
            raise RuntimeError("device_not_found")
        operation = safe_text(payload.get("operation"))
        if operation == "heating.set_mode":
            result = await self.call(getattr(self.hive, "heating"), "setMode", "set_mode", args=(device, safe_text(payload.get("mode"))))
        elif operation == "heating.set_target_temperature":
            result = await self.call(getattr(self.hive, "heating"), "setTargetTemperature", "set_target_temperature", args=(device, float(payload.get("temperature"))))
        else:
            raise RuntimeError("unsupported_service")
        if result is False:
            raise RuntimeError("device_offline")
        return {"accepted": True}

    async def stop_hive(self) -> None:
        if self.hive is not None:
            client = getattr(getattr(self.hive, "api", None), "websession", None)
            close = getattr(client, "close", None)
            if close is not None:
                result = close()
                if asyncio.iscoroutine(result):
                    await result
        self.hive = None

    async def dispatch(self, message: dict[str, Any]) -> dict[str, Any]:
        operation = safe_text(message.get("operation"))
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        if operation == "initialize": return response(message["id"], {"workerVersion": 1})
        if operation == "health": return response(message["id"], {"ready": self.hive is not None})
        if operation == "auth.login": return response(message["id"], await self.login(payload))
        if operation == "auth.submit_mfa": return response(message["id"], await self.submit_mfa(payload))
        if operation == "auth.register_device": return response(message["id"], await self.register(payload))
        if operation == "session.start": return response(message["id"], await self.start_session(payload))
        if operation in ("devices.discover", "devices.poll"): return response(message["id"], await self.snapshot())
        if operation == "device.command": return response(message["id"], await self.command(payload))
        if operation == "session.stop": await self.stop_hive(); self.tokens = {}; self.device_data = []; self.challenge = {}; self.username = ""; self.password = ""; return response(message["id"], {"stopped": True})
        if operation == "account.deregister": return response(message["id"], {"deregistered": False, "supported": False})
        return error_response(message["id"], "unsupported_operation", "Hive worker operation is not supported.")

    async def run(self) -> None:
        for message in read_messages():
            if message.get("operation") == "error":
                print(json.dumps(message), flush=True)
                continue
            try:
                result = await self.dispatch(message)
            except Exception as exc:  # Never include upstream tracebacks in stdout.
                code = str(exc) if str(exc) in {"invalid_username", "invalid_password", "invalid_mfa_code", "internet_unavailable", "reauth_required", "setup_session_expired", "session_not_started", "device_not_found", "device_offline", "unsupported_service", "client_registration_failed"} else "hive_api_unavailable"
                result = error_response(message["id"], code, "Hive operation failed.")
            print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    asyncio.run(Worker().run())
