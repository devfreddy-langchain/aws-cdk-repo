// =============================================================================
// lib/config — everything about a config file, in three parts:
//   types.ts     LangSmithConfig: the shape of config/<env>.ts, every field documented
//   sizing.ts    what `size` and `environment` set (SIZE_PRESETS, ENVIRONMENT_PROTECTION, resolveSizes)
//   validate.ts  validateConfig: plain-English checks that run before anything is built
// Import from here ('lib/config'), not from the single files.
// =============================================================================
export * from './types';
export * from './sizing';
export * from './validate';
