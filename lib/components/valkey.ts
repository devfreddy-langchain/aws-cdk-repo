// =============================================================================
// 8 — ElastiCache Valkey
// WHAT  Replication group <name> (Valkey, valkey.engineVersion; cluster mode off), four IAM users
//       <name>-core / -fleet / -insights / -polly, and user group <name>.
// WHY   IAM authentication: each consumer connects as its own user with a 15-minute IAM token
//       (no password). Attaching a user group switches the "default" user off. Transit
//       encryption is REQUIRED (TLS only) and data is encrypted at rest. With 2+ nodes,
//       automatic failover and Multi-AZ are on. Redis database index per consumer:
//       0 core, 1 Fleet, 2 Chat (polly), 3 Insights (set in the <name>/connections secret).
// HOW   AWS::ElastiCache::User/UserGroup/SubnetGroup/ReplicationGroup (L1 — CDK has no
//       higher-level construct for these). Takes about 15 minutes.
// =============================================================================
import { aws_elasticache as elasticache, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LangSmithConfig, Sizes } from '../config';
import { CACHE_CONSUMERS, Names } from '../naming';

export interface ValkeyInfo {
  primaryEndpoint: string;
  replicationGroupId: string;
}

export interface ValkeyProps {
  cfg: LangSmithConfig;
  names: Names;
  sizes: Sizes;
  subnetIds: string[];
  securityGroupId: string;
  removalPolicy: RemovalPolicy;
}

export class Valkey extends Construct {
  public readonly info: ValkeyInfo;

  constructor(scope: Construct, id: string, props: ValkeyProps) {
    super(scope, id);
    const { cfg, names, sizes } = props;

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'SubnetGroup', {
      cacheSubnetGroupName: names.cacheSubnetGroup,
      description: `LangSmith ${cfg.name}`,
      subnetIds: props.subnetIds,
    });

    // For IAM authentication the user ID and the user name must be identical.
    const users = CACHE_CONSUMERS.map((consumer) => new elasticache.CfnUser(this, `User-${consumer}`, {
      userId: names.cacheUser(consumer),
      userName: names.cacheUser(consumer),
      engine: 'valkey',
      authenticationMode: { Type: 'iam' },
      accessString: 'on ~* &* +@all',
    }));

    const userGroup = new elasticache.CfnUserGroup(this, 'UserGroup', {
      userGroupId: names.cacheId,
      engine: 'valkey',
      userIds: users.map((u) => u.ref),
    });

    const multiNode = sizes.cacheNodes >= 2;
    const group = new elasticache.CfnReplicationGroup(this, 'ReplicationGroup', {
      replicationGroupId: names.cacheId,
      replicationGroupDescription: `LangSmith ${cfg.name}`,
      engine: 'valkey',
      engineVersion: cfg.valkey.engineVersion,
      cacheNodeType: sizes.cacheNodeType,
      numCacheClusters: sizes.cacheNodes,
      automaticFailoverEnabled: multiNode,
      multiAzEnabled: multiNode,
      cacheParameterGroupName: `default.valkey${cfg.valkey.engineVersion.split('.')[0]}`,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [props.securityGroupId],
      transitEncryptionEnabled: true,
      transitEncryptionMode: 'required',
      atRestEncryptionEnabled: true,
      userGroupIds: [userGroup.ref],
      snapshotRetentionLimit: sizes.pgBackupDays, // the same retention as the databases' backups (environment)
    });
    group.applyRemovalPolicy(props.removalPolicy);

    this.info = { primaryEndpoint: group.attrPrimaryEndPointAddress, replicationGroupId: names.cacheId };
  }
}
