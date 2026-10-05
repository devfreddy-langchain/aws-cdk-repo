// New VPC with Layout A: pods share the routable private subnets (as in LangChain's Terraform
// module). Needs about 4x the routable addresses of Layout B; 'large' = 10.0.0.0/20, a /22 per AZ.
// Stage sizes, one NAT per AZ.
import { LangSmithConfig } from '../../lib/config';
import base from '../example';

const config: LangSmithConfig = {
  ...base,
  name: 'ls-layouta',
  cdkQualifier: 'lslayouta',
  environment: 'stage',
  size: 'medium',
  network: { createVpc: true, availabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'], layout: 'A', addressPlan: 'large', natMode: 'per-az' },
};

export default config;
