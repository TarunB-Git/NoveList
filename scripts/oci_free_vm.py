#!/usr/bin/env python3
"""Retry one OCI A1 VM launch, with allocation checks and resumable requests.

Operator tool: credentials come from ~/.oci/config. The default action is a
read-only preflight; --run enables VM creation. See docs/oracle-vm.md.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from email.utils import parsedate_to_datetime
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import tempfile
import time
import uuid


SHAPE = "VM.Standard.A1.Flex"
TAG = "novelist-provisioner-id"
ROOT = Path(__file__).resolve().parent.parent
TOKEN_MAX_AGE = 23 * 60 * 60  # Stop before OCI's 24-hour retry-token expiry.


@dataclass
class Settings:
    compartment_id: str
    subnet_id: str
    image_id: str
    ssh_public_key_file: str
    profile: str = "DEFAULT"
    display_name: str = "novelist"
    ocpus: int = 2
    memory_gb: int = 12
    boot_volume_gb: int = 50
    interval_seconds: int = 120  # Capacity retry interval per availability domain.
    availability_domains: list[str] = field(default_factory=list)

    def validate(self) -> None:
        for name in ("compartment_id", "subnet_id", "image_id", "profile", "ssh_public_key_file"):
            if not isinstance(getattr(self, name), str) or not getattr(self, name).strip():
                raise ValueError(f"Set {name} in the configuration")
        if not self.compartment_id.startswith(("ocid1.compartment.", "ocid1.tenancy.")):
            raise ValueError("compartment_id must be a compartment or tenancy OCID")
        for name, kind in (("subnet_id", "subnet"), ("image_id", "image")):
            if not getattr(self, name).startswith(f"ocid1.{kind}."):
                raise ValueError(f"{name} must be an OCI {kind} OCID")
        for name, lower, upper in (
            ("ocpus", 1, 2), ("memory_gb", 1, 12),
            ("boot_volume_gb", 50, 200), ("interval_seconds", 1, 86400),
        ):
            value = getattr(self, name)
            if type(value) is not int or not lower <= value <= upper:
                raise ValueError(f"{name} must be an integer from {lower} to {upper}")
        if self.memory_gb < self.ocpus:
            raise ValueError("A1 memory_gb must be at least the requested OCPU count")
        if not isinstance(self.display_name, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", self.display_name
        ):
            raise ValueError("display_name must use 1–64 letters, numbers, dots, underscores, or hyphens")
        if not isinstance(self.availability_domains, list) or not all(
            isinstance(value, str) and value.strip() for value in self.availability_domains
        ):
            raise ValueError("availability_domains must be a list of names, or [] for automatic selection")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str = "", retry_after: float = 0):
        super().__init__(f"OCI {code} (HTTP {status})")
        self.status, self.code, self.message = status, code, message
        self.retry_after = retry_after

    @property
    def capacity(self) -> bool:
        return self.status in (409, 500, 503) and "out of host capacity" in self.message.lower()

    @property
    def transient(self) -> bool:
        return self.status in (0, 429, 500, 502, 503, 504)


def retry_after_seconds(value, now=time.time) -> float:
    try:
        delay = float(value)
    except (TypeError, ValueError):
        try:
            delay = parsedate_to_datetime(str(value)).timestamp() - now()
        except (TypeError, ValueError, OverflowError):
            return 0
    return max(0, delay) if math.isfinite(delay) else 0


def public_key(path: str) -> str:
    text = Path(path).expanduser().read_text(encoding="utf-8").strip()
    parts = text.split()
    if len(parts) < 2 or parts[0] not in ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"):
        raise ValueError("ssh_public_key_file must contain an SSH public key, not a private key")
    blob = base64.b64decode(parts[1], validate=True)
    size = int.from_bytes(blob[:4], "big")
    if blob[4:4 + size] != parts[0].encode() or len(blob) <= 4 + size:
        raise ValueError("Invalid SSH public key")
    return " ".join(parts[:2])


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def tenancy_lock(tenancy: str):
    import fcntl

    digest = hashlib.sha256(tenancy.encode()).hexdigest()[:20]
    path = Path(tempfile.gettempdir()) / f"novelist-oci-{digest}.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another retry process for this tenancy is already running on this machine") from error
        yield


def check_budget(settings: Settings, instances: list, volumes: list) -> None:
    cpus, memory = 0.0, 0.0
    for instance in instances:
        # Stopped and terminating instances still reserve resources.
        if instance.lifecycle_state != "TERMINATED" and instance.shape == SHAPE:
            cpus += float(instance.shape_config.ocpus)
            memory += float(instance.shape_config.memory_in_gbs)
    disk = sum(float(volume.size_in_gbs) for volume in volumes if volume.lifecycle_state != "TERMINATED")
    if not all(math.isfinite(value) and value >= 0 for value in (cpus, memory, disk)):
        raise ValueError("OCI returned invalid allocation totals; refusing to launch")
    if cpus + settings.ocpus > 2 or memory + settings.memory_gb > 12:
        raise ValueError(f"Existing A1 allocation ({cpus:g} OCPU / {memory:g} GB) leaves too little Always Free capacity")
    if disk + settings.boot_volume_gb > 200:
        raise ValueError(f"Existing boot/block volumes ({disk:g} GB) leave too little of the 200 GB allowance")


class OCICloud:
    """Small adapter around the optional official SDK; SDK retries are disabled."""

    def __init__(self, profile: str):
        try:
            import oci
        except ImportError as error:
            raise ValueError("Install scripts/requirements-cloud.txt in a separate virtual environment first") from error
        self.oci = oci
        self.network_error = (oci.exceptions.RequestException, oci.exceptions.ConnectTimeout)
        try:
            self.config = oci.config.from_file(profile_name=profile)
            oci.config.validate_config(self.config)
        except (oci.exceptions.ConfigFileNotFound, oci.exceptions.ProfileNotFound,
                oci.exceptions.InvalidConfig) as error:
            raise ValueError("Check ~/.oci/config, its selected profile, and API signing key; see docs/oracle-vm.md") from error
        self.tenancy, self.region = self.config["tenancy"], self.config["region"]
        options = {"retry_strategy": oci.retry.NoneRetryStrategy(), "timeout": (10, 60),
                   "circuit_breaker_strategy": oci.circuit_breaker.NoCircuitBreakerStrategy()}
        self.identity = oci.identity.IdentityClient(self.config, **options)
        self.compute = oci.core.ComputeClient(self.config, **options)
        self.storage = oci.core.BlockstorageClient(self.config, **options)
        self.network = oci.core.VirtualNetworkClient(self.config, **options)

    def call(self, method, *args, all_pages=False, **kwargs):
        kwargs["retry_strategy"] = self.oci.retry.NoneRetryStrategy()
        try:
            if all_pages:
                return self.oci.pagination.list_call_get_all_results(method, *args, **kwargs).data
            return method(*args, **kwargs).data
        except self.oci.exceptions.ServiceError as error:
            headers = {key.lower(): value for key, value in (error.headers or {}).items()}
            retry_after = retry_after_seconds(headers.get("retry-after", 0))
            raise ApiError(error.status, error.code, error.message, retry_after) from error
        except self.network_error as error:
            raise ApiError(0, "NetworkError") from error

    def compartments(self) -> list[str]:
        items = self.call(self.identity.list_compartments, self.tenancy, all_pages=True,
                          compartment_id_in_subtree=True, access_level="ANY", lifecycle_state="ACTIVE")
        return sorted({self.tenancy, *(item.id for item in items)})

    def validate(self, settings: Settings) -> list[str]:
        regions = self.call(self.identity.list_region_subscriptions, self.tenancy, all_pages=True)
        if not any(item.is_home_region and item.region_name == self.region for item in regions):
            raise ValueError("The OCI profile must use the tenancy's home region for Always Free compute")
        domains = [item.name for item in self.call(
            self.identity.list_availability_domains, self.tenancy, all_pages=True)]
        subnet = self.call(self.network.get_subnet, settings.subnet_id)
        if subnet.prohibit_public_ip_on_vnic or subnet.lifecycle_state != "AVAILABLE":
            raise ValueError("Select an available public subnet; this tool does not create networking")
        chosen = settings.availability_domains or domains
        if any(domain not in domains for domain in chosen):
            raise ValueError("An availability domain is outside the configured home region")
        chosen = [domain for domain in chosen if subnet.availability_domain in (None, domain)]
        if not chosen:
            raise ValueError("No selected availability domain matches the subnet")
        image = self.call(self.compute.get_image, settings.image_id)
        if image.compartment_id is not None or image.operating_system != "Canonical Ubuntu" or image.lifecycle_state != "AVAILABLE":
            raise ValueError("Choose an available Canonical Ubuntu platform image; custom/Marketplace images are refused")
        self.call(self.compute.get_image_shape_compatibility_entry, settings.image_id, SHAPE)
        if settings.compartment_id not in self.compartments():
            raise ValueError("Target compartment is outside this tenancy or is inactive")
        return list(dict.fromkeys(chosen))

    def inventory(self):
        instances, volumes = [], []
        domains = self.call(self.identity.list_availability_domains, self.tenancy, all_pages=True)
        for compartment in self.compartments():
            instances.extend(self.call(self.compute.list_instances, compartment, all_pages=True))
            volumes.extend(self.call(self.storage.list_volumes, compartment_id=compartment, all_pages=True))
            for domain in domains:
                volumes.extend(self.call(self.storage.list_boot_volumes, availability_domain=domain.name,
                                         compartment_id=compartment, all_pages=True))
        return instances, volumes

    def get_instance(self, instance_id: str):
        return self.call(self.compute.get_instance, instance_id)

    def launch(self, settings: Settings, ssh_key: str, pending: dict, run_id: str):
        models = self.oci.core.models
        details = models.LaunchInstanceDetails(
            availability_domain=pending["domain"], compartment_id=settings.compartment_id,
            display_name=settings.display_name, shape=SHAPE,
            shape_config=models.LaunchInstanceShapeConfigDetails(ocpus=settings.ocpus, memory_in_gbs=settings.memory_gb),
            source_details=models.InstanceSourceViaImageDetails(image_id=settings.image_id,
                boot_volume_size_in_gbs=settings.boot_volume_gb, boot_volume_vpus_per_gb=10),
            create_vnic_details=models.CreateVnicDetails(subnet_id=settings.subnet_id, assign_public_ip=True),
            metadata={"ssh_authorized_keys": ssh_key}, freeform_tags={TAG: run_id},
        )
        return self.call(self.compute.launch_instance, details, opc_retry_token=pending["token"])


def existing_instance(settings: Settings, state: dict, instances: list):
    matches = [item for item in instances if item.lifecycle_state != "TERMINATED"
               and (item.freeform_tags or {}).get(TAG) == state["run_id"]]
    matches.extend(item for item in instances if item.lifecycle_state != "TERMINATED"
                   and item.compartment_id == settings.compartment_id and item.display_name == settings.display_name)
    matches = list({item.id: item for item in matches}.values())
    if len(matches) > 1:
        raise ValueError("Multiple matching VMs exist; inspect the Console before continuing")
    return matches[0] if matches else None


def retry_launch(cloud, settings: Settings, ssh_key: str, state_path: Path, *, run=False,
                 max_attempts=0, sleep=time.sleep, now=time.time, jitter=random.uniform, log=print):
    def settings_fingerprint(values):
        return hashlib.sha256(json.dumps(
            {"settings": values, "key": ssh_key, "tenancy": cloud.tenancy, "region": cloud.region},
            sort_keys=True).encode()).hexdigest()

    launch_settings = asdict(settings)
    launch_settings.pop("interval_seconds")
    fingerprint = settings_fingerprint(launch_settings)
    state = json.loads(state_path.read_text()) if state_path.exists() else {
        "fingerprint": fingerprint, "run_id": uuid.uuid4().hex, "domain_index": 0,
    }
    if not isinstance(state, dict):
        raise ValueError("Invalid state file; inspect OCI before repairing it")
    if state.get("fingerprint") != fingerprint:
        # Older state included timing in its hash but did not store that interval.
        # Match only that bounded field; every other setting must still agree.
        legacy_settings = asdict(settings)
        for previous_interval in range(1, 86401):
            legacy_settings["interval_seconds"] = previous_interval
            if state.get("fingerprint") == settings_fingerprint(legacy_settings):
                state["fingerprint"] = fingerprint
                break
        else:
            raise ValueError("Configuration changed since the previous run; reconcile its state file before continuing")
    if not isinstance(state.get("run_id"), str) or type(state.get("domain_index")) is not int:
        raise ValueError("Invalid state file; inspect OCI before repairing it")
    pending = state.get("pending")
    if pending is not None and (not isinstance(pending, dict) or not isinstance(pending.get("token"), str)
                    or not isinstance(pending.get("domain"), str)
                    or not isinstance(pending.get("created_at"), (int, float))
                    or not math.isfinite(pending["created_at"])):
        raise ValueError("Invalid pending request; inspect OCI before repairing its state file")
    if not isinstance(state.get("not_before", 0), (int, float)) or not math.isfinite(state.get("not_before", 0)):
        raise ValueError("Invalid retry time in state file")
    domains = cloud.validate(settings)
    if not domains or pending and pending["domain"] not in domains:
        raise ValueError("Selected availability domains no longer match the pending request")
    capacity_spacing = settings.interval_seconds / len(domains)
    if run:
        log(f"Capacity checks: {len(domains)} AD(s), roughly {settings.interval_seconds}s per AD; "
            f"attempts staggered by {capacity_spacing:g}s, excluding request time and backoff.")
    attempts, failures = 0, 0
    while not max_attempts or attempts < max_attempts:
        if run:
            sleep(max(0, state.get("not_before", 0) - now()))
        attempts += 1
        launching = False
        try:
            if state.get("instance_id"):
                instance = cloud.get_instance(state["instance_id"])
                if instance.lifecycle_state == "TERMINATED":
                    raise ValueError("The recorded VM was terminated; this state will not create a replacement")
                log(f"VM exists: {instance.id} ({instance.lifecycle_state}).")
                return instance.id
            instances, volumes = cloud.inventory()
            instance = existing_instance(settings, state, instances)
            if instance:
                if run:
                    state["instance_id"] = instance.id
                    save_json(state_path, state)
                log(f"VM exists: {instance.id} ({instance.lifecycle_state}).")
                return instance.id
            check_budget(settings, instances, volumes)
            pending = state.get("pending")
            if pending and now() - pending["created_at"] >= TOKEN_MAX_AGE:
                raise ValueError("An ambiguous launch is older than 23 hours; inspect OCI before retiring its retry token")
            if not run:
                log(f"Preflight OK: {cloud.region}, {SHAPE}, {settings.ocpus} OCPU, "
                    f"{settings.memory_gb} GB RAM, {settings.boot_volume_gb} GB boot disk; domains: {', '.join(domains)}.")
                log("Run again with --run to start creation attempts.")
                return None
            if not pending:
                pending = {"token": uuid.uuid4().hex, "domain": domains[state["domain_index"] % len(domains)],
                           "created_at": now()}
                state["pending"] = pending
            state["not_before"] = now() + settings.interval_seconds + jitter(0, 15)
            save_json(state_path, state)  # Persist token before the POST, including across interrupts.
            launching = True
            instance = cloud.launch(settings, ssh_key, pending, state["run_id"])
            state["instance_id"] = instance.id
            save_json(state_path, state)
            log(f"Launch accepted: {instance.id} ({instance.lifecycle_state}).")
            log("Check Compute > Instances for RUNNING and its public IP. No further launch requests will be sent.")
            return instance.id
        except ApiError as error:
            if not run or not (error.capacity or error.transient):
                raise
            if launching and error.capacity:
                # This explicit rejection is different from a timeout/unknown response.
                state.pop("pending", None)
                state["domain_index"] += 1
                failures = 0
                delay = max(error.retry_after, capacity_spacing)
                reason = f"No host capacity in {pending['domain']}"
            else:
                failures += 1
                delay = max(60, error.retry_after, min(1800, settings.interval_seconds * 2 ** min(failures, 10))) + jitter(0, 15)
                reason = str(error)
            state["not_before"] = now() + delay
            save_json(state_path, state)
            log(f"Attempt {attempts}: {reason}; next check in {delay:.0f}s.")
    log("Attempt limit reached. Resume with the same config and state file.")
    return None


def configure(path: Path) -> None:
    if path.exists():
        raise ValueError(f"{path} already exists; edit it or choose a different --config")
    values = {}
    prompts = (
        ("profile", "OCI profile", "DEFAULT"),
        ("compartment_id", "Target compartment OCID (tenancy OCID also works)", ""),
        ("subnet_id", "Existing public subnet OCID", ""),
        ("image_id", "Ubuntu ARM platform image OCID from the Console", ""),
        ("ssh_public_key_file", "SSH public key file", "~/.ssh/id_ed25519.pub"),
        ("display_name", "VM name", "novelist"),
    )
    for key, label, default in prompts:
        values[key] = input(f"{label}{' [' + default + ']' if default else ''}: ").strip() or default
    settings = Settings(**values)
    settings.validate()
    public_key(settings.ssh_public_key_file)
    save_json(path, asdict(settings))
    print(f"Saved {path}. Run a preflight before starting retries.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / ".local/oci-free-vm.json")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--configure", action="store_true", help="Ask for local setup values; no cloud calls")
    actions.add_argument("--run", action="store_true", help="Create the VM when capacity becomes available")
    parser.add_argument("--max-attempts", type=int, default=0, help="Limit retry cycles; 0 means unlimited")
    args = parser.parse_args()
    try:
        if args.max_attempts < 0:
            raise ValueError("--max-attempts must be nonnegative")
        if args.configure:
            configure(args.config)
            return 0
        settings = Settings(**json.loads(args.config.read_text()))
        settings.validate()
        ssh_key = public_key(settings.ssh_public_key_file)
        cloud = OCICloud(settings.profile)
        state_path = args.config.with_suffix(".state.json")
        with tenancy_lock(cloud.tenancy):
            retry_launch(cloud, settings, ssh_key, state_path, run=args.run,
                         max_attempts=args.max_attempts,
                         log=lambda text: print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}", flush=True))
        return 0
    except KeyboardInterrupt:
        print("Stopped. Resume with the same config; any pending retry token is retained.")
        return 130
    except (ValueError, TypeError, OSError, ApiError) as error:
        print(f"Stopped: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
