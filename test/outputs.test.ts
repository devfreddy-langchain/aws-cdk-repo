// The contract between the stack outputs (lib/outputs.ts) and the scripts that read them
// (post-deploy/, tools/), and file references that must survive renames.
import * as fs from 'fs';
import * as path from 'path';
import { INFORMATIONAL_OUTPUTS, OUTPUT_DESCRIPTIONS, OutputName } from '../lib/outputs';
import { loadConfig, synth } from './helpers';

const root = path.join(__dirname, '..');
const scripts = ['post-deploy', 'tools'].flatMap((d) =>
  fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.sh')).map((f) => path.join(d, f)));
/** Every output a script reads with `out <Name>` (comments excluded). */
const readByScripts = new Set(scripts.flatMap((f) =>
  fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#'))
    .flatMap((l) => [...l.matchAll(/\bout ([A-Z][A-Za-z]+)/g)].map((m) => m[1]))));

test('every output a script reads exists in lib/outputs.ts', () => {
  for (const name of readByScripts) expect([name, name in OUTPUT_DESCRIPTIONS]).toEqual([name, true]);
});

test('every output is read by a script, or is listed as informational', () => {
  for (const name of Object.keys(OUTPUT_DESCRIPTIONS) as OutputName[]) {
    expect([name, readByScripts.has(name) || INFORMATIONAL_OUTPUTS.includes(name)]).toEqual([name, true]);
  }
  for (const name of INFORMATIONAL_OUTPUTS) expect([name, readByScripts.has(name)]).toEqual([name, false]);
});

describe.each([
  ['envoy-gateway', 'example', ['IngressMode', 'TargetGroupArn', 'LoadBalancerDnsName', 'CertificateArn', 'PrivateZoneId']],
  ['alb', 'examples/alb-ingress', ['IngressMode', 'AlbSecurityGroupId', 'PrivateSubnetIds', 'PrivateZoneId']],
] as const)('ingress mode %s', (_mode, config, needed) => {
  test('emits the outputs post-deploy/04 and 05 need for it', () => {
    const outputs = Object.keys(synth(loadConfig(config)).langsmith.toJSON().Outputs);
    const always = ['Name', 'Region', 'Account', 'WorkloadIdentity', 'ClusterName', 'VpcId', 'Hostname', 'LangsmithNamespace',
      'SecretsPrefix', 'ConnectionsSecretName', 'CoreDbMasterSecretArn', 'MetastoreDbMasterSecretArn', 'BlobBucket', 'SmithdbBucket',
      'SmithdbTier', 'SmithdbResources'];
    for (const name of [...always, ...needed]) expect([name, outputs.includes(name)]).toEqual([name, true]);
  });
});

test('no file refers to a path that was renamed or moved', () => {
  const gone = ['02-import-certificate', 'helm/envoy-gateway-resources', 'helm/envoy-gateway-target-group-binding',
    'docs/07-gotchas', 'lib/config.ts', 'albAllowedCidrs', 'out/acm-certificate-arn)', 'smithdb_lab_values',
    'k8s/eniconfig', 'examples/layout-b', 'eniconfigs.yaml', 'kubeconfig eniconfig', 'docs/0', '](docs/'];
  const skip = new Set(['node_modules', 'cdk.out', 'out', '.git']);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name) && !(dir === 'config' && e.name === 'local')) walk(p); }
      else if (/\.(ts|sh|md|yaml|json|sql|example)$/.test(e.name) && e.name !== 'package-lock.json') files.push(p);
    }
  };
  walk('.');
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const old of gone) {
      // The two places that mention albAllowedCidrs on purpose: the migration error and its test.
      if (old === 'albAllowedCidrs' && /lib\/config\/validate\.ts|test\/config\.test\.ts/.test(f)) continue;
      if (path.normalize(f) === path.normalize('test/outputs.test.ts')) continue;
      expect([f, old, text.includes(old)]).toEqual([f, old, false]);
    }
  }
});
