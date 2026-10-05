// Tags: everything an environment creates must be findable by langsmith-env=<name>
// (tools/list-resources.sh), and what cannot carry tags must be on a short, known list.
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/build-app';
import { DEFAULT_LOG_RETENTION_DAYS } from '../lib/components/eks-cluster';
import { validateConfig } from '../lib/config';
import { appLikeTheCli, EXAMPLES, loadConfig, synth } from './helpers';

/**
 * CloudFormation resource types that have no Tags property. Each is found by name instead
 * (tools/list-resources.sh) or disappears with its parent.
 */
const UNTAGGABLE = new Set([
  'AWS::IAM::ManagedPolicy', 'AWS::IAM::InstanceProfile', 'AWS::IAM::Policy',
  'AWS::KMS::Alias',
  'AWS::S3::BucketPolicy',
  'AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress',
  'AWS::EC2::VPCCidrBlock', 'AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::Route',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::LaunchTemplate', // tagged through its own TagSpecifications instead (tested below)
  'AWS::ElasticLoadBalancingV2::Listener', // part of the ALB, which is tagged
  'AWS::Route53::RecordSet', // a record in the zone; found with the zone
  'AWS::SecretsManager::SecretTargetAttachment',
  'AWS::CDK::Metadata',
]);

type Resource = { Type: string; Properties?: Record<string, any> };

/**
 * Tags come as [{Key, Value}] for most types and as a { key: value } map for a few (EKS node group).
 * A Route 53 hosted zone keeps them in HostedZoneTags.
 */
function tagsOf(r: Resource): Record<string, string> {
  const t = r.Properties?.Tags ?? r.Properties?.HostedZoneTags;
  if (Array.isArray(t)) return Object.fromEntries(t.map((x: { Key: string; Value: string }) => [x.Key, x.Value]));
  return t ?? {};
}

function allResources(name: string, extraTags?: Record<string, string>): { stackTags: Record<string, string>[]; resources: Resource[] } {
  const cfg = loadConfig(name);
  if (extraTags) cfg.extraTags = extraTags;
  const stacks = buildApp(appLikeTheCli(), cfg);
  const list = [stacks.langsmith, stacks.network].filter((st) => st !== undefined);
  const resources = list.flatMap((st) => Object.values(Template.fromStack(st!).toJSON().Resources as Record<string, Resource>));
  return { stackTags: list.map((st) => st!.tags.tagValues()), resources };
}

describe('every taggable resource carries the environment tags', () => {
  test.each(EXAMPLES)('%s', (name) => {
    const cfg = loadConfig(name);
    const { resources } = allResources(name, { purpose: 'test' });
    const missing = resources
      .filter((r) => !UNTAGGABLE.has(r.Type))
      .filter((r) => {
        const t = tagsOf(r);
        return t.app !== 'langsmith' || t['langsmith-env'] !== cfg.name || t.purpose !== 'test';
      })
      .map((r) => r.Type);
    expect(missing).toEqual([]);
  });

  test.each(EXAMPLES)('%s: both CloudFormation stacks are tagged', (name) => {
    const cfg = loadConfig(name);
    for (const tags of allResources(name, { purpose: 'test' }).stackTags) {
      expect(tags).toEqual({ app: 'langsmith', 'langsmith-env': cfg.name, purpose: 'test' });
    }
  });
});

describe('what EC2 and Kubernetes controllers create is tagged too', () => {
  const cfg = loadConfig('examples/irsa-dev'); // node group + bastion
  const { resources } = allResources('examples/irsa-dev');

  test('the node launch template tags itself, the instances, their volumes and network interfaces', () => {
    const lts = resources.filter((r) => r.Type === 'AWS::EC2::LaunchTemplate');
    expect(lts).toHaveLength(1); // nodes only: the bastion is a plain instance (bastion.ts)
    for (const lt of lts) {
      const own = lt.Properties!.TagSpecifications;
      expect(own).toEqual([{ ResourceType: 'launch-template', Tags: expect.arrayContaining([{ Key: 'langsmith-env', Value: cfg.name }]) }]);
      const specs = lt.Properties!.LaunchTemplateData.TagSpecifications as { ResourceType: string; Tags: { Key: string; Value: string }[] }[];
      expect(specs.map((x) => x.ResourceType).sort()).toEqual(['instance', 'network-interface', 'volume']);
      for (const spec of specs) expect(spec.Tags).toEqual(expect.arrayContaining([{ Key: 'langsmith-env', Value: cfg.name }, { Key: 'app', Value: 'langsmith' }]));
    }
  });

  test('the bastion has the tags and copies them to its root volume', () => {
    const bastion = resources.find((r) => r.Type === 'AWS::EC2::Instance')!;
    expect(tagsOf(bastion)['langsmith-env']).toBe(cfg.name);
    expect(bastion.Properties!.PropagateTagsToVolumeOnCreation).toBe(true);
    expect(bastion.Properties!.MetadataOptions).toEqual({ HttpEndpoint: 'enabled', HttpTokens: 'required', HttpPutResponseHopLimit: 1 });
  });

  test('the EBS CSI driver tags every volume it creates', () => {
    const csi = resources.find((r) => r.Type === 'AWS::EKS::Addon' && r.Properties!.AddonName === 'aws-ebs-csi-driver')!;
    expect(JSON.parse(csi.Properties!.ConfigurationValues)).toEqual({
      controller: { extraVolumeTags: { app: 'langsmith', 'langsmith-env': cfg.name } },
    });
  });
});

describe('EKS control-plane log group', () => {
  test('created by the stack before the cluster, with retention, deleted with dataRemovalPolicy destroy', () => {
    const cfg = loadConfig('examples/irsa-dev');
    cfg.dataRemovalPolicy = 'destroy';
    const s = synth(cfg);
    const [logId, log] = Object.entries(s.resources).find(([, r]) => r.Type === 'AWS::Logs::LogGroup')!;
    expect(log.Properties).toMatchObject({ LogGroupName: `/aws/eks/${cfg.name}/cluster`, RetentionInDays: DEFAULT_LOG_RETENTION_DAYS });
    expect((log as any).DeletionPolicy).toBe('Delete');
    const cluster = Object.values(s.resources).find((r) => r.Type === 'AWS::EKS::Cluster') as any;
    expect(cluster.DependsOn).toContain(logId);
  });

  test('kept with dataRemovalPolicy retain; retention from eks.logRetentionDays', () => {
    const cfg = loadConfig('examples/irsa-dev');
    cfg.dataRemovalPolicy = 'retain';
    cfg.eks.logRetentionDays = 30;
    const log = Object.values(synth(cfg).resources).find((r) => r.Type === 'AWS::Logs::LogGroup') as any;
    expect(log.DeletionPolicy).toBe('Retain');
    expect(log.Properties.RetentionInDays).toBe(30);
  });

  test('no log group when the cluster is not created by this app', () => {
    const cfg = loadConfig('examples/byo-vpc');
    cfg.eks = { ...cfg.eks, enabled: false, existingClusterName: 'theirs', existingOidcIssuer: 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE' };
    cfg.kms.enabled = false;
    cfg.ingress = { mode: 'alb' };
    expect(Object.values(synth(cfg).resources).filter((r) => r.Type === 'AWS::Logs::LogGroup')).toEqual([]);
  });
});

describe('config checks for tags and retention', () => {
  test.each([['app'], ['langsmith-env'], ['Name'], ['aws:foo']])('extraTags key %s is refused', (key) => {
    const cfg = loadConfig('examples/irsa-dev');
    cfg.extraTags = { [key]: 'x' };
    expect(() => validateConfig(cfg)).toThrow(/extraTags/);
  });

  test('a retention CloudWatch does not accept is refused', () => {
    const cfg = loadConfig('examples/irsa-dev');
    cfg.eks.logRetentionDays = 45;
    expect(() => validateConfig(cfg)).toThrow(/logRetentionDays/);
  });
});
