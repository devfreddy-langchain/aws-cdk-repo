# shellcheck shell=bash
# Variables set here are used by the scripts that source this file:
# shellcheck disable=SC2034
# =============================================================================
# post-deploy/lib.sh — shared helpers for the post-deploy scripts
#
# Sourced (not run) by every post-deploy/0N-*.sh script, after it has changed
# into the repository root. It:
#   * loads post-deploy/settings.env (optional — every setting has a default),
#   * reads the CDK stack outputs from out/cdk-outputs.json (see out() below),
#   * sets AWS_REGION from those outputs and KUBECONFIG=out/kubeconfig,
#   * creates a private temporary directory $TMP, removed when the script exits.
#     Secret material is only ever staged there and handed to the AWS CLI with
#     file://, never put on the command line and never printed.
#
# Environment overrides (rarely needed):
#   SETTINGS_FILE  default post-deploy/settings.env
#   OUT_DIR        default out          (rendered files, kubeconfig, image list)
#   CDK_OUTPUTS    default $OUT_DIR/cdk-outputs.json
# =============================================================================
set -euo pipefail
umask 077

# ----------------------------------------------------------------- helpers ----
section() { printf '\n\033[1m======== %s ========\033[0m\n' "$*" >&2; }
log()     { printf '  -> %s\n' "$*" >&2; }
warn()    { printf '  !! WARNING: %s\n' "$*" >&2; }
die()     { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
csv()     { echo "$1" | tr ',' ' '; }                 # "a,b,c" -> "a b c"
found()   { [ -n "$1" ] && [ "$1" != "None" ] && [ "$1" != "null" ]; }   # --output text prints None for null

# need_tools <tool>...: stop early, with one message, if a command-line tool is missing.
need_tools() {
  local t missing=""
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  [ -z "$missing" ] || die "missing tools:$missing (README.md, 'Before you start', lists them)"
  # Helm 3 only: Helm 4 changed what --wait and --dry-run do, and these scripts are tested with Helm 3.
  if [[ " $* " == *" helm "* ]]; then
    local v; v=$(helm version --short 2>/dev/null || true)
    case "$v" in v3.*) ;; *) die "Helm 3 (3.12 or later) is required; found '${v:-none}'. Helm 4 is not supported yet (README.md, 'Before you start')." ;; esac
  fi
}

# render <template> <output> VAR...: fill ${VAR} placeholders in a helm/ values template.
# Only the listed variables are substituted (other ${...} text is left alone), and the
# render fails if any ${UPPER_CASE} placeholder is left over (a typo, or a missing value).
render() {
  local tpl=$1 out=$2 list="" v; shift 2
  for v in "$@"; do export "${v?}"; list="$list \${$v}"; done
  envsubst "$list" < "$tpl" > "$out"
  # shellcheck disable=SC2016  # a literal ${ to search for
  if grep -n '\${[A-Z][A-Z0-9_]*}' "$out" >&2; then die "unfilled placeholders in $out (from $tpl)"; fi
}

# retry: AWS is eventually consistent (IAM, new endpoints). Retry for up to ~2 minutes.
retry() { local n=0; until "$@"; do n=$((n + 1)); [ $n -ge 12 ] && return 1; log "retrying in 10s ($n/12)"; sleep 10; done; }

# ecr_path <image>: where a public image lives under <registry>/<NAME>/ in ECR.
#   docker.io/library/postgres:18 -> postgres ; ghcr.io/kedacore/keda:2.20.1 -> kedacore/keda
ecr_path() {
  local p=${1%:*} first; first=${p%%/*}
  case "$first" in *.*) p=${p#*/} ;; esac
  echo "${p#library/}"
}

# ecr_image <public image>: the full ECR reference of a mirrored image (post-deploy/03).
ecr_image() { echo "$IMAGE_BASE/$(ecr_path "$1"):${1##*:}"; }

# check_images_in_ecr <rendered.yaml>: stop if a rendered chart uses an image that is not in
# your ECR (re-run 03 after changing versions). ${image} is the Deployments operator's
# placeholder for a deployed agent's own image.
check_images_in_ecr() {
  local outside
  # shellcheck disable=SC2016  # a literal ${image}
  outside=$(grep -E '^[[:space:]]+(- )?image: ' "$1" | grep -v -e "$IMAGE_BASE/" -e '\${image}' | sort -u || true)
  [ -z "$outside" ] || { printf '%s\n' "$outside" >&2; die "the images above (in $1) are not in $IMAGE_BASE (re-run ./post-deploy/03-mirror-images.sh?)"; }
}

# ------------------------------------------------------------- settings ----
# Everything that is NOT a CDK output: file paths and pinned versions.
SETTINGS_FILE=${SETTINGS_FILE:-post-deploy/settings.env}
if [ -r "$SETTINGS_FILE" ]; then
  # shellcheck source=/dev/null
  . "$SETTINGS_FILE"
fi
: "${LICENSE_KEY_FILE:=./secrets/langsmith-license.txt}"
: "${TLS_CERT_FILE:=}" "${TLS_KEY_FILE:=}" "${TLS_CHAIN_FILE:=}" "${CUSTOM_CA_BUNDLE_FILE:=}" "${EXTRA_VALUES_FILE:=}"
: "${LANGSMITH_CHART_VERSION:=0.17.0}" "${LBC_CHART_VERSION:=3.5.0}" "${ESO_CHART_VERSION:=2.11.0}"
: "${CLUSTER_AUTOSCALER_CHART_VERSION:=9.56.0}" "${CLUSTER_AUTOSCALER_IMAGE_TAG:=v1.34.5}" "${KEDA_CHART_VERSION:=2.20.1}"
# Envoy Gateway (ingress mode 'envoy-gateway'): the chart, and the Envoy proxy image that release is
# tested with (the chart's default, templates/_helpers.tpl). Keep the two in step.
: "${ENVOY_GATEWAY_CHART_VERSION:=v1.9.2}" "${ENVOY_PROXY_IMAGE_TAG:=distroless-v1.39.1}"
: "${BOOTSTRAP_PG_IMAGE:=docker.io/library/postgres:18.6}" "${SMOKE_CURL_IMAGE:=docker.io/curlimages/curl:8.12.1}"
# The images the Deployments operator runs next to each agent (helm/langsmith-values.yaml,
# operator.templates). Exact tags: ECR repositories are immutable, so a moving tag such as
# redis:7 would stay frozen at whatever it pointed to on the first mirror.
: "${OPERATOR_REDIS_IMAGE:=docker.io/library/redis:7.4.11}" "${OPERATOR_PGVECTOR_IMAGE:=docker.io/pgvector/pgvector:0.8.7-pg15}"

LANGSMITH_CHART_REPO=https://langchain-ai.github.io/helm
LBC_CHART_REPO=https://aws.github.io/eks-charts
ESO_CHART_REPO=https://charts.external-secrets.io
CLUSTER_AUTOSCALER_CHART_REPO=https://kubernetes.github.io/autoscaler
KEDA_CHART_REPO=https://kedacore.github.io/charts
ENVOY_GATEWAY_CHART=oci://docker.io/envoyproxy/gateway-helm   # an OCI chart: no --repo

# ---------------------------------------------------------- CDK outputs ----
# `npx cdk deploy --all -c config=<env> --outputs-file out/cdk-outputs.json` writes one JSON
# object per stack: { "<name>-network": {...}, "<name>-langsmith": {...} }. The stacks use
# different output names, so they are merged into one flat object here, once.
OUT_DIR=${OUT_DIR:-out}
CDK_OUTPUTS=${CDK_OUTPUTS:-$OUT_DIR/cdk-outputs.json}
mkdir -p "$OUT_DIR"
OUT_ABS=$(cd "$OUT_DIR" && pwd)      # absolute: for files used from another directory (kubeconfig, helm command)
need_tools jq
if [ -n "${BEFORE_DEPLOY_OUTPUTS:-}" ]; then
  # 00-import-certificate.sh before `cdk deploy`: the few values it needs, from its arguments.
  CDK_OUTPUTS_JSON=$BEFORE_DEPLOY_OUTPUTS
else
  [ -r "$CDK_OUTPUTS" ] || die "missing $CDK_OUTPUTS. Run: npx cdk deploy --all -c config=<env> --outputs-file $CDK_OUTPUTS"
  CDK_OUTPUTS_JSON=$(jq -c '[.[]] | add // {}' "$CDK_OUTPUTS") || die "$CDK_OUTPUTS is not valid JSON"
fi

# out <OutputName> [default]: one CDK output by name.
#   Without a default the output is required: a missing one stops the script with a clear
#   message (usually: that component is turned off in your CDK config).
#   With a default (often ""), a missing output returns the default.
# Always assign the result to a variable first (x=$(out Foo)); only then does `set -e`
# stop the script when a required output is missing.
out() {
  local v
  v=$(jq -r --arg k "$1" '.[$k] // empty' <<<"$CDK_OUTPUTS_JSON")
  if [ -z "$v" ]; then
    [ $# -ge 2 ] && { printf '%s' "$2"; return 0; }
    die "CDK output '$1' is missing from $CDK_OUTPUTS (is that component enabled in your CDK config, and did 'cdk deploy --outputs-file' run after the last change?)"
  fi
  printf '%s' "$v"
}

# The outputs every script needs.
NAME=$(out Name)
AWS_REGION=$(out Region)
ACCOUNT=$(out Account)
WORKLOAD_IDENTITY=$(out WorkloadIdentity irsa)
NS=$(out LangsmithNamespace langsmith)
case "$WORKLOAD_IDENTITY" in irsa|podIdentity) ;; *) die "WorkloadIdentity output must be irsa or podIdentity, got '$WORKLOAD_IDENTITY'" ;; esac
# How traffic reaches LangSmith (CDK config ingress.mode). Installs deployed before this output
# existed used the ALB from the Ingress: 'alb'.
INGRESS_MODE=$(out IngressMode alb)
case "$INGRESS_MODE" in envoy-gateway|alb) ;; *) die "IngressMode output must be envoy-gateway or alb, got '$INGRESS_MODE'" ;; esac

export AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION AWS_PAGER=""
KUBECONFIG=$OUT_ABS/kubeconfig
export KUBECONFIG
# Before cdk deploy (post-deploy/00) there is no IngressMode output yet, so it is not logged.
if [ -n "${BEFORE_DEPLOY_OUTPUTS:-}" ]; then log "environment $NAME: account $ACCOUNT, region $AWS_REGION (before cdk deploy)"
else log "environment $NAME: account $ACCOUNT, region $AWS_REGION, ingress $INGRESS_MODE ($CDK_OUTPUTS)"; fi

# Every image lives under <account>.dkr.ecr.<region>.amazonaws.com/<NAME>/... (post-deploy/03).
IMAGE_BASE="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/$NAME"
# Tags on what these scripts create in AWS (ECR repositories, imported certificate).
TAGS=("Key=app,Value=langsmith" "Key=langsmith-env,Value=$NAME")

# CERT_RECORD: where post-deploy/00 records the certificate it imported — one file per environment,
# so the certificate of one environment is never picked up for another.
CERT_RECORD=$OUT_DIR/acm-certificate-arn-$NAME

# cert_arn: the ACM certificate for the ALB — the CDK config's certificate, else the one
# post-deploy/00 imported (recorded in $CERT_RECORD), else empty.
cert_arn() {
  local c
  c=$(out CertificateArn "")
  if [ -n "$c" ]; then echo "$c"; elif [ -s "$CERT_RECORD" ]; then cat "$CERT_RECORD"; fi
}

# sa_annotations <role ARN>: the ServiceAccount annotations for one workload role, as a
# one-line YAML map for the helm/*.yaml templates.
#   irsa        -> { eks.amazonaws.com/role-arn: "<role ARN>" }   (IRSA reads the role from the annotation)
#   podIdentity -> {}                                             (CDK created a pod identity association
#                                                                  for the ServiceAccount; no annotation)
sa_annotations() {
  if [ "$WORKLOAD_IDENTITY" = irsa ]; then printf '{ eks.amazonaws.com/role-arn: "%s" }' "$1"; else printf '{}'; fi
}

# need_kubeconfig: steps that talk to the cluster need out/kubeconfig (04 step 1).
need_kubeconfig() {
  [ -s "$KUBECONFIG" ] || die "$KUBECONFIG not found: run ./post-deploy/04-cluster-prereqs.sh kubeconfig first"
}

# secret_is_placeholder <secret id>: true while the secret still holds the value CDK created it
# with (REPLACE_ME, lib/components/secrets.ts), i.e. post-deploy/01 has not filled it in yet.
# The value goes to a private temp file, is compared there, and the file is removed.
SECRET_PLACEHOLDER=REPLACE_ME
secret_is_placeholder() {
  local rc=0
  aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text > "$TMP/current" ||
    die "cannot read secret $1 (does it exist? do your credentials allow secretsmanager:GetSecretValue?)"
  [ "$(cat "$TMP/current")" = "$SECRET_PLACEHOLDER" ] || rc=1
  rm -f "$TMP/current"
  return $rc
}

# SEEDED_SECRETS: the secrets post-deploy/01 fills in (under the SecretsPrefix output).
SEEDED_SECRETS="license-key fernet/agent-builder fernet/insights fernet/polly"

# wait_for_endpoints <namespace> <service>: wait (up to 3 minutes) until a Service has a ready
# endpoint — e.g. an admission webhook, which must answer before objects it checks are created.
wait_for_endpoints() {
  local n ready
  for n in $(seq 18); do
    ready=$(kubectl -n "$1" get endpointslices -l "kubernetes.io/service-name=$2" \
      -o jsonpath='{.items[*].endpoints[?(@.conditions.ready==true)].addresses[*]}' 2>/dev/null || true)
    [ -n "$ready" ] && return 0
    log "waiting for $1/$2 to have a ready endpoint ($n/18)"; sleep 10
  done
  die "$1/$2 has no ready endpoint: kubectl -n $1 get pods"
}

# wait_job <namespace> <job> <seconds>: wait until a Job has completed (returns 0) or failed
# (returns 1 at once, instead of waiting out the whole timeout).
wait_job() {
  local ns=$1 job=$2 deadline=$((SECONDS + $3)) state
  while [ $SECONDS -lt $deadline ]; do
    state=$(kubectl -n "$ns" get job "$job" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{" "}{end}' 2>/dev/null || true)
    case " $state " in *" Complete "*) return 0 ;; *" Failed "*) return 1 ;; esac
    sleep 10
  done
  return 1
}

# Private temporary directory: secret material is staged here and handed over with file://.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
