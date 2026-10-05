#!/usr/bin/env node
// =============================================================================
// The CDK app: loads config/<name>.ts and builds the stacks (lib/build-app.ts).
//
//   npx cdk synth -c config=dev               # render the CloudFormation templates (offline)
//   npx cdk deploy --all -c config=dev        # writes out/cdk-outputs.json (cdk.json sets outputsFile)
// =============================================================================
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/build-app';
import { loadConfigFile } from '../lib/load-config';

const app = new App();

// `-c config=dev` loads config/dev.ts (start from config/example.ts).
const configName = app.node.tryGetContext('config');
if (!configName) {
  throw new Error('Choose a config: npx cdk synth -c config=<name>   (loads config/<name>.ts; start from config/example.ts)');
}
buildApp(app, loadConfigFile(configName));
