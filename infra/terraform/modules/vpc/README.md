# Terraform `vpc` Module

Provisions the AWS network foundation for an EziAgric environment: one VPC, an
Internet gateway, public and private subnets spread across availability zones,
and NAT gateways that give the private subnets outbound internet access.

## Overview

This module is the root of the Terraform dependency graph — every other module
in `infra/terraform/modules/` consumes its outputs:

| Consumer | Uses |
|---|---|
| [`rds`](../rds/README.md) | `vpc_id`, `private_subnet_ids` — Aurora cluster placement and its security group |
| [`redis`](../redis/README.md) | `vpc_id`, `private_subnet_ids` — ElastiCache replication group placement and its security group |
| [`eks`](../eks/README.md) | `vpc_id`, `private_subnet_ids` — control plane VPC config and node group subnets |
| [`admin_isolation`](../admin_isolation/README.md) | `vpc_id` — security group that restricts admin endpoint access |

The module is deliberately network-only. It creates **no security groups** of
its own: data-store security groups live in the `rds` and `redis` modules, and
admin endpoint isolation lives in the `admin_isolation` module.

## Resources

| Resource | Type | Purpose |
|---|---|---|
| `aws_vpc.this` | `aws_vpc` | VPC with DNS support and DNS hostnames enabled |
| `aws_internet_gateway.this` | `aws_internet_gateway` | IGW attached to the VPC; terminates the public route |
| `aws_subnet.public` | `aws_subnet` | One public subnet per entry in `public_subnet_cidrs`; `map_public_ip_on_launch = true` |
| `aws_subnet.private` | `aws_subnet` | One private subnet per entry in `private_subnet_cidrs`; no public IP mapping |
| `aws_eip.nat` | `aws_eip` | Elastic IP for each NAT gateway (VPC domain) |
| `aws_nat_gateway.this` | `aws_nat_gateway` | NAT gateway in a public subnet; provides egress for private subnets |
| `aws_route_table.public` | `aws_route_table` | Public route table — `0.0.0.0/0` → internet gateway |
| `aws_route_table.private` | `aws_route_table` | One private route table per NAT gateway — `0.0.0.0/0` → NAT gateway |
| `aws_route_table_association.public` | `aws_route_table_association` | Binds every public subnet to the public route table |
| `aws_route_table_association.private` | `aws_route_table_association` | Binds every private subnet to a private route table (round-robin over NAT gateways) |

Every resource is tagged `Name` and `Environment`.

## Inputs

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `project_name` | `string` | — | yes | Project name. Used as the resource name prefix and the `Name` tag. |
| `environment` | `string` | — | yes | Environment name (e.g. `dev`, `staging`). Applied as the `Environment` tag. |
| `region` | `string` | — | yes | AWS region. Declared for parity with the other modules; the module body does not reference it, so the region is taken from the `aws` provider in the calling environment. |
| `vpc_cidr` | `string` | — | yes | CIDR block for the VPC. Must contain every public and private subnet CIDR. |
| `public_subnet_cidrs` | `list(string)` | — | yes | CIDR blocks for the public subnets. One subnet is created per entry. |
| `private_subnet_cidrs` | `list(string)` | — | yes | CIDR blocks for the private subnets. One subnet is created per entry. |
| `availability_zones` | `list(string)` | — | yes | Availability zones, matched **positionally** against both subnet CIDR lists. |
| `nat_gateway_count` | `number` | `1` | no | Number of NAT gateways, and therefore the number of private route tables. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `vpc_id` | `string` | ID of the VPC. Pass to `rds`, `redis`, `eks`, and `admin_isolation`. |
| `vpc_cidr` | `string` | CIDR block of the VPC. Pass to the `allowed_cidr_blocks` of `rds` and `redis`. |
| `public_subnet_ids` | `list(string)` | IDs of the public subnets, in `public_subnet_cidrs` order. |
| `private_subnet_ids` | `list(string)` | IDs of the private subnets, in `private_subnet_cidrs` order. |
| `nat_gateway_ids` | `list(string)` | IDs of the NAT gateways, in creation order. |

## Usage

```hcl
module "vpc" {
  source = "../../modules/vpc"

  project_name         = "amana"
  environment          = "dev"
  region               = var.region
  vpc_cidr             = "10.0.0.0/16"
  public_subnet_cidrs  = ["10.0.1.0/24", "10.0.2.0/24"]
  private_subnet_cidrs = ["10.0.10.0/24", "10.0.11.0/24"]
  availability_zones   = ["us-east-1a", "us-east-1b"]
  nat_gateway_count    = 1
}
```

A live example lives in
[`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf)
and its staging counterpart in
[`infra/terraform/environments/staging/main.tf`](../../environments/staging/main.tf).

## Operational notes

- **Subnet/AZ counts must line up.** Subnets are placed with
  `availability_zones[count.index]`, so `availability_zones` must contain at
  least as many entries as the longest subnet CIDR list. Mismatches fail at
  `terraform plan` with an index-out-of-range error.
- **`nat_gateway_count` must be at least 1.** The private route table
  association divides by `nat_gateway_count`; a value of `0` fails the plan.
- **NAT gateways are placed in the first N public subnets**
  (`aws_subnet.public[count.index]`), so `nat_gateway_count` must not exceed
  `length(public_subnet_cidrs)`.
- **NAT gateways are billed per hour.** Use `nat_gateway_count = 1` in dev and
  spread them across AZs only where the environment needs AZ-redundant egress
  (staging uses one per AZ).
- **Private subnets carry no public IPs.** The EKS node group, Aurora cluster,
  and ElastiCache replication group all live here, so they are reachable only
  from inside the VPC — this is what keeps admin endpoints and data stores off
  the public internet.
- **Public subnets exist for NAT gateways** (and for any future public load
  balancer). They are not used by the data-store modules.
- **There is no default route for the VPC itself** beyond the public and
  private route tables; on-prem or peering routes are not managed by this
  module.

## Related

- [`../rds/README.md`](../rds/README.md),
  [`../redis/README.md`](../redis/README.md) — data-store modules that run
  inside the private subnets created here
- [`../eks/README.md`](../eks/README.md),
  [`../admin_isolation/README.md`](../admin_isolation/README.md) — the
  remaining consumers of `vpc_id`
- [`docs/admin-network-isolation.md`](../../../../docs/admin-network-isolation.md) —
  how the admin plane is kept off the public internet
- [`docs/threat-model.md`](../../../../docs/threat-model.md) — network trust
  boundaries assumed by the platform
