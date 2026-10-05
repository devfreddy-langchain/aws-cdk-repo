// =============================================================================
// trust.ts — WHO may assume each role (the "trust policy").
//
// A role has two halves:
//   - the trust policy (this file): which principal may become the role;
//   - the permission policies (policies.ts): what the role may then do.
//
// AWS services (EKS control plane, EC2 instances) are trusted by service name.
// Pods are trusted in one of two ways, chosen by `workloadIdentity` in config:
//
//   IRSA (default)                         EKS Pod Identity
//   ------------------------------------   ----------------------------------------
//   Principal: the cluster's OIDC          Principal: pods.eks.amazonaws.com
//   provider (one per cluster)             (the same for every cluster)
//   Condition: the ServiceAccount token    No condition: the binding lives in EKS as a
//   must be for namespace/serviceaccount   "pod identity association" (namespace/SA -> role)
//   Binding: annotation on the SA          Binding: AWS::EKS::PodIdentityAssociation
//   Trust changes per cluster              Trust never changes (roles can be pre-created)
// =============================================================================
import { Fn } from 'aws-cdk-lib';

/** Trust for the EKS control plane (the cluster role). */
export function eksServiceTrust() {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'eks.amazonaws.com' }, Action: ['sts:AssumeRole', 'sts:TagSession'] }],
  };
}

/** Trust for EC2 instances (worker nodes, the bastion). */
export function ec2Trust() {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  };
}

/** EKS Pod Identity: the Pod Identity agent on each node assumes the role for the pod. */
export function podIdentityTrust() {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'pods.eks.amazonaws.com' }, Action: ['sts:AssumeRole', 'sts:TagSession'] }],
  };
}

/**
 * IRSA trust, as a JSON *text* with two placeholders:
 *   ${OidcProviderArn}  arn:aws:iam::<account>:oidc-provider/oidc.eks.<region>.amazonaws.com/id/<ID>
 *   ${IssuerHost}       oidc.eks.<region>.amazonaws.com/id/<ID>
 *
 * Why text and not an object? The condition KEYS contain the issuer host
 * ("oidc.eks....:sub"), and the issuer only exists once the cluster does.
 * CloudFormation cannot put a reference inside an object key — but Fn::Sub can
 * substitute anywhere inside a string, keys included. So we write the policy as
 * text and let CloudFormation fill in the two values at deploy time
 * (irsaTrustForStack below). The same text, filled in by iam-pack, is what an
 * IAM team uses to create the role by hand.
 *
 * serviceAccount '*' allows every ServiceAccount in the namespace (used only for
 * the shared <name>-langsmith role, as in the LangChain Terraform module).
 */
export function irsaTrustTemplate(namespace: string, serviceAccount: string): string {
  const subject = `system:serviceaccount:${namespace}:${serviceAccount}`;
  const condition = serviceAccount === '*'
    ? {
        StringEquals: { '${IssuerHost}:aud': 'sts.amazonaws.com' },
        StringLike: { '${IssuerHost}:sub': subject },
      }
    : {
        StringEquals: { '${IssuerHost}:aud': 'sts.amazonaws.com', '${IssuerHost}:sub': subject },
      };
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Federated: '${OidcProviderArn}' },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: condition,
    }],
  }, null, 2);
}

/** The IRSA trust for a CloudFormation template: Fn::Sub fills in the two placeholders at deploy time. */
export function irsaTrustForStack(namespace: string, serviceAccount: string, oidc: { providerArn: string; issuerHost: string }) {
  return Fn.sub(irsaTrustTemplate(namespace, serviceAccount), {
    OidcProviderArn: oidc.providerArn,
    IssuerHost: oidc.issuerHost,
  });
}

/** The IRSA trust as plain text for iam-pack: placeholders replaced by known values or <ANGLE-BRACKET> hints. */
export function irsaTrustForHumans(namespace: string, serviceAccount: string, oidc: { providerArn: string; issuerHost: string }) {
  return JSON.parse(
    irsaTrustTemplate(namespace, serviceAccount)
      .split('${OidcProviderArn}').join(oidc.providerArn)
      .split('${IssuerHost}').join(oidc.issuerHost),
  );
}
