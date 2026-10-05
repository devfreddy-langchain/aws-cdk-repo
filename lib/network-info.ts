// =============================================================================
// network-info.ts — the network the LangSmith stack runs in, whoever created it.
//
// Either the optional network stack creates a VPC (network.createVpc = true) or
// you bring your own (network.vpcId, vpcCidrs, privateSubnets). Both produce the
// same NetworkInfo, so the rest of the app does not care which.
// =============================================================================
import { LangSmithConfig, SubnetRef } from './config';

export interface NetworkInfo {
  vpcId: string;
  /** Every CIDR of the VPC (a Layout B pod CIDR included). Security group rules use these. */
  vpcCidrs: string[];
  /** Private subnets, one per AZ: nodes, RDS, Valkey, ALB, EKS control-plane ENIs. */
  privateSubnets: SubnetRef[];
  /** Layout B only: pod subnets (the VPC CNI finds them by their kubernetes.io/role/cni=1 tag). */
  podSubnets: SubnetRef[];
  /** If set, this install's roles may use its buckets only through this S3 gateway endpoint. */
  s3GatewayEndpointId?: string;
}

/** NetworkInfo for a VPC you bring (network.createVpc = false). */
export function networkInfoFromConfig(cfg: LangSmithConfig): NetworkInfo {
  const n = cfg.network;
  return {
    vpcId: n.vpcId!,
    vpcCidrs: n.vpcCidrs ?? [],
    privateSubnets: n.privateSubnets ?? [],
    podSubnets: n.podSubnets ?? [],
    s3GatewayEndpointId: n.s3GatewayEndpointId,
  };
}
