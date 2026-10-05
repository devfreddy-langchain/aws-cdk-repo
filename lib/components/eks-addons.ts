// =============================================================================
// 5 / 6 — EKS managed add-ons
// WHAT  The cluster's system components, as EKS managed add-ons, in two groups (below).
// WHY   Managed add-ons are versioned and updated by EKS, with no Helm chart to maintain. The
//       cluster is created without the self-managed defaults (eks-cluster.ts), so these are the
//       only copies.
// HOW   Each add-on is a native AWS::EKS::Addon (1:1 with `aws eks create-addon`), with
//       resolveConflicts OVERWRITE and, when not pinned in config, the EKS default version.
//
// 5, BEFORE the node group (nodes must start with these):
//   vpc-cni                 pod networking. Own role (IRSA or Pod Identity), not the node role.
//                           WARM_IP_TARGET=5 / MINIMUM_IP_TARGET=20 keep a small per-node IP pool
//                           instead of a whole spare ENI (~30 IPs on m6i.4xlarge): saves subnet space.
//                           Layout B: pods get IPs from the subnets tagged kubernetes.io/role/cni=1
//                           (enhanced subnet discovery, on by default). Pinned to a version that
//                           honours the cni=0 tag on the node subnets, unless addonVersions.vpcCni is set.
//   kube-proxy              service routing.
//   eks-pod-identity-agent  podIdentity mode only: hands roles to pods.
// 6, AFTER the node group (they run as Deployments that need nodes):
//   coredns                 cluster DNS.
//   aws-ebs-csi-driver      creates the SmithDB cache volumes. Own role. Puts the app's tags on
//                           every volume it creates (extraVolumeTags), so they are found by tag.
//   metrics-server          SmithDB autoscaling (HPA) reads pod metrics from it.
// =============================================================================
import { aws_eks as eks, CfnResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EksConfig, VPC_CNI_SUBNET_TAGS_VERSION, WorkloadIdentity } from '../config';

type AddonKey = keyof EksConfig['addons'];

interface AddonOptions {
  clusterName: string;
  eksConfig: EksConfig;
  workloadIdentity: WorkloadIdentity;
}

/** One add-on. `role` binds a ServiceAccount to a role the IRSA way or the Pod Identity way. */
function addon(scope: Construct, key: AddonKey, addonName: string, o: AddonOptions,
  extra: { configuration?: object; role?: { arn: string; serviceAccount: string }; defaultVersion?: string } = {}): eks.CfnAddon {
  const irsa = o.workloadIdentity === 'irsa';
  return new eks.CfnAddon(scope, addonName, {
    clusterName: o.clusterName,
    addonName,
    addonVersion: o.eksConfig.addonVersions?.[key] ?? extra.defaultVersion,
    resolveConflicts: 'OVERWRITE',
    configurationValues: extra.configuration ? JSON.stringify(extra.configuration) : undefined,
    // IRSA: EKS annotates the add-on's ServiceAccount with the role ARN.
    serviceAccountRoleArn: extra.role && irsa ? extra.role.arn : undefined,
    // Pod Identity: EKS creates the pod identity association for the add-on's ServiceAccount.
    podIdentityAssociations: extra.role && !irsa ? [{ roleArn: extra.role.arn, serviceAccount: extra.role.serviceAccount }] : undefined,
  });
}

export interface AddonsBeforeNodesProps extends AddonOptions {
  vpcCniRoleArn?: string;
  /** Layout B: pods use their own (tagged) subnets, so the VPC CNI must honour the subnet tags. */
  podSubnets: boolean;
}

export class EksAddonsBeforeNodes extends Construct {
  /** Everything the node group must wait for. */
  public readonly all: CfnResource[] = [];

  constructor(scope: Construct, id: string, props: AddonsBeforeNodesProps) {
    super(scope, id);
    const enabled = props.eksConfig.addons;

    let podIdentityAgent: eks.CfnAddon | undefined;
    if (props.workloadIdentity === 'podIdentity' && enabled.podIdentityAgent) {
      podIdentityAgent = addon(this, 'podIdentityAgent', 'eks-pod-identity-agent', props);
      this.all.push(podIdentityAgent);
    }

    if (enabled.vpcCni) {
      const vpcCni = addon(this, 'vpcCni', 'vpc-cni', props, {
        configuration: { env: { WARM_IP_TARGET: '5', MINIMUM_IP_TARGET: '20' } },
        defaultVersion: props.podSubnets ? VPC_CNI_SUBNET_TAGS_VERSION : undefined,
        role: props.vpcCniRoleArn ? { arn: props.vpcCniRoleArn, serviceAccount: 'aws-node' } : undefined,
      });
      if (podIdentityAgent) vpcCni.node.addDependency(podIdentityAgent);
      this.all.push(vpcCni);
    }

    if (enabled.kubeProxy) this.all.push(addon(this, 'kubeProxy', 'kube-proxy', props));
  }
}

export interface AddonsAfterNodesProps extends AddonOptions {
  ebsCsiRoleArn?: string;
  /** tagsFor(cfg): put on every EBS volume the EBS CSI driver creates. */
  volumeTags: Record<string, string>;
}

export class EksAddonsAfterNodes extends Construct {
  constructor(scope: Construct, id: string, props: AddonsAfterNodesProps) {
    super(scope, id);
    const enabled = props.eksConfig.addons;
    if (enabled.coreDns) addon(this, 'coreDns', 'coredns', props);
    if (enabled.ebsCsiDriver) {
      addon(this, 'ebsCsiDriver', 'aws-ebs-csi-driver', props, {
        configuration: { controller: { extraVolumeTags: props.volumeTags } },
        role: props.ebsCsiRoleArn ? { arn: props.ebsCsiRoleArn, serviceAccount: 'ebs-csi-controller-sa' } : undefined,
      });
    }
    if (enabled.metricsServer) addon(this, 'metricsServer', 'metrics-server', props);
  }
}
