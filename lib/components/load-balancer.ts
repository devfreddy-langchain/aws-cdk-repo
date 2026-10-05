// =============================================================================
// 12 — Internal ALB in front of Envoy Gateway (ingress.mode 'envoy-gateway', the default)
// WHAT  The internal Application Load Balancer users reach at https://<hostname>:
//       - an HTTPS listener on 443 with your ACM certificate (TLS ends here);
//       - an IP target group on port 10080, where the Envoy Gateway proxy pods listen;
//       - the rule that lets the ALB reach those pods (cluster security group, 10080 from <name>-alb);
//       - the DNS record hostname -> ALB in the private zone.
// WHY   Envoy Gateway routes inside the cluster with Gateway API HTTPRoutes: one for LangSmith
//       and one per agent deployment (README.md, Network). The ALB stays the AWS
//       front door, so TLS, the allowed CIDRs and (later) WAF stay on an AWS resource that
//       CloudFormation owns: it exists after `cdk deploy`, and `cdk destroy` removes it.
// HOW   Plain L1 resources. The target group starts EMPTY: post-deploy/04 installs Envoy Gateway
//       and creates a TargetGroupBinding, and the AWS Load Balancer Controller then registers the
//       Envoy pod IPs in it. Why 10080: the Gateway listens on port 80, and Envoy, running as
//       non-root, serves Gateway port N on container port N + 10000.
//       ingress.mode 'alb' creates none of this: the Load Balancer Controller builds the ALB from
//       the LangSmith Ingress during `helm install`, and post-deploy/05 writes the DNS record.
// =============================================================================
import { aws_ec2 as ec2, aws_elasticloadbalancingv2 as elbv2, aws_route53 as route53 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LangSmithConfig } from '../config';
import { Names } from '../naming';

/** Where the Envoy proxy pods listen: Gateway listener port 80 + Envoy Gateway's 10000 offset. */
export const ENVOY_PROXY_PORT = 10080;
/** The TLS policy of the HTTPS listener: TLS 1.3, and 1.2 with forward secrecy only. */
export const ALB_SSL_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06';

export interface LoadBalancerProps {
  cfg: LangSmithConfig;
  names: Names;
  vpcId: string;
  subnetIds: string[];
  albSecurityGroupId: string;
  /** The security group EKS created for the cluster; the nodes (and so the Envoy pods) use it. */
  clusterSecurityGroupId: string;
  /** The private zone for the hostname record. Undefined = no record (you add your own). */
  zoneId?: string;
  deletionProtection: boolean;
}

export class LoadBalancer extends Construct {
  public readonly loadBalancerDnsName: string;
  public readonly targetGroupArn: string;

  constructor(scope: Construct, id: string, props: LoadBalancerProps) {
    super(scope, id);
    const { cfg, names } = props;

    const alb = new elbv2.CfnLoadBalancer(this, 'Alb', {
      name: names.alb,
      type: 'application',
      scheme: 'internal',
      ipAddressType: 'ipv4',
      subnets: props.subnetIds,
      securityGroups: [props.albSecurityGroupId],
      loadBalancerAttributes: [
        // Drop requests with header names that are not valid HTTP (request-smuggling hardening).
        { key: 'routing.http.drop_invalid_header_fields.enabled', value: 'true' },
        // Long-lived streams (traces, agent runs) may stay idle up to an hour.
        { key: 'idle_timeout.timeout_seconds', value: '3600' },
        { key: 'deletion_protection.enabled', value: String(props.deletionProtection) },
      ],
    });

    const targetGroup = new elbv2.CfnTargetGroup(this, 'EnvoyTargets', {
      name: names.envoyTargetGroup,
      targetType: 'ip',
      protocol: 'HTTP',
      protocolVersion: 'HTTP1',
      port: ENVOY_PROXY_PORT,
      vpcId: props.vpcId,
      // The health check carries no LangSmith hostname, so Envoy answers it with 404 (no matching
      // route). Any answer up to 404 means the proxy is up (the upstream Terraform module does the same).
      healthCheckProtocol: 'HTTP',
      healthCheckPath: '/',
      matcher: { httpCode: '200-404' },
      healthCheckIntervalSeconds: 15,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
    });

    new elbv2.CfnListener(this, 'Https', {
      loadBalancerArn: alb.ref,
      port: 443,
      protocol: 'HTTPS',
      sslPolicy: ALB_SSL_POLICY,
      certificates: [{ certificateArn: cfg.dns.certificateArn! }],
      defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });

    // The ALB reaches the Envoy pods on 10080 — and nothing else on the nodes.
    new ec2.CfnSecurityGroupIngress(this, 'AlbToEnvoy', {
      groupId: props.clusterSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: ENVOY_PROXY_PORT,
      toPort: ENVOY_PROXY_PORT,
      sourceSecurityGroupId: props.albSecurityGroupId,
      description: `LangSmith ALB to the Envoy Gateway proxy pods (${names.alb})`,
    });

    if (props.zoneId) {
      new route53.CfnRecordSet(this, 'Hostname', {
        hostedZoneId: props.zoneId,
        name: cfg.dns.hostname,
        type: 'A',
        aliasTarget: { dnsName: alb.attrDnsName, hostedZoneId: alb.attrCanonicalHostedZoneId, evaluateTargetHealth: false },
      });
    }

    this.loadBalancerDnsName = alb.attrDnsName;
    this.targetGroupArn = targetGroup.ref;
  }
}
