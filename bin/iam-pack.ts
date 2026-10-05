// =============================================================================
// iam-pack — print every IAM role this config uses, as plain JSON (lib/iam/pack.ts).
//
//   npm run iam-pack -- -c config=dev                       # JSON to stdout
//   npm run iam-pack -- -c config=dev --issuer <host>       # IRSA, once the cluster exists
//   npm run iam-pack -- -c config=dev --out-dir out/iam-pack
//       writes, per role: <role>/trust-policy.json, <role>/inline-<name>.json,
//       <role>/managed-policy-arns.txt, <role>/NOTES.txt — ready for
//       aws iam create-role --assume-role-policy-document file://<role>/trust-policy.json ...
//
// Offline: reads only the config file.
// =============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { validateConfig } from '../lib/config';
import { buildIamPack } from '../lib/iam/pack';
import { configNameFromArgs, loadConfigFile } from '../lib/load-config';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configName = configNameFromArgs(process.argv);
if (!configName) {
  console.error('usage: npm run iam-pack -- -c config=<name> [--issuer <oidc issuer host>] [--out-dir <dir>]');
  process.exit(1);
}
const cfg = loadConfigFile(configName);
validateConfig(cfg);

const pack = buildIamPack(cfg, { issuer: arg('--issuer') });
const outDir = arg('--out-dir');

if (!outDir) {
  console.log(JSON.stringify(pack, null, 2));
} else {
  for (const role of pack.roles) {
    const dir = path.join(outDir, role.roleName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trust-policy.json'), JSON.stringify(role.trustPolicy, null, 2) + '\n');
    for (const [name, doc] of Object.entries(role.inlinePolicies)) {
      fs.writeFileSync(path.join(dir, `inline-${name}.json`), JSON.stringify(doc, null, 2) + '\n');
    }
    fs.writeFileSync(path.join(dir, 'managed-policy-arns.txt'), role.managedPolicyArns.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'NOTES.txt'),
      [`${role.roleName}: ${role.description}`, `Used by: ${role.usedBy.join(', ') || '-'}`, ...role.notes].join('\n') + '\n');
  }
  for (const [name, doc] of Object.entries(pack.managedPolicies)) {
    fs.writeFileSync(path.join(outDir, `managed-policy-${name}.json`), JSON.stringify(doc, null, 2) + '\n');
  }
  console.error(`IAM pack for ${cfg.name} (${pack.workloadIdentity}): ${pack.roles.length} roles written to ${outDir}`);
}
