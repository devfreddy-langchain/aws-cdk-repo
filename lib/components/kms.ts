// =============================================================================
// 3 — KMS key for EKS secrets encryption
// WHAT  A customer-managed KMS key, alias/<name>, with yearly automatic rotation.
// WHY   EKS envelope-encrypts Kubernetes Secrets with it. Everything else uses AWS-managed
//       keys (aws/ebs, aws/rds, aws/secretsmanager, SSE-S3), as in the LangChain Terraform module.
// HOW   The key policy is the AWS default: the account administers the key through IAM.
//       If you bring your own cluster role (existingRoles.eksCluster), this construct adds ONE
//       statement to the key policy that lets that role use the key — your role is not changed.
//       With dataRemovalPolicy 'destroy' (test environments), `cdk destroy` schedules the key's deletion after
//       7 days, the minimum KMS allows, instead of the default 30.
// =============================================================================
import { aws_iam as iam, aws_kms as kms, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Names } from '../naming';

export interface EksSecretsKeyProps {
  names: Names;
  removalPolicy: RemovalPolicy;
  /** Set when the cluster role is brought by you: grant it through the key policy. */
  importedClusterRoleArn?: string;
}

export class EksSecretsKey extends Construct {
  public readonly keyArn: string;

  constructor(scope: Construct, id: string, props: EksSecretsKeyProps) {
    super(scope, id);
    const key = new kms.Key(this, 'Key', {
      alias: props.names.kmsAlias,
      description: `LangSmith ${props.names.clusterName}: EKS secrets encryption`,
      enableKeyRotation: true,
      removalPolicy: props.removalPolicy,
      pendingWindow: props.removalPolicy === RemovalPolicy.DESTROY ? Duration.days(7) : undefined,
    });
    if (props.importedClusterRoleArn) {
      key.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'EksClusterRoleEnvelopeEncryption',
        principals: [new iam.ArnPrincipal(props.importedClusterRoleArn)],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ListGrants', 'kms:DescribeKey', 'kms:CreateGrant'],
        resources: ['*'], // in a key policy, "*" means "this key"
      }));
    }
    this.keyArn = key.keyArn;
  }
}
