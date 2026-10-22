# Production environment — EliteWork (Amana).
#
# Third environment in the `infra/terraform/environments/` ladder, composed
# from exactly the same modules as `dev/` and `staging/`:
#
#   vpc  →  rds  →  redis  →  eks  →  admin_isolation  →  secrets
#
# Only the sizing and the safety flags differ from staging — the module
# composition, variable names, and outputs are identical, so a promotion
# from staging to production is a change of values, not of wiring.
#
# Differences from `staging/`, and why:
#
#   * Aurora is `db.r6g.large` with three cluster instances (one writer plus
#     two readers) instead of `db.r5.large` with two, so a reader failure
#     never costs the writer its headroom.
#   * Backups are retained for 35 days instead of 30 (AWS caps the Aurora
#     automated backup retention at 35 days) and the final snapshot is kept.
#   * Deletion protection stays on: the production cluster cannot be dropped
#     by accident, and tearing it down requires an explicit plan.
#   * ElastiCache runs `cache.r6g.large` with three cache clusters (one
#     primary plus two replicas) and 30 days of snapshots.
#   * The EKS node group runs `m6i.large` nodes at 4 desired / 3 minimum /
#     10 maximum so a single node loss cannot drop below the baseline and a
#     scale-up for a payout batch does not have to wait for a new node group.
#   * One NAT gateway per availability zone keeps private-subnet egress
#     available when a single AZ has a NAT failure.
#
# The environment is expected to live in its own AWS account: the module
# resource identifiers are environment-agnostic (`amana-rds-cluster`,
# `amana-redis`, `amana-eks-cluster`), so two environments in the same
# account would collide.
terraform {
  backend "s3" {
    bucket         = "amana-terraform-state-production"
    key            = "infra/terraform/production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "amana-terraform-locks-production"
  }
}

provider "aws" {
  region = var.region
}

module "vpc" {
  source = "../../modules/vpc"

  project_name         = "amana"
  environment          = "production"
  region               = var.region
  vpc_cidr             = "10.0.0.0/16"
  public_subnet_cidrs  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  private_subnet_cidrs = ["10.0.10.0/24", "10.0.11.0/24", "10.0.12.0/24"]
  availability_zones   = ["us-east-1a", "us-east-1b", "us-east-1c"]
  nat_gateway_count    = 3
}

module "rds" {
  source = "../../modules/rds"

  project_name            = "amana"
  environment             = "production"
  vpc_id                  = module.vpc.vpc_id
  subnet_ids              = module.vpc.private_subnet_ids
  allowed_cidr_blocks     = [module.vpc.vpc_cidr]
  engine                  = "aurora-postgresql"
  engine_version          = "15.4"
  instance_class          = "db.r6g.large"
  database_name           = "amana_production"
  master_username         = var.db_master_username
  master_password         = var.db_master_password
  port                    = 5432
  replica_count           = 3
  backup_retention_period = 35
  preferred_backup_window = "03:00-04:00"
  skip_final_snapshot     = false
  deletion_protection     = true
}

module "redis" {
  source = "../../modules/redis"

  project_name               = "amana"
  environment                = "production"
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.private_subnet_ids
  allowed_cidr_blocks        = [module.vpc.vpc_cidr]
  engine                     = "redis"
  engine_version             = "7.0"
  node_type                  = "cache.r6g.large"
  port                       = 6379
  replica_count              = 3
  parameter_group_name       = "default.redis7"
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token
  snapshot_retention_limit   = 30
  snapshot_window            = "02:00-03:00"
}

module "eks" {
  source = "../../modules/eks"

  project_name              = "amana"
  environment               = "production"
  region                    = var.region
  vpc_id                    = module.vpc.vpc_id
  subnet_ids                = module.vpc.private_subnet_ids
  kubernetes_version        = "1.29"
  instance_types            = ["m6i.large"]
  desired_size              = 4
  max_size                  = 10
  min_size                  = 3
  node_labels               = {}
  endpoint_private_access   = true
  endpoint_public_access    = false
  public_access_cidrs       = []
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
}

module "admin_isolation" {
  source = "../../modules/admin_isolation"

  project_name        = "amana"
  environment         = "production"
  vpc_id              = module.vpc.vpc_id
  trusted_admin_cidrs = ["10.0.0.0/16", "172.16.0.0/12"]
}

module "secrets" {
  source = "../../modules/secrets"

  project_name       = "amana"
  environment        = "production"
  eks_node_role_name = module.eks.node_role_arn
}


variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "db_master_username" {
  description = "Database master username"
  type        = string
  sensitive   = true
}

variable "db_master_password" {
  description = "Database master password"
  type        = string
  sensitive   = true
}

variable "redis_auth_token" {
  description = "Redis auth token"
  type        = string
  sensitive   = true
}

output "rds_endpoint" {
  description = "RDS endpoint"
  value       = module.rds.cluster_endpoint
}

output "redis_endpoint" {
  description = "Redis endpoint"
  value       = module.redis.primary_endpoint
}

output "eks_cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_id
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}
