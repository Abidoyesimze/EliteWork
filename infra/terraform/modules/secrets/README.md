# Terraform `secrets` Module

Creates the AWS Secrets Manager container that holds `ADMIN_SECRET_KEY` — the
Stellar Soroban signing key used by backend admin operations — and attaches the
IAM policy that lets the EKS node role read it.

## Overview

The module is built around a hard rule: **the secret value is never written to
Terraform state, Git, Kubernetes manifests, or logs.** Terraform creates the
secret container with a placeholder version; the real value is injected out of
band with the AWS CLI immediately after the first apply.

The full provisioning, rotation, and troubleshooting procedure is documented in
[`docs/admin-secret-management.md`](../../../../docs/admin-secret-management.md),
and the wider inventory in
[`docs/secrets-policy.md`](../../../../docs/secrets-policy.md).

## Resources

| Resource | Type | Purpose |
|---|---|---|
| `aws_secretsmanager_secret.admin_secret_key` | `aws_secretsmanager_secret` | Secret container named `<project>-<environment>-admin-secret-key` |
| `aws_secretsmanager_secret_version.admin_secret_key` | `aws_secretsmanager_secret_version` | Initial placeholder version (`REPLACE_WITH_ADMIN_SECRET_KEY`) with `ignore_changes = [secret_string]`, so Terraform never overwrites the injected value |
| `aws_iam_policy_document.admin_secret_key_read` (data) | `aws_iam_policy_document` | Policy document allowing `secretsmanager:GetSecretValue` and `secretsmanager:DescribeSecret` on this secret only |
| `aws_iam_policy.admin_secret_key_read` | `aws_iam_policy` | Customer-managed IAM policy carrying that document |
| `aws_iam_role_policy_attachment.admin_secret_key_read` | `aws_iam_role_policy_attachment` | Attaches the policy to the EKS node role |

## Inputs

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `project_name` | `string` | — | yes | Project name. Used as the name prefix of the secret and the IAM policy. |
| `environment` | `string` | — | yes | Environment name (e.g. `dev`, `staging`). Part of the secret name and the `Environment` tag. |
| `eks_node_role_name` | `string` | — | yes | IAM role of the EKS worker nodes, as a **name or an ARN** — the environments pass `module.eks.node_role_arn`. The read policy is attached to it. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `secret_arn` | `string` | ARN of the secret. Use it in a K8s `ExternalSecret` or the Secrets Store CSI driver. |
| `secret_name` | `string` | Name of the secret, for use with `aws secretsmanager` CLI commands. |
| `secret_read_policy_arn` | `string` | ARN of the IAM policy granting read access. |

None of the outputs expose the secret value.

## Usage

```hcl
module "secrets" {
  source = "../../modules/secrets"

  project_name       = "amana"
  environment        = "dev"
  eks_node_role_name = module.eks.node_role_arn
}
```

A live example lives in
[`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf);
staging wires the same three inputs.

After the first apply, inject the real signing key — the placeholder is
rejected by the backend's health check:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw secret_name)" \
  --secret-string "S<your-56-char-base32-secret-key>"
```

## Operational notes

- **Terraform creates the container, not the value.** The first version holds
  the literal placeholder `REPLACE_WITH_ADMIN_SECRET_KEY`. The
  `ignore_changes = [secret_string]` lifecycle rule means subsequent applies
  leave whatever you injected in place — Terraform will not reset it to the
  placeholder.
- **Inject the real value immediately after the first apply.** Until you do,
  the secret exists but carries a non-functional value, and the backend's
  `adminSigningKey` health check fails.
- **The real value never enters Terraform state.** It is written through the
  AWS CLI, not through Terraform, so it is absent from the state file, from
  plan output, and from CI logs.
- **Read access is scoped to the EKS node role and to this one secret.** The
  policy grants only `GetSecretValue` and `DescribeSecret` on the secret ARN.
  Pods reach the value through the node role, so the pod's service account
  needs no additional IAM binding.
- **Rotation is out of band.** Generate a new Stellar keypair, call
  `put-secret-value` again, and restart the backend pods. The steps and the
  verification command are in
  [`docs/admin-secret-management.md`](../../../../docs/admin-secret-management.md#rotation).
- **Automatic rotation is not implemented in this module.** The module creates
  no `aws_secretsmanager_secret_rotation` resource — until one is added, rotation
  is the manual procedure above.
  [`docs/admin-secret-management.md`](../../../../docs/admin-secret-management.md#automated-rotation-optional)
  describes the shape of the rotation Lambda.
- **The secret name is environment-scoped.** It resolves to
  `amana-<environment>-admin-secret-key`, matching the names used by the
  Kubernetes manifests and the rotation docs.

## Related

- [`../eks/README.md`](../eks/README.md) — provides the `node_role_arn` used to
  attach the read policy
- [`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf) —
  dev wiring
- [`docs/admin-secret-management.md`](../../../../docs/admin-secret-management.md) —
  provisioning, rotation, and troubleshooting for `ADMIN_SECRET_KEY`
- [`docs/secrets-policy.md`](../../../../docs/secrets-policy.md) — secrets
  inventory, owners, and rotation cadence
- [`docs/admin-secret-rotation.md`](../../../../docs/admin-secret-rotation.md) —
  rotation automation
