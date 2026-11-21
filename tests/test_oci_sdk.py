"""Exercise official SDK request construction without contacting OCI."""

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.oci_free_vm import ApiError, OCICloud, Settings, SHAPE

try:
    import oci
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
except ImportError:
    oci = None


@unittest.skipUnless(oci, "install scripts/requirements-cloud.txt to check SDK integration")
class SDKTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.config = dict(tenancy="ocid1.tenancy.oc1..test", user="ocid1.user.oc1..test",
                          fingerprint=":".join(["00"] * 16), region="eu-stockholm-1",
                          key_content=key.private_bytes(serialization.Encoding.PEM,
                              serialization.PrivateFormat.TraditionalOpenSSL,
                              serialization.NoEncryption()).decode())

    def setUp(self):
        self.cloud = object.__new__(OCICloud)
        self.cloud.oci = oci
        self.cloud.network_error = (oci.exceptions.RequestException, oci.exceptions.ConnectTimeout)
        self.cloud.tenancy = self.config["tenancy"]
        self.cloud.region = self.config["region"]
        self.settings = Settings("ocid1.compartment.test", "ocid1.subnet.test", "ocid1.image.test", "unused.pub")
        self.requests = []
        options = dict(retry_strategy=oci.retry.NoneRetryStrategy(),
                       circuit_breaker_strategy=oci.circuit_breaker.NoCircuitBreakerStrategy())
        for name, client in (("identity", oci.identity.IdentityClient), ("compute", oci.core.ComputeClient),
                             ("storage", oci.core.BlockstorageClient), ("network", oci.core.VirtualNetworkClient)):
            value = client(self.config, **options)
            value.base_client.call_api = self.respond
            setattr(self.cloud, name, value)

    def respond(self, resource_path, method, **kwargs):
        self.requests.append((resource_path, method, kwargs))
        responses = {
            "/regionSubscriptions": [SimpleNamespace(is_home_region=True, region_name=self.cloud.region)],
            "/availabilityDomains": [SimpleNamespace(name="AD-1")],
            "/compartments": [SimpleNamespace(id=self.settings.compartment_id)],
            "/subnets/{subnetId}": SimpleNamespace(prohibit_public_ip_on_vnic=False,
                                                   lifecycle_state="AVAILABLE", availability_domain=None),
            "/images/{imageId}": SimpleNamespace(compartment_id=None,
                operating_system="Canonical Ubuntu", lifecycle_state="AVAILABLE"),
        }
        data = responses.get(resource_path, [])
        if resource_path.endswith("/regionSubscriptions"):
            data = responses["/regionSubscriptions"]
        if method == "POST":
            data = SimpleNamespace(id="vm-1", lifecycle_state="PROVISIONING")
        return oci.response.Response(200, {}, data, None)

    def test_preflight_and_inventory_use_supported_sdk_parameters(self):
        self.assertEqual(self.cloud.validate(self.settings), ["AD-1"])
        self.assertEqual(self.cloud.inventory(), ([], []))
        for path in ("/volumes", "/bootVolumes"):
            queries = [kwargs["query_params"] for resource, _, kwargs in self.requests if resource == path]
            self.assertEqual({item["compartmentId"] for item in queries},
                             {self.cloud.tenancy, self.settings.compartment_id})
            if path == "/bootVolumes":
                self.assertTrue(all(item["availabilityDomain"] == "AD-1" for item in queries))

    def test_launch_serializes_bounded_shape_disk_and_retry_token(self):
        self.cloud.launch(self.settings, "public-key", {"domain": "AD-1", "token": "retry-token"}, "run-id")
        path, method, kwargs = self.requests[-1]
        self.assertEqual((path, method), ("/instances", "POST"))
        details = oci.util.to_dict(kwargs["body"])
        self.assertEqual(details["shape"], SHAPE)
        self.assertEqual(details["shape_config"]["ocpus"], 2)
        self.assertEqual(details["shape_config"]["memory_in_gbs"], 12)
        self.assertEqual(details["source_details"]["boot_volume_size_in_gbs"], 50)
        self.assertEqual(details["source_details"]["boot_volume_vpus_per_gb"], 10)
        self.assertEqual(kwargs["header_params"]["opc-retry-token"], "retry-token")

    def test_configured_sdk_clients_construct_without_network(self):
        with patch.object(oci.config, "from_file", return_value=self.config):
            cloud = OCICloud("DEFAULT")
        self.assertEqual(cloud.tenancy, self.config["tenancy"])
        self.assertEqual(cloud.region, self.config["region"])

    def test_sdk_transport_and_throttle_errors_reach_retry_loop(self):
        for original, expected in ((oci.exceptions.ConnectTimeout("timeout"), 0),
                                   (oci.exceptions.RequestException("connection lost"), 0),
                                   (oci.exceptions.ServiceError(429, "TooManyRequests",
                                        {"Retry-After": "600"}, "throttle"), 429)):
            def fail(*args, **kwargs):
                raise original
            with self.subTest(error=type(original)), self.assertRaises(ApiError) as caught:
                self.cloud.call(fail)
            self.assertEqual(caught.exception.status, expected)
            if expected == 429:
                self.assertEqual(caught.exception.retry_after, 600)


if __name__ == "__main__":
    unittest.main()
