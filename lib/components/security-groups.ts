// =============================================================================
// 2 — Security groups
// WHAT  Up to four groups: <name>-eks-api, -rds, -cache, -alb (each only when its user is on).
// WHY   RDS (5432), Valkey (6379) and the ALB (443) accept traffic only from inside the VPC
//       (or ingress.allowedCidrs); the EKS API accepts 443 from in-VPC hosts (bastion, VPN).
//       Pod-to-pod and ALB-to-pod rules are handled by the EKS cluster security group and the
//       AWS Load Balancer Controller. Same shape as the LangChain Terraform module.
// HOW   One rule per VPC CIDR (a Layout B pod CIDR included). The default allow-all egress is
//       replaced by "to VPC" on the rds, cache and alb groups.
// =============================================================================
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LangSmithConfig } from '../config';
import { Names } from '../naming';

export interface SecurityGroupsProps {
  cfg: LangSmithConfig;
  names: Names;
  vpc: ec2.IVpc;
  vpcCidrs: string[];
  createEksApi: boolean;
  createRds: boolean;
  createCache: boolean;
  createAlb: boolean;
}

export class SecurityGroups extends Construct {
  public readonly eksApi?: ec2.SecurityGroup;
  public readonly rds?: ec2.SecurityGroup;
  public readonly cache?: ec2.SecurityGroup;
  public readonly alb?: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
    super(scope, id);
    const { names, vpc, vpcCidrs } = props;

    if (props.createEksApi) {
      // Extra group on the EKS control-plane ENIs. Egress stays open (EKS manages its own traffic).
      this.eksApi = new ec2.SecurityGroup(this, 'EksApi', {
        vpc, securityGroupName: names.sg.eksApi, description: 'LangSmith EKS API: 443 from inside the VPC', allowAllOutbound: true,
      });
      for (const cidr of vpcCidrs) this.eksApi.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'kubectl/helm from inside the VPC');
    }

    if (props.createRds) {
      this.rds = new ec2.SecurityGroup(this, 'Rds', {
        vpc, securityGroupName: names.sg.rds, description: 'LangSmith PostgreSQL: 5432 from inside the VPC', allowAllOutbound: false,
      });
      for (const cidr of vpcCidrs) {
        this.rds.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(5432), 'PostgreSQL from VPC');
        this.rds.addEgressRule(ec2.Peer.ipv4(cidr), ec2.Port.allTraffic(), 'to VPC');
      }
    }

    if (props.createCache) {
      this.cache = new ec2.SecurityGroup(this, 'Cache', {
        vpc, securityGroupName: names.sg.cache, description: 'LangSmith Valkey: 6379 from inside the VPC', allowAllOutbound: false,
      });
      for (const cidr of vpcCidrs) {
        this.cache.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(6379), 'Valkey from VPC');
        this.cache.addEgressRule(ec2.Peer.ipv4(cidr), ec2.Port.allTraffic(), 'to VPC');
      }
    }

    if (props.createAlb) {
      // The internal ALB's group: CDK's ALB (ingress.mode 'envoy-gateway', load-balancer.ts) or the
      // one the Load Balancer Controller creates from the LangSmith Ingress ('alb': post-deploy/04 puts
      // this group's ID into the Ingress annotations).
      this.alb = new ec2.SecurityGroup(this, 'Alb', {
        vpc, securityGroupName: names.sg.alb, description: 'LangSmith internal ALB: 443 from allowed CIDRs', allowAllOutbound: false,
      });
      const allowed = props.cfg.ingress?.allowedCidrs ?? [];
      const users = allowed.length > 0 ? allowed : vpcCidrs;
      for (const cidr of users) this.alb.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'LangSmith users');
      for (const cidr of vpcCidrs) this.alb.addEgressRule(ec2.Peer.ipv4(cidr), ec2.Port.allTraffic(), 'to pods');
    }
  }
}
