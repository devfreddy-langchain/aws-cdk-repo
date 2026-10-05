// =============================================================================
// config/example.ts — copy to config/<your-env>.ts, edit, then:
//
//   npx cdk synth -c config=<your-env>             # check (offline, no AWS calls)
//   npx cdk deploy --all -c config=<your-env>     # writes out/cdk-outputs.json (cdk.json sets outputsFile)
//
// Hover over any field in your editor for its documentation (lib/config/types.ts).
// This file holds settings and IDs only — never a secret. The license key and TLS
// files are read by the post-deploy scripts from ./secrets/ (git-ignored).
// =============================================================================
import { LangSmithConfig } from '../lib/config';

const config: LangSmithConfig = {
  // ------------------------------------------------------------- basics ----
  name: 'langsmith-dev',          // prefix of every resource; lowercase, <= 20 chars
  account: '123456789012',
  region: 'us-east-1',
  cdkQualifier: 'lsdev',          // this environment's own CDK bootstrap toolkit (README.md, Part 2); lowercase, <= 10 chars
  environment: 'dev',             // dev | stage | prod: how protected (Multi-AZ, deletion protection, backups)
  size: 'small',                  // lab | small | medium | large: how big (default: dev small, stage medium, prod large; lab = tests only)
  sizes: {},                      // one-off overrides, e.g. { nodeMax: 8, cacheNodes: 2 }; check with `npm run sizes`
  workloadIdentity: 'irsa',       // 'irsa' (default) | 'podIdentity'
  permissionsBoundaryArn: undefined,
  dataRemovalPolicy: 'retain',    // 'retain' keeps data on `cdk destroy`; 'destroy' for throw-away test environments
  extraTags: {},                  // more tags on everything, e.g. { 'cost-center': '1234' } (app and langsmith-env are always set)

  // ------------------------------------------------------------ network ----
  // Option 1: your VPC (README.md, Network)
  network: {
    createVpc: false,
    vpcId: 'vpc-0123456789abcdef0',
    vpcCidrs: ['10.0.0.0/21'],
    privateSubnets: [
      { id: 'subnet-0aaaaaaaaaaaaaaaa', az: 'us-east-1a' },
      { id: 'subnet-0bbbbbbbbbbbbbbbb', az: 'us-east-1b' },
      { id: 'subnet-0cccccccccccccccc', az: 'us-east-1c' },
    ],
    podSubnets: [],               // a separate pod range on your VPC: one per AZ, tagged kubernetes.io/role/cni=1 (README.md, Network)
    s3GatewayEndpointId: undefined,
  },
  // Option 2: a new VPC in its own stack (<name>-network). Layout 'B' (the default) puts pods in 100.64.0.0/16;
  // layout 'A' puts them in the routable subnets (then also set addressPlan). Pin them: changing either replaces subnets.
  // network: { createVpc: true, availabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'], layout: 'B', podCidr: '100.64.0.0/16', natMode: 'single' },

  ingress: {
    mode: 'envoy-gateway',        // 'envoy-gateway' (default): CDK's ALB -> Envoy Gateway -> LangSmith; 'alb': ALB straight to the pods
    allowedCidrs: [],             // who may reach https://<hostname>; [] = the VPC CIDRs
  },

  // --------------------------------------------------------- components ----
  kms: { enabled: true },

  eks: {
    enabled: true,
    version: '1.34',
    publicAccessCidrs: [],        // [] = private API only. Dev from a laptop: ['203.0.113.10/32']
    adminRoleArns: ['arn:aws:iam::123456789012:role/Admin'],
    logRetentionDays: 90,         // control-plane logs in /aws/eks/<name>/cluster
    nodeGroup: { enabled: true },
    addons: { vpcCni: true, kubeProxy: true, coreDns: true, ebsCsiDriver: true, metricsServer: true, podIdentityAgent: true },
    addonVersions: {},            // empty = the EKS default for the Kubernetes version
  },

  s3: {
    blob: { enabled: true },
    smithdb: { enabled: true },
  },

  secrets: { enabled: true, adminEmail: 'admin@example.com' },

  postgres: {
    core: { enabled: true, engineVersion: '16' },
    metastore: { enabled: true, engineVersion: '18' },
  },

  valkey: { enabled: true, engineVersion: '8.1' },

  workloadRoles: {
    langsmith: true,
    smithdb: true,
    externalSecrets: true,
    loadBalancerController: true,
    clusterAutoscaler: true,
    bedrock: false,
  },

  kubernetes: {
    langsmithNamespace: 'langsmith',
    // Pod Identity only (IRSA ignores this): every ServiceAccount of chart 0.17.0 for a release
    // named "langsmith", except langsmith-smithdb, which has its own role.
    langsmithServiceAccounts: [
      'langsmith-ace-backend', 'langsmith-backend', 'langsmith-fleet-tool-server', 'langsmith-fleet-trigger-server',
      'langsmith-frontend', 'langsmith-host-backend', 'langsmith-ingest-queue', 'langsmith-listener', 'langsmith-operator',
      'langsmith-platform-backend', 'langsmith-playground', 'langsmith-queue',
      'langsmith-standalone-fleet-api-server', 'langsmith-standalone-fleet-queue',
      'langsmith-standalone-insights-api-server', 'langsmith-standalone-insights-queue',
      'langsmith-standalone-polly-api-server', 'langsmith-standalone-polly-queue',
    ],
  },

  dns: {
    hostname: 'langsmith.example.internal',
    privateZone: { enabled: true, domain: 'example.internal' },
    // REPLACE: an ISSUED ACM certificate for the hostname, in this account and region. It must exist
    // BEFORE `cdk deploy` (CDK creates the HTTPS listener): import PEM files with post-deploy/00 first.
    certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
  },

  bastion: { enabled: false, instanceType: 't3.small', createSsmEndpoints: false },

  // ------------------------------------------------ bring your own IAM ----
  // Any role listed here is used as-is; CDK creates nothing for it (README.md, Appendix C).
  existingRoles: {},
  irsaTrustManagedExternally: false,
};

export default config;
