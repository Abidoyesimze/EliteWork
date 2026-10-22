# Terraform `redis` Module

Provisions an ElastiCache for Redis replication group — a Multi-AZ, encrypted,
password-protected cache cluster — together with its own subnet group and
security group.

## Overview

Redis backs the backend's queues, distributed locks, cache, and rate limiting.
This module creates the managed cluster that those consumers talk to, placed in
the private subnets of the [`vpc`](../vpc/README.md) module and reachable only
from the CIDR blocks in `allowed_cidr_blocks`.

The expected behaviour of every consumer during a Redis outage is specified in
[`docs/redis-resilience.md`](../../../../docs/redis-resilience.md), and the
maintenance-window procedure lives in
[`docs/runbooks/redis-maintenance.md`](../../../../docs/runbooks/redis-maintenance.md).

## Resources

| Resource | Type | Purpose |
|---|---|---|
| `aws_security_group.this` | `aws_security_group` | Ingress on `port` from `allowed_cidr_blocks`; unrestricted egress. Uses `create_before_destroy` so replacements do not drop traffic |
| `aws_elasticache_subnet_group.this` | `aws_elasticache_subnet_group` | Places the replication group across the supplied private subnets |
| `aws_elasticache_replication_group.this` | `aws_elasticache_replication_group` | The Redis replication group: node type, cluster count, engine, parameter group, encryption, auth token, and snapshot settings |

Every resource is tagged `Name` and `Environment`.

## Inputs

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `project_name` | `string` | — | yes | Project name. Used as the replication group ID and the `Name` tag. |
| `environment` | `string` | — | yes | Environment name (e.g. `dev`, `staging`). Applied as the `Environment` tag. |
| `vpc_id` | `string` | — | yes | VPC ID in which the security group is created. Use `module.vpc.vpc_id`. |
| `subnet_ids` | `list(string)` | — | yes | Subnet IDs for the cache subnet group. Use `module.vpc.private_subnet_ids`. |
| `allowed_cidr_blocks` | `list(string)` | `[]` | no | CIDR blocks allowed to reach Redis on `port`. **Empty means no inbound access at all.** |
| `engine` | `string` | `"redis"` | no | Cache engine. |
| `engine_version` | `string` | `"7.0"` | no | Engine version. |
| `node_type` | `string` | `"cache.t3.medium"` | no | Cache node type for every node in the group. |
| `port` | `number` | `6379` | no | Redis port; also the port opened in the security group. |
| `replica_count` | `number` | `2` | no | Number of cache clusters (`number_cache_clusters`). **Includes the primary** — the default of `2` is one primary plus one replica. |
| `parameter_group_name` | `string` | `"default.redis7"` | no | Parameter group applied to the group. Must already exist. |
| `automatic_failover_enabled` | `bool` | `true` | no | ElastiCache promotes a replica automatically if the primary fails. |
| `multi_az_enabled` | `bool` | `true` | no | Spread the nodes across availability zones. |
| `at_rest_encryption_enabled` | `bool` | `true` | no | Encrypt the data on disk and the snapshots. |
| `transit_encryption_enabled` | `bool` | `true` | no | Encrypt client ↔ Redis traffic (TLS). |
| `auth_token` | `string` | — | yes | Password (16–128 printable characters) clients must present. **Sensitive** — never commit it. |
| `snapshot_retention_limit` | `number` | `5` | no | Number of days snapshots are retained. `0` disables snapshots. |
| `snapshot_window` | `string` | `"02:00-03:00"` | no | Daily snapshot window (UTC). |

## Outputs

| Name | Type | Description |
|---|---|---|
| `primary_endpoint` | `string` | Primary (writer) endpoint — use this for application connections. |
| `reader_endpoint` | `string` | Reader endpoint for read-only clients. |
| `replication_group_id` | `string` | ID of the replication group. |
| `port` | `number` | Port the group is listening on. |

## Usage

```hcl
module "redis" {
  source = "../../modules/redis"

  project_name              = "amana"
  environment                = "dev"
  vpc_id                    = module.vpc.vpc_id
  subnet_ids                = module.vpc.private_subnet_ids
  allowed_cidr_blocks       = [module.vpc.vpc_cidr]
  engine                    = "redis"
  engine_version            = "7.0"
  node_type                 = "cache.t3.medium"
  port                      = 6379
  replica_count             = 2
  parameter_group_name      = "default.redis7"
  automatic_failover_enabled = true
  multi_az_enabled          = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                = var.redis_auth_token
  snapshot_retention_limit  = 5
  snapshot_window           = "02:00-03:00"
}
```

A live example lives in
[`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf);
staging uses the same block with larger nodes, three cache clusters, and a
14-day snapshot window.

Point the backend at the group with the primary endpoint, carrying the auth
token as the URL password and using `rediss://` because transit encryption is
on:

```
rediss://:<auth_token>@<primary_endpoint>:6379
```

The backend reads this from `REDIS_URL`
(see [`backend/src/config/env.ts`](../../../../backend/src/config/env.ts)).

## Operational notes

- **`replica_count` includes the primary.** It is passed straight to
  `num_cache_clusters`, so the default `2` means one primary plus one
  replica — not two replicas.
- **Failover and Multi-AZ need at least two cache clusters.** AWS rejects
  `automatic_failover_enabled = true` or `multi_az_enabled = true` on a group
  with a single node. Keep `replica_count >= 2` when either flag is on.
- **`allowed_cidr_blocks` defaults to `[]`.** With an empty list the security
  group has no inbound rule and no client can connect. Set it explicitly (the
  environments use `[module.vpc.vpc_cidr]`).
- **`transit_encryption_enabled = true` requires a TLS client.** The backend
  connects with `ioredis`, so `REDIS_URL` must use the `rediss://` scheme — a
  plain `redis://` URL will fail the handshake against an encrypted group.
- **`auth_token` is required and sensitive.** The token is stored in Terraform
  state, so the state file must stay encrypted. The AWS provider also rejects
  tokens shorter than 16 characters or containing `/`, `"`, or `@`.
- **The auth token cannot be rotated in place** on a replication group —
  changing it replaces the group, which is a disruptive operation. Plan
  maintenance accordingly; the runbook covers the procedure.
- **Snapshots are enabled by default** (`snapshot_retention_limit = 5`). Setting
  it to `0` disables snapshots entirely and removes the last restore point.
- **The security group allows all egress** (`0.0.0.0/0`). Egress is restricted
  at the network-policy layer in the Kubernetes manifests, not here.

## Related

- [`../vpc/README.md`](../vpc/README.md) — provides `vpc_id` and
  `private_subnet_ids`
- [`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf) —
  dev wiring
- [`docs/redis-resilience.md`](../../../../docs/redis-resilience.md) — expected
  behaviour per consumer when Redis is unavailable
- [`docs/runbooks/redis-maintenance.md`](../../../../docs/runbooks/redis-maintenance.md) —
  maintenance-window procedure that guarantees no payout risk
- [`docs/idempotency-redis-roundtrips.md`](../../../../docs/idempotency-redis-roundtrips.md) —
  how the idempotency middleware uses this cluster
