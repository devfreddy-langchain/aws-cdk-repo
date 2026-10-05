// =============================================================================
// naming.ts — every resource name, in one place.
//
// Names are derived from config only (never looked up), so they are known before
// anything exists. That is what lets an IAM team write policies in advance
// (npm run iam-pack) and lets post-deploy scripts find things by name.
// Everything starts with `name` and is tagged app=langsmith, langsmith-env=<name>.
// =============================================================================
import { LangSmithConfig, resolveSizes } from './config';

/** The four Valkey users: one per LangSmith consumer (core app, Fleet, Insights, Chat/Polly). */
export const CACHE_CONSUMERS = ['core', 'fleet', 'insights', 'polly'] as const;

/** PostgreSQL login roles that the DB bootstrap Job (post-deploy/04) creates with the rds_iam grant. */
export const CORE_DB_USERS = ['langsmith_app', 'langsmith_fleet', 'langsmith_insights', 'langsmith_polly'] as const;
export const METASTORE_DB_USER = 'smithdb_app';

/**
 * The tags on everything this app creates: on both stacks, on every resource that supports tags
 * (build-app.ts), in the launch templates (instances, volumes, network interfaces) and on the
 * EBS volumes the EBS CSI driver creates. Find a whole environment with:
 *   aws resourcegroupstaggingapi get-resources --tag-filters Key=langsmith-env,Values=<name>
 * or tools/list-resources.sh <name>.
 */
export function tagsFor(cfg: LangSmithConfig): Record<string, string> {
  return { app: 'langsmith', 'langsmith-env': cfg.name, ...(cfg.extraTags ?? {}) };
}

export function namesFor(cfg: LangSmithConfig) {
  const n = cfg.name;
  return {
    // Kubernetes
    clusterName: cfg.eks.enabled ? n : (cfg.eks.existingClusterName ?? n),
    // The instance type is part of the name: changing it makes CloudFormation create a new node
    // group and then delete the old one. (It cannot replace a node group that keeps its name.)
    nodeGroupName: `general-${resolveSizes(cfg).nodeInstanceType.replace(/\./g, '-')}`,
    launchTemplateName: `${n}-general`,
    // EKS writes control-plane logs to exactly this name; eks-cluster.ts creates it first.
    clusterLogGroup: `/aws/eks/${cfg.eks.enabled ? n : (cfg.eks.existingClusterName ?? n)}/cluster`,

    // IAM roles (README.md, Appendix C)
    role: {
      eksCluster: `${n}-eks-cluster`,
      eksNode: `${n}-eks-node`,
      bastion: `${n}-bastion`,
      vpcCni: `${n}-vpc-cni`,
      ebsCsi: `${n}-ebs-csi`,
      langsmith: `${n}-langsmith`,
      smithdb: `${n}-smithdb`,
      externalSecrets: `${n}-eso`,
      loadBalancerController: `${n}-lbc`,
      clusterAutoscaler: `${n}-cluster-autoscaler`,
    },
    lbcManagedPolicy: `${n}-lbc`,
    bastionInstanceProfile: `${n}-bastion`,

    // Internal ALB (ingress.mode 'envoy-gateway'; ALB names max 32 characters) and its Envoy target group
    alb: `${n}-alb`,
    envoyTargetGroup: `${n}-envoy`,

    // Security groups
    sg: { eksApi: `${n}-eks-api`, rds: `${n}-rds`, cache: `${n}-cache`, alb: `${n}-alb`, bastion: `${n}-bastion`, endpoints: `${n}-endpoints` },

    // KMS
    kmsAlias: `alias/${n}`,

    // S3 (bucket names are global, so the account ID is part of them)
    blobBucket: cfg.s3.blob.existingBucketName ?? `${n}-blob-${cfg.account}`,
    smithdbBucket: cfg.s3.smithdb.existingBucketName ?? `${n}-smithdb-${cfg.account}`,

    // Secrets Manager: everything under <name>/
    secretsPrefix: `${n}/`,
    secret: (suffix: string) => `${n}/${suffix}`,

    // RDS
    dbSubnetGroup: `${n}-db`,
    coreDbInstance: `${n}-core`,
    metastoreDbInstance: `${n}-metastore`,

    // ElastiCache
    cacheId: cfg.valkey.existing?.replicationGroupId ?? n,
    cacheSubnetGroup: `${n}-cache`,
    cacheUser: (consumer: string) => `${n}-${consumer}`,
  };
}

export type Names = ReturnType<typeof namesFor>;
