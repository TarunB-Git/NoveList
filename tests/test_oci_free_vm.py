"""Provisioning safety checks use a fake cloud; no credentials or network needed."""

import base64
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from scripts.oci_free_vm import (
    ApiError, Settings, SHAPE, TAG, TOKEN_MAX_AGE, check_budget, public_key,
    retry_after_seconds, retry_launch, save_json, tenancy_lock,
)


def instance(**overrides):
    values = dict(id="vm-1", lifecycle_state="PROVISIONING", shape=SHAPE,
                  shape_config=SimpleNamespace(ocpus=2, memory_in_gbs=12),
                  compartment_id="ocid1.compartment.test", display_name="novelist", freeform_tags={})
    return SimpleNamespace(**(values | overrides))


class Clock:
    def __init__(self):
        self.time = 1000
        self.waits = []

    def now(self):
        return self.time

    def sleep(self, seconds):
        self.waits.append(seconds)
        self.time += seconds


class Cloud:
    tenancy, region = "test-tenancy", "test-home-region"

    def __init__(self, outcomes=()):
        self.outcomes = list(outcomes)
        self.requests = []
        self.instances, self.volumes = [], []
        self.inventory_error = None
        self.domains = ["AD-1", "AD-2"]

    def validate(self, settings):
        return self.domains

    def inventory(self):
        if self.inventory_error:
            raise self.inventory_error
        return self.instances, self.volumes

    def get_instance(self, identifier):
        return next(item for item in self.instances if item.id == identifier)

    def launch(self, settings, key, pending, run_id):
        self.requests.append(dict(pending))
        outcome = self.outcomes.pop(0) if self.outcomes else instance(freeform_tags={TAG: run_id})
        if isinstance(outcome, Exception):
            raise outcome
        self.instances.append(outcome)
        return outcome


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "vm.state.json"
        self.settings = Settings("ocid1.compartment.test", "ocid1.subnet.test", "ocid1.image.test", "unused.pub")
        self.clock = Clock()

    def run_cloud(self, cloud, **options):
        return retry_launch(cloud, self.settings, "test-public-key", self.path,
                            sleep=self.clock.sleep, now=self.clock.now,
                            jitter=lambda *_: 0, log=lambda _: None, **options)

    def test_preflight_never_launches_or_writes_state(self):
        cloud = Cloud()
        self.assertIsNone(self.run_cloud(cloud))
        self.assertEqual(cloud.requests, [])
        self.assertFalse(self.path.exists())

    def test_rejects_paid_sizes_and_short_intervals(self):
        for field, value in (("ocpus", 4), ("memory_gb", 24), ("boot_volume_gb", 201),
                             ("interval_seconds", 0), ("ocpus", True), ("memory_gb", 1)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                Settings(**(vars(self.settings) | {field: value})).validate()

    def test_existing_stopped_resources_count_toward_budget(self):
        cloud = Cloud()
        cloud.instances = [instance(lifecycle_state="STOPPED", display_name="another-vm")]
        with self.assertRaisesRegex(ValueError, "Existing A1 allocation"):
            self.run_cloud(cloud, run=True)
        self.assertEqual(cloud.requests, [])
        with self.assertRaisesRegex(ValueError, "200 GB allowance"):
            check_budget(self.settings, [], [SimpleNamespace(size_in_gbs=151, lifecycle_state="AVAILABLE")])

    def test_capacity_rejection_waits_and_rotates_domains(self):
        cloud = Cloud([ApiError(500, "InternalError", "Out of host capacity")])
        self.assertEqual(self.run_cloud(cloud, run=True), "vm-1")
        self.assertEqual([item["domain"] for item in cloud.requests], ["AD-1", "AD-2"])
        self.assertNotEqual(cloud.requests[0]["token"], cloud.requests[1]["token"])
        self.assertEqual(self.clock.waits, [0, 60])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_three_domains_are_checked_once_per_two_minutes(self):
        cloud = Cloud([ApiError(500, "InternalError", "Out of host capacity") for _ in range(3)])
        cloud.domains = ["AD-1", "AD-2", "AD-3"]
        self.run_cloud(cloud, run=True)
        self.assertEqual([item["domain"] for item in cloud.requests], ["AD-1", "AD-2", "AD-3", "AD-1"])
        self.assertEqual(self.clock.waits, [0, 40, 40, 40])
        self.assertEqual(self.clock.time, 1120)

    def test_one_domain_keeps_full_interval(self):
        cloud = Cloud([ApiError(500, "InternalError", "Out of host capacity")])
        cloud.domains = ["AD-1"]
        self.run_cloud(cloud, run=True)
        self.assertEqual(self.clock.waits, [0, 120])

    def test_capacity_rotation_honors_retry_after_without_extra_jitter(self):
        cloud = Cloud([ApiError(500, "InternalError", "Out of host capacity", retry_after=600)])
        cloud.domains = ["AD-1", "AD-2", "AD-3"]
        retry_launch(cloud, self.settings, "test-public-key", self.path, run=True,
                     sleep=self.clock.sleep, now=self.clock.now, jitter=lambda low, high: high,
                     log=lambda _: None)
        self.assertEqual(self.clock.waits, [0, 600])

    def test_fifteen_seconds_per_domain_staggers_three_domains(self):
        self.settings.interval_seconds = 15
        self.settings.validate()
        cloud = Cloud([ApiError(500, "InternalError", "Out of host capacity") for _ in range(3)])
        cloud.domains = ["AD-1", "AD-2", "AD-3"]
        self.run_cloud(cloud, run=True)
        self.assertEqual(self.clock.waits, [0, 5, 5, 5])
        self.assertEqual([item["domain"] for item in cloud.requests], ["AD-1", "AD-2", "AD-3", "AD-1"])

    def test_interval_change_preserves_pending_token_and_cooldown(self):
        cloud = Cloud([ApiError(0, "NetworkError")])
        self.run_cloud(cloud, run=True, max_attempts=1)
        original = json.loads(self.path.read_text())
        self.settings.interval_seconds = 15
        self.run_cloud(cloud, run=True)
        saved = json.loads(self.path.read_text())
        self.assertEqual(cloud.requests[0], cloud.requests[1])
        self.assertEqual(saved["run_id"], original["run_id"])
        self.assertEqual(saved["domain_index"], original["domain_index"])
        self.assertEqual(self.clock.waits, [0, 240])

    def test_legacy_interval_migration_preserves_state_and_read_only_preflight(self):
        self.settings.interval_seconds = 37
        cloud = Cloud([ApiError(0, "NetworkError")])
        self.run_cloud(cloud, run=True, max_attempts=1)
        state = json.loads(self.path.read_text())
        state["fingerprint"] = hashlib.sha256(json.dumps(
            {"settings": asdict(self.settings), "key": "test-public-key",
             "tenancy": cloud.tenancy, "region": cloud.region}, sort_keys=True).encode()).hexdigest()
        save_json(self.path, state)
        original_bytes = self.path.read_bytes()
        self.settings.interval_seconds = 15
        self.run_cloud(cloud)
        self.assertEqual(self.path.read_bytes(), original_bytes)
        self.run_cloud(cloud, run=True)
        saved = json.loads(self.path.read_text())
        self.assertNotEqual(saved["fingerprint"], state["fingerprint"])
        self.assertEqual(saved["run_id"], state["run_id"])
        self.assertEqual(saved["pending"], state["pending"])
        self.assertEqual(cloud.requests[0], cloud.requests[1])
        self.assertEqual(self.clock.waits, [0, 74])

    def test_legacy_migration_refuses_changed_launch_settings(self):
        cloud = Cloud([ApiError(0, "NetworkError")])
        self.run_cloud(cloud, run=True, max_attempts=1)
        state = json.loads(self.path.read_text())
        state["fingerprint"] = hashlib.sha256(json.dumps(
            {"settings": asdict(self.settings), "key": "test-public-key",
             "tenancy": cloud.tenancy, "region": cloud.region}, sort_keys=True).encode()).hexdigest()
        save_json(self.path, state)
        original_bytes = self.path.read_bytes()
        self.settings.memory_gb = 6
        self.settings.interval_seconds = 15
        with self.assertRaisesRegex(ValueError, "Configuration changed"):
            self.run_cloud(cloud, run=True)
        self.assertEqual(self.path.read_bytes(), original_bytes)
        self.assertEqual(len(cloud.requests), 1)

    def test_short_interval_keeps_minimum_transient_backoff(self):
        self.settings.interval_seconds = 15
        cloud = Cloud([ApiError(429, "TooManyRequests")])
        self.run_cloud(cloud, run=True)
        self.assertEqual(self.clock.waits, [0, 60])
        self.assertEqual(cloud.requests[0], cloud.requests[1])

    def test_rotation_resumes_existing_state_without_changing_config(self):
        cloud = Cloud([ApiError(500, "InternalError", "Out of host capacity")])
        cloud.domains = ["AD-1", "AD-2", "AD-3"]
        self.run_cloud(cloud, run=True, max_attempts=1)
        state = json.loads(self.path.read_text())
        # A previous script version may have persisted the longer global wait.
        state["not_before"] = self.clock.now() + 120
        save_json(self.path, state)
        self.run_cloud(cloud, run=True)
        self.assertEqual(self.clock.waits, [0, 120])
        self.assertEqual(cloud.requests[1]["domain"], "AD-2")

    def test_throttling_honors_retry_after_and_reuses_request(self):
        cloud = Cloud([ApiError(429, "TooManyRequests", retry_after=600)])
        cloud.domains = ["AD-1", "AD-2", "AD-3"]
        self.run_cloud(cloud, run=True)
        self.assertEqual(self.clock.waits, [0, 600])
        self.assertEqual(cloud.requests[0], cloud.requests[1])

    def test_ambiguous_launch_resumes_same_token_after_restart(self):
        cloud = Cloud([ApiError(0, "NetworkError")])
        cloud.domains = ["AD-1", "AD-2", "AD-3"]
        self.run_cloud(cloud, run=True, max_attempts=1)
        self.assertEqual(json.loads(self.path.read_text())["pending"], cloud.requests[0])
        self.run_cloud(cloud, run=True, max_attempts=1)
        self.assertEqual(cloud.requests[0], cloud.requests[1])
        self.assertEqual(self.clock.waits, [0, 240])

    def test_lost_launch_response_is_found_without_second_post(self):
        cloud = Cloud([ApiError(0, "NetworkError")])
        self.run_cloud(cloud, run=True, max_attempts=1)
        state = json.loads(self.path.read_text())
        cloud.instances.append(instance(freeform_tags={TAG: state["run_id"]}, display_name="renamed"))
        self.assertEqual(self.run_cloud(cloud, run=True), "vm-1")
        self.assertEqual(len(cloud.requests), 1)

    def test_success_stops_and_rerun_does_not_create_again(self):
        cloud = Cloud()
        self.run_cloud(cloud, run=True)
        self.run_cloud(cloud, run=True)
        self.assertEqual(len(cloud.requests), 1)
        cloud.instances[0].lifecycle_state = "TERMINATED"
        with self.assertRaisesRegex(ValueError, "will not create a replacement"):
            self.run_cloud(cloud, run=True)
        self.assertEqual(len(cloud.requests), 1)

    def test_old_ambiguous_token_and_changed_config_stop(self):
        cloud = Cloud([ApiError(0, "NetworkError")])
        self.run_cloud(cloud, run=True, max_attempts=1)
        self.clock.time += TOKEN_MAX_AGE
        with self.assertRaisesRegex(ValueError, "older than 23 hours"):
            self.run_cloud(cloud, run=True)
        self.settings.memory_gb = 6
        with self.assertRaisesRegex(ValueError, "Configuration changed"):
            self.run_cloud(cloud, run=True)
        self.assertEqual(len(cloud.requests), 1)

    def test_permission_errors_stop_without_launching(self):
        cloud = Cloud()
        cloud.inventory_error = ApiError(403, "NotAuthorized")
        with self.assertRaises(ApiError):
            self.run_cloud(cloud, run=True)
        self.assertEqual(cloud.requests, [])

    def test_permanent_launch_error_is_not_retried(self):
        cloud = Cloud([ApiError(400, "InvalidParameter")])
        with self.assertRaises(ApiError):
            self.run_cloud(cloud, run=True)
        self.assertEqual(len(cloud.requests), 1)

    def test_multiple_matching_instances_stop(self):
        cloud = Cloud()
        cloud.instances = [instance(id="vm-1"), instance(id="vm-2")]
        with self.assertRaisesRegex(ValueError, "Multiple matching VMs"):
            self.run_cloud(cloud, run=True)
        self.assertEqual(cloud.requests, [])

    def test_retry_after_seconds_and_http_date(self):
        self.assertEqual(retry_after_seconds("600"), 600)
        self.assertEqual(retry_after_seconds("Thu, 01 Jan 1970 00:20:00 GMT", now=lambda: 1000), 200)
        for value in ("bad", "nan", "inf", -1, None):
            self.assertEqual(retry_after_seconds(value), 0)

    def test_public_key_rejects_private_key_and_malformed_data(self):
        path = Path(self.directory.name) / "key.pub"
        for text in ("-----BEGIN OPENSSH PRIVATE KEY-----", "ssh-ed25519 not-base64"):
            path.write_text(text)
            with self.assertRaises(ValueError):
                public_key(str(path))
        algorithm = b"ssh-ed25519"
        blob = len(algorithm).to_bytes(4, "big") + algorithm + (32).to_bytes(4, "big") + b"x" * 32
        path.write_text("ssh-ed25519 " + base64.b64encode(blob).decode() + " comment")
        self.assertEqual(len(public_key(str(path)).split()), 2)

    def test_concurrent_local_launchers_are_refused(self):
        with tenancy_lock("test-" + self.directory.name):
            with self.assertRaisesRegex(ValueError, "already running"):
                with tenancy_lock("test-" + self.directory.name):
                    self.fail("second process obtained the lock")

    def test_malformed_pending_state_fails_before_cloud_launch(self):
        cloud = Cloud([ApiError(0, "NetworkError")])
        self.run_cloud(cloud, run=True, max_attempts=1)
        state = json.loads(self.path.read_text())
        for pending in ({"token": "broken"}, {}, []):
            state["pending"] = pending
            save_json(self.path, state)
            with self.subTest(pending=pending), self.assertRaisesRegex(ValueError, "Invalid pending request"):
                self.run_cloud(cloud, run=True)
        self.path.write_text("[]")
        with self.assertRaisesRegex(ValueError, "Invalid state file"):
            self.run_cloud(cloud, run=True)
        self.assertEqual(len(cloud.requests), 1)


if __name__ == "__main__":
    unittest.main()
