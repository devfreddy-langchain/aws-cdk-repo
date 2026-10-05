#!/usr/bin/env bash
# =============================================================================
# post-deploy/05-dns-and-smoke-test.sh — check (or, ingress mode 'alb', write) the DNS record, then smoke tests
#
#   ./post-deploy/05-dns-and-smoke-test.sh
#
# Run after the LangSmith install: `bash out/helm-install-langsmith.sh` (written by
# 04-cluster-prereqs.sh). Safe to re-run.
#
# WHAT   1. Finds the internal ALB. Ingress mode 'envoy-gateway' (output IngressMode): CDK's
#           ALB (output LoadBalancerDnsName), and checks that the LangSmith HTTPRoute is accepted
#           by the Gateway. Mode 'alb': waits for the ALB the AWS Load Balancer Controller
#           creates for the LangSmith Ingress.
#        2. The LangSmith hostname (output Hostname) -> that ALB, an alias A record in the private
#           hosted zone (output PrivateZoneId). 'envoy-gateway': CDK wrote it; this checks it.
#           'alb': this script writes it.
#        3. Checks from inside the cluster that every Deployment is Available and that
#           /api/v1/info reports SmithDB ingestion and query enabled.
#        4. Calls https://<hostname>/api/v1/info through DNS + ALB + TLS (+ Envoy).
# WHY    In mode 'alb', CDK cannot create the record: that ALB only exists after `helm install`.
#        An alias record follows the ALB if its addresses change (a CNAME is not needed).
# HOW    route53 change-resource-record-sets UPSERT (mode 'alb'; safe to re-run);
#        kubectl run with the curl image from your ECR (SMOKE_CURL_IMAGE, mirrored by 03).
# VERIFY From a machine that resolves the private zone and trusts your CA:
#          curl https://<hostname>/api/v1/info
# NEEDS  aws, kubectl, jq; out/kubeconfig (04 step 1); elasticloadbalancing:DescribeLoadBalancers,
#        route53:ListResourceRecordSets and (mode 'alb') route53:ChangeResourceRecordSets on the private zone.
# =============================================================================
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
# shellcheck source-path=SCRIPTDIR/..
. post-deploy/lib.sh

need_tools aws kubectl jq
need_kubeconfig
HOST=$(out Hostname)
if [ "$INGRESS_MODE" = alb ]; then ZONE_ID=$(out PrivateZoneId); else ZONE_ID=$(out PrivateZoneId ""); fi
SECRETS_PREFIX=$(out SecretsPrefix)
CURL_IMAGE=$(ecr_image "$SMOKE_CURL_IMAGE")

# ------------------------------------------------------------------ 1 ALB ----
# WHAT  envoy-gateway: CDK's ALB, and the LangSmith HTTPRoute accepted by langsmith-gateway.
#       alb: the ALB DNS name from the Ingress status (up to ~15 minutes after helm install).
# VERIFY kubectl -n <namespace> get httproute   (or: get ingress, ADDRESS column)
section "05 1/4 Internal ALB ($INGRESS_MODE)"
lb=""
if [ "$INGRESS_MODE" = envoy-gateway ]; then
  lb=$(out LoadBalancerDnsName)
  accepted=""
  for _ in $(seq 1 20); do
    accepted=$(kubectl -n "$NS" get httproute -o jsonpath='{.items[*].status.parents[*].conditions[?(@.type=="Accepted")].status}' 2>/dev/null || true)
    case " $accepted " in *" True "*) break ;; esac
    log "waiting for the LangSmith HTTPRoute to be accepted (kubectl -n $NS get httproute)"; sleep 15
  done
  case " $accepted " in *" True "*) ;; *) die "no accepted HTTPRoute in $NS: kubectl -n $NS describe httproute ; kubectl -n $NS describe gateway langsmith-gateway" ;; esac
  log "HTTPRoute accepted by langsmith-gateway; ALB $lb (CDK)"
else
  for _ in $(seq 1 60); do
    lb=$(kubectl -n "$NS" get ingress -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
    [ -n "$lb" ] && break
    log "waiting for the ALB (kubectl -n $NS get ingress)"; sleep 15
  done
  [ -n "$lb" ] || die "the Ingress has no ALB yet: kubectl -n kube-system logs deploy/aws-load-balancer-controller"
  log "ALB $lb"
fi

# ------------------------------------------------------------ 2 DNS record ----
# WHAT  Alias A record <hostname> -> ALB, in the private hosted zone.
# HOW   envoy-gateway: CDK owns the record; read it back and compare.
#       alb: the ALB's own hosted zone ID (CanonicalHostedZoneId) is part of an alias target.
#       The change batch is written to a temp file and passed with file://.
section "05 2/4 DNS record"
if [ "$INGRESS_MODE" = envoy-gateway ]; then
  if [ -z "$ZONE_ID" ]; then
    warn "no PrivateZoneId output: CDK wrote no record. Point $HOST at $lb in your own DNS."
  else
    target=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --start-record-name "$HOST" --start-record-type A \
      --max-items 1 --query "ResourceRecordSets[?Name=='$HOST.'].AliasTarget.DNSName | [0]" --output text)
    case "$(echo "$target" | tr '[:upper:]' '[:lower:]')" in
      *"$(echo "$lb" | tr '[:upper:]' '[:lower:]')"*) log "A $HOST -> $lb (zone $ZONE_ID, written by CDK)" ;;
      *) die "the record for $HOST in zone $ZONE_ID points at '$target', not at $lb (re-run cdk deploy)" ;;
    esac
  fi
else
  lb_zone=$(aws elbv2 describe-load-balancers --query "LoadBalancers[?DNSName=='$lb'].CanonicalHostedZoneId | [0]" --output text)
  found "$lb_zone" || die "load balancer $lb not found in $AWS_REGION"
  cat > "$TMP/dns.json" <<EOF
{ "Comment": "LangSmith $NAME",
  "Changes": [{ "Action": "UPSERT",
    "ResourceRecordSet": { "Name": "$HOST", "Type": "A",
      "AliasTarget": { "HostedZoneId": "$lb_zone", "DNSName": "$lb", "EvaluateTargetHealth": false } } }] }
EOF
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "file://$TMP/dns.json" >/dev/null
  log "A $HOST -> $lb (zone $ZONE_ID; private zones can take ~1-2 minutes to answer)"
fi

# ------------------------------------------------------- 3 in-cluster checks ----
# WHAT  Every Deployment in the namespace (core, SmithDB, Fleet, Insights, Chat, operator)
#       is Available, and /api/v1/info reports SmithDB ingestion + query enabled.
section "05 3/4 In-cluster checks"
kubectl -n "$NS" wait --for=condition=Available deployment --all --timeout=15m >/dev/null
log "all Deployments in namespace $NS are Available"
info=$(kubectl -n "$NS" run "smoke-$RANDOM" --rm -i --restart=Never --quiet --image="$CURL_IMAGE" \
  --command -- curl -fsS --max-time 20 http://langsmith-frontend/api/v1/info) ||
  die "http://langsmith-frontend/api/v1/info did not answer from inside the cluster: kubectl -n $NS get pods ; kubectl -n $NS logs deploy/langsmith-frontend"
echo "$info" | jq -e '.instance_flags.sdb_ingestion_enabled and .instance_flags.sdb_query_enabled' >/dev/null ||
  die "SmithDB is not enabled in /api/v1/info: $(echo "$info" | jq -c .instance_flags)"
log "LangSmith $(echo "$info" | jq -r .version): SmithDB ingestion + query enabled"

# --------------------------------------------------- 4 through DNS + ALB + TLS ----
# --insecure only because a pod may not trust a private CA; the real certificate check
# belongs on a client machine (VERIFY in the header).
section "05 4/4 https://$HOST"
# Mode 'alb': the record was just written, and a private zone takes about a minute to answer.
[ "$INGRESS_MODE" = envoy-gateway ] || sleep 60
code=$(kubectl -n "$NS" run "smoke-$RANDOM" --rm -i --restart=Never --quiet --image="$CURL_IMAGE" \
  --command -- curl -sS --insecure -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST/api/v1/info" || true)
if [ "$code" = 200 ]; then log "https://$HOST -> 200 through the internal ALB$([ "$INGRESS_MODE" = alb ] || printf ' and Envoy Gateway')"
else warn "https://$HOST returned '$code' (DNS still propagating? re-run this script in a few minutes)"; fi

cat >&2 <<EOF

  LangSmith is up:        https://$HOST   (from networks that resolve the private zone)
  Without VPN/DNS (test): kubectl -n $NS port-forward svc/langsmith-frontend 8080:80  ->  http://localhost:8080
  Sign in with:           aws secretsmanager get-secret-value --secret-id ${SECRETS_PREFIX}initial-org-admin-email --query SecretString --output text
  Password:               aws secretsmanager get-secret-value --secret-id ${SECRETS_PREFIX}initial-org-admin-password --query SecretString --output text
EOF
