// The ALB-direct ingress: the AWS Load Balancer Controller creates the internal ALB from the
// LangSmith chart's Ingress during `helm install`, and the ALB sends traffic straight to the pods
// (no Envoy Gateway). The certificate may then be imported after `cdk deploy` with post-deploy/00.
import { LangSmithConfig } from '../../lib/config';
import base from './irsa-dev';

const config: LangSmithConfig = {
  ...base,
  name: 'ls-alb',
  cdkQualifier: 'lsalb',
  ingress: { ...base.ingress, mode: 'alb' },
  dns: { ...base.dns, certificateArn: undefined },
};

export default config;
