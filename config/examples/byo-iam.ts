// Every IAM role pre-created by your IAM team (EKS Pod Identity, so the trust policies
// can be written before the cluster exists). The stack then creates NO IAM at all.
// Print what each role must contain with: npm run iam-pack -- -c config=examples/byo-iam
import { LangSmithConfig } from '../../lib/config';
import base from '../example';

const role = (name: string) => `arn:aws:iam::123456789012:role/platform/${name}`;

const config: LangSmithConfig = {
  ...base,
  name: 'ls-byoiam',
  cdkQualifier: 'lsbyoiam',
  workloadIdentity: 'podIdentity',
  bastion: { enabled: true, instanceType: 't3.small', createSsmEndpoints: false },
  existingRoles: {
    eksCluster: role('ls-byoiam-eks-cluster'),
    eksNode: role('ls-byoiam-eks-node'),
    bastion: role('ls-byoiam-bastion'),
    bastionInstanceProfileName: 'ls-byoiam-bastion',
    vpcCni: role('ls-byoiam-vpc-cni'),
    ebsCsi: role('ls-byoiam-ebs-csi'),
    langsmith: role('ls-byoiam-langsmith'),
    smithdb: role('ls-byoiam-smithdb'),
    externalSecrets: role('ls-byoiam-eso'),
    loadBalancerController: role('ls-byoiam-lbc'),
    clusterAutoscaler: role('ls-byoiam-cluster-autoscaler'),
  },
};

export default config;
