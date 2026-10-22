# Terraform `eks` Module

Provisions the managed Kubernetes cluster the platform runs on: the EKS control
plane, a managed worker node group, the IAM roles both use, and the security
groups that carry the cluster's network policy.

## Overview

The module creates one EKS cluster and one managed node group, wired into the
private subnets of the [`vpc`](../vpc/README.md) module. It also creates the
two IAM roles the cluster depends on — the control-plane role and the worker
node role — and attaches the AWS managed policies each one needs.

The worker role ARN is the module's most-used output: the
[`secrets`](../secrets/README.md) module attaches a scoped read policy for
`ADMIN_SECRET_KEY` to it, so the backend pods can read the secret without the
value ever being written into a Kubernetes manifest.

The module is deliberately self-contained: it owns the cluster, its node
group, its security groups, and its IAM roles, and it exposes them through
outputs. It does not create the Kubernetes workloads — those live in
[`infra/k8s/`](../../../../infra/k8s/) and are applied to the cluster after
the Terraform apply completes.

## Resources

| Resource | Type | Purpose |
|---|---|---|
| `aws_iam_role.cluster` | `aws_iam_role` | Control-plane role assumed by `eks.amazonaws.com`; named `<project>-eks-cluster-role` |
| `aws_iam_role_policy_attachment.cluster_amazon_eks_cluster_policy` | `aws_iam_role_policy_attachment` | Attaches `AmazonEKSClusterPolicy` |
| `aws_iam_role_policy_attachment.cluster_amazon_eks_vpc_resource_controller` | `aws_iam_role_policy_attachment` | Attaches `AmazonEKSVPCResourceController` |
| `aws_iam_role.node` | `aws_iam_role` | Worker node role assumed by `ec2.amazonaws.com`; named `<project>-eks-node-role` |
| `aws_iam_role_policy_attachment.node_amazon_eks_worker_node_policy` | `aws_iam_role_policy_attachment` | Attaches `AmazonEKSWorkerNodePolicy` |
| `aws_iam_role_policy_attachment.node_amazon_eks_cni_policy` | `aws_iam_role_policy_attachment` | Attaches `AmazonEKS_CNI_Policy` (required for pod networking) |
| `aws_iam_role_policy_attachment.node_amazon_ec2_container_registry_readonly` | `aws_iam_role_policy_attachment` | Attaches `AmazonEC2ContainerRegistryReadOnly` |
| `aws_security_group.cluster` | `aws_security_group` | Attached to the control plane; name prefix `<project>-eks-cluster-sg`; unrestricted egress |
| `aws_security_group.node` | `aws_security_group` | Attached to the worker nodes; name prefix `<project>-eks-node-sg`; unrestricted egress |
| `aws_security_group_rule.cluster_ingress_node` | `aws_security_group_rule` | Allows TCP `443` into the cluster security group from the node security group, so pods can reach the API server |
| `aws_eks_cluster.this` | `aws_eks_cluster` | The control plane: version, VPC config, endpoint access, cluster log types |
| `aws_eks_node_group.this` | `aws_eks_node_group` | The managed worker node group: instance types, scaling config, labels, and the `dedicated=amana` taint |

Every resource is tagged `Name` and `Environment`.

## Inputs

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `project_name` | `string` | — | yes | Project name. Used as the prefix for the cluster, node group, IAM role, and security group names. |
| `environment` | `string` | — | yes | Environment name (e.g. `dev`, `staging`, `production`). Applied as the `Environment` tag. |
| `region` | `string` | — | yes | AWS region. Declared for parity with the other modules; the module body does not reference it, so the region is taken from the `aws` provider in the calling environment. |
| `vpc_id` | `string` | — | yes | VPC ID in which the security groups are created. Use `module.vpc.vpc_id`. |
| `subnet_ids` | `list(string)` | — | yes | Subnet IDs for the control plane and the node group. Use `module.vpc.private_subnet_ids`. |
| `kubernetes_version` | `string` | `"1.29"` | no | Kubernetes version for the control plane. The node group follows the cluster version. |
| `instance_types` | `list(string)` | `["t3.medium"]` | no | EC2 instance types for the node group. |
| `desired_size` | `number` | `2` | no | Desired number of worker nodes. |
| `max_size` | `number` | `4` | no | Maximum number of worker nodes the autoscaler may scale to. |
| `min_size` | `number` | `1` | no | Minimum number of worker nodes the autoscaler may scale down to. |
| `node_labels` | `map(string)` | `{}` | no | Labels applied to the node group, e.g. `role = "backend"`. |
| `endpoint_private_access` | `bool` | `true` | no | Expose the API server endpoint through the VPC. |
| `endpoint_public_access` | `bool` | `false` | no | Expose the API server endpoint to the public internet. Keep this `false` outside a break-glass scenario. |
| `public_access_cidrs` | `list(string)` | `[]` | no | CIDR blocks allowed to reach the public endpoint. **Only consulted when `endpoint_public_access` is `true`.** |
| `enabled_cluster_log_types` | `list(string)` | `["api", "audit", "authenticator", "controllerManager", "scheduler"]` | no | Control-plane log types sent to CloudWatch. `api` and `audit` are what the security review depends on. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `cluster_id` | `string` | ID of the EKS cluster. |
| `cluster_arn` | `string` | ARN of the EKS cluster. |
| `cluster_endpoint` | `string` | HTTPS endpoint of the Kubernetes API server. |
| `cluster_security_group_id` | `string` | ID of the cluster security group. |
| `node_group_id` | `string` | ID of the managed node group. |
| `node_role_arn` | `string` | ARN of the worker node IAM role — pass it to the `secrets` module to attach the scoped `ADMIN_SECRET_KEY` read policy. |
| `cluster_certificate_authority_data` | `string` | Base64-encoded cluster CA certificate, for `aws eks update-kubeconfig`. |

## Usage

```hcl
module "eks" {
  source = "../../modules/eks"

  project_name              = "amana"
  environment               = "dev"
  region                    = var.region
  vpc_id                    = module.vpc.vpc_id
  subnet_ids                = module.vpc.private_subnet_ids
  kubernetes_version        = "1.29"
  instance_types            = ["t3.medium"]
  desired_size              = 2
  max_size                  = 4
  min_size                  = 1
  node_labels               = {}
  endpoint_private_access   = true
  endpoint_public_access    = false
  public_access_cidrs       = []
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
}
```

Live examples live in
[`infra/terraform/environments/dev/main.tf`](../../environments/dev/main.tf),
[`infra/terraform/environments/staging/main.tf`](../../environments/staging/main.tf),
and [`infra/terraform/environments/production/main.tf`](../../environments/production/main.tf).

After the apply, point `kubectl` at the cluster and apply the workloads:

```bash
aws eks update-kubeconfig --name "$(terraform output -raw eks_cluster_name)"
kubectl apply -f ../../../k8s/
```

## Operational notes

- **The IAM role names are not environment-scoped.** The cluster and node
  roles are named `<project>-eks-cluster-role` and `<project>-eks-node-role`
  regardless of `environment` (only the `Environment` tag differs). Two
  environments in the same AWS account therefore collide on the role name —
  keep one account per environment, or make the names environment-scoped
  before adding a second environment to an account.
- **The node group is tainted.** Every node carries
  `dedicated=amana:NoSchedule`, so only workloads with a matching toleration
  are scheduled. A deployment without
  `tolerations: [{ key: "dedicated", operator: "Equal", value: "amana", effect: "NoSchedule" }]`
  stays `Pending` — this is the first thing to check when a pod never starts.
- **The cluster security group only admits the API server from the node
  security group** (`aws_security_group_rule.cluster_ingress_node`). The node
  security group declares no ingress rules of its own, so anything else that
  needs to reach a node — a bastion, an external controller — has to be
  granted explicitly in a PR.
- **Both security groups allow all egress** (`0.0.0.0/0`). Egress is
  restricted at the network-policy layer in the Kubernetes manifests, not here.
- **The API server is private by default.** `endpoint_public_access` defaults
  to `false`; turning it on requires `public_access_cidrs` to be set to the
  operator ranges, otherwise the endpoint is open to the internet.
- **`scaling_config` bounds the autoscaler.** `desired_size`, `min_size`, and
  `max_size` are the only levers on node count; a workload that needs more
  capacity than `max_size` needs a plan change, not a manual resize.
- **Control-plane logs are billed separately.** `enabled_cluster_log_types`
  sends those log types to CloudWatch Logs, which costs money per GB in
  every environment — the `api` and `audit` types are the ones the security
  review reads.
- **Upgrading the Kubernetes version is in-place.** Changing
  `kubernetes_version` rolls the control plane and the node group; the
  workload manifests must stay compatible with the target version.
- **The node role is the pod's identity.** Anything a pod needs from AWS is
  granted to `node_role_arn`, so keep the attached policies scoped — the
  `secrets` module attaches only a single-secret read policy.

## Related

- [`../vpc/README.md`](../vpc/README.md) — provides `vpc_id` and
  `private_subnet_ids`
- [`../secrets/README.md`](../secrets/README.md) — attaches the scoped
  `ADMIN_SECRET_KEY` read policy to `node_role_arn`
- [`../admin_isolation/README.md`](../admin_isolation/README.md) — the VPC
  security group that restricts the admin plane
- [`infra/terraform/environments/production/main.tf`](../../environments/production/main.tf) —
  production wiring
- [`docs/admin-network-isolation.md`](../../../../docs/admin-network-isolation.md) —
  how the admin plane is kept off the public internet
- [`docs/threat-model.md`](../../../../docs/threat-model.md) — trust boundaries
  assumed by the platform
- [`docs/runbooks/deployment.md`](../../../../docs/runbooks/deployment.md) —
  the deployment procedure that follows the Terraform apply
