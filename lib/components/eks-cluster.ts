// =============================================================================
// 4 — EKS cluster (and the OIDC provider for IRSA)
// WHAT  The EKS control plane, cluster-admin access entries, and — in IRSA mode — the IAM OIDC
//       provider that lets pods trade their ServiceAccount token for AWS credentials.
// WHY   authenticationMode API: access is granted with EKS access entries (no aws-auth
//       ConfigMap). Kubernetes Secrets are encrypted with the KMS key. All control-plane logs on.
//       The private endpoint is always on; a public endpoint only for eks.publicAccessCidrs.
//       bootstrapSelfManagedAddons = false: vpc-cni/kube-proxy/coredns come as versioned EKS
//       managed add-ons instead (eks-addons.ts).
//       bootstrapClusterCreatorAdminPermissions = false: the "creator" here is CloudFormation's
//       deployment role, which should not be a Kubernetes admin; admins are listed explicitly.
//       The log group /aws/eks/<name>/cluster is created here, BEFORE the cluster: otherwise
//       EKS creates it itself — untagged, kept forever, and left behind by `cdk destroy`.
// HOW   AWS::Logs::LogGroup, AWS::EKS::Cluster (L1, 1:1 with `aws eks create-cluster`),
//       AWS::EKS::AccessEntry, AWS::IAM::OIDCProvider. Takes about 10 minutes.
// =============================================================================
import { createHash } from 'crypto';
import { Aws, aws_eks as eks, aws_iam as iam, aws_logs as logs, Fn, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LangSmithConfig } from '../config';
import { Names } from '../naming';

export interface EksClusterProps {
  cfg: LangSmithConfig;
  names: Names;
  clusterRoleArn: string;
  subnetIds: string[];
  /** The <name>-eks-api security group. */
  securityGroupId: string;
  /** KMS key for secrets encryption; undefined = no envelope encryption. */
  secretsKeyArn?: string;
  /** Role ARNs that become cluster admins (eks.adminRoleArns). */
  adminPrincipalArns: string[];
  /** The bastion role, also a cluster admin (a reference when this stack creates it). */
  bastionRoleArn?: string;
  /** What `cdk destroy` does with the control-plane log group (follows dataRemovalPolicy). */
  logRemovalPolicy: RemovalPolicy;
}

/** Control-plane log retention when eks.logRetentionDays is not set (the default of the terraform-aws-modules/eks module the upstream Terraform uses). */
export const DEFAULT_LOG_RETENTION_DAYS = 90;

export class EksCluster extends Construct {
  public readonly cluster: eks.CfnCluster;
  /** Security group EKS creates for the cluster (nodes and pods use it). */
  public readonly clusterSecurityGroupId: string;
  /** IRSA only: the OIDC provider ARN and issuer host the trust policies need. */
  public readonly oidc?: { providerArn: string; issuerHost: string };

  constructor(scope: Construct, id: string, props: EksClusterProps) {
    super(scope, id);
    const { cfg, names } = props;
    const publicCidrs = cfg.eks.publicAccessCidrs;

    const logGroup = new logs.CfnLogGroup(this, 'ControlPlaneLogs', {
      logGroupName: names.clusterLogGroup,
      retentionInDays: cfg.eks.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
    });
    logGroup.applyRemovalPolicy(props.logRemovalPolicy);

    this.cluster = new eks.CfnCluster(this, 'Cluster', {
      name: names.clusterName,
      version: cfg.eks.version,
      roleArn: props.clusterRoleArn,
      resourcesVpcConfig: {
        subnetIds: props.subnetIds,
        securityGroupIds: [props.securityGroupId],
        endpointPrivateAccess: true,
        endpointPublicAccess: publicCidrs.length > 0,
        publicAccessCidrs: publicCidrs.length > 0 ? publicCidrs : undefined,
      },
      accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: false },
      encryptionConfig: props.secretsKeyArn
        ? [{ resources: ['secrets'], provider: { keyArn: props.secretsKeyArn } }]
        : undefined,
      logging: {
        clusterLogging: {
          enabledTypes: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'].map((type) => ({ type })),
        },
      },
      bootstrapSelfManagedAddons: false,
    });
    this.cluster.node.addDependency(logGroup); // the log group must exist before EKS starts writing
    this.clusterSecurityGroupId = this.cluster.attrClusterSecurityGroupId;

    // Cluster admins: one access entry each, with the AWS-managed cluster-admin access policy.
    // The logical ID comes from the ARN, not its position in the list: reordering or removing an
    // admin must not make CloudFormation re-create entries that already exist.
    const admins: [string, string][] = props.adminPrincipalArns.map((arn) => [`Admin${createHash('sha256').update(arn).digest('hex').slice(0, 8)}`, arn]);
    if (props.bastionRoleArn) admins.push(['BastionAdmin', props.bastionRoleArn]);
    for (const [logicalId, principalArn] of admins) {
      new eks.CfnAccessEntry(this, logicalId, {
        clusterName: this.cluster.ref,
        principalArn,
        accessPolicies: [{
          policyArn: `arn:${Aws.PARTITION}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy`,
          accessScope: { type: 'cluster' },
        }],
      });
    }

    // IRSA: register the cluster's OIDC issuer in IAM (native resource, no Lambda).
    if (cfg.workloadIdentity === 'irsa') {
      const provider = new iam.CfnOIDCProvider(this, 'OidcProvider', {
        url: this.cluster.attrOpenIdConnectIssuerUrl,
        clientIdList: ['sts.amazonaws.com'],
      });
      this.oidc = {
        providerArn: provider.attrArn,
        // "https://oidc.eks.<region>.amazonaws.com/id/<ID>" -> "oidc.eks.<region>.amazonaws.com/id/<ID>"
        issuerHost: Fn.select(1, Fn.split('//', this.cluster.attrOpenIdConnectIssuerUrl)),
      };
    }
  }
}
