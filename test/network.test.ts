// The optional network stack: the address plan of README.md, Network.
import { VPC_CNI_SUBNET_TAGS_VERSION } from '../lib/config';
import { countOf, loadConfig, synth } from './helpers';

function subnetCidrs(t: any): string[] {
  return Object.values(t.toJSON().Resources as Record<string, any>)
    .filter((r) => r.Type === 'AWS::EC2::Subnet').map((r) => r.Properties.CidrBlock).sort();
}

/** irsa-dev (a new Layout B VPC) switched to Layout A, with the plan left to its default. */
function layoutA() {
  const cfg = loadConfig('examples/irsa-dev');
  cfg.network = { ...cfg.network, layout: 'A', podCidr: undefined };
  return cfg;
}

const tagsOf = (r: any): Record<string, string> => Object.fromEntries((r.Properties.Tags ?? []).map((t: any) => [t.Key, t.Value]));
const subnetsNamed = (t: any, part: string) => Object.values(t.toJSON().Resources as Record<string, any>)
  .filter((r) => r.Type === 'AWS::EC2::Subnet' && tagsOf(r).Name.includes(part));
const vpcCniOf = (s: ReturnType<typeof synth>) =>
  Object.values(s.resources).find((r) => r.Type === 'AWS::EKS::Addon' && (r.Properties as any).AddonName === 'vpc-cni')!.Properties as any;

test('Layout A dev: /21 VPC, three /23 private and three /28 public subnets, one NAT', () => {
  const s = synth(layoutA());
  const net = s.network!;
  net.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.0.0.0/21', EnableDnsHostnames: true, EnableDnsSupport: true });
  expect(subnetCidrs(net)).toEqual(['10.0.0.0/23', '10.0.2.0/23', '10.0.4.0/23', '10.0.6.0/28', '10.0.6.16/28', '10.0.6.32/28']);
  net.resourceCountIs('AWS::EC2::NatGateway', 1);
  net.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
  net.resourceCountIs('AWS::EC2::VPCCidrBlock', 0);
});

test('Layout B (the default): 100.64.0.0/16 secondary CIDR with three /19 pod subnets', () => {
  const cfg = loadConfig('examples/irsa-dev');
  delete cfg.network.layout; // the example pins it; this checks the default
  const s = synth(cfg);
  const net = s.network!;
  net.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.0.0.0/23' });
  net.hasResourceProperties('AWS::EC2::VPCCidrBlock', { CidrBlock: '100.64.0.0/16' });
  expect(subnetCidrs(net)).toEqual([
    '10.0.0.0/25', '10.0.0.128/25', '10.0.1.0/25', '10.0.1.128/28', '10.0.1.144/28', '10.0.1.160/28',
    '100.64.0.0/19', '100.64.32.0/19', '100.64.64.0/19',
  ]);
  net.resourceCountIs('AWS::EC2::NatGateway', 1);
  // The main stack opens the security groups to the pod CIDR too.
  const rds = Object.values(s.resources).find((r) => (r.Properties as any)?.GroupName === 'ls-irsa-rds')!;
  expect((rds.Properties as any).SecurityGroupIngress.map((i: any) => i.CidrIp).sort()).toEqual(['10.0.0.0/23', '100.64.0.0/16']);
});

test('Layout B: the VPC CNI finds the pod subnets by tag (no ENIConfig), and never uses the node subnets', () => {
  const s = synth(loadConfig('examples/irsa-dev'));
  const pods = subnetsNamed(s.network!, '-pods-');
  const priv = subnetsNamed(s.network!, '-private-');
  expect([pods.length, priv.length]).toEqual([3, 3]);
  for (const p of pods) {
    expect(tagsOf(p)['kubernetes.io/role/cni']).toBe('1');
    expect(tagsOf(p)['cni.networking.k8s.aws/cluster/ls-irsa']).toBe('shared');
  }
  for (const p of priv) expect(tagsOf(p)['kubernetes.io/role/cni']).toBe('0');
  // No custom networking; a version that honours the cni=0 tag, unless you pin one.
  const cni = vpcCniOf(s);
  expect(JSON.parse(cni.ConfigurationValues)).toEqual({ env: { WARM_IP_TARGET: '5', MINIMUM_IP_TARGET: '20' } });
  expect(cni.AddonVersion).toBe(VPC_CNI_SUBNET_TAGS_VERSION);
  const pinned = loadConfig('examples/irsa-dev');
  pinned.eks.addonVersions = { vpcCni: 'v1.24.0-eksbuild.1' };
  expect(vpcCniOf(synth(pinned)).AddonVersion).toBe('v1.24.0-eksbuild.1');
});

test('Layout B with another pod range (network.podCidr): its /19s per AZ, and the security groups follow', () => {
  const cfg = loadConfig('examples/irsa-dev');
  cfg.network = { ...cfg.network, podCidr: '198.19.0.0/16' };
  const s = synth(cfg);
  s.network!.hasResourceProperties('AWS::EC2::VPCCidrBlock', { CidrBlock: '198.19.0.0/16' });
  expect(subnetsNamed(s.network!, '-pods-').map((r) => r.Properties.CidrBlock).sort())
    .toEqual(['198.19.0.0/19', '198.19.32.0/19', '198.19.64.0/19']);
  const rds = Object.values(s.resources).find((r) => (r.Properties as any)?.GroupName === 'ls-irsa-rds')!;
  expect((rds.Properties as any).SecurityGroupIngress.map((i: any) => i.CidrIp).sort()).toEqual(['10.0.0.0/23', '198.19.0.0/16']);
});

test('Layout A: no cni tags and no VPC CNI pin (the EKS default version)', () => {
  const s = synth(layoutA());
  for (const r of Object.values(s.network!.toJSON().Resources as Record<string, any>).filter((x) => x.Type === 'AWS::EC2::Subnet')) {
    expect(Object.keys(tagsOf(r)).filter((k) => k.includes('cni'))).toEqual([]);
  }
  expect(vpcCniOf(s).AddonVersion).toBeUndefined();
});

test('private subnets are tagged for internal load balancers; public subnets never auto-assign public IPs', () => {
  const net = synth(loadConfig('examples/irsa-dev')).network!;
  const subnets = Object.values(net.toJSON().Resources as Record<string, any>).filter((r) => r.Type === 'AWS::EC2::Subnet');
  for (const subnet of subnets) expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false);
  const priv = subnets.filter((r) => r.Properties.Tags.some((t: any) => t.Key === 'kubernetes.io/role/internal-elb'));
  expect(priv).toHaveLength(3);
});

test('the main stack gets the new VPC through references, not a lookup', () => {
  const s = synth(loadConfig('examples/irsa-dev'));
  expect(countOf(s, 'AWS::EC2::VPC')).toBe(0);
  const cluster = Object.values(s.resources).find((r) => r.Type === 'AWS::EKS::Cluster')!;
  // cdk.json: defaultCrossStackReferences 'weak' reads the network stack's outputs with Fn::GetStackOutput
  // (no exports, no custom resources). tools/teardown.sh removes the stacks in the right order.
  expect(JSON.stringify((cluster.Properties as any).ResourcesVpcConfig.SubnetIds)).toContain('Fn::GetStackOutput');
  expect(Object.keys(synth(loadConfig('examples/irsa-dev')).network!.toJSON().Outputs ?? {}).length).toBeGreaterThan(0);
});

test("addressPlan: the default follows environment (prod 'large' /20, else 'standard' /21) and can be pinned", () => {
  const cfg = layoutA();
  const vpcCidr = (c: typeof cfg) => (Object.values(synth(c).network!.toJSON().Resources as Record<string, any>)
    .find((r) => r.Type === 'AWS::EC2::VPC')!).Properties.CidrBlock;
  expect(vpcCidr({ ...cfg, environment: 'dev' })).toBe('10.0.0.0/21');
  expect(vpcCidr({ ...cfg, environment: 'prod', size: 'large' })).toBe('10.0.0.0/20');
  expect(vpcCidr({ ...cfg, environment: 'dev', network: { ...cfg.network, addressPlan: 'large' } })).toBe('10.0.0.0/20');
});
