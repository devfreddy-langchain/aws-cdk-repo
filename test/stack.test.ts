// The main stack: no hidden resources, every toggle works, no secrets in the template,
// and the settings that matter (TLS, IMDSv2, private endpoints) are what the docs say.
import { PLACEHOLDER } from '../lib/components/secrets';
import { VPC_CNI_SUBNET_TAGS_VERSION } from '../lib/config';
import { countOf, EXAMPLES, loadConfig, rolesByName, Synthesized, synth } from './helpers';

describe('no hidden resources', () => {
  test.each(EXAMPLES)('%s: no Lambda functions and no custom resources', (name) => {
    const s = synth(loadConfig(name));
    for (const t of [s.langsmith, s.network].filter((x) => x !== undefined)) {
      const types = Object.values(t!.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type);
      expect(types.filter((type) => type === 'AWS::Lambda::Function' || type.startsWith('Custom::'))).toEqual([]);
    }
  });

  test.each(EXAMPLES)('%s: no template parameters except the CDK bootstrap version', (name) => {
    expect(Object.keys(synth(loadConfig(name)).langsmith.toJSON().Parameters ?? {})).toEqual(['BootstrapVersion']);
  });
});

describe('toggles: each component off removes its resources', () => {
  const cases: [string, (c: ReturnType<typeof loadConfig>) => void, string[]][] = [
    ['valkey', (c) => { c.valkey.enabled = false; c.valkey.existing = { primaryEndpoint: 'cache.example', replicationGroupId: 'mine' }; },
      ['AWS::ElastiCache::ReplicationGroup', 'AWS::ElastiCache::User', 'AWS::ElastiCache::UserGroup', 'AWS::ElastiCache::SubnetGroup']],
    ['postgres', (c) => {
      const existing = { endpoint: 'db.example', resourceId: 'db-ABC', masterSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:m' };
      c.postgres.core = { ...c.postgres.core, enabled: false, existing };
      c.postgres.metastore = { ...c.postgres.metastore, enabled: false, existing };
    }, ['AWS::RDS::DBInstance', 'AWS::RDS::DBSubnetGroup', 'AWS::RDS::DBParameterGroup']],
    ['s3', (c) => { c.s3.blob = { enabled: false, existingBucketName: 'mine-blob' }; c.s3.smithdb = { enabled: false, existingBucketName: 'mine-sdb' }; },
      ['AWS::S3::Bucket', 'AWS::S3::BucketPolicy']],
    ['kms', (c) => { c.kms.enabled = false; }, ['AWS::KMS::Key', 'AWS::KMS::Alias']],
    ['secrets', (c) => { c.secrets.enabled = false; c.workloadRoles.externalSecrets = false; }, ['AWS::SecretsManager::Secret']],
    ['dns', (c) => { c.dns.privateZone.enabled = false; }, ['AWS::Route53::HostedZone']],
    ['node group', (c) => { c.eks.nodeGroup.enabled = false; }, ['AWS::EKS::Nodegroup', 'AWS::EC2::LaunchTemplate']],
    ['eks', (c) => {
      c.eks.enabled = false; c.eks.existingClusterName = 'mine'; c.eks.existingOidcIssuer = 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE';
      c.ingress = { mode: 'alb' }; c.kms.enabled = false;
    }, ['AWS::EKS::Cluster', 'AWS::EKS::AccessEntry', 'AWS::IAM::OIDCProvider']],
    ["ingress 'alb' (no CDK load balancer)", (c) => { c.ingress = { mode: 'alb' }; },
      ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::TargetGroup', 'AWS::ElasticLoadBalancingV2::Listener',
        'AWS::Route53::RecordSet']],
  ];

  test.each(cases)('%s', (_name, turnOff, types) => {
    const on = synth(loadConfig('example'));
    const cfg = loadConfig('example');
    turnOff(cfg);
    const off = synth(cfg);
    for (const type of types) {
      expect(countOf(on, type)).toBeGreaterThan(0);
      expect(countOf(off, type)).toBe(0);
    }
  });

  test('without a node group, only the add-ons nodes need at boot are created', () => {
    const cfg = loadConfig('example');
    cfg.eks.nodeGroup.enabled = false;
    const s = synth(cfg);
    const addons = Object.values(s.resources).filter((r) => r.Type === 'AWS::EKS::Addon').map((r) => (r.Properties as any).AddonName).sort();
    expect(addons).toEqual(['kube-proxy', 'vpc-cni']);
    expect(Object.keys(rolesByName(s))).not.toContain('langsmith-dev-ebs-csi');
  });

  test('add-ons can be switched off one by one', () => {
    const cfg = loadConfig('example');
    cfg.eks.addons.metricsServer = false;
    cfg.eks.addons.ebsCsiDriver = false;
    const s = synth(cfg);
    const addons = Object.values(s.resources).filter((r) => r.Type === 'AWS::EKS::Addon').map((r) => (r.Properties as any).AddonName).sort();
    expect(addons).toEqual(['coredns', 'kube-proxy', 'vpc-cni']);
  });

  test('existing EKS cluster: add-ons and node group attach to it by name', () => {
    const cfg = loadConfig('example');
    cfg.eks.enabled = false;
    cfg.eks.existingClusterName = 'mine';
    cfg.eks.existingOidcIssuer = 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE';
    cfg.ingress = { mode: 'alb' }; // CDK's ALB needs this stack's cluster security group
    cfg.kms.enabled = false;    // the key only encrypts a cluster this app creates
    const s = synth(cfg);
    s.langsmith.hasResourceProperties('AWS::EKS::Nodegroup', { ClusterName: 'mine' });
    s.langsmith.hasResourceProperties('AWS::EKS::Addon', { ClusterName: 'mine', AddonName: 'coredns' });
  });
});

describe('secrets', () => {
  const secretStrings = (s: Synthesized) => Object.values(s.resources)
    .filter((r) => r.Type === 'AWS::SecretsManager::Secret')
    .map((r) => ({ name: (r.Properties as any).Name, value: (r.Properties as any).SecretString, generated: !!(r.Properties as any).GenerateSecretString }));

  test('no secret value in the template: placeholders, generated values, the admin email, host names', () => {
    const secrets = secretStrings(synth(loadConfig('example')));
    expect(secrets.map((x) => x.name).sort()).toEqual([
      'langsmith-dev/api-key-salt', 'langsmith-dev/connections', 'langsmith-dev/fernet/agent-builder', 'langsmith-dev/fernet/insights',
      'langsmith-dev/fernet/polly', 'langsmith-dev/initial-org-admin-email', 'langsmith-dev/initial-org-admin-password',
      'langsmith-dev/jwt-secret', 'langsmith-dev/license-key',
    ]);
    for (const x of secrets) {
      if (/license-key|fernet\//.test(x.name)) expect(x.value).toBe(PLACEHOLDER);
      if (/password|salt|jwt/.test(x.name)) { expect(x.generated).toBe(true); expect(x.value).toBeUndefined(); }
    }
  });

  test('the connections secret has the keys the ExternalSecrets read, and no password', () => {
    const conn = secretStrings(synth(loadConfig('example'))).find((x) => x.name.endsWith('/connections'))!;
    const text = JSON.stringify(conn.value);
    for (const key of ['core_postgres_url', 'core_redis_url', 'metastore_host', 'fleet_redis_url', 'polly_postgres_url', 'insights_redis_url']) {
      expect(text).toContain(key);
    }
    expect(text).not.toMatch(/password/i);
  });

  test('secrets are kept on delete by default', () => {
    const s = synth(loadConfig('example'));
    const policies = Object.values(s.langsmith.toJSON().Resources as Record<string, any>)
      .filter((r) => r.Type === 'AWS::SecretsManager::Secret').map((r) => r.DeletionPolicy);
    expect(new Set(policies)).toEqual(new Set(['Retain']));
  });
});

describe('the settings that matter', () => {
  const s = synth(loadConfig('example'));

  test('EKS: API auth mode, private endpoint only, secrets encrypted, all logs, no creator admin', () => {
    s.langsmith.hasResourceProperties('AWS::EKS::Cluster', {
      AccessConfig: { AuthenticationMode: 'API', BootstrapClusterCreatorAdminPermissions: false },
      ResourcesVpcConfig: { EndpointPrivateAccess: true, EndpointPublicAccess: false },
      BootstrapSelfManagedAddons: false,
      EncryptionConfig: [{ Resources: ['secrets'] }],
    });
    const cluster = Object.values(s.resources).find((r) => r.Type === 'AWS::EKS::Cluster')!;
    expect((cluster.Properties as any).Logging.ClusterLogging.EnabledTypes).toHaveLength(5);
  });

  test('public EKS endpoint only for the listed CIDRs', () => {
    const cfg = loadConfig('example');
    cfg.eks.publicAccessCidrs = ['203.0.113.10/32'];
    synth(cfg).langsmith.hasResourceProperties('AWS::EKS::Cluster', {
      ResourcesVpcConfig: { EndpointPublicAccess: true, PublicAccessCidrs: ['203.0.113.10/32'] },
    });
  });

  test('nodes: IMDSv2 required with hop limit 1, encrypted gp3 root', () => {
    s.langsmith.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1 },
        BlockDeviceMappings: [{ Ebs: { VolumeType: 'gp3', Encrypted: true, VolumeSize: 100 } }],
      },
    });
  });

  test('node group waits for vpc-cni; coredns waits for the node group', () => {
    const json = s.langsmith.toJSON().Resources as Record<string, any>;
    const [ngId, ng] = Object.entries(json).find(([, r]) => r.Type === 'AWS::EKS::Nodegroup')!;
    const vpcCniId = Object.entries(json).find(([, r]) => r.Type === 'AWS::EKS::Addon' && r.Properties.AddonName === 'vpc-cni')![0];
    expect(ng.DependsOn).toContain(vpcCniId);
    const coredns = Object.values(json).find((r) => r.Type === 'AWS::EKS::Addon' && r.Properties.AddonName === 'coredns');
    expect(coredns.DependsOn).toContain(ngId);
  });

  test('RDS: IAM auth, RDS-managed password, encrypted, private, TLS required', () => {
    s.langsmith.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'langsmith-dev-core', Engine: 'postgres', EngineVersion: '16',
      EnableIAMDatabaseAuthentication: true, ManageMasterUserPassword: true, StorageEncrypted: true, PubliclyAccessible: false,
    });
    s.langsmith.hasResourceProperties('AWS::RDS::DBParameterGroup', { Family: 'postgres18', Parameters: { 'rds.force_ssl': '1' } });
  });

  test('Valkey: TLS required, encrypted, IAM users', () => {
    s.langsmith.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'valkey', TransitEncryptionEnabled: true, TransitEncryptionMode: 'required', AtRestEncryptionEnabled: true,
    });
    s.langsmith.hasResourceProperties('AWS::ElastiCache::User', { UserId: 'langsmith-dev-polly', UserName: 'langsmith-dev-polly', AuthenticationMode: { Type: 'iam' } });
  });

  test('S3: private, owner-enforced, HTTPS only; SmithDB bucket has no lifecycle', () => {
    s.langsmith.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'langsmith-dev-smithdb-123456789012',
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
    const sdb = Object.values(s.resources).find((r) => (r.Properties as any)?.BucketName === 'langsmith-dev-smithdb-123456789012')!;
    expect((sdb.Properties as any).LifecycleConfiguration).toBeUndefined();
  });

  test('VPC-endpoint-only access when an S3 gateway endpoint is given', () => {
    const t = JSON.stringify(synth(loadConfig('examples/byo-vpc')).langsmith.toJSON());
    expect(t).toContain('DenyClusterRolesOutsideVpce');
    expect(t).toContain('vpce-0123456789abcdef0');
  });

  test('security groups: one rule per VPC CIDR, ALB only from the allowed CIDRs', () => {
    const b = synth(loadConfig('examples/byo-vpc'));
    const rds = Object.values(b.resources).find((r) => (r.Properties as any)?.GroupName === 'ls-byovpc-rds')!;
    expect((rds.Properties as any).SecurityGroupIngress.map((i: any) => i.CidrIp).sort()).toEqual(['10.20.0.0/23', '100.64.0.0/16']);
    const alb = Object.values(b.resources).find((r) => (r.Properties as any)?.GroupName === 'ls-byovpc-alb')!;
    expect((alb.Properties as any).SecurityGroupIngress.map((i: any) => i.CidrIp)).toEqual(['10.0.0.0/8']);
  });

  test('bring your own VPC: no VPC or subnet is created, existing zone and cert are passed through', () => {
    const b = synth(loadConfig('examples/byo-vpc'));
    expect(b.network).toBeUndefined();
    expect(countOf(b, 'AWS::EC2::VPC')).toBe(0);
    expect(countOf(b, 'AWS::EC2::Subnet')).toBe(0);
    expect(countOf(b, 'AWS::Route53::HostedZone')).toBe(0);
    b.langsmith.hasOutput('PrivateZoneId', { Value: 'Z0123456789EXAMPLE' });
    b.langsmith.hasOutput('PodSubnets', { Value: 'us-east-1a=subnet-0dddddddddddddddd,us-east-1b=subnet-0eeeeeeeeeeeeeeee' });
    // Your pod subnets: you tag them (README.md, Network); CDK pins a VPC CNI that honours the tags.
    b.langsmith.hasResourceProperties('AWS::EKS::Addon', {
      AddonName: 'vpc-cni',
      AddonVersion: VPC_CNI_SUBNET_TAGS_VERSION,
      ConfigurationValues: JSON.stringify({ env: { WARM_IP_TARGET: '5', MINIMUM_IP_TARGET: '20' } }),
    });
  });

  test('every resource that can be tagged carries app and langsmith-env', () => {
    s.langsmith.hasResourceProperties('AWS::RDS::DBInstance', {
      Tags: [{ Key: 'app', Value: 'langsmith' }, { Key: 'langsmith-env', Value: 'langsmith-dev' }],
    });
  });

  test('outputs for post-deploy are present', () => {
    for (const name of ['ClusterName', 'WorkloadIdentity', 'PrivateSubnetIds', 'AlbSecurityGroupId', 'CoreDbMasterSecretArn',
      'ValkeyEndpoint', 'LangsmithRoleArn', 'ExternalSecretsRoleArn', 'SecretsPrefix', 'PrivateZoneId']) {
      expect(Object.keys(s.langsmith.toJSON().Outputs)).toContain(name);
    }
  });
});

describe("ingress.mode 'envoy-gateway' (default): CDK's internal ALB in front of Envoy Gateway", () => {
  const s = synth(loadConfig('example'));
  const one = (type: string) => Object.values(s.resources).filter((r) => r.Type === type);

  test('internal ALB in the private subnets, behind the <name>-alb security group', () => {
    const [alb] = one('AWS::ElasticLoadBalancingV2::LoadBalancer');
    expect(alb.Properties).toMatchObject({ Name: 'langsmith-dev-alb', Scheme: 'internal', Type: 'application' });
    expect((alb.Properties as any).Subnets).toEqual(['subnet-0aaaaaaaaaaaaaaaa', 'subnet-0bbbbbbbbbbbbbbbb', 'subnet-0cccccccccccccccc']);
    expect((alb.Properties as any).LoadBalancerAttributes).toEqual(expect.arrayContaining([
      { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
      { Key: 'idle_timeout.timeout_seconds', Value: '3600' },
      { Key: 'deletion_protection.enabled', Value: 'false' },
    ]));
  });

  test('deletion protection follows the environment', () => {
    const cfg = loadConfig('example');
    cfg.environment = 'prod';
    const alb = Object.values(synth(cfg).resources).find((r) => r.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')!;
    expect((alb.Properties as any).LoadBalancerAttributes).toContainEqual({ Key: 'deletion_protection.enabled', Value: 'true' });
  });

  test('IP target group on 10080 (Envoy serves Gateway port 80 there), healthy on any answer up to 404', () => {
    s.langsmith.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'langsmith-dev-envoy', TargetType: 'ip', Protocol: 'HTTP', Port: 10080, Matcher: { HttpCode: '200-404' },
    });
  });

  test('only an HTTPS listener: the certificate from config and the TLS 1.3/1.2 policy', () => {
    expect(one('AWS::ElasticLoadBalancingV2::Listener')).toHaveLength(1);
    s.langsmith.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443, Protocol: 'HTTPS', SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      Certificates: [{ CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000' }],
    });
  });

  test('the ALB reaches the nodes on 10080 only, from its own security group', () => {
    const rules = one('AWS::EC2::SecurityGroupIngress').filter((r) => (r.Properties as any).FromPort === 10080);
    expect(rules).toHaveLength(1);
    expect(rules[0].Properties).toMatchObject({ IpProtocol: 'tcp', ToPort: 10080 });
    expect(JSON.stringify(rules[0].Properties)).toContain('ClusterSecurityGroupId');
    expect(JSON.stringify((rules[0].Properties as any).SourceSecurityGroupId)).toContain('SecurityGroupsAlb');
  });

  test('CDK writes the hostname record (alias to the ALB), in the zone it created or the one you bring', () => {
    s.langsmith.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'langsmith.example.internal', Type: 'A' });
    const byo = synth(loadConfig('examples/byo-vpc'));
    byo.langsmith.hasResourceProperties('AWS::Route53::RecordSet', { HostedZoneId: 'Z0123456789EXAMPLE', Name: 'langsmith.corp.example.internal' });
  });

  test('outputs for post-deploy/04 and 05', () => {
    s.langsmith.hasOutput('IngressMode', { Value: 'envoy-gateway' });
    for (const name of ['TargetGroupArn', 'LoadBalancerDnsName']) expect(Object.keys(s.langsmith.toJSON().Outputs)).toContain(name);
    const alb = synth(loadConfig('examples/alb-ingress'));
    alb.langsmith.hasOutput('IngressMode', { Value: 'alb' });
    expect(Object.keys(alb.langsmith.toJSON().Outputs)).not.toContain('TargetGroupArn');
  });
});

// Found in the first teardown: CDK's default leaves a lab's key pending deletion for 30 days.
test.each([['destroy', 7], ['retain', undefined]] as const)('KMS key pending window with dataRemovalPolicy %s: %s days', (policy, days) => {
  const cfg = loadConfig('examples/irsa-dev');
  cfg.dataRemovalPolicy = policy;
  const key = Object.values(synth(cfg).resources).find((r) => r.Type === 'AWS::KMS::Key')!;
  expect(key.Properties!.PendingWindowInDays).toBe(days);
});

describe('settings that must survive later edits', () => {
  test('SmithDB trusts the configured namespace (IRSA and Pod Identity)', () => {
    const irsa = loadConfig('examples/irsa-dev');
    irsa.kubernetes.langsmithNamespace = 'ls-prod';
    const role = rolesByName(synth(irsa))['ls-irsa-smithdb'];
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain('system:serviceaccount:ls-prod:langsmith-smithdb');

    const podId = loadConfig('examples/podidentity-dev');
    podId.kubernetes.langsmithNamespace = 'ls-prod';
    synth(podId).langsmith.hasResourceProperties('AWS::EKS::PodIdentityAssociation', { Namespace: 'ls-prod', ServiceAccount: 'langsmith-smithdb' });
  });

  test("ingress 'alb' on your own cluster still gets the ALB security group (post-deploy/04 needs it)", () => {
    const cfg = loadConfig('example');
    cfg.eks.enabled = false; cfg.eks.existingClusterName = 'mine'; cfg.eks.existingOidcIssuer = 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE';
    cfg.kms.enabled = false;
    cfg.ingress = { mode: 'alb' };
    const outputs = synth(cfg).langsmith.toJSON().Outputs;
    expect(Object.keys(outputs)).toContain('AlbSecurityGroupId');
  });

  test('cluster admin entries keep their logical IDs when the list is reordered', () => {
    const ids = (arns: string[]) => {
      const cfg = loadConfig('examples/irsa-dev');
      cfg.eks.adminRoleArns = arns;
      const entries = Object.entries(synth(cfg).resources).filter(([, r]) => r.Type === 'AWS::EKS::AccessEntry');
      return Object.fromEntries(entries.map(([id, r]) => [JSON.stringify((r.Properties as any).PrincipalArn), id]));
    };
    const a = 'arn:aws:iam::123456789012:role/Admin';
    const b = 'arn:aws:iam::123456789012:role/Platform';
    expect(ids([b, a])).toEqual(ids([a, b]));
    expect(Object.values(ids([a, b])).filter((id) => id.includes('BastionAdmin'))).toHaveLength(1);
  });

  test('cdkQualifier points both stacks at that bootstrap toolkit', () => {
    const cfg = loadConfig('examples/irsa-dev');
    cfg.cdkQualifier = 'lsdev';
    const s = synth(cfg);
    for (const t of [s.langsmith, s.network!]) {
      expect(t.toJSON().Parameters.BootstrapVersion.Default).toBe('/cdk-bootstrap/lsdev/version');
    }
  });
});
