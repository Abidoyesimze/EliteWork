# Terraform `admin_isolation` Module

Creates the VPC security group that restricts the admin plane — the
`/api/admin/*` routes served by the backend on port `4000` — to trusted
internal management networks.

## Overview

The module is a single security group with two ingress rules (HTTPS on `443`
and the backend's own port `4000`) that are open **only** to the CIDR blocks
listed in `trusted_admin_cidrs`. Everything else — the public internet, guest
Wi-Fi, an untrusted contractor network — is denied at the VPC layer, before a
request ever reaches the Kubernetes cluster.

It is the VPC-level half of the admin isolation story. The pod-level half is
the `NetworkPolicy` in
[`infra/k8s/admin-network-policy.yaml`](../../../../infra/k8s/admin-network-policy.yaml),
and the edge half is the whitelisted internal ingress in
[`infra/k8s/admin-ingress.yaml`](../../../../infra/k8s/admin-ingress.yaml).
The three layers are described together in
[`docs/admin-network-isolation.md`](../../../../docs/admin-network-isolation.md).

The module creates **no** resources other than the security group: it is
attached to the backend's load balancer or node security group by the caller
via the `admin_security_group_id` output.

## Resources

| Resource | Type | Purpose |
|---|---|---|
| `aws_security_group.admin_access_sg` | `aws_security_group` | Named `<project>-<environment>-admin-sg`. Ingress on `443` and `4000` from `trusted_admin_cidrs`; unrestricted egress. Tagged `Name`, `Environment`, and `Policy = AdminEndpointIsolation` |

The `Policy` tag makes the security group discoverable from the AWS console
and from any compliance query that inventories admin-related controls.

## Inputs

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `project_name` | `string` | — | yes | Project name. Used as the security group name prefix and the `Name` tag. |
| `environment` | `string` | — | yes | Environment name (e.g. `staging`, `production`). Part of the security group name and the `Environment` tag. |
| `vpc_id` | `string` | — | yes | VPC ID in which the security group is created. Use `module.vpc.vpc_id`. |
| `trusted_admin_cidrs` | `list(string)` | `["10.0.0.0/16", "172.16.0.0/12"]` | no | CIDR blocks permitted to reach the admin endpoints. **Keep this list as narrow as the management network allows** — every entry is a full admin path. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `admin_security_group_id` | `string` | ID of the admin isolation security group. Attach it to the resource that fronts the backend (load balancer, ingress controller, or node security group). |

## Usage

```hcl
module "admin_isolation" {
  source = "../../modules/admin_isolation"

  project_name        = "amana"
  environment         = "staging"
  vpc_id              = module.vpc.vpc_id
  trusted_admin_cidrs = ["10.0.0.0/16", "172.16.0.0/12"]
}
```

A live example lives in
[`infra/terraform/environments/staging/main.tf`](../../environments/staging/main.tf);
production wires the same four inputs.

The output is attached by the caller — for example, to the backend's ingress
or load balancer:

```hcl
resource "aws_lb" "backend" {
  security_groups = [aws_security_group.backend.id, module.admin_isolation.admin_security_group_id]
  # ...
}
```

## Operational notes

- **The CIDR list is the whole control.** The security group has no other
  ingress rule, so an empty `trusted_admin_cidrs` list locks the admin plane
  off entirely — useful for a lockdown window, but it also locks out the
  operators who need it.
- **The defaults assume a VPN.** `10.0.0.0/16` and `172.16.0.0/12` are the
  private RFC 1918 ranges that the corporate VPN and the VPC itself occupy
  (see [`docs/admin-network-isolation.md`](../../../../docs/admin-network-isolation.md)).
  Replace them with the specific corporate egress ranges when they are known —
  a `/16` is a whole private network, and every host in it becomes an
  admin-capable source.
- **Both `443` and `4000` are opened.** `443` is the admin ingress listener;
  `4000` is the backend's own HTTP port, opened so an operator on the
  management VPN can reach the backend directly for diagnostics.
- **Egress is unrestricted** (`0.0.0.0/0`). The rule exists to constrain
  *who may call in*, not what the backend may call out; outbound traffic is
  restricted at the network-policy layer in the Kubernetes manifests.
- **The security group is not attached by this module.** Creating it grants
  nothing until the caller wires `admin_security_group_id` into the resource
  that fronts the backend — check that the attachment exists before assuming
  the isolation is in force.
- **The name embeds the environment**, so the same module can be applied to
  `dev`, `staging`, and `production` without a name collision across
  accounts.
- **Ingress rules are authoritative on creation.** AWS security groups are
  allow-only: a rule that is removed here is removed everywhere the group is
  attached, so treat the diff as a deliberate access change.

## Related

- [`../vpc/README.md`](../vpc/README.md) — provides `vpc_id`
- [`../eks/README.md`](../eks/README.md) — the cluster the admin endpoints run
  in, and the node security group the output is usually attached to
- [`docs/admin-network-isolation.md`](../../../../docs/admin-network-isolation.md) —
  the full isolation topology across the ingress, NetworkPolicy, and security
  group layers
- [`docs/admin-endpoint-security-checklist.md`](../../../../docs/admin-endpoint-security-checklist.md) —
  pre-release checklist for the admin plane
- [`docs/threat-model.md`](../../../../docs/threat-model.md) — the trust
  boundaries this control defends
- [`infra/k8s/admin-network-policy.yaml`](../../../../infra/k8s/admin-network-policy.yaml) —
  the pod-level counterpart to this module
