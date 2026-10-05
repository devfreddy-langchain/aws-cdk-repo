// =============================================================================
// 10 — Binding workload roles to Kubernetes ServiceAccounts
// WHAT  podIdentity mode: one AWS::EKS::PodIdentityAssociation per namespace/ServiceAccount.
//       irsa mode: nothing here — the binding is the ServiceAccount annotation
//       `eks.amazonaws.com/role-arn: <role ARN>`, which post-deploy/04 writes into the Helm
//       values from this stack's outputs.
// WHY   A role is useless until a pod can use it. With Pod Identity, EKS keeps the mapping and the
//       ServiceAccount needs no annotation. Associations can exist before the ServiceAccount does.
// HOW   One association per (role, ServiceAccount) pair listed in the role's spec (lib/iam/roles.ts).
// =============================================================================
import { aws_eks as eks } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RoleRef, RoleSpec } from '../iam/roles';

export interface WorkloadBindingsProps {
  clusterName: string;
  /** Each workload role with the ServiceAccounts that should get it. */
  roles: { spec: RoleSpec; role: RoleRef }[];
}

export class PodIdentityBindings extends Construct {
  constructor(scope: Construct, id: string, props: WorkloadBindingsProps) {
    super(scope, id);
    for (const { spec, role } of props.roles) {
      for (const sa of spec.serviceAccounts ?? []) {
        new eks.CfnPodIdentityAssociation(this, `${spec.roleName}-${sa.namespace}-${sa.name}`, {
          clusterName: props.clusterName,
          namespace: sa.namespace,
          serviceAccount: sa.name,
          roleArn: role.arn,
        });
      }
    }
  }
}
