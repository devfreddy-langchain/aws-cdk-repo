// =============================================================================
// sizes — print every size and setting a config resolves to, and where each one came from.
//
//   npm run sizes -- -c config=dev
//
// The value of each field comes from, in this order (the last one wins):
//   size '<lab|small|medium|large>' capacity presets    (SIZE_PRESETS in lib/config/sizing.ts)
//   environment '<dev|stage|prod>' protection settings  (ENVIRONMENT_PROTECTION)
//   sizes (override)              your config's `sizes: { ... }`
// See README.md, Sizing for what changing each value does to a running install.
//
// Offline: reads only the config file. The sizes are printed even when the config has errors (for
// example the placeholder certificate before README Step 3); the errors follow, and the exit code is 1.
// =============================================================================
import { addressPlan, effectiveSize, explainSizes, layoutOf, podCidrOf, validateConfig } from '../lib/config';
import { configNameFromArgs, loadConfigFile } from '../lib/load-config';
import { namesFor } from '../lib/naming';

const configName = configNameFromArgs(process.argv);
if (!configName) {
  console.error('usage: npm run sizes -- -c config=<name>');
  process.exit(1);
}
const cfg = loadConfigFile(configName);
let configErrors: string | undefined;
try {
  validateConfig(cfg);
} catch (e) {
  configErrors = (e as Error).message;
}

console.log(`${cfg.name}: environment '${cfg.environment}', size '${effectiveSize(cfg)}'${cfg.size ? '' : ' (default)'}`);
console.log(`node group: ${namesFor(cfg).nodeGroupName}`);
if (cfg.network.createVpc) {
  // The VPC's layout and address plan: changing either replaces the VPC, so pin them in the config.
  console.log(`network.layout: ${layoutOf(cfg)}${cfg.network.layout ? '' : ' (default — pin it in your config)'}`);
  if (layoutOf(cfg) === 'B') console.log(`network.podCidr: ${podCidrOf(cfg)}${cfg.network.podCidr ? '' : ' (default — pin it in your config)'}`);
}
if (cfg.network.createVpc && layoutOf(cfg) === 'A') {
  // The VPC's address plan: pinned in the config, or the environment's default (changing it replaces the VPC).
  console.log(`network.addressPlan: ${addressPlan(cfg)}${cfg.network.addressPlan ? '' : ` (default for '${cfg.environment}' — pin it in your config)`}`);
}
console.log('');
const rows = explainSizes(cfg).map((r) => [r.field, String(r.value), r.from]);
const widths = [0, 1].map((c) => Math.max(...rows.map((r) => r[c].length), 5));
console.log(`${'field'.padEnd(widths[0])}  ${'value'.padEnd(widths[1])}  from`);
for (const [field, value, from] of rows) console.log(`${field.padEnd(widths[0])}  ${value.padEnd(widths[1])}  ${from}`);

if (configErrors) {
  console.error(`\n${configErrors}`);
  process.exit(1);
}
