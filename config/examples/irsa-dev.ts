// New VPC (a separate pod range: pods in 100.64.0.0/16, one NAT), IRSA, bastion on. The default learning setup.
import { LangSmithConfig } from '../../lib/config';
import base from '../example';

const config: LangSmithConfig = {
  ...base,
  name: 'ls-irsa',
  cdkQualifier: 'lsirsa',
  workloadIdentity: 'irsa',
  network: { createVpc: true, availabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'], layout: 'B', podCidr: '100.64.0.0/16', natMode: 'single' },
  bastion: { enabled: true, instanceType: 't3.small', createSsmEndpoints: false },
};

export default config;
