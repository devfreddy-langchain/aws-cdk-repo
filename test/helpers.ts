// Shared test helpers: load a config, synthesize it offline, look at the templates.
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/build-app';
import { LangSmithConfig } from '../lib/config';
import { loadConfigFile } from '../lib/load-config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cdkJson = require('../cdk.json') as { context: Record<string, unknown> };

export const EXAMPLES = [
  'example',
  'examples/irsa-dev',
  'examples/podidentity-dev',
  'examples/layout-a',
  'examples/byo-vpc',
  'examples/byo-iam',
  'examples/alb-ingress',
];

/** A fresh, deep copy of a config file, safe to modify in a test. */
export function loadConfig(name: string): LangSmithConfig {
  return structuredClone(loadConfigFile(name));
}

export interface Synthesized {
  langsmith: Template;
  network?: Template;
  /** Every resource of the main stack: logical ID -> { Type, Properties }. */
  resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
}

/**
 * A CDK App with the feature flags of cdk.json, as `cdk synth` and `cdk deploy` use them.
 * (A bare `new App()` would use the library defaults, and the tests would check other templates.)
 */
export function appLikeTheCli(): App {
  return new App({ context: cdkJson.context });
}

export function synth(cfg: LangSmithConfig): Synthesized {
  const stacks = buildApp(appLikeTheCli(), cfg);
  const langsmith = Template.fromStack(stacks.langsmith);
  return {
    langsmith,
    network: stacks.network ? Template.fromStack(stacks.network) : undefined,
    resources: langsmith.toJSON().Resources,
  };
}

export function countOf(s: Synthesized, type: string): number {
  return Object.values(s.resources).filter((r) => r.Type === type).length;
}

/** Role name -> resource, for every AWS::IAM::Role in the main stack. */
export function rolesByName(s: Synthesized): Record<string, { Properties: Record<string, any> }> {
  const out: Record<string, { Properties: Record<string, any> }> = {};
  for (const r of Object.values(s.resources)) {
    if (r.Type === 'AWS::IAM::Role') out[(r.Properties as any).RoleName] = r as any;
  }
  return out;
}
