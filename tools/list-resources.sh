#!/usr/bin/env bash
# =============================================================================
# tools/list-resources.sh — everything one LangSmith environment has in AWS. READ-ONLY.
#
#   ./tools/list-resources.sh <name> [--region <region>] [--qualifier <cdk-bootstrap-qualifier>]
#
# <name> is the `name` in your CDK config. Run it:
#   * any time, to see what an environment consists of;
#   * after `cdk destroy` (or tools/teardown.sh), to see what is LEFT. An empty section = nothing left.
#
# WHAT IT CHECKS
#   1. Everything tagged langsmith-env=<name> in the region (Resource Groups Tagging API):
#      what CloudFormation created, plus what the EBS CSI driver, the Load Balancer Controller and
#      post-deploy/00 and 03 created (they use the same tags).
#   2. By NAME, what cannot carry tags, or that the tagging API does not show:
#      the CloudFormation stacks, IAM roles/policies/instance profiles (global), the EKS log group,
#      the KMS alias, secrets scheduled for deletion, ECR repositories, final DB/cache snapshots,
#      leftover EBS volumes and network interfaces — and, with --qualifier, the CDK bootstrap toolkit.
#   Not covered: DNS records post-deploy/05 wrote into a hosted zone you brought (records have no tags).
#
# Needs: aws CLI v2, credentials for the account. Changes nothing.
# =============================================================================
set -euo pipefail

usage() { echo "usage: $0 <name> [--region <region>] [--qualifier <cdk-bootstrap-qualifier>]" >&2; exit 2; }
[ $# -ge 1 ] || usage
NAME=$1; shift
REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-}}
QUALIFIER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION=${2:?}; shift 2 ;;
    --qualifier) QUALIFIER=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done
# Same rule as the CDK config check (lib/config/validate.ts), so the name is safe inside queries below.
[[ "$NAME" =~ ^[a-z][a-z0-9-]{0,19}$ ]] || { echo "ERROR: '$NAME' is not a valid config name" >&2; exit 2; }
[ -z "$QUALIFIER" ] || [[ "$QUALIFIER" =~ ^[a-z0-9]{1,10}$ ]] || { echo "ERROR: qualifier: lowercase letters/digits, max 10" >&2; exit 2; }
[ -n "$REGION" ] || REGION=$(aws configure get region || true)
[ -n "$REGION" ] || { echo "ERROR: no region: pass --region or set AWS_REGION" >&2; exit 2; }
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
section() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# show <text>: print the AWS CLI text output, or "(none)". --output text prints "None" for null.
show() { if [ -z "$1" ] || [ "$1" = "None" ]; then echo "  (none)"; else printf '%s\n' "$1" | sed 's/^/  /'; fi; }

echo "LangSmith environment '$NAME' — account $ACCOUNT, region $REGION"

section "1. Tagged langsmith-env=$NAME (region $REGION)"
echo "  (The tagging index can still list resources deleted in about the last hour, e.g. terminated"
echo "   instances; sections 2-9 check the live state.)"
show "$(aws resourcegroupstaggingapi get-resources --tag-filters "Key=langsmith-env,Values=$NAME" \
  --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | sort)"

section "2. CloudFormation stacks"
show "$(aws cloudformation describe-stacks --query \
  "Stacks[?StackName=='$NAME-network' || StackName=='$NAME-langsmith'].[StackName,StackStatus]" --output text)"

section "3. IAM (global) — roles, policies, instance profiles named $NAME-*; OIDC providers tagged $NAME"
show "$(aws iam list-roles --query "Roles[?starts_with(RoleName, '$NAME-')].RoleName" --output text | tr '\t' '\n')"
show "$(aws iam list-policies --scope Local --query "Policies[?starts_with(PolicyName, '$NAME-')].Arn" --output text | tr '\t' '\n')"
show "$(aws iam list-instance-profiles --query "InstanceProfiles[?starts_with(InstanceProfileName, '$NAME-')].InstanceProfileName" --output text | tr '\t' '\n')"
oidc=""
for arn in $(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text); do
  tag=$(aws iam list-open-id-connect-provider-tags --open-id-connect-provider-arn "$arn" \
    --query "Tags[?Key=='langsmith-env'].Value | [0]" --output text)
  [ "$tag" = "$NAME" ] && oidc="$oidc$arn"$'\n'
done
show "${oidc%$'\n'}"

section "4. EKS control-plane log group, KMS alias"
show "$(aws logs describe-log-groups --log-group-name-prefix "/aws/eks/$NAME/" --query 'logGroups[].logGroupName' --output text)"
show "$(aws kms list-aliases --query "Aliases[?AliasName=='alias/$NAME'].[AliasName,TargetKeyId]" --output text)"

section "5. Secrets $NAME/* (including ones scheduled for deletion — their names stay taken)"
show "$(aws secretsmanager list-secrets --include-planned-deletion --filters "Key=name,Values=$NAME/" \
  --query 'SecretList[].[Name,DeletedDate]' --output text)"

section "6. ECR repositories $NAME/* (post-deploy/03)"
show "$(aws ecr describe-repositories --query "repositories[?starts_with(repositoryName, '$NAME/')].repositoryName" --output text | tr '\t' '\n')"

section "7. Final snapshots (dataRemovalPolicy: retain)"
show "$(aws rds describe-db-snapshots --snapshot-type manual \
  --query "DBSnapshots[?starts_with(DBInstanceIdentifier, '$NAME-')].[DBSnapshotIdentifier,SnapshotCreateTime]" --output text)"
show "$(aws elasticache describe-snapshots --query "Snapshots[?ReplicationGroupId=='$NAME'].SnapshotName" --output text)"

section "8. Unattached EBS volumes and network interfaces tagged $NAME (should be none)"
show "$(aws ec2 describe-volumes --filters "Name=tag:langsmith-env,Values=$NAME" Name=status,Values=available \
  --query 'Volumes[].[VolumeId,Size,CreateTime]' --output text)"
show "$(aws ec2 describe-network-interfaces --filters "Name=tag:langsmith-env,Values=$NAME" Name=status,Values=available \
  --query 'NetworkInterfaces[].[NetworkInterfaceId,Description]' --output text)"

if [ -n "$QUALIFIER" ]; then
  section "9. CDK bootstrap toolkit (qualifier $QUALIFIER)"
  show "$(aws cloudformation describe-stacks --query \
    "Stacks[?StackName=='CDKToolkit-$QUALIFIER'].[StackName,StackStatus]" --output text)"
  show "$(aws s3api list-buckets --query "Buckets[?Name=='cdk-$QUALIFIER-assets-$ACCOUNT-$REGION'].Name" --output text)"
  show "$(aws iam list-roles --query "Roles[?starts_with(RoleName, 'cdk-$QUALIFIER-')].RoleName" --output text | tr '\t' '\n')"
fi
echo
