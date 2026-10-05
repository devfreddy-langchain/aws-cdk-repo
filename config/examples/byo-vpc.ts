// Your VPC with a secondary pod CIDR (Layout B on your network: tag the pod subnets kubernetes.io/role/cni=1
// and the private subnets kubernetes.io/role/cni=0, README.md, Network), your S3 gateway endpoint,
// a narrower ALB audience, and your private zone and certificate.
import { LangSmithConfig } from '../../lib/config';
import base from '../example';

const config: LangSmithConfig = {
  ...base,
  name: 'ls-byovpc',
  cdkQualifier: 'lsbyovpc',
  network: {
    createVpc: false,
    vpcId: 'vpc-0123456789abcdef0',
    vpcCidrs: ['10.20.0.0/23', '100.64.0.0/16'],
    privateSubnets: [
      { id: 'subnet-0aaaaaaaaaaaaaaaa', az: 'us-east-1a' },
      { id: 'subnet-0bbbbbbbbbbbbbbbb', az: 'us-east-1b' },
    ],
    podSubnets: [
      { id: 'subnet-0dddddddddddddddd', az: 'us-east-1a' },
      { id: 'subnet-0eeeeeeeeeeeeeeee', az: 'us-east-1b' },
    ],
    s3GatewayEndpointId: 'vpce-0123456789abcdef0',
  },
  ingress: { ...base.ingress, allowedCidrs: ['10.0.0.0/8'] },
  dns: {
    hostname: 'langsmith.corp.example.internal',
    privateZone: { enabled: false, domain: 'corp.example.internal', existingZoneId: 'Z0123456789EXAMPLE' },
    certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
  },
};

export default config;
