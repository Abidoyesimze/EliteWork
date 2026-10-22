# Data Store Network Isolation Policy

This document describes the Kubernetes `NetworkPolicy` manifests that restrict
ingress to the in-cluster Postgres and Redis workloads in the EliteWork
(Amana) platform, and how they relate to the backend's egress lockdown.

---

## 1. Intended Network Topology

Both data stores are reached only by the backend service, over the pod
network inside the cluster:

```
[ Backend Pods (app: backend) ] ──TCP 5432──► [ Postgres StatefulSet (app: postgres) ]
                                        └──TCP 6379──► [ Redis Deployment (app: redis) ]

[ Frontend Pods ] ──✗─────── (denied at the pod level)
[ Any other pod / namespace ] ──✗─────── (denied at the pod level)
```

The policies are a pair, and both halves matter:

| Layer | Manifest | Question it answers |
|---|---|---|
| Egress | [`infra/k8s/backend-egress-network-policy.yaml`](../infra/k8s/backend-egress-network-policy.yaml) | Where may the backend send traffic? |
| Ingress | [`infra/k8s/postgres-network-policy.yaml`](../infra/k8s/postgres-network-policy.yaml), [`infra/k8s/redis-network-policy.yaml`](../infra/k8s/redis-network-policy.yaml) | Who may reach the data stores? |

A backend pod can therefore only reach Postgres and Redis, and Postgres and
Redis can only be reached by the backend. The frontend, the admin plane, and
any third-party pod are denied on both sides.

---

## 2. Infrastructure Manifests Summary

| Manifest File | Policy / Control | Scope |
|---------------|------------------|-------|
| `infra/k8s/postgres-network-policy.yaml` | Kubernetes `NetworkPolicy` (`postgres-ingress-lockdown`) | Allows TCP 5432 ingress to `app: postgres` pods from `app: backend` pods only |
| `infra/k8s/redis-network-policy.yaml` | Kubernetes `NetworkPolicy` (`redis-ingress-lockdown`) | Allows TCP 6379 ingress to `app: redis` pods from `app: backend` pods only |
| `infra/k8s/backend-egress-network-policy.yaml` | Kubernetes `NetworkPolicy` (`backend-egress-lockdown`) | Default-deny egress from `app: backend`, with scoped exceptions for DNS, Postgres, Redis, and external SaaS over TLS |

Each policy selects its workload with a `podSelector` and declares
`policyTypes: [Ingress]`. Under Kubernetes NetworkPolicy semantics, once a
pod is selected by an ingress policy, **all** ingress to it is denied except
the rules that are listed. The manifests are therefore allow-lists, not
deny-lists: anything not named in them is dropped by the CNI.

The `from` clauses use a bare `podSelector` with no `namespaceSelector`, which
matches pods in the policy's own namespace (`default`) only. A pod in another
namespace cannot inherit access by naming the same labels.

---

## 3. Security Review & Compliance

### Threat Vectors Mitigated

- **Lateral movement into the data tier**: a compromised frontend or admin
  pod can no longer open a Postgres session or a Redis connection, so it
  cannot read trade data, drain the queue, release another tenant's
  distributed lock, or enumerate the idempotency namespace.
- **Credential reuse from a foothold**: the Redis auth token and the Postgres
  password are only useful from inside the cluster *and* only from a pod the
  platform labels as the backend — a stolen credential alone no longer opens
  a data-store session.
- **Accidental exposure by a new workload**: a pod added to the cluster
  without a network policy of its own still cannot reach the data stores,
  because the policies on the data-store side are the ones that grant
  access.

### Residual Risk & Safeguards

- **Same-namespace compromise**: a pod in the `default` namespace that is
  labelled `app: backend` is trusted. An attacker who can create or modify
  pods in that namespace inherits the backend's data-store access; the
  control that matters there is RBAC and admission control on the namespace,
  not the NetworkPolicy.
- **The backup CronJob**: the backup jobs in
  [`infra/k8s/cronjob-backup.yaml`](../infra/k8s/cronjob-backup.yaml) run
  in the `amana` namespace against the managed database. If they are ever
  pointed at the in-cluster Postgres StatefulSet, they need a scoped rule
  added to `postgres-network-policy.yaml` — with a `namespaceSelector` for
  the `amana` namespace — through a pull request. Do not widen the existing
  rule instead.
- **Namespace selection**: the policies assume the data stores and the
  backend stay in the `default` namespace. Moving either of them changes
  which pods the bare `podSelector` matches and requires the policies to be
  updated in the same change.

---

## 4. Rollout & Operational Audit Commands

Apply the policies in staging first and confirm the backend still reaches
both data stores before enabling them in production:

```bash
# Apply
kubectl apply -f infra/k8s/postgres-network-policy.yaml
kubectl apply -f infra/k8s/redis-network-policy.yaml

# Confirm the policies are active and see what they select
kubectl get netpol postgres-ingress-lockdown redis-ingress-lockdown -n default
kubectl describe netpol postgres-ingress-lockdown -n default

# Confirm the backend still works (no drops in the CNI flow logs)
kubectl logs deploy/backend -c backend
kubectl exec deploy/backend -c backend -- node -e "require('net').connect(5432,'postgres-service').on('error',e=>{console.error(e.message);process.exit(1)}).on('connect',()=>process.exit(0))"
```

A new consumer of either data store — a reporting job, an admin task runner,
a settlement worker — needs a scoped rule added to the matching manifest
through a pull request. Rules are never widened to `0.0.0.0/0`, and an empty
`from:` clause is not used to "open things up".
