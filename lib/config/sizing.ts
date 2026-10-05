// =============================================================================
// lib/config/sizing.ts — what `size` and `environment` set (README.md, Sizing).
//
// Two independent dials:
//   size         how BIG: machines, database classes and storage, cache type, SmithDB tier.
//   environment  how PROTECTED: Multi-AZ, deletion protection, backups, cache failover.
// resolveSizes() = the size preset, then the environment's protection settings, then your
// `sizes` overrides. `npm run sizes -- -c config=<env>` prints the result and where each value came from.
// =============================================================================
import type { Environment, LangSmithConfig, Size } from './types';

/** Capacity: set by `size`. */
export interface CapacitySizes {
  nodeInstanceType: string;
  nodeMin: number;
  nodeDesired: number;
  nodeMax: number;
  /** Passed to the LangSmith Helm values by post-deploy/04 (SmithDB sizing preset). */
  smithdbTier: 'small' | 'medium';
  /**
   * 'tier': SmithDB uses its tier's CPU and memory, and the fast smithdb-cache volumes.
   * 'lab':  post-deploy/04 adds helm/smithdb-lab.yaml — about a quarter of the CPU and memory, cache on plain gp3.
   */
  smithdbResources: 'tier' | 'lab';
  pgCoreClass: string;
  pgMetastoreClass: string;
  pgStorageGib: number;
  pgMaxStorageGib: number;
  cacheNodeType: string;
}

/** Protection: set by `environment`. */
export interface ProtectionSettings {
  pgMultiAz: boolean;
  pgBackupDays: number;
  deletionProtection: boolean;
  /** Valkey nodes; failover is on with 2 or more. */
  cacheNodes: number;
}

/** Every resolved size and setting. Any of them can be overridden in `sizes`. */
export type Sizes = CapacitySizes & ProtectionSettings;

// Why these values:
//  - nodes m6i, not m5: each SmithDB cache volume is provisioned at 1,000 MiB/s; an m5.4xlarge has
//    594 MB/s of EBS bandwidth for the whole node, an m6i.4xlarge 1,250 MB/s (burst), m6i.8xlarge 1,250.
//  - node size: one node must hold SmithDB's largest pod (8 vCPU small, 28 vCPU medium).
//  - metastore: LangChain's SmithDB sizing asks for 2 vCPU / 16 GiB (small) and 4 vCPU / 32 GiB (medium).
//  - large: SmithDB stays 'medium' — its 'large' tier needs local NVMe nodes, which this app does not build.
//  - lab: functional tests only, not a LangChain-tested shape. Burstable databases and cache, SmithDB
//    with reduced resources (helm/smithdb-lab.yaml): about 23 vCPU of pods in total, so 2 nodes.
//    t3, not t4g: in us-east-1, RDS offers db.t4g.medium in only 2 of 6 AZs, db.t3.medium in all of them
//    (first live deploy: "no instances of the requested class available in the current ... zone").
export const SIZE_PRESETS: Record<Size, CapacitySizes> = {
  lab: {
    nodeInstanceType: 'm6i.4xlarge', nodeMin: 2, nodeDesired: 2, nodeMax: 4, smithdbTier: 'small', smithdbResources: 'lab',
    pgCoreClass: 'db.t3.medium', pgMetastoreClass: 'db.t3.medium', pgStorageGib: 20, pgMaxStorageGib: 100,
    cacheNodeType: 'cache.t3.medium',
  },
  small: {
    nodeInstanceType: 'm6i.4xlarge', nodeMin: 3, nodeDesired: 3, nodeMax: 6, smithdbTier: 'small', smithdbResources: 'tier',
    pgCoreClass: 'db.m6g.large', pgMetastoreClass: 'db.r6g.large', pgStorageGib: 50, pgMaxStorageGib: 500,
    cacheNodeType: 'cache.m7g.xlarge',
  },
  medium: {
    nodeInstanceType: 'm6i.8xlarge', nodeMin: 3, nodeDesired: 3, nodeMax: 8, smithdbTier: 'medium', smithdbResources: 'tier',
    pgCoreClass: 'db.m6g.large', pgMetastoreClass: 'db.r6g.xlarge', pgStorageGib: 100, pgMaxStorageGib: 1000,
    cacheNodeType: 'cache.m7g.xlarge',
  },
  large: {
    nodeInstanceType: 'm6i.8xlarge', nodeMin: 4, nodeDesired: 5, nodeMax: 10, smithdbTier: 'medium', smithdbResources: 'tier',
    pgCoreClass: 'db.m6g.xlarge', pgMetastoreClass: 'db.r6g.xlarge', pgStorageGib: 100, pgMaxStorageGib: 2000,
    cacheNodeType: 'cache.m7g.2xlarge',
  },
};

export const ENVIRONMENT_PROTECTION: Record<Environment, ProtectionSettings> = {
  dev:   { pgMultiAz: false, pgBackupDays: 7,  deletionProtection: false, cacheNodes: 1 },
  stage: { pgMultiAz: true,  pgBackupDays: 7,  deletionProtection: true,  cacheNodes: 2 },
  prod:  { pgMultiAz: true,  pgBackupDays: 14, deletionProtection: true,  cacheNodes: 3 },
};

/** The size used when `size` is not set. */
export const DEFAULT_SIZE: Record<Environment, Size> = { dev: 'small', stage: 'medium', prod: 'large' };

/** The size preset in effect: `size`, or the environment's default. */
export function effectiveSize(cfg: LangSmithConfig): Size {
  return cfg.size ?? DEFAULT_SIZE[cfg.environment];
}

/** One resolved value and where it came from (printed by `npm run sizes`). */
export interface SizeSource { field: keyof Sizes; value: string | number | boolean; from: string }

export function explainSizes(cfg: LangSmithConfig): SizeSource[] {
  const size = effectiveSize(cfg);
  const protectedBy = ENVIRONMENT_PROTECTION[cfg.environment] as unknown as Record<string, string | number | boolean>;
  const overrides = (cfg.sizes ?? {}) as Record<string, string | number | boolean>;
  return Object.entries(resolveSizes(cfg)).map(([field, value]) => ({
    field: field as keyof Sizes,
    value,
    from: field in overrides ? 'sizes (override)'
      : field in protectedBy ? `environment '${cfg.environment}'`
      : `size '${size}'${cfg.size ? '' : ` (default for '${cfg.environment}')`}`,
  }));
}

/** The size preset, then the environment's protection settings, then your `sizes` overrides. */
export function resolveSizes(cfg: LangSmithConfig): Sizes {
  return { ...SIZE_PRESETS[effectiveSize(cfg)], ...ENVIRONMENT_PROTECTION[cfg.environment], ...(cfg.sizes ?? {}) };
}

/**
 * The largest single SmithDB pod per tier, in vCPU (LangChain's SmithDB tiers: the compaction
 * worker in `small`, the query service in `medium`). It must fit on one node.
 */
export const SMITHDB_LARGEST_POD_VCPU: Record<Sizes['smithdbTier'], number> = { small: 8, medium: 28 };
/** With smithdbResources 'lab': the compaction worker in helm/smithdb-lab.yaml. */
export const SMITHDB_LAB_LARGEST_POD_VCPU = 2;

/**
 * vCPUs of an EC2 instance type, read from its size: large = 2, xlarge = 4, Nxlarge = 4 x N.
 * True for the general-purpose, compute, memory and storage families (m, c, r, i, ...).
 * undefined for sizes this cannot tell (metal, nano ... medium).
 */
export function instanceVcpus(instanceType: string): number | undefined {
  const size = instanceType.split('.')[1] ?? '';
  if (size === 'large') return 2;
  if (size === 'xlarge') return 4;
  const m = /^(\d+)xlarge$/.exec(size);
  return m ? 4 * Number(m[1]) : undefined;
}
