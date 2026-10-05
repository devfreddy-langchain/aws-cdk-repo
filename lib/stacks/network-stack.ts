// =============================================================================
// 1 — Network (network-stack.ts): OPTIONAL, a new VPC that meets README.md, Network
// WHAT  A VPC in its own stack <name>-network, deployed only when network.createVpc = true:
//
//   VPC (DNS support + hostnames)          [+ secondary 100.64.0.0/16 for Layout B]
//   3 x private subnet  (nodes, RDS, Valkey, ALB, EKS ENIs)   tagged internal-elb [B: cni=0]
//   3 x public subnet   (/28, only the NAT gateways live here)
//   3 x pod subnet      (Layout B, the default)                tagged cni=1
//   Internet gateway -> public route table
//   NAT gateway: 1 (single) or 3 (per-az), each with an Elastic IP
//   1 private route table per AZ: 0.0.0.0/0 -> NAT (the AZ's pod subnet shares it)
//   S3 gateway endpoint on the private route tables (free; keeps S3/ECR layers off the NAT)
//
// WHY   Its own stack, so a network team can review and deploy it on its own, and so you can skip it
//       and bring your own VPC instead (README.md, Network).
// HOW   Plain L1 resources, one per AWS API object; the LangSmith stack gets their IDs through
//       stack outputs (references, never lookups). Layouts:
//   B  (default) only nodes/ALB/databases routable (10.0.0.0/23, private /25s); pods in network.podCidr
//      (default 100.64.0.0/16), a /19 per AZ.
//      The VPC CNI picks pod subnets by tag (enhanced subnet discovery): kubernetes.io/role/cni=1 on
//      the pod subnets, =0 on the private subnets so pods never take routable IPs.
//   A  everything routable. addressPlan 'standard': 10.0.0.0/21 (private /23s); 'large': 10.0.0.0/20 (private /22s)
// =============================================================================
import { aws_ec2 as ec2, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AddressPlan, addressPlan, DEFAULT_POD_CIDR, LangSmithConfig, Layout, layoutOf, podCidrOf } from '../config';
import { namesFor } from '../naming';
import { NetworkInfo } from '../network-info';

interface LayoutCidrs { vpc: string; private: string[]; public: string[]; podVpc?: string; pods?: string[] }

/**
 * The address plan. It depends only on `layout` and `network.addressPlan`, never on `size`:
 * subnets cannot be resized in place, so changing them replaces the VPC.
 */
export function layoutCidrs(layout: Layout, plan: AddressPlan, podCidr: string = DEFAULT_POD_CIDR): LayoutCidrs {
  if (layout === 'B') {
    // podCidr is a validated a.b.0.0/16: the first three /19s of it, one per AZ.
    const [a, b] = podCidr.split('.');
    return {
      vpc: '10.0.0.0/23',
      private: ['10.0.0.0/25', '10.0.0.128/25', '10.0.1.0/25'],
      public: ['10.0.1.128/28', '10.0.1.144/28', '10.0.1.160/28'],
      podVpc: podCidr,
      pods: [0, 32, 64].map((c) => `${a}.${b}.${c}.0/19`),
    };
  }
  if (plan === 'large') {
    return {
      vpc: '10.0.0.0/20',
      private: ['10.0.0.0/22', '10.0.4.0/22', '10.0.8.0/22'],
      public: ['10.0.12.0/28', '10.0.12.16/28', '10.0.12.32/28'],
    };
  }
  return {
    vpc: '10.0.0.0/21',
    private: ['10.0.0.0/23', '10.0.2.0/23', '10.0.4.0/23'],
    public: ['10.0.6.0/28', '10.0.6.16/28', '10.0.6.32/28'],
  };
}

export interface NetworkStackProps extends StackProps { cfg: LangSmithConfig }

export class NetworkStack extends Stack {
  /** What the LangSmith stack needs to know about this VPC. */
  public readonly network: NetworkInfo;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const cfg = props.cfg;
    const n = cfg.name;
    const azs = cfg.network.availabilityZones!;
    const layout = layoutOf(cfg);
    const natMode = cfg.network.natMode ?? (cfg.environment === 'dev' ? 'single' : 'per-az');
    const cidrs = layoutCidrs(layout, addressPlan(cfg), podCidrOf(cfg));
    const clusterName = namesFor(cfg).clusterName;
    const named = (resource: Construct, name: string) => Tags.of(resource).add('Name', name);

    // --- VPC with DNS support and DNS hostnames (both required by EKS and private DNS) --------
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: cidrs.vpc, enableDnsSupport: true, enableDnsHostnames: true });
    named(vpc, `${n}-vpc`);

    // Layout B: a secondary, non-routable CIDR for pod IPs.
    let podCidr: ec2.CfnVPCCidrBlock | undefined;
    if (cidrs.podVpc) {
      podCidr = new ec2.CfnVPCCidrBlock(this, 'PodCidr', { vpcId: vpc.ref, cidrBlock: cidrs.podVpc });
    }

    // --- Internet gateway + public route table (only the NAT gateways use it) ---------------
    const igw = new ec2.CfnInternetGateway(this, 'InternetGateway');
    named(igw, `${n}-igw`);
    const igwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'InternetGatewayAttachment', { vpcId: vpc.ref, internetGatewayId: igw.ref });
    const publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', { vpcId: vpc.ref });
    named(publicRouteTable, `${n}-public`);
    const publicDefault = new ec2.CfnRoute(this, 'PublicDefaultRoute', {
      routeTableId: publicRouteTable.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.ref,
    });
    publicDefault.node.addDependency(igwAttachment);

    // --- Per AZ: subnets, NAT, private route table -----------------------------------------
    const privateSubnets: NetworkInfo['privateSubnets'] = [];
    const podSubnets: NetworkInfo['podSubnets'] = [];
    const privateRouteTables: string[] = [];
    let natGatewayId = '';

    azs.forEach((az, i) => {
      const suffix = `${i + 1}`;

      const publicSubnet = new ec2.CfnSubnet(this, `PublicSubnet${suffix}`, {
        vpcId: vpc.ref, availabilityZone: az, cidrBlock: cidrs.public[i], mapPublicIpOnLaunch: false,
      });
      named(publicSubnet, `${n}-public-${az}`);
      new ec2.CfnSubnetRouteTableAssociation(this, `PublicSubnet${suffix}Routes`, {
        subnetId: publicSubnet.ref, routeTableId: publicRouteTable.ref,
      });

      const privateSubnet = new ec2.CfnSubnet(this, `PrivateSubnet${suffix}`, {
        vpcId: vpc.ref, availabilityZone: az, cidrBlock: cidrs.private[i], mapPublicIpOnLaunch: false,
      });
      named(privateSubnet, `${n}-private-${az}`);
      // The AWS Load Balancer Controller may place internal load balancers here.
      Tags.of(privateSubnet).add('kubernetes.io/role/internal-elb', '1');
      // Layout B: the VPC CNI gives pods no IPs from this subnet, not even from the node's own interface.
      if (cidrs.pods) Tags.of(privateSubnet).add('kubernetes.io/role/cni', '0');
      privateSubnets.push({ id: privateSubnet.ref, az });

      // NAT gateway: one in the first AZ (single), or one in every AZ (per-az).
      if (natMode === 'per-az' || i === 0) {
        const eip = new ec2.CfnEIP(this, `NatEip${suffix}`, { domain: 'vpc' });
        named(eip, `${n}-nat-${az}-eip`);
        const nat = new ec2.CfnNatGateway(this, `NatGateway${suffix}`, { subnetId: publicSubnet.ref, allocationId: eip.attrAllocationId });
        named(nat, `${n}-nat-${az}`);
        nat.node.addDependency(igwAttachment);
        natGatewayId = nat.ref;
      }

      const privateRouteTable = new ec2.CfnRouteTable(this, `PrivateRouteTable${suffix}`, { vpcId: vpc.ref });
      named(privateRouteTable, `${n}-private-${az}`);
      new ec2.CfnRoute(this, `PrivateDefaultRoute${suffix}`, {
        routeTableId: privateRouteTable.ref, destinationCidrBlock: '0.0.0.0/0', natGatewayId,
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PrivateSubnet${suffix}Routes`, {
        subnetId: privateSubnet.ref, routeTableId: privateRouteTable.ref,
      });
      privateRouteTables.push(privateRouteTable.ref);

      // Layout B: the pod subnet in this AZ shares the AZ's private route table.
      if (cidrs.pods && podCidr) {
        const podSubnet = new ec2.CfnSubnet(this, `PodSubnet${suffix}`, {
          vpcId: vpc.ref, availabilityZone: az, cidrBlock: cidrs.pods[i], mapPublicIpOnLaunch: false,
        });
        podSubnet.node.addDependency(podCidr);
        named(podSubnet, `${n}-pods-${az}`);
        // The VPC CNI creates the nodes' pod interfaces here (enhanced subnet discovery), and only
        // for this cluster: other clusters in the VPC leave the subnet alone.
        Tags.of(podSubnet).add('kubernetes.io/role/cni', '1');
        Tags.of(podSubnet).add(`cni.networking.k8s.aws/cluster/${clusterName}`, 'shared');
        new ec2.CfnSubnetRouteTableAssociation(this, `PodSubnet${suffix}Routes`, {
          subnetId: podSubnet.ref, routeTableId: privateRouteTable.ref,
        });
        podSubnets.push({ id: podSubnet.ref, az });
      }
    });

    // --- S3 gateway endpoint: free, keeps S3 traffic (incl. ECR image layers) off the NAT ----
    const s3Endpoint = new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      vpcId: vpc.ref,
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: privateRouteTables,
    });
    named(s3Endpoint, `${n}-s3`);

    this.network = {
      vpcId: vpc.ref,
      vpcCidrs: cidrs.podVpc ? [cidrs.vpc, cidrs.podVpc] : [cidrs.vpc],
      privateSubnets,
      podSubnets,
      s3GatewayEndpointId: s3Endpoint.ref,
    };
  }
}
