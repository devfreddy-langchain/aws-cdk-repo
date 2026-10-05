#!/usr/bin/env bash
# =============================================================================
# post-deploy/00-import-certificate.sh — (optional) import your TLS certificate into ACM, BEFORE cdk deploy
#
#   BEFORE cdk deploy (ingress mode 'envoy-gateway', the default — CDK creates the HTTPS listener):
#     ./post-deploy/00-import-certificate.sh --name <name> --region <region> --hostname <hostname>
#     then put the printed ARN into dns.certificateArn in your CDK config.
#   AFTER cdk deploy (ingress mode 'alb' only, when the config has no certificateArn):
#     ./post-deploy/00-import-certificate.sh
#
# Skip this script when you already have an ISSUED ACM certificate for the LangSmith hostname
# (in the config's certificateArn): run after deploy, it notices that, checks it and stops.
#
# WHAT   Imports TLS_CERT_FILE + TLS_KEY_FILE (+ TLS_CHAIN_FILE) from post-deploy/settings.env
#        into AWS Certificate Manager and records the new ARN in out/acm-certificate-arn-<name>
#        (mode 'alb': 04-cluster-prereqs.sh picks it up for the ALB from there).
# WHY    The internal ALB terminates HTTPS with an ACM certificate. Certificates from a
#        private/corporate CA cannot be issued by ACM, so they are imported. The private
#        key goes to ACM only — it never reaches the cluster or the Helm values.
# HOW    aws acm import-certificate with fileb:// (binary-safe, nothing on argv but paths).
#        Idempotent: if out/acm-certificate-arn-<name> exists and that certificate still exists
#        in ACM, nothing is imported again. The record is per environment (<name>), so one
#        environment's certificate is never reused for another.
# VERIFY aws acm describe-certificate --certificate-arn <arn> --query Certificate.Status   (ISSUED)
# NOTE   Imported certificates do NOT renew themselves. Before it expires, re-import the
#        renewed files into the SAME ARN:
#          aws acm import-certificate --certificate-arn <arn> --certificate fileb://... \
#            --private-key fileb://... --certificate-chain fileb://...
# NEEDS  aws, jq; acm:ImportCertificate, acm:DescribeCertificate, acm:AddTagsToCertificate
#        (before deploy also sts:GetCallerIdentity).
# =============================================================================
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

# Before `cdk deploy` there are no outputs: take the three values from the arguments (the same
# values as name, region and dns.hostname in your CDK config) and hand them to lib.sh.
if [ $# -gt 0 ]; then
  name="" region="" host=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name=${2:?}; shift 2 ;;
      --region) region=${2:?}; shift 2 ;;
      --hostname) host=${2:?}; shift 2 ;;
      *) echo "usage: $0 [--name <name> --region <region> --hostname <hostname>]" >&2; exit 2 ;;
    esac
  done
  # Same rules as the CDK config check (lib/config/validate.ts).
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,19}$ ]] || { echo "ERROR: --name: the CDK config name (lowercase, max 20)" >&2; exit 2; }
  [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "ERROR: --region: e.g. us-east-1" >&2; exit 2; }
  [[ "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "ERROR: --hostname: the CDK config's dns.hostname" >&2; exit 2; }
  account=$(AWS_REGION=$region aws sts get-caller-identity --query Account --output text)
  BEFORE_DEPLOY_OUTPUTS=$(jq -nc --arg n "$name" --arg r "$region" --arg a "$account" --arg h "$host" \
    '{Name: $n, Region: $r, Account: $a, Hostname: $h}')
  export BEFORE_DEPLOY_OUTPUTS
fi
# shellcheck source-path=SCRIPTDIR/..
. post-deploy/lib.sh

need_tools aws jq
HOSTNAME_OUT=$(out Hostname)

section "00 TLS certificate"

cert=$(out CertificateArn "")
if [ -n "$cert" ]; then
  log "your CDK config sets certificateArn: $cert (nothing to import)"
elif [ -s "$CERT_RECORD" ] &&
     aws acm describe-certificate --certificate-arn "$(cat "$CERT_RECORD")" >/dev/null 2>&1; then
  cert=$(cat "$CERT_RECORD")
  log "already imported: $cert (recorded in $CERT_RECORD)"
else
  [ -r "$TLS_CERT_FILE" ] || die "TLS_CERT_FILE '$TLS_CERT_FILE' is not readable (post-deploy/settings.env)"
  [ -r "$TLS_KEY_FILE" ]  || die "TLS_KEY_FILE '$TLS_KEY_FILE' is not readable (post-deploy/settings.env)"
  [ -z "$TLS_CHAIN_FILE" ] || [ -r "$TLS_CHAIN_FILE" ] || die "TLS_CHAIN_FILE '$TLS_CHAIN_FILE' is not readable"
  cert=$(aws acm import-certificate --certificate "fileb://$TLS_CERT_FILE" --private-key "fileb://$TLS_KEY_FILE" \
    ${TLS_CHAIN_FILE:+--certificate-chain "fileb://$TLS_CHAIN_FILE"} --tags "${TAGS[@]}" --query CertificateArn --output text)
  echo "$cert" > "$CERT_RECORD"      # so a re-run does not import it again
  log "imported $cert (recorded in $CERT_RECORD)"
fi

# VERIFY: the certificate must be ISSUED, and should cover the LangSmith hostname.
status=$(aws acm describe-certificate --certificate-arn "$cert" --query Certificate.Status --output text)
[ "$status" = ISSUED ] || die "certificate $cert is $status, not ISSUED"
names=$(aws acm describe-certificate --certificate-arn "$cert" --query 'Certificate.SubjectAlternativeNames' --output text | tr '\t\n' '  ')
log "status ISSUED; names: $names"
case " $names " in
  *" $HOSTNAME_OUT "*|*" *.${HOSTNAME_OUT#*.} "*) log "covers $HOSTNAME_OUT" ;;
  *) warn "the certificate names do not include $HOSTNAME_OUT; browsers will reject it" ;;
esac
if [ -n "${BEFORE_DEPLOY_OUTPUTS:-}" ]; then
  cat >&2 <<EOF

  Next: put this in your CDK config (config/<env>.ts), then run cdk deploy:
    dns: { ..., certificateArn: '$cert' }
EOF
fi
