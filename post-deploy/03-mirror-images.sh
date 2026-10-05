#!/usr/bin/env bash
# =============================================================================
# post-deploy/03-mirror-images.sh — copy every container image into your ECR
#
#   ./post-deploy/03-mirror-images.sh            mirror (needs internet + AWS credentials)
#   ./post-deploy/03-mirror-images.sh --list     only print the image list (no AWS calls)
#
# WHAT   Copies every image the install uses into ECR under
#        <account>.dkr.ecr.<region>.amazonaws.com/<Name>/...
#        and creates the ECR repositories for them (CDK does not create these).
# WHY    The nodes pull only from your account's ECR (node role:
#        AmazonEC2ContainerRegistryPullOnly); the cluster never needs Docker Hub, ghcr.io or
#        any other registry. 04-cluster-prereqs.sh refuses Helm values that reference an
#        image outside your ECR.
# HOW    The list = every images.* entry in the pinned LangSmith chart (minus components
#        that stay off: presidio, sandbox-host, ClickHouse, in-chart Postgres)
#        + the 4 platform charts (versions from post-deploy/settings.env)
#        + Envoy Gateway's controller and Envoy proxy images (ingress mode envoy-gateway)
#        + the Deployments operator's per-agent Postgres/Redis images
#        + the bootstrap/smoke-test helper images.
#        Each repository <Name>/<path> is created with IMMUTABLE tags (a tag can never be
#        re-pointed to different content) and scan-on-push. `crane copy` copies all
#        architectures of an image. A tag that is already in ECR is skipped, so a re-run
#        only copies what is missing (e.g. after a version bump in settings.env).
#        Run this on a host with internet access. If your nodes cannot reach the internet,
#        that is fine: only this host needs it.
# VERIFY aws ecr describe-repositories --query "repositories[?starts_with(repositoryName,'<Name>/')].repositoryName"
#        out/images.txt lists every source image.
# NEEDS  aws, helm, yq, crane, jq; ecr:CreateRepository, ecr:DescribeRepositories,
#        ecr:DescribeImages, ecr:GetAuthorizationToken, ecr:TagResource and the ECR push
#        permissions (ecr:InitiateLayerUpload, UploadLayerPart, CompleteLayerUpload,
#        PutImage, BatchCheckLayerAvailability, BatchGetImage).
# =============================================================================
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
# shellcheck source-path=SCRIPTDIR/..
. post-deploy/lib.sh

# image_list: one public image reference per line.
image_list() {
  local lbc_app eso_app keda_app
  # LangSmith chart images; presidio, sandbox-host, clickhouse and the in-chart postgres and redis stay
  # disabled (RDS and Valkey instead). The operator's per-agent Postgres and Redis are pinned below.
  helm show values langsmith --repo "$LANGSMITH_CHART_REPO" --version "$LANGSMITH_CHART_VERSION" |
    yq -r '.images | to_entries[] | select(.value | type == "!!map") | select(.value.repository != null)
           | select(.key | test("^(presidioAnalyzerImage|sandboxHostImage|clickhouseImage|postgresImage|redisImage)$") | not)
           | .value.repository + ":" + .value.tag'
  # Platform charts: the image tag is the chart's appVersion.
  lbc_app=$(helm show chart aws-load-balancer-controller --repo "$LBC_CHART_REPO" --version "$LBC_CHART_VERSION" | yq -r .appVersion)
  eso_app=$(helm show chart external-secrets --repo "$ESO_CHART_REPO" --version "$ESO_CHART_VERSION" | yq -r .appVersion)
  keda_app=$(helm show chart keda --repo "$KEDA_CHART_REPO" --version "$KEDA_CHART_VERSION" | yq -r .appVersion)
  cat <<EOF
public.ecr.aws/eks/aws-load-balancer-controller:$lbc_app
ghcr.io/external-secrets/external-secrets:$eso_app
registry.k8s.io/autoscaling/cluster-autoscaler:$CLUSTER_AUTOSCALER_IMAGE_TAG
ghcr.io/kedacore/keda:$keda_app
ghcr.io/kedacore/keda-metrics-apiserver:$keda_app
ghcr.io/kedacore/keda-admission-webhooks:$keda_app
$OPERATOR_PGVECTOR_IMAGE
$OPERATOR_REDIS_IMAGE
$BOOTSTRAP_PG_IMAGE
$SMOKE_CURL_IMAGE
EOF
  # Envoy Gateway: the controller (tag = chart version) and the proxy it runs for each Gateway.
  if [ "$INGRESS_MODE" = envoy-gateway ]; then
    echo "docker.io/envoyproxy/gateway:$ENVOY_GATEWAY_CHART_VERSION"
    echo "docker.io/envoyproxy/envoy:$ENVOY_PROXY_IMAGE_TAG"
  fi
}

need_tools helm yq
section "03 Mirror images into ECR"
image_list | sort -u > "$OUT_DIR/images.txt"
log "$(wc -l < "$OUT_DIR/images.txt" | tr -d ' ') images (list: $OUT_DIR/images.txt)"
if [ "${1:-}" = --list ]; then cat "$OUT_DIR/images.txt"; exit 0; fi

need_tools aws crane jq
registry=${IMAGE_BASE%%/*}
# Log crane in to your registry. The token goes through a pipe, never on the command line.
aws ecr get-login-password | crane auth login "$registry" --username AWS --password-stdin >/dev/null

while read -r src <&3; do   # fd 3: no command in the loop can swallow the list
  repo="$NAME/$(ecr_path "$src")"; tag=${src##*:}
  # Repository: created once, IMMUTABLE tags, scan on push.
  aws ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1 ||
    aws ecr create-repository --repository-name "$repo" --image-tag-mutability IMMUTABLE \
      --image-scanning-configuration scanOnPush=true --tags "${TAGS[@]}" >/dev/null
  # Image: copied only if this tag is not in ECR yet (immutable tags cannot be overwritten anyway).
  if aws ecr describe-images --repository-name "$repo" --image-ids "imageTag=$tag" >/dev/null 2>&1; then
    log "present  $repo:$tag"
  else
    log "copy     $src -> $registry/$repo:$tag"
    retry crane copy "$src" "$registry/$repo:$tag"
  fi
done 3< "$OUT_DIR/images.txt"
log "$(wc -l < "$OUT_DIR/images.txt" | tr -d ' ') images under $registry/$NAME/"
