// =============================================================================
// build-app.ts — config in, stacks out. Used by bin/langsmith.ts and by the tests (with the
// feature flags of cdk.json, test/helpers.ts), so the tests synthesize exactly what you deploy.
//
//   <name>-network    only when network.createVpc = true   (lib/stacks/network-stack.ts)
//   <name>-langsmith  everything else                       (lib/stacks/langsmith-stack.ts)
// =============================================================================
import { App, DefaultStackSynthesizer, Tags } from 'aws-cdk-lib';
import { LangSmithConfig, validateConfig } from './config';
import { NetworkInfo, networkInfoFromConfig } from './network-info';
import { tagsFor } from './naming';
import { LangSmithStack } from './stacks/langsmith-stack';
import { NetworkStack } from './stacks/network-stack';

export interface BuiltStacks {
  network?: NetworkStack;
  langsmith: LangSmithStack;
}

export function buildApp(app: App, cfg: LangSmithConfig): BuiltStacks {
  validateConfig(cfg);

  // Tags on every resource that supports them (filter on them in the console and in billing),
  // and — through the stacks' `tags` below — on the two CloudFormation stacks themselves.
  // Resources CloudFormation cannot tag are found by name by tools/list-resources.sh.
  const tags = tagsFor(cfg);
  for (const [key, value] of Object.entries(tags)) Tags.of(app).add(key, value);

  const env = { account: cfg.account, region: cfg.region };
  // cdkQualifier: deploy through this environment's own bootstrap toolkit (CDKToolkit-<q>), whose
  // execution policies are scoped to this name. A new synthesizer per stack (one cannot be shared).
  const synthesizer = () => (cfg.cdkQualifier ? new DefaultStackSynthesizer({ qualifier: cfg.cdkQualifier }) : undefined);

  let networkStack: NetworkStack | undefined;
  let network: NetworkInfo;
  if (cfg.network.createVpc) {
    networkStack = new NetworkStack(app, `${cfg.name}-network`, {
      env, cfg, tags, synthesizer: synthesizer(), description: `LangSmith ${cfg.name}: VPC (optional network stack)`,
    });
    network = networkStack.network;
  } else {
    network = networkInfoFromConfig(cfg);
  }

  const langsmith = new LangSmithStack(app, `${cfg.name}-langsmith`, {
    env, cfg, network, tags, synthesizer: synthesizer(), description: `LangSmith ${cfg.name}: EKS, databases, storage, secrets, IAM`,
  });
  return { network: networkStack, langsmith };
}
