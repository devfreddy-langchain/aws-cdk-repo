// =============================================================================
// 7 — S3 buckets
// WHAT  <name>-blob-<account> (large trace payloads, attachments) and
//       <name>-smithdb-<account> (SmithDB's durable trace data). Each can be switched off.
// WHY   Public access blocked, bucket-owner-enforced, SSE-S3 encryption, HTTPS-only policy.
//       With an S3 gateway endpoint, this install's roles (<name>-*) may use the buckets only
//       through it. The blob bucket expires objects under ttl_s/ (14 d) and ttl_l/ (400 d),
//       matching LangSmith's retention settings. The SmithDB bucket has NO lifecycle rules:
//       expiring objects there would delete live trace data.
// HOW   s3.Bucket. enforceSSL adds the "deny non-HTTPS" bucket-policy statement.
//       No autoDeleteObjects (that would add a hidden Lambda): `cdk destroy` keeps or fails on
//       non-empty buckets, depending on dataRemovalPolicy.
// =============================================================================
import { Aws, aws_iam as iam, aws_s3 as s3, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LangSmithConfig } from '../config';
import { Names } from '../naming';

export interface S3BucketsProps {
  cfg: LangSmithConfig;
  names: Names;
  removalPolicy: RemovalPolicy;
  s3GatewayEndpointId?: string;
}

export class S3Buckets extends Construct {
  constructor(scope: Construct, id: string, props: S3BucketsProps) {
    super(scope, id);
    const { cfg, names } = props;

    if (cfg.s3.blob.enabled) {
      const blob = this.bucket('Blob', names.blobBucket, props);
      blob.addLifecycleRule({ id: 'ttl-short', prefix: 'ttl_s/', expiration: Duration.days(14) });
      blob.addLifecycleRule({ id: 'ttl-long', prefix: 'ttl_l/', expiration: Duration.days(400) });
      blob.addLifecycleRule({ id: 'abort-incomplete-multipart', abortIncompleteMultipartUploadAfter: Duration.days(7) });
    }
    if (cfg.s3.smithdb.enabled) {
      this.bucket('Smithdb', names.smithdbBucket, props); // no lifecycle rules, on purpose
    }
  }

  private bucket(id: string, bucketName: string, props: S3BucketsProps): s3.Bucket {
    const bucket = new s3.Bucket(this, id, {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.removalPolicy,
    });
    if (props.s3GatewayEndpointId) {
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'DenyClusterRolesOutsideVpce',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [bucket.bucketArn, bucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: { 'aws:SourceVpce': props.s3GatewayEndpointId },
          ArnLike: { 'aws:PrincipalArn': `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${props.cfg.name}-*` },
        },
      }));
    }
    return bucket;
  }
}
