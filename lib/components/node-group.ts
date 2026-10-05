// =============================================================================
// 6 — Node group "general-<instance type>"
// WHAT  A launch template and one EKS managed node group, sized by `size` (README.md, Sizing).
// WHY   Launch template: IMDSv2 required with hop limit 1, so pods cannot borrow the node's
//       credentials (they use their own roles); 100 GiB encrypted gp3 root volume; the app's
//       tags on the instances, their volumes and network interfaces (EC2 does not inherit them).
//       EKS tags the Auto Scaling group for cluster-autoscaler discovery automatically, and
//       creates the node role's access entry itself.
// HOW   AWS::EC2::LaunchTemplate + AWS::EKS::Nodegroup (1:1 with `aws eks create-nodegroup`).
// =============================================================================
import { aws_ec2 as ec2, aws_eks as eks } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Sizes } from '../config';
import { Names } from '../naming';

export interface NodeGroupProps {
  names: Names;
  /** config.name — goes into the Name tag. */
  envName: string;
  /** tagsFor(cfg): app, langsmith-env and any extraTags. */
  tags: Record<string, string>;
  /** The cluster name (a reference to the cluster when this app creates it). */
  clusterName: string;
  nodeRoleArn: string;
  subnetIds: string[];
  sizes: Sizes;
}

export class NodeGroup extends Construct {
  public readonly nodegroup: eks.CfnNodegroup;

  constructor(scope: Construct, id: string, props: NodeGroupProps) {
    super(scope, id);
    const { names, sizes } = props;
    const tagList = Object.entries(props.tags).map(([key, value]) => ({ key, value }));
    const nodeTags = [{ key: 'Name', value: `${props.envName}-node` }, ...tagList];

    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: names.launchTemplateName,
      tagSpecifications: [{ resourceType: 'launch-template', tags: tagList }], // the template itself
      launchTemplateData: {
        blockDeviceMappings: [{
          deviceName: '/dev/xvda',
          ebs: { volumeSize: 100, volumeType: 'gp3', encrypted: true, deleteOnTermination: true },
        }],
        metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
        tagSpecifications: [
          { resourceType: 'instance', tags: nodeTags },
          { resourceType: 'volume', tags: nodeTags },
          { resourceType: 'network-interface', tags: nodeTags },
        ],
      },
    });

    this.nodegroup = new eks.CfnNodegroup(this, 'Nodegroup', {
      clusterName: props.clusterName,
      nodegroupName: names.nodeGroupName,
      nodeRole: props.nodeRoleArn,
      subnets: props.subnetIds,
      launchTemplate: { id: launchTemplate.ref, version: launchTemplate.attrLatestVersionNumber },
      amiType: 'AL2023_x86_64_STANDARD',
      capacityType: 'ON_DEMAND',
      instanceTypes: [sizes.nodeInstanceType],
      labels: { workload: 'general' },
      scalingConfig: { minSize: sizes.nodeMin, desiredSize: sizes.nodeDesired, maxSize: sizes.nodeMax },
      updateConfig: { maxUnavailable: 1 },
    });
  }
}
