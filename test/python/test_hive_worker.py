import asyncio
import io
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKER_DIR = ROOT / "src" / "integrations" / "hive" / "python"
sys.path.insert(0, str(WORKER_DIR))

from device_mapper import as_bool, map_device, map_session_snapshot  # noqa: E402
from protocol import public_error, read_messages  # noqa: E402
import hive_worker  # noqa: E402


class FakeAuth:
    def __init__(self):
        self.device_group_key = None
        self.device_key = None
        self.device_password = None
        self.registered = False

    async def device_registration(self, name):
        self.registered = True

    async def get_device_data(self):
        return ["group", "key", "device-password"]


class FakeHeating:
    def __init__(self, climates):
        self.climates = climates
        self.commands = []

    async def getClimate(self, item):
        return {**item, "haName": item.get("hiveName"), "status": item.get("state", {})}

    async def setMode(self, device, mode):
        self.commands.append(("mode", device["hiveID"], mode))
        return True

    async def setTargetTemperature(self, device, temperature):
        self.commands.append(("temperature", device["hiveID"], temperature))
        return True


class FakeHive:
    def __init__(self, username=None, password=None):
        self.username = username
        self.password = password
        self.auth = FakeAuth()
        self.deviceList = {
            "climate": [
                {"hiveID": "zone-1", "hiveName": "Downstairs", "hiveType": "thermostat", "state": {"mode": "SCHEDULE", "targetTemperature": 21}},
            ],
            "water_heater": [{"hiveID": "water-1", "hiveType": "hot_water"}],
        }
        self.heating = FakeHeating(self.deviceList["climate"])
        self.data = {"user": {"id": "account-1"}, "products": {}}
        self.api = type("Api", (), {"websession": None})()
        self.started = False

    async def login(self):
        return {"AuthenticationResult": {"AccessToken": "opaque"}}

    async def startSession(self, config):
        self.started = True

    async def getDevices(self, device_id):
        return True

    async def createDevices(self):
        return True


class HiveWorkerTests(unittest.TestCase):
    def setUp(self):
        self.original_hive = hive_worker.Hive
        hive_worker.Hive = FakeHive

    def tearDown(self):
        hive_worker.Hive = self.original_hive

    def test_mapper_is_allow_listed_and_handles_string_booleans(self):
        mapped = map_device({"hiveID": "zone-1", "hiveName": "Downstairs", "hiveType": "thermostat", "online": "false", "state": {"mode": "MANUAL"}})
        self.assertEqual(mapped["cloudId"], "zone-1")
        self.assertEqual(mapped["name"], "Downstairs")
        self.assertFalse(mapped["online"])
        self.assertEqual(as_bool("false"), False)
        self.assertEqual(as_bool("true"), True)
        self.assertNotIn("password", mapped)

    def test_mocked_login_discovery_and_command(self):
        worker = hive_worker.Worker()
        login = asyncio.run(worker.dispatch({"id": "1", "operation": "auth.login", "payload": {"username": "owner@example.com", "password": "password"}}))
        self.assertTrue(login["ok"])
        self.assertEqual(login["payload"]["registrationRequired"], False)
        asyncio.run(worker.dispatch({"id": "2", "operation": "session.start", "payload": {"username": "owner@example.com", "password": "password", "tokens": login["payload"]["tokens"], "deviceData": []}}))
        snapshot = asyncio.run(worker.dispatch({"id": "3", "operation": "devices.poll", "payload": {}}))
        self.assertEqual(snapshot["payload"]["devices"][0]["cloudId"], "zone-1")
        self.assertEqual(snapshot["payload"]["hotWaterDeviceCount"], 1)
        command = asyncio.run(worker.dispatch({"id": "4", "operation": "device.command", "payload": {"cloudId": "zone-1", "operation": "heating.set_mode", "mode": "OFF"}}))
        self.assertTrue(command["ok"])
        self.assertEqual(worker.hive.heating.commands[-1], ("mode", "zone-1", "OFF"))
        asyncio.run(worker.dispatch({"id": "5", "operation": "session.stop", "payload": {}}))
        self.assertIsNone(worker.hive)

    def test_snapshot_mapper_uses_logical_climates_and_disregards_unknown_raw_fields(self):
        fake = FakeHive("owner@example.com", "password")
        snapshot = asyncio.run(map_session_snapshot(fake))
        self.assertEqual(len(snapshot["devices"]), 1)
        self.assertEqual(snapshot["devices"][0]["name"], "Downstairs")
        self.assertEqual(snapshot["hotWaterDeviceCount"], 1)
        self.assertNotIn("AuthenticationResult", snapshot)


class ProtocolTests(unittest.TestCase):
    def test_error_redaction_and_invalid_input(self):
        self.assertNotIn("super-secret", public_error("failure", "password=super-secret")["message"])
        stream = io.StringIO('{"protocolVersion": 1, "id": "ok", "operation": "health"}\nnot-json\n')
        with patch.object(sys, "stdin", stream):
            messages = list(read_messages())
        self.assertEqual(messages[0]["id"], "ok")
        self.assertEqual(messages[1]["operation"], "error")


if __name__ == "__main__":
    unittest.main()
