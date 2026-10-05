// =============================================================================
// outputs.ts — the values the post-deploy scripts read.
//
// `npx cdk deploy --all -c config=<env>` writes these to out/cdk-outputs.json (cdk.json sets
// outputsFile); post-deploy/lib.sh reads them with jq. Output names are a contract with
// post-deploy/ and tools/: rename one here and you must rename it there (test/outputs.test.ts
// checks both directions). Outputs whose component is off are simply not emitted.
// =============================================================================
import { CfnOutput, Stack } from 'aws-cdk-lib';

export const OUTPUT_DESCRIPTIONS = {
  Name: 'Install name (prefix of every resource)',
  Region: 'AWS region',
  Account: 'AWS account ID',
  WorkloadIdentity: "How pods get AWS credentials: 'irsa' or 'podIdentity'",
  SmithdbTier: 'SmithDB sizing preset for the Helm values',
  SmithdbResources: "'tier', or 'lab' (post-deploy/04 adds helm/smithdb-lab.yaml)",
  ClusterName: 'EKS cluster name',
  ClusterSecurityGroupId: 'Security group EKS created for the cluster (on the nodes and, in Layout B, on the pod interfaces)',
  VpcId: 'VPC ID',
  VpcCidrs: 'VPC CIDRs, comma-separated',
  PrivateSubnetIds: 'Private subnet IDs, comma-separated (the internal ALB is in these)',
  PodSubnets: 'Layout B pod subnets as <az>=<subnet-id>, comma-separated (post-deploy/04 step 3 checks their tags)',
  AlbSecurityGroupId: 'Security group for the internal ALB (<name>-alb)',
  KmsKeyArn: 'KMS key for EKS secrets encryption',
  BlobBucket: 'S3 bucket for LangSmith blobs',
  SmithdbBucket: 'S3 bucket for SmithDB data',
  SecretsPrefix: 'Secrets Manager prefix of every app secret',
  ConnectionsSecretName: 'Secret with host names and IAM user names',
  CoreDbEndpoint: 'Core PostgreSQL endpoint',
  CoreDbMasterSecretArn: 'Secret with the core PostgreSQL master credentials (bootstrap Job only)',
  MetastoreDbEndpoint: 'Metastore PostgreSQL endpoint',
  MetastoreDbMasterSecretArn: 'Secret with the metastore master credentials (bootstrap Job only)',
  ValkeyEndpoint: 'Valkey primary endpoint',
  PrivateZoneId: 'Route 53 private hosted zone ID',
  Hostname: 'LangSmith hostname',
  CertificateArn: 'ACM certificate ARN for the ALB (empty: import one with post-deploy/00)',
  IngressMode: "How traffic reaches LangSmith: 'envoy-gateway' (CDK's ALB -> Envoy Gateway) or 'alb' (ALB from the Ingress)",
  TargetGroupArn: 'ALB target group for the Envoy Gateway proxy pods (post-deploy/04 binds it)',
  LoadBalancerDnsName: 'DNS name of the internal ALB that CDK created',
  LangsmithNamespace: 'Kubernetes namespace for LangSmith',
  LangsmithRoleArn: 'IAM role for the LangSmith pods',
  SmithdbRoleArn: 'IAM role for SmithDB',
  ExternalSecretsRoleArn: 'IAM role for External Secrets Operator',
  LoadBalancerControllerRoleArn: 'IAM role for the AWS Load Balancer Controller',
  ClusterAutoscalerRoleArn: 'IAM role for Cluster Autoscaler',
  BastionInstanceId: 'Bastion instance: aws ssm start-session --target <id>',
} as const;

export type OutputName = keyof typeof OUTPUT_DESCRIPTIONS;

/** Outputs for you to look up (console, runbooks); no script reads them. */
export const INFORMATIONAL_OUTPUTS: OutputName[] = [
  'ClusterSecurityGroupId', 'VpcCidrs', 'KmsKeyArn', 'CoreDbEndpoint', 'MetastoreDbEndpoint', 'ValkeyEndpoint', 'BastionInstanceId',
];

/** One CfnOutput per defined value. */
export function addOutputs(stack: Stack, values: Partial<Record<OutputName, string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;
    new CfnOutput(stack, name, { value, description: OUTPUT_DESCRIPTIONS[name as OutputName] });
  }
}
