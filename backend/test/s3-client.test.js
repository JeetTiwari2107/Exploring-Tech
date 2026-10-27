import test from 'node:test';
import assert from 'node:assert/strict';
import { getS3Config } from '../src/storage/s3-client.js';

test('S3 remains opt-in and normalizes only non-secret settings', () => {
  assert.deepEqual(getS3Config({}), {
    bucket: '',
    prefix: 'localgit-studio/backups',
    region: 'us-east-1',
    endpoint: undefined,
  });
  assert.deepEqual(getS3Config({
    LOCAL_GIT_S3_BUCKET: 'my-private-bucket',
    LOCAL_GIT_S3_REGION: 'eu-west-1',
    LOCAL_GIT_S3_PREFIX: '/personal/assets/',
    LOCAL_GIT_S3_ENDPOINT: 'https://objects.example.invalid',
  }), {
    bucket: 'my-private-bucket',
    prefix: 'personal/assets',
    region: 'eu-west-1',
    endpoint: 'https://objects.example.invalid',
  });
});

test('S3 configuration rejects invalid buckets, traversal prefixes, and credential-bearing endpoints', () => {
  assert.throws(() => getS3Config({ LOCAL_GIT_S3_BUCKET: 'Invalid_Bucket' }), /bucket/i);
  assert.throws(() => getS3Config({ LOCAL_GIT_S3_PREFIX: 'personal/../other' }), /prefix/i);
  assert.throws(() => getS3Config({ LOCAL_GIT_S3_ENDPOINT: 'https://name:password@objects.example.invalid' }), /endpoint/i);
  assert.throws(() => getS3Config({ LOCAL_GIT_S3_ENDPOINT: 'file:///etc/passwd' }), /endpoint/i);
  assert.throws(() => getS3Config({ LOCAL_GIT_S3_ENDPOINT: 'http://objects.example.invalid' }), /HTTPS/i);
  assert.equal(getS3Config({ LOCAL_GIT_S3_ENDPOINT: 'http://127.0.0.1:9000' }).endpoint, 'http://127.0.0.1:9000');
  assert.equal(getS3Config({ LOCAL_GIT_S3_ENDPOINT: 'http://localhost:9000' }).endpoint, 'http://localhost:9000');
});
