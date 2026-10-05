// =============================================================================
// roles.ts — EVERY IAM role this app can create, in one file.
//
// Read this file top to bottom to review all of the install's IAM. Each role is a
// RoleSpec: name + trust policy (trust.ts) + AWS managed policies + inline
// policies (policies.ts). One function, createOrImportRole(), turns a spec into
// an AWS::IAM::Role — or, if you brought your own role (config.existingRoles),
// creates nothing and just returns your ARN.
//
//   Role (name)                      Used by
//   <name>-eks-cluster               the EKS control plane
//   <name>-eks-node                  worker nodes (EC2)
//   <name>-bastion                   the optional SSM jump host
//   <name>-vpc-cni                   kube-system/aws-node (VPC CNI add-on)
//   <name>-ebs-csi                   kube-system/ebs-csi-controller-sa
//   <name>-langsmith                 LangSmith pods (the LangSmith namespace)
//   <name>-smithdb                   <namespace>/langsmith-smithdb
//   <name>-eso                       external-secrets/external-secrets
//   <name>-lbc                       kube-system/aws-load-balancer-controller
//   <name>-cluster-autoscaler        kube-system/cluster-autoscaler
// README.md, Appendix C, lists each one.
//
// Nodes get NO access to buckets, secrets or databases: pods get their own roles.
// =============================================================================
import { aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ExistingRoles, LangSmithConfig } from '../config';
import { CACHE_CONSUMERS, CORE_DB_USERS, METASTORE_DB_USER, Names } from '../naming';
import {
  bedrockPolicy, clusterAutoscalerPolicy, eksDescribeClusterPolicy, eksSecretsEncryptionPolicy, langsmithAppPolicy, managed,
  secretsReadPolicy, smithdbPolicy, Where,
} from './policies';
import { ec2Trust, eksServiceTrust } from './trust';

/** The roles, by the key used in config.existingRoles and names.role. */
export type RoleKey = Exclude<keyof ExistingRoles, 'bastionInstanceProfileName'>;

export interface ServiceAccountRef { namespace: string; name: string }

/**
 * The Kubernetes ServiceAccount each platform role is for. These names come from the
 * Helm charts (post-deploy/04 installs them with exactly these names). SmithDB's is in the
 * LangSmith namespace from the config (smithdbServiceAccount).
 */
export const SERVICE_ACCOUNTS = {
  vpcCni: { namespace: 'kube-system', name: 'aws-node' },
  ebsCsi: { namespace: 'kube-system', name: 'ebs-csi-controller-sa' },
  externalSecrets: { namespace: 'external-secrets', name: 'external-secrets' },
  loadBalancerController: { namespace: 'kube-system', name: 'aws-load-balancer-controller' },
  clusterAutoscaler: { namespace: 'kube-system', name: 'cluster-autoscaler' },
} as const;

export interface RoleSpec {
  key: RoleKey;
  roleName: string;
  description: string;
  /** Trust policy: an object, or (IRSA in the stack) an Fn::Sub string. */
  trust: unknown;
  managedPolicyArns: string[];
  /** Inline policies by name. */
  inlinePolicies: Record<string, object>;
  /** Workload roles: the ServiceAccount(s) that use the role. */
  serviceAccounts?: ServiceAccountRef[];
}

/** Everything the specs need. The stack passes real references; iam-pack passes placeholders. */
export interface SpecInputs extends Where {
  cfg: LangSmithConfig;
  names: Names;
  /** Trust policy for a pod ServiceAccount ('*' = every SA in the namespace), per workloadIdentity. */
  podTrust: (namespace: string, serviceAccount: string) => unknown;
  /** KMS key for EKS secrets encryption (omit when the key policy grants the role instead). */
  eksSecretsKeyArn?: string;
  coreDbResourceId: string;
  metastoreDbResourceId: string;
  rdsMasterSecretArns: string[];
  /** ARN of the <name>-lbc managed policy (created next to the role). */
  loadBalancerControllerPolicyArn: string;
}

// ---- <name>-eks-cluster ----------------------------------------------------------------
export function eksClusterRoleSpec(i: SpecInputs): RoleSpec {
  return {
    key: 'eksCluster',
    roleName: i.names.role.eksCluster,
    description: 'EKS control plane for LangSmith',
    trust: eksServiceTrust(),
    managedPolicyArns: [managed(i.partition, 'AmazonEKSClusterPolicy')],
    inlinePolicies: i.eksSecretsKeyArn ? { 'secrets-encryption': eksSecretsEncryptionPolicy(i.eksSecretsKeyArn) } : {},
  };
}

// ---- <name>-eks-node and <name>-bastion --------------------------------------------------
export function eksNodeRoleSpec(i: SpecInputs): RoleSpec {
  return {
    key: 'eksNode',
    roleName: i.names.role.eksNode,
    description: 'EKS worker nodes for LangSmith (no CNI policy: the VPC CNI has its own role)',
    trust: ec2Trust(),
    managedPolicyArns: [
      managed(i.partition, 'AmazonEKSWorkerNodePolicy'),
      managed(i.partition, 'AmazonEC2ContainerRegistryPullOnly'), // pull mirrored images from ECR
      managed(i.partition, 'AmazonSSMManagedInstanceCore'), // Session Manager access to nodes for debugging
    ],
    inlinePolicies: {},
  };
}

export function bastionRoleSpec(i: SpecInputs): RoleSpec {
  const extra = i.cfg.bastion.operatorPolicyArn ? [i.cfg.bastion.operatorPolicyArn] : [];
  return {
    key: 'bastion',
    roleName: i.names.role.bastion,
    description: 'SSM-only jump host for LangSmith (becomes an EKS cluster admin)',
    trust: ec2Trust(),
    managedPolicyArns: [managed(i.partition, 'AmazonSSMManagedInstanceCore'), ...extra],
    inlinePolicies: { kubeconfig: eksDescribeClusterPolicy(i, i.names.clusterName) },
  };
}

// ---- add-on roles: <name>-vpc-cni, <name>-ebs-csi ------------------------------------------
export function vpcCniRoleSpec(i: SpecInputs): RoleSpec {
  const sa = SERVICE_ACCOUNTS.vpcCni;
  return {
    key: 'vpcCni',
    roleName: i.names.role.vpcCni,
    description: 'VPC CNI add-on (assigns pod IPs)',
    trust: i.podTrust(sa.namespace, sa.name),
    managedPolicyArns: [managed(i.partition, 'AmazonEKS_CNI_Policy')],
    inlinePolicies: {},
    serviceAccounts: [sa],
  };
}

export function ebsCsiRoleSpec(i: SpecInputs): RoleSpec {
  const sa = SERVICE_ACCOUNTS.ebsCsi;
  return {
    key: 'ebsCsi',
    roleName: i.names.role.ebsCsi,
    description: 'EBS CSI driver add-on (creates the SmithDB cache volumes)',
    trust: i.podTrust(sa.namespace, sa.name),
    managedPolicyArns: [managed(i.partition, 'service-role/AmazonEBSCSIDriverPolicy')],
    inlinePolicies: {},
    serviceAccounts: [sa],
  };
}

// ---- <name>-langsmith ------------------------------------------------------------------
export function langsmithRoleSpec(i: SpecInputs): RoleSpec {
  const ns = i.cfg.kubernetes.langsmithNamespace;
  // IRSA: one trust for every ServiceAccount in the namespace. Pod Identity: one association per ServiceAccount.
  const serviceAccounts = i.cfg.workloadIdentity === 'irsa'
    ? [{ namespace: ns, name: '*' }]
    : i.cfg.kubernetes.langsmithServiceAccounts.map((name) => ({ namespace: ns, name }));
  const inline: Record<string, object> = {
    'langsmith-app': langsmithAppPolicy({
      ...where(i),
      blobBucket: i.names.blobBucket,
      coreDbResourceId: i.coreDbResourceId,
      coreDbUsers: CORE_DB_USERS,
      cacheReplicationGroupId: i.names.cacheId,
      cacheUserIds: CACHE_CONSUMERS.map((c) => i.names.cacheUser(c)),
    }),
  };
  if (i.cfg.workloadRoles.bedrock) inline.bedrock = bedrockPolicy(where(i));
  return {
    key: 'langsmith',
    roleName: i.names.role.langsmith,
    description: 'Shared role for the LangSmith application pods',
    trust: i.podTrust(ns, '*'),
    managedPolicyArns: [],
    inlinePolicies: inline,
    serviceAccounts,
  };
}

// ---- <name>-smithdb --------------------------------------------------------------------
/** SmithDB's ServiceAccount: chart 0.17.0, release "langsmith", in the LangSmith namespace. */
export function smithdbServiceAccount(cfg: LangSmithConfig): ServiceAccountRef {
  return { namespace: cfg.kubernetes.langsmithNamespace, name: 'langsmith-smithdb' };
}

export function smithdbRoleSpec(i: SpecInputs): RoleSpec {
  const sa = smithdbServiceAccount(i.cfg);
  return {
    key: 'smithdb',
    roleName: i.names.role.smithdb,
    description: 'SmithDB (trace store): its bucket and its metastore database',
    trust: i.podTrust(sa.namespace, sa.name),
    managedPolicyArns: [],
    inlinePolicies: {
      smithdb: smithdbPolicy({
        ...where(i),
        smithdbBucket: i.names.smithdbBucket,
        metastoreDbResourceId: i.metastoreDbResourceId,
        metastoreDbUser: METASTORE_DB_USER,
      }),
    },
    serviceAccounts: [sa],
  };
}

// ---- <name>-eso ------------------------------------------------------------------------
export function externalSecretsRoleSpec(i: SpecInputs): RoleSpec {
  const sa = SERVICE_ACCOUNTS.externalSecrets;
  return {
    key: 'externalSecrets',
    roleName: i.names.role.externalSecrets,
    description: 'External Secrets Operator: read the <name>/ secrets and the RDS master secrets',
    trust: i.podTrust(sa.namespace, sa.name),
    managedPolicyArns: [],
    inlinePolicies: {
      'secrets-read': secretsReadPolicy({ ...where(i), secretsPrefix: i.names.secretsPrefix, rdsMasterSecretArns: i.rdsMasterSecretArns }),
    },
    serviceAccounts: [sa],
  };
}

// ---- <name>-lbc ------------------------------------------------------------------------
export function loadBalancerControllerRoleSpec(i: SpecInputs): RoleSpec {
  const sa = SERVICE_ACCOUNTS.loadBalancerController;
  return {
    key: 'loadBalancerController',
    roleName: i.names.role.loadBalancerController,
    description: 'AWS Load Balancer Controller: registers the Envoy pods with the ALB (or creates the ALB, ingress mode alb)',
    trust: i.podTrust(sa.namespace, sa.name),
    // The published controller policy is too long for an inline policy, so it is a customer-managed policy.
    managedPolicyArns: [i.loadBalancerControllerPolicyArn],
    inlinePolicies: {},
    serviceAccounts: [sa],
  };
}

// ---- <name>-cluster-autoscaler ---------------------------------------------------------
export function clusterAutoscalerRoleSpec(i: SpecInputs): RoleSpec {
  const sa = SERVICE_ACCOUNTS.clusterAutoscaler;
  return {
    key: 'clusterAutoscaler',
    roleName: i.names.role.clusterAutoscaler,
    description: 'Cluster Autoscaler: resize this cluster\'s node groups only',
    trust: i.podTrust(sa.namespace, sa.name),
    managedPolicyArns: [],
    inlinePolicies: { 'cluster-autoscaler': clusterAutoscalerPolicy(i.names.clusterName) },
    serviceAccounts: [sa],
  };
}

// -----------------------------------------------------------------------------------
// Which roles a config uses — one rule, read by the stack and by iam-pack.
// -----------------------------------------------------------------------------------
export function roleEnabled(cfg: LangSmithConfig, key: RoleKey): boolean {
  switch (key) {
    case 'eksCluster': return cfg.eks.enabled;
    case 'eksNode': return cfg.eks.nodeGroup.enabled;
    case 'bastion': return cfg.bastion.enabled;
    case 'vpcCni': return cfg.eks.addons.vpcCni;
    // The EBS CSI add-on runs on nodes, so it (and its role) comes with this app's node group,
    // or right away on a cluster you bring (its nodes exist already).
    case 'ebsCsi': return cfg.eks.addons.ebsCsiDriver && (cfg.eks.nodeGroup.enabled || !cfg.eks.enabled);
    case 'langsmith': return cfg.workloadRoles.langsmith;
    case 'smithdb': return cfg.workloadRoles.smithdb;
    case 'externalSecrets': return cfg.workloadRoles.externalSecrets;
    case 'loadBalancerController': return cfg.workloadRoles.loadBalancerController;
    case 'clusterAutoscaler': return cfg.workloadRoles.clusterAutoscaler;
  }
}

// -----------------------------------------------------------------------------------
// Creating the role
// -----------------------------------------------------------------------------------
const LOGICAL_IDS: Record<RoleKey, string> = {
  eksCluster: 'EksClusterRole',
  eksNode: 'EksNodeRole',
  bastion: 'BastionRole',
  vpcCni: 'VpcCniRole',
  ebsCsi: 'EbsCsiRole',
  langsmith: 'LangSmithRole',
  smithdb: 'SmithdbRole',
  externalSecrets: 'ExternalSecretsRole',
  loadBalancerController: 'LoadBalancerControllerRole',
  clusterAutoscaler: 'ClusterAutoscalerRole',
};

/** A role as the rest of the stack sees it: its ARN and its name. */
export interface RoleRef { arn: string; name: string }

/**
 * Creates the role described by `spec` — or, when config.existingRoles has an ARN
 * for this role, creates nothing and returns that ARN.
 *
 * The role is an AWS::IAM::Role written 1:1 from the spec (the same as
 * `aws iam create-role` + `attach-role-policy` + `put-role-policy`).
 */
export function createOrImportRole(scope: Construct, spec: RoleSpec, cfg: LangSmithConfig): RoleRef {
  const existingArn = cfg.existingRoles[spec.key];
  if (existingArn) {
    // Bring your own role: nothing is created and nothing is attached to it.
    // The name is the last part of the ARN (arn:aws:iam::<account>:role/<optional-path/>name).
    return { arn: existingArn, name: existingArn.split('/').pop()! };
  }
  const role = new iam.CfnRole(scope, LOGICAL_IDS[spec.key], {
    roleName: spec.roleName,
    description: spec.description,
    assumeRolePolicyDocument: spec.trust,
    managedPolicyArns: spec.managedPolicyArns.length > 0 ? spec.managedPolicyArns : undefined,
    policies: Object.entries(spec.inlinePolicies).map(([policyName, policyDocument]) => ({ policyName, policyDocument })),
    permissionsBoundary: cfg.permissionsBoundaryArn,
  });
  // For AWS::IAM::Role, Ref returns the role name.
  return { arn: role.attrArn, name: role.ref };
}

/** The bastion's instance profile (an EC2 instance gets its role through one). Returns the profile name. */
export function createOrImportBastionInstanceProfile(scope: Construct, cfg: LangSmithConfig, names: Names, role: RoleRef): string {
  if (cfg.existingRoles.bastionInstanceProfileName) return cfg.existingRoles.bastionInstanceProfileName;
  const profile = new iam.CfnInstanceProfile(scope, 'BastionInstanceProfile', {
    instanceProfileName: names.bastionInstanceProfile,
    roles: [role.name],
  });
  return profile.ref;
}

function where(i: SpecInputs): Where {
  return { partition: i.partition, region: i.region, account: i.account };
}
