# Terraform `rds` Module

Provisions an Aurora PostgreSQL cluster with its own subnet group and security
group, ready for the EziAgric backend to connect to.

## Overview

The module creates a single Aurora cluster plus a configurable number of
instances, places them in the private subnets of the [`vpc`](../vpc/README.md)
module, and locks network access down with a dedicated security group that only
admits the configured CIDR blocks on the database port.

The database is the system of record for off-chain trade metadata. See
[`docs/data-model-relationships.md`](../../../../docs/data-model-relationships.md)
for the schema context and
[`docs/pii-encryption.md`](../../../../docs/pii-encryption.md) for how PII is
protected at rest.

## Resources

| Resource | Type | Purpose |
|---|---|---|
| `aws_db_subnet_group.this` | `aws_db_subnet_group` | Places the cluster across the supplied private subnets |
| `aws_security_group.this` | `aws_security_group` | Ingress on `port` from `allowed_cidr_blocks`; unrestricted egress. Uses `create_before_destroy` so replacements do not drop traffic |
| `aws_rds_cluster.this` | `aws_rds_cluster` | Aurora cluster: engine, credentials, backup retention and window, subnet group, security group, deletion protection |
| `aws_rds_cluster_instance.this` | `aws_rds_cluster_instance` | `replica_count` instances in the cluster, identified `<project>-rds-instance-<n>` |

Every resource is tagged `Name` and `Environment`.

## Inputs

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `project_name` | `string` | — | yes | Project name. Used as the resource name prefix and the `Name` tag. |
| `environment` | `string` | — | yes | Environment name (e.g. `dev`, `staging`). Applied as the `Environment` tag. |
| `vpc_id` | `string` | — | yes | VPC ID in which the security group is created. Use `module.vpc.vpc_id`. |
| `subnet_ids` | `list(string)` | — | yes | Subnet IDs for the DB subnet group. Use `module.vpc.private_subnet_ids`. |
| `allowed_cidr_blocks` | `list(string)` | `[]` | no | CIDR blocks allowed to reach the database on `port`. **Empty means no inbound access at all.** |
| `engine` | `string` | `"aurora-postgresql"` | no | Database engine. |
| `engine_version` | `string` | `"15.4"` | no | Engine version. |
| `instance_class` | `string` | `"db.t3.medium"` | no | Instance class for every cluster instance. |
| `database_name` | `string` | — | yes | Name of the initial database created in the cluster. |
| `master_username` | `string` | — | yes | Master username. Marked sensitive in the calling environment. |
| `master_password` | `string` | — | yes | Master password. **Sensitive** — never commit it to a `*.tfvars` file. |
| `port` | `number` | `5432` | no | Database port; also the port opened in the security group. |
| `replica_count` | `number` | `1` | no | Number of instances in the cluster. `1` = writer only, `2` = writer + one reader. |
| `backup_retention_period` | `number` | `7` | no | Automated backup retention in days. |
| `preferred_backup_window` | `string` | `"03:00-04:00"` | no | Preferred daily backup window (UTC). |
| `skip_final_snapshot` | `bool` | `false` | no | Skip the final snapshot when the cluster is destroyed. |
| `deletion_protection` | `bool` | `true` | no | Block deletion of the cluster while enabled. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `cluster_endpoint` | `string` | Writer endpoint — use this for application connections. |
| `cluster_reader_endpoint` | `string` | Reader endpoint — use this for read-only queries and reporting. |
| `cluster_id` | `string` | ID of the Aurora cluster. |
| `instance_ids` | `list(string)` | IDs of the cluster instances. |

## Usage

```hcl
module "rds" {
  source = "../../modules/rds"

  project_name            = "amana"
  environment              = "dev"
  vpc_id                  = module.vpc.vpc_id
  subnet_ids              = module.vpc.private_subnet_ids
  allowed_cidr_blocks     = [module.vpc.vpc_cidr]
  engine                  = "aurora-postgresql"
  engine_version          = "15.4"
  instance_class          = "db.t3.medium"
  database_name           = "amana_dev"
  master_username         = var.db_master_username
  master_password         = var.db_master_password
  port                    = 5432
  replica_count           = 1
  backup_retention_period = 7
  preferred_backup_window = "03:00-04:00"
  skip_final_snapshot     = true
  deletion_protection     = false
}
```

A live example lives in
[`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf);
staging uses the same block with larger instances, a 30-day backup window, and
deletion protection enabled.

Point the backend at the cluster with the writer endpoint:

```
postgresql://<master_username>:<master_password>@<cluster_endpoint>:5432/<database_name>
```

## Operational notes

- **`allowed_cidr_blocks` defaults to `[]`.** With an empty list the security
  group has no inbound rule at all and nothing — not even the EKS node group —
  can reach the database. Set it explicitly (the environments use
  `[module.vpc.vpc_cidr]`).
- **The master password lands in Terraform state.** The password is stored on
  the cluster resource, so the state file must stay encrypted. The environment
  backends use an S3 bucket with `encrypt = true` and a DynamoDB lock table.
  Prefer injecting the value via `TF_VAR_db_master_password` from a secret
  store over a committed `*.tfvars` file.
- **`deletion_protection` defaults to `true`.** Set it to `false` (and let the
  change apply) before destroying the cluster, otherwise the destroy fails.
- **`skip_final_snapshot` should stay `false` outside dev.** The dev
  environment sets it to `true` so that tearing down the stack does not leave
  paid-for snapshots behind.
- **Aurora readers scale out, they do not replace the writer.** `replica_count`
  counts cluster instances; the cluster always keeps one writer. Use
  `cluster_reader_endpoint` for analytics so reporting does not contend with
  trade traffic.
- **Backups are managed by the cluster**, not by the database. Restore
  procedures are in
  [`docs/runbooks/database-migration.md`](../../../../docs/runbooks/database-migration.md).
- **The security group allows all egress** (`0.0.0.0/0`). Egress is restricted
  at the network-policy layer in the Kubernetes manifests, not here.

## Related

- [`../vpc/README.md`](../vpc/README.md) — provides `vpc_id` and
  `private_subnet_ids`
- [`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf) —
  dev wiring
- [`docs/secrets-policy.md`](../../../../docs/secrets-policy.md) — where the
  database credentials are expected to come from
- [`docs/data-model-relationships.md`](../../../../docs/data-model-relationships.md) —
  what lives in this database
- [`docs/runbooks/database-migration.md`](../../../../docs/runbooks/database-migration.md) —
  migration and restore procedures
