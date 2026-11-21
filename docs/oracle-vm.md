# Oracle Always Free VM retry tool

[`scripts/oci_free_vm.py`](../scripts/oci_free_vm.py) requests one Ubuntu ARM VM when capacity becomes available. It uses the official OCI Python SDK, an existing public subnet, and your SSH public key. It runs locally on Linux or macOS with Python 3.11 or newer. A preflight is the default; only `--run` sends instance creation requests.

The default request is `VM.Standard.A1.Flex`, 2 OCPU, 12 GB RAM, and a 50 GB balanced boot volume in the tenancy's home region. The tool inventories instances and boot/block volumes across active compartments before each launch cycle and refuses allocations above 2 OCPU, 12 GB RAM, or 200 GB total volume storage. It stops if it cannot read the inventory. Those ceilings reflect [Oracle's published Always Free allowances](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), checked October 8, 2026.

Inventory checks cover current allocations, not prior monthly usage, backups, other services, or simultaneous changes from another computer. Check your account's Always Free eligibility, usage, and billing in the Console before running. The script never upgrades the account or falls back to a paid shape. Capacity is not guaranteed, and Oracle may reclaim idle free instances.

## 1. Check account usage and Python

In the OCI Console, select the tenancy's **home region**. Check **Governance & Administration → Limits, Quotas and Usage**, plus billing/usage. The default request uses the script's full A1 CPU/RAM allowance; it needs that allocation to be unused. Existing VMs and volumes count toward shared allowances.

On the computer that will run the retries:

```bash
cd /home/tar_guest/webnovel-search
python3 --version
```

Use Python 3.11 or newer. On another computer, substitute the checkout's path. Windows users should run this tool in a Linux environment such as WSL: its lock uses Unix APIs. The computer must stay awake and connected while retrying.

## 2. Configure an OCI API signing key

The API signing key authorizes cloud requests. The SSH key in step 4 authorizes login to the eventual VM. Keep both private keys locally.

```bash
mkdir -p ~/.oci
chmod 700 ~/.oci
```

1. In the Console, open your profile's **User settings → API Keys**. For an identity-domain account, open your user's details under its domain if necessary.
2. Choose **Add API Key → Generate API Key Pair**, download the private key, and finish adding the key.
3. Move the downloaded PEM into `~/.oci/`, naming it `novelist_api_key.pem`. Use its actual download location and preserve any existing signing keys.
4. Copy the **Configuration File Preview** into `~/.oci/config`. If a config already exists, append a profile called `NOVELIST` instead of overwriting existing profiles.
5. Set `key_file` to the private key's absolute path and `region` to the home region identifier. Use the actual IDs/fingerprint from the Console snippet.

Example structure, with placeholders to replace locally:

```ini
[NOVELIST]
user=ocid1.user.oc1..YOUR_USER_ID
fingerprint=YOUR_KEY_FINGERPRINT
tenancy=ocid1.tenancy.oc1..YOUR_TENANCY_ID
region=YOUR_HOME_REGION_IDENTIFIER
key_file=/absolute/path/to/.oci/novelist_api_key.pem
```

```bash
chmod 600 ~/.oci/config ~/.oci/novelist_api_key.pem
```

If you already have a working profile, use it rather than generating another key. [Oracle's key procedure](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm), [configuration format](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/sdkconfig.htm).

The selected user needs permission to list compartments and read instances/volumes across the tenancy, read the selected image/subnet, and create an instance with its boot volume and VNIC in the target compartment. On a managed tenancy, ask its administrator for appropriate access. Incomplete inventory access stops the script; it does not modify IAM policies.

## 3. Prepare the public network

Reuse a suitable existing VCN/subnet if available. Otherwise, open **Networking → Virtual Cloud Networks** in the home region and create/open these resources in the target compartment:

| Resource | Setting |
| --- | --- |
| VCN | Name `novelist-vcn`, IPv4 CIDR `10.0.0.0/16` |
| Internet gateway | Enabled, attached to that VCN |
| Subnet route table | Destination `0.0.0.0/0` → that internet gateway |
| Subnet | Regional, public, CIDR `10.0.0.0/24`, associated with that route table |

Use the VCN's Internet Gateways, Route Tables, and Subnets pages. A regional subnet lets the retry loop switch compatible availability domains without changing networks. This setup needs no NAT gateway or load balancer.

In the subnet's security list, allow **stateful TCP ingress** from your current public IPv4 address with `/32` appended, destination port **22**, source ports all. Check existing rules if reusing a list; remove a redundant world-open SSH rule only after confirming your own source rule. Preserve required egress/ICMP rules so downloads and network diagnostics work.

Keep application port 8080 closed to the internet. Open 80/443 later when configuring HTTPS. [Oracle's internet gateway and security-rule instructions](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingIGs.htm).

Copy the **subnet OCID** from its details and the **compartment OCID** from the target compartment's details. For the root compartment, use the tenancy OCID from your OCI profile. The tool checks that the subnet is public and available; verify its routing and security rules manually.

## 4. Prepare SSH access and an image OCID

If you need a new SSH key:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/novelist_vm -C novelist-vm
```

Choose a passphrase. If that filename exists, reuse its key or choose another name; do not overwrite it. The wizard uses `~/.ssh/novelist_vm.pub`. Connecting afterward uses `~/.ssh/novelist_vm`.

In **Compute → Instances → Create instance**, select `VM.Standard.A1.Flex` and a compatible **Canonical Ubuntu 24.04 or 22.04 ARM64 platform image**. Copy the image OCID without submitting a launch. Alternatively, open [Oracle's image release listings](https://docs.oracle.com/en-us/iaas/images/), choose a current Ubuntu ARM64 image, and copy the OCID for your home region from that release's details. Choose standard Ubuntu: Oracle documents that Minimal Ubuntu is unsuitable for its ARM shapes. Custom and Marketplace images are refused by this script. [Platform images](https://docs.oracle.com/en-us/iaas/Content/Compute/References/images.htm).

You now have the profile name, compartment/subnet/image OCIDs, and SSH public-key path. These values are entered locally; no credentials need to be sent in chat.

## 5. Install, configure, and check

From the repository root:

```bash
python3 -m venv .venv-cloud
.venv-cloud/bin/python -m pip install -r scripts/requirements-cloud.txt
.venv-cloud/bin/python scripts/oci_free_vm.py --configure
.venv-cloud/bin/python scripts/oci_free_vm.py
```

Answer the wizard:

| Prompt | Enter |
| --- | --- |
| OCI profile | `NOVELIST`, or your existing profile name |
| Target compartment OCID | Compartment or tenancy OCID from step 3 |
| Existing public subnet OCID | Subnet OCID from step 3 |
| Ubuntu ARM platform image OCID | Image OCID from step 4 |
| SSH public key file | `~/.ssh/novelist_vm.pub`, or your chosen `.pub` path |
| VM name | `novelist`, or another recognizable unique name |

It saves `.local/oci-free-vm.json` with owner-only permissions. The final command above performs the read-only preflight. Expect `Preflight OK` with your home region, A1 shape, 2 OCPU, 12 GB RAM, and 50 GB boot disk. This checks configuration/current allocation; it cannot reserve capacity. An existing matching VM is reported instead.

The local config/state, optional virtual environment, and credentials directories are excluded from Git and Docker context. The API key stays outside the checkout in `~/.oci/`. If configuration already exists, inspect that local JSON rather than overwriting it.

## 6. Run the retries

After preflight succeeds:

```bash
.venv-cloud/bin/python scripts/oci_free_vm.py --run
```

Keep the computer awake and the process running. `Ctrl+C` stops it; the same command resumes later. A successful launch prints the instance OCID and exits immediately. Check **Compute → Instances** for `RUNNING` and the public IP. This tool provisions a VM; it does not install or deploy NoveList.

If installed, `tmux` lets the process continue when its terminal window closes:

```bash
tmux new -s novelist-oci
.venv-cloud/bin/python scripts/oci_free_vm.py --run
```

Press **Ctrl+B**, release, then **D** to detach. Reconnect using `tmux attach -t novelist-oci`; stop the script with `Ctrl+C` inside that session. The session does not survive a reboot or keep a sleeping computer online.

To limit a run, add `--max-attempts 10`. A cycle includes inventory and at most one launch request. To use another configuration location, pass `--config /absolute/path/vm.json` consistently to all commands. [`oci-free-vm.example.json`](../scripts/oci-free-vm.example.json) shows the fields; the wizard creates the usable local file.

## 7. Retry behavior and troubleshooting

- Capacity rejections advance to the next compatible availability domain. `interval_seconds` sets the interval **per AD**: the default 120 is divided across eligible ADs to stagger requests. With three ADs, attempts are approximately at 0s (AD1), 40s (AD2), 80s (AD3), and 120s (AD1 again). With one AD, the delay remains 120 seconds. Request/inventory time can extend the schedule.
- Throttling, network failures, and temporary server errors use exponential backoff, up to 30 minutes before jitter. An OCI `Retry-After` header can extend that delay. SDK retries and circuit breakers are disabled so the loop controls pacing.
- Capacity delays have no added jitter; `Retry-After` can extend them. Throttling and ambiguous failures retain shared exponential backoff with a minimum 60-second delay plus jitter. `interval_seconds` accepts integers from 1 to 86400; for example, 15 with three ADs gives a five-second wait between requests. These settings are not an Oracle rate-limit guarantee.
- A pending launch's token, domain, and next retry time are saved **before** the request in a sibling `.state.json` file. Ambiguous responses reuse that request, including after a restart. Explicit capacity rejection clears it. An ambiguous token older than 23 hours causes a stop before OCI's 24-hour token expiry; inspect the Console before repairing that state.
- The tool recognizes its recorded instance, its run tag, or an existing instance with the same name in the target compartment. It exits when one exists and refuses multiple matches. A local tenancy lock prevents two copies on the same computer. Run only one provisioner per tenancy across all computers.

Authentication, permissions, invalid configuration, or unsupported resources cause a stop. Startup preflight errors also stop: fix the problem and rerun. Preserve both configuration and state when resuming; do not delete state to bypass a pending launch or allocation check.

| Message or symptom | Action |
| --- | --- |
| `No host capacity` | Leave the loop running; this is the expected rejection. |
| HTTP 429 | Allow the backoff; avoid additional retry processes. |
| HTTP 401 | Check profile, key path, fingerprint, registered API key, and computer clock. |
| HTTP 403/404 | Check region, resource IDs, compartment, and IAM access. OCI may hide inaccessible resources as missing. |
| Insufficient CPU/RAM/storage allowance | Review existing allocations. Reduce the requested allocation before starting if appropriate; do not delete resources to bypass checks. |
| Changed config / old ambiguous token | Reconcile the state with the Console before any fresh request; keep the state file. |
| SSH timeout after launch | Check `RUNNING`, public IP, subnet route, current source IP in port-22 rule, and guest firewall. |
| SSH permission denied | Use the `ubuntu` user and the private key paired with the configured `.pub` file. |

You can change `interval_seconds` between runs without invalidating pending launch tokens. The fingerprint excludes timing but continues to protect all other settings. Older fingerprints are migrated by verifying that only a previously valid integer interval differs; pending tokens, run IDs, AD position, and persisted cooldowns are retained. Read-only preflight does not write migrated state. Other configuration changes still require reconciliation.

To activate the staggered cadence on an already running process, stop it with `Ctrl+C` and rerun the same `--run` command. Existing configuration, pending tokens, AD position, and cooldown state remain valid. A previously saved longer cooldown is honored before the new cadence takes effect. No state deletion or configuration edit is needed.

## 8. Connect after allocation

Wait for `RUNNING` in the Console and copy the public IP. From your computer, replace `VM_PUBLIC_IP` and connect:

```bash
ssh -i ~/.ssh/novelist_vm ubuntu@VM_PUBLIC_IP
```

On the VM:

```bash
uname -m
free -h
df -h /
```

Expect an ARM64 host (`aarch64`), the requested memory, and its boot filesystem. Preserve the provisioner's local configuration/state. Rerunning should report the existing VM.

## Application deployment comes next

NoveList needs a persistent data directory, HTTPS termination, and an independently retained backup. On this VM, local disk can hold the current SQLite databases and index, avoiding a database rewrite. The next steps are:

1. Install Docker using its supported Ubuntu instructions and clone the reviewed repository onto the VM.
2. Build the root Dockerfile and verify the model/index load on ARM64. This repository's image has not been validated on an A1 host.
3. Set a unique administrator password, mount durable data outside the image, and start one API instance bound to loopback. Use the fictional seed or restore an approved catalogue backup.
4. Through an SSH tunnel, check health, search, registration/sign-in, reading library, and persistence after replacing the container.
5. Configure a reverse proxy with HTTPS, point your subdomain at the VM, and permit 80/443 in the OCI security list and guest firewall. Preserve Oracle's platform firewall rules when adjusting the guest firewall.
6. Retain an encrypted backup off the VM and test restore using the [backup procedure](deployment.md#back-up-and-restore).

After provisioning, complete these steps from the VM host. [Render deployment guide](deployment.md)
