// =============================================================================
// load-config.ts — find and load config/<name>.ts. Used by the CDK app (bin/langsmith.ts),
// the npm scripts (bin/sizes.ts, bin/iam-pack.ts) and the tests, so all of them read a
// config file the same way.
//
//   -c config=dev            -> config/dev.ts
//   -c config=local/test1    -> config/local/test1.ts   (config/local/ is git-ignored)
// =============================================================================
import * as path from 'path';
import { LangSmithConfig } from './config';

/** The `config=<name>` value of `-c` / `--context` in a command line, if there is one. */
export function configNameFromArgs(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length - 1; i++) {
    if ((argv[i] === '-c' || argv[i] === '--context') && argv[i + 1].startsWith('config=')) return argv[i + 1].slice('config='.length);
  }
  return undefined;
}

/** The default export of config/<name>.ts. */
export function loadConfigFile(name: string): LangSmithConfig {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(__dirname, '..', 'config', name)).default as LangSmithConfig;
}
