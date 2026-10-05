// =============================================================================
// 13 — Bastion: an OPTIONAL SSM-only jump host
// WHAT  A small Amazon Linux 2023 instance in a private subnet that you reach with
//       `aws ssm start-session` — no SSH key, no inbound rule, no public IP. Its role is a
//       cluster admin (access entry in eks-cluster.ts), so kubectl/helm work from it.
// WHY   With a private EKS endpoint, kubectl/helm and the post-deploy scripts must run inside
//       the VPC.
// HOW   Security group with NO inbound rules and only 443 out. The instance: IMDSv2 required,
//       hop limit 1, 30 GiB encrypted gp3. User data = tools/install-tools-al2023.sh, so the
//       CLIs are ready. The AMI is the latest AL2023, resolved by CloudFormation at deploy time
//       from AWS's public SSM parameter (no lookup at synth time).
//       Optional SSM interface endpoints for VPCs without NAT.
// =============================================================================
import { aws_ec2 as ec2, Fn } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { LangSmithConfig } from '../config';
import { Names } from '../naming';

export interface BastionProps {
  cfg: LangSmithConfig;
  names: Names;
  vpc: ec2.IVpc;
  vpcCidrs: string[];
  subnetIds: string[];
  instanceProfileName: string;
}

export class Bastion extends Construct {
  public readonly instanceId: string;

  constructor(scope: Construct, id: string, props: BastionProps) {
    super(scope, id);
    const { cfg, names } = props;

    const sg = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc, securityGroupName: names.sg.bastion, description: 'LangSmith bastion (no inbound)', allowAllOutbound: false,
    });
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS out: SSM, AWS APIs, EKS API, tool downloads');

    if (cfg.bastion.createSsmEndpoints) {
      const endpointSg = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
        vpc: props.vpc, securityGroupName: names.sg.endpoints, description: 'LangSmith interface endpoints (443 from VPC)', allowAllOutbound: false,
      });
      for (const cidr of props.vpcCidrs) endpointSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'HTTPS from VPC');
      for (const service of ['ssm', 'ssmmessages', 'ec2messages']) {
        new ec2.CfnVPCEndpoint(this, `Endpoint-${service}`, {
          vpcId: props.vpc.vpcId,
          serviceName: `com.amazonaws.${cfg.region}.${service}`,
          vpcEndpointType: 'Interface',
          subnetIds: props.subnetIds,
          securityGroupIds: [endpointSg.securityGroupId],
          privateDnsEnabled: true,
        });
      }
    }

    // One plain AWS::EC2::Instance, no launch template: when a failed `cdk deploy --no-rollback` is
    // continued, CloudFormation re-applies every resource, and a launch template then gets a new
    // version — which would force a replacement of the instance, refused on a no-rollback stack.
    const userData = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'install-tools-al2023.sh'), 'utf8');
    const instance = new ec2.CfnInstance(this, 'Host', {
      imageId: '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}',
      instanceType: cfg.bastion.instanceType,
      iamInstanceProfile: props.instanceProfileName,
      subnetId: props.subnetIds[0],
      securityGroupIds: [sg.securityGroupId],
      metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
      blockDeviceMappings: [{ deviceName: '/dev/xvda', ebs: { volumeSize: 30, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }],
      userData: Fn.base64(userData),
      tags: [{ key: 'Name', value: names.role.bastion }], // + the app's tags (build-app.ts)
      propagateTagsToVolumeOnCreation: true,              // the root volume gets the same tags
    });
    this.instanceId = instance.ref;
  }
}
