// Same as irsa-dev, but pods get AWS access through EKS Pod Identity.
import { LangSmithConfig } from '../../lib/config';
import base from './irsa-dev';

const config: LangSmithConfig = {
  ...base,
  name: 'ls-podid',
  cdkQualifier: 'lspodid',
  workloadIdentity: 'podIdentity',
};

export default config;
