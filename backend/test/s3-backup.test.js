import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGitFixture } from './helpers/git-fixture.js';
import { createBackupService } from '../src/storage/backup-service.js';

class MemoryS3 {
  objects = new Map();
  failNextManifestVersion = false;
  blockNextPut = false;
  putStarted;
  releasePut;

  constructor() {
    this.putStarted = new Promise((resolve) => { this.signalPutStarted = resolve; });
    this.putReleased = new Promise((resolve) => { this.releasePut = resolve; });
  }

  async send(command) {
    const { Bucket, Key } = command.input;
    const address = `${Bucket}/${Key}`;
    if (command instanceof PutObjectCommand) {
      if (this.blockNextPut) {
        this.blockNextPut = false;
        this.signalPutStarted();
        await this.putReleased;
      }
      const chunks = [];
      const body = command.input.Body;
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) chunks.push(Buffer.from(body));
      else for await (const chunk of body) chunks.push(Buffer.from(chunk));
      if (this.failNextManifestVersion && Key.includes('/manifest-versions/')) {
        this.failNextManifestVersion = false;
        throw new Error('simulated interrupted upload');
      }
      this.objects.set(address, { body: Buffer.concat(chunks), metadata: command.input.Metadata || {} });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(address);
      if (!object) throw Object.assign(new Error('Missing object'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([object.body]), ContentLength: object.body.length, Metadata: object.metadata };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(address);
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const [sourceBucket, ...sourceParts] = command.input.CopySource.split('/');
      const sourceKey = sourceParts.map((part) => decodeURIComponent(part)).join('/');
      const source = this.objects.get(`${sourceBucket}/${sourceKey}`);
      if (!source) throw Object.assign(new Error('Missing copy source'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      this.objects.set(address, { body: Buffer.from(source.body), metadata: command.input.Metadata || {} });
      return {};
    }
    throw new Error(`Unsupported fake S3 command: ${command.constructor.name}`);
  }
}

function service(client = new MemoryS3()) {
  const config = { bucket: 'private-bucket', prefix: 'personal-backup', region: 'us-east-1', endpoint: undefined };
  return { client, storage: createBackupService({ config, client }) };
}

test('manual selected-file backup writes a secret-free versioned manifest and restore requires exact overwrite confirmation', async (t) => {
  const { root } = await createGitFixture(t);
  await mkdir(path.join(root, 'assets'));
  const file = path.join(root, 'assets', 'large.bin');
  await writeFile(file, Buffer.from('large asset bytes'));
  const { storage, client } = service();
  const preview = await storage.createBackupPreview(root, ['assets/large.bin']);
  assert.equal(preview.files.length, 1);
  await storage.backup(preview.previewId, root);
  const manifest = await storage.getManifest(root);
  assert.equal(manifest.files[0].path, 'assets/large.bin');
  const manifestObject = [...client.objects.entries()].find(([key]) => key.endsWith('/manifest.json'))[1];
  const manifestJson = manifestObject.body.toString('utf8');
  assert.match(manifestJson, /"version":1/);
  assert.doesNotMatch(manifestJson, /AWS_ACCESS_KEY|SECRET_ACCESS_KEY|C:\\\\Users/);

  await writeFile(file, 'local edits to preserve');
  const restorePreview = await storage.createRestorePreview(root, ['assets/large.bin']);
  assert.equal(restorePreview.files[0].overwriteRequired, true);
  await assert.rejects(storage.restore(restorePreview.previewId, root), /confirm/i);
  await storage.restore(restorePreview.previewId, root, ['assets/large.bin']);
  assert.equal(await readFile(file, 'utf8'), 'large asset bytes');
});

test('backup previews reject traversal, sensitive paths, and disabled S3 without uploading', async (t) => {
  const { root } = await createGitFixture(t);
  await writeFile(path.join(root, '.env'), 'secret');
  const { storage, client } = service();
  await assert.rejects(storage.createBackupPreview(root, ['../outside']), /path/i);
  await assert.rejects(storage.createBackupPreview(root, ['.env']), /credentials|settings/i);
  await assert.rejects(storage.createBackupPreview(root, ['credentials.json']), /credentials|settings/i);
  const disabled = createBackupService({ config: { bucket: '', prefix: 'private-backup', region: 'us-east-1' }, client });
  await assert.rejects(disabled.createBackupPreview(root, ['.env']), /disabled|bucket/i);
  assert.equal(client.objects.size, 0);
});

test('a failed S3 transfer does not publish a completed manifest', async (t) => {
  const { root } = await createGitFixture(t);
  await writeFile(path.join(root, 'asset.bin'), 'verified bytes');
  const client = new MemoryS3();
  const { storage } = service(client);
  const preview = await storage.createBackupPreview(root, ['asset.bin']);
  client.failNextManifestVersion = true;
  await assert.rejects(storage.backup(preview.previewId, root), /S3|upload/i);
  assert.equal([...client.objects.keys()].some((key) => key.endsWith('/manifest.json')), false);
});

test('a backup preview cannot be replayed while its first S3 transfer is active', async (t) => {
  const { root } = await createGitFixture(t);
  await writeFile(path.join(root, 'asset.bin'), 'verified bytes');
  const client = new MemoryS3();
  client.blockNextPut = true;
  const { storage } = service(client);
  const preview = await storage.createBackupPreview(root, ['asset.bin']);
  const inProgress = storage.backup(preview.previewId, root);
  await client.putStarted;
  await assert.rejects(storage.backup(preview.previewId, root), /already being used/i);
  client.releasePut();
  await inProgress;
});

test('a changed local file cannot delete an existing content-addressed backup object', async (t) => {
  const { root } = await createGitFixture(t);
  const file = path.join(root, 'asset.bin');
  await writeFile(file, 'original verified bytes');
  const client = new MemoryS3();
  const { storage } = service(client);
  const firstPreview = await storage.createBackupPreview(root, ['asset.bin']);
  await storage.backup(firstPreview.previewId, root);
  const beforeManifest = await storage.getManifest(root);
  const objectAddress = [...client.objects.keys()].find((address) => address.endsWith(`/objects/${beforeManifest.files[0].sha256}`));
  const originalObject = Buffer.from(client.objects.get(objectAddress).body);

  const preview = await storage.createBackupPreview(root, ['asset.bin']);
  client.blockNextPut = true;
  const inProgress = storage.backup(preview.previewId, root);
  await client.putStarted;
  await writeFile(file, 'modified bytes while upload waited');
  client.releasePut();
  await assert.rejects(inProgress, /changed during backup/i);

  assert.deepEqual(client.objects.get(objectAddress).body, originalObject);
  assert.deepEqual((await storage.getManifest(root)).files, beforeManifest.files);
});

test('S3 transfers for one repository are serialized across different previews', async (t) => {
  const { root } = await createGitFixture(t);
  await writeFile(path.join(root, 'one.bin'), 'one');
  await writeFile(path.join(root, 'two.bin'), 'two');
  const client = new MemoryS3();
  client.blockNextPut = true;
  const { storage } = service(client);
  const first = await storage.createBackupPreview(root, ['one.bin']);
  const second = await storage.createBackupPreview(root, ['two.bin']);
  const inProgress = storage.backup(first.previewId, root);
  await client.putStarted;
  await assert.rejects(storage.backup(second.previewId, root), /already running for this repository/i);
  client.releasePut();
  await inProgress;
  await storage.backup(second.previewId, root);
});

test('restore rejects a same-sized corrupted S3 object and preserves the local file', async (t) => {
  const { root } = await createGitFixture(t);
  const file = path.join(root, 'asset.bin');
  await writeFile(file, 'verified original bytes');
  const { storage, client } = service();
  const backupPreview = await storage.createBackupPreview(root, ['asset.bin']);
  await storage.backup(backupPreview.previewId, root);
  const manifest = await storage.getManifest(root);
  const key = [...client.objects.keys()].find((address) => address.endsWith(`/objects/${manifest.files[0].sha256}`));
  const object = client.objects.get(key);
  const corrupted = Buffer.from(object.body);
  corrupted[0] ^= 1;
  object.body = corrupted;

  await writeFile(file, 'local edits to preserve');
  const restorePreview = await storage.createRestorePreview(root, ['asset.bin']);
  await assert.rejects(storage.restore(restorePreview.previewId, root, ['asset.bin']), /SHA-256/i);
  assert.equal(await readFile(file, 'utf8'), 'local edits to preserve');
});

test('restore recreates missing parent directories inside the selected repository', async (t) => {
  const { root } = await createGitFixture(t);
  const file = path.join(root, 'assets', 'nested', 'large.bin');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'restored after folder deletion');
  const { storage } = service();
  const preview = await storage.createBackupPreview(root, ['assets/nested/large.bin']);
  await storage.backup(preview.previewId, root);
  await rm(path.join(root, 'assets'), { recursive: true, force: true });

  const restorePreview = await storage.createRestorePreview(root, ['assets/nested/large.bin']);
  assert.equal(restorePreview.files[0].exists, false);
  await storage.restore(restorePreview.previewId, root);
  assert.equal(await readFile(file, 'utf8'), 'restored after folder deletion');
});

test('restore previews enforce the 5 GiB aggregate selection limit before inspecting local files', async (t) => {
  const { root } = await createGitFixture(t);
  const paths = ['one.bin', 'two.bin', 'three.bin'];
  for (const filePath of paths) await writeFile(path.join(root, filePath), 'small test object');
  const { storage, client } = service();
  const backupPreview = await storage.createBackupPreview(root, paths);
  await storage.backup(backupPreview.previewId, root);
  const manifestEntry = [...client.objects.entries()].find(([address]) => address.endsWith('/manifest.json'));
  const manifest = JSON.parse(manifestEntry[1].body.toString('utf8'));
  for (const file of manifest.files) file.size = 2 * 1024 * 1024 * 1024;
  manifestEntry[1].body = Buffer.from(JSON.stringify(manifest));

  await assert.rejects(storage.createRestorePreview(root, paths), /5 GiB/i);
});
