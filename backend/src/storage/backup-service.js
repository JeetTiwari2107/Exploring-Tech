import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { resolveWorkspaceFile } from '../workspace/paths.js';
import { createS3Client } from './s3-client.js';

const manifestVersion = 1;
const maximumFileBytes = 2 * 1024 * 1024 * 1024;
const maximumBackupBytes = 5 * 1024 * 1024 * 1024;
const maximumSelectedFiles = 50;
const previewLifetimeMs = 10 * 60 * 1000;
const maximumManifestBytes = 2 * 1024 * 1024;
const sensitiveDirectoryNames = new Set(['.aws', '.ssh', '.local', '.docker', '.kube', '.gnupg', '.config', 'node_modules', 'credentials']);

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function statusError(message, status = 400, details) {
  return Object.assign(new Error(message), { status, ...(details ? { details } : {}) });
}

function isSensitivePath(relativePath) {
  const parts = relativePath.toLowerCase().split('/');
  const name = parts.at(-1) || '';
  return parts.some((part) => sensitiveDirectoryNames.has(part))
    || name === '.env' || name.startsWith('.env.') || name === 'credentials'
    || ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'id_ecdsa_sk', 'id_ed25519_sk', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json', 'service-account.json', 'kubeconfig'].includes(name)
    || ['.pem', '.key', '.p12', '.pfx'].some((suffix) => name.endsWith(suffix));
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw statusError('Select a repository-relative file path.');
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => part === '..')) throw statusError('File path traversal is not allowed.');
  const normalized = parts.filter((part) => part && part !== '.').join('/');
  if (!normalized) throw statusError('A file path is required.');
  if (isSensitivePath(normalized)) throw statusError('This path may contain credentials or local settings and cannot be backed up.');
  return normalized;
}

async function digestFile(filePath) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    if (size > maximumFileBytes) throw statusError('Files larger than 2 GiB cannot be backed up.', 413);
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

async function safeFileDetails(repoRoot, relativePath, allowMissing = false) {
  const normalized = validateRelativePath(relativePath);
  const file = await resolveWorkspaceFile(repoRoot, normalized, { allowMissing });
  try {
    const info = await lstat(file.absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) throw statusError('Backup paths must identify regular files.');
    if (info.size > maximumFileBytes) throw statusError('Files larger than 2 GiB cannot be backed up.', 413);
    return { ...file, exists: true, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return { ...file, exists: false, size: 0, mtimeMs: null, mode: 0o600 };
    throw error;
  }
}

async function ensureParentDirectories(repoRoot, relativePath) {
  const root = await realpath(repoRoot);
  const parts = relativePath.split('/').slice(0, -1);
  const created = [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!isWithin(root, current)) throw statusError('Restore path escaped the selected repository.', 400);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw statusError('Restore parent paths must be regular directories.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await mkdir(current);
        created.push(current);
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw statusError('Restore parent paths must be regular directories.');
    }
    const canonical = await realpath(current);
    if (!isWithin(root, canonical)) throw statusError('Restore path resolves outside the selected repository.', 400);
  }
  return created;
}

async function repositoryMetadataPaths(repoPath, create) {
  const root = await realpath(repoPath);
  const markerPath = path.join(root, '.git');
  let marker;
  try { marker = await lstat(markerPath); } catch { throw statusError('S3 backup requires a standard Git repository.'); }
  if (!marker.isDirectory() || marker.isSymbolicLink()) {
    throw statusError('S3 backup is unavailable for linked worktrees because their Git metadata is outside this folder.');
  }
  const gitDirectory = await realpath(markerPath);
  if (!isWithin(root, gitDirectory)) throw statusError('Git metadata resolves outside the selected repository.');
  const metadataDirectory = path.join(gitDirectory, 'localgit-studio');
  try {
    const details = await lstat(metadataDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) throw statusError('Local backup metadata path is not a directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (create) await mkdir(metadataDirectory);
    else return { root, metadataDirectory, sidecar: path.join(metadataDirectory, 'backup.json'), exists: false };
  }
  const canonicalMetadata = await realpath(metadataDirectory);
  if (!isWithin(gitDirectory, canonicalMetadata)) throw statusError('Local backup metadata resolves outside Git metadata.');
  return { root, metadataDirectory: canonicalMetadata, sidecar: path.join(canonicalMetadata, 'backup.json'), exists: true };
}

async function readRepositoryMetadata(repoPath, config, create = false) {
  const paths = await repositoryMetadataPaths(repoPath, create);
  if (!paths.exists) return null;
  try {
    const sidecarStat = await lstat(paths.sidecar);
    if (sidecarStat.isSymbolicLink() || !sidecarStat.isFile() || sidecarStat.size > 4096) throw statusError('Local backup metadata is invalid.');
    const metadata = JSON.parse(await readFile(paths.sidecar, 'utf8'));
    if (metadata.version !== manifestVersion || typeof metadata.repositoryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(metadata.repositoryId)) {
      throw statusError('Local backup metadata is invalid.');
    }
    if (metadata.bucket !== config.bucket || metadata.prefix !== config.prefix) {
      throw statusError('The configured S3 bucket or prefix changed. Restore the original settings to access this repository backup.');
    }
    return { ...paths, repositoryId: metadata.repositoryId };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
    const metadata = { version: manifestVersion, repositoryId: randomUUID(), bucket: config.bucket, prefix: config.prefix };
    const temporary = `${paths.sidecar}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
    await rename(temporary, paths.sidecar);
    return { ...paths, repositoryId: metadata.repositoryId };
  }
}

function repositoryPrefix(config, repositoryId) {
  return `${config.prefix}/${repositoryId}`;
}

function isMissingObject(error) {
  return error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;
}

function safeS3Error(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return statusError('S3 request timed out. Check the endpoint and try again.', 504);
  if (error?.name === 'AccessDenied' || error?.$metadata?.httpStatusCode === 403) return statusError('S3 access was denied. Check the bucket permissions and credential profile.', 502);
  return statusError('S3 backup failed. Check the bucket, endpoint, and credential profile.', 502);
}

async function send(client, command, { allowMissing = false } = {}) {
  try {
    return await client.send(command, { abortSignal: AbortSignal.timeout(30_000) });
  } catch (error) {
    if (allowMissing && isMissingObject(error)) return null;
    throw safeS3Error(error);
  }
}

async function streamToBuffer(body, maximumBytes) {
  const chunks = [];
  let length = 0;
  if (!body) return Buffer.alloc(0);
  const stream = body instanceof Readable || typeof body[Symbol.asyncIterator] === 'function' ? body : Readable.from([body]);
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maximumBytes) throw statusError('S3 manifest is too large or malformed.', 502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function safeManifestPath(value) {
  try { return validateRelativePath(value) === value && value.split('/').every((part) => part && part !== '.' && part !== '..'); }
  catch { return false; }
}

function validateManifest(manifest, repositoryId, prefix) {
  if (!manifest || manifest.version !== manifestVersion || manifest.repositoryId !== repositoryId || !Array.isArray(manifest.files) || manifest.files.length > 5000) {
    throw statusError('S3 manifest is invalid. It was not applied.', 502);
  }
  const seen = new Set();
  const files = manifest.files.map((file) => {
    if (!file || !safeManifestPath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximumFileBytes
      || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
      || file.objectKey !== `${prefix}/objects/${file.sha256}` || seen.has(file.path)
      || typeof file.updatedAt !== 'string' || file.updatedAt.length > 64) {
      throw statusError('S3 manifest is invalid. It was not applied.', 502);
    }
    seen.add(file.path);
    return { path: file.path, size: file.size, sha256: file.sha256, mode: file.mode, objectKey: file.objectKey, updatedAt: file.updatedAt };
  });
  return { version: manifestVersion, repositoryId, updatedAt: String(manifest.updatedAt || ''), files };
}

export function createBackupService({ config, client = createS3Client(config), configError = false }) {
  const previews = new Map();
  let activeTransfers = 0;
  const activeRepositories = new Set();

  function beginTransfer(root) {
    if (activeRepositories.has(root)) throw statusError('An S3 transfer is already running for this repository.', 409);
    if (activeTransfers >= 2) throw statusError('Two S3 transfers are already running. Try again when one finishes.', 429);
    activeTransfers += 1;
    activeRepositories.add(root);
    return () => {
      activeTransfers = Math.max(0, activeTransfers - 1);
      activeRepositories.delete(root);
    };
  }

  function requireConfigured() {
    if (configError) throw statusError('S3 configuration is invalid. Review LOCAL_GIT_S3_BUCKET, LOCAL_GIT_S3_PREFIX, and LOCAL_GIT_S3_ENDPOINT.', 503);
    if (!config?.bucket) throw statusError('S3 backup is disabled. Configure LOCAL_GIT_S3_BUCKET to enable it.', 503);
  }

  function savePreview(record) {
    const now = Date.now();
    for (const [id, value] of previews) if (now - value.createdAt > previewLifetimeMs) previews.delete(id);
    while (previews.size >= 50) previews.delete(previews.keys().next().value);
    const previewId = randomUUID();
    previews.set(previewId, { ...record, createdAt: now });
    return previewId;
  }

  function getPreview(previewId, root, type) {
    const preview = previews.get(previewId);
    if (!preview || Date.now() - preview.createdAt > previewLifetimeMs || preview.type !== type || path.resolve(preview.root) !== path.resolve(root)) {
      throw statusError('This preview expired or no longer matches the selected repository. Create a new preview.', 409);
    }
    return preview;
  }

  async function readManifestRecords(repoPath, metadata) {
    if (!metadata) return { version: manifestVersion, repositoryId: null, updatedAt: '', files: [] };
    const prefix = repositoryPrefix(config, metadata.repositoryId);
    const key = `${prefix}/manifest.json`;
    const response = await send(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { allowMissing: true });
    if (!response) return { version: manifestVersion, repositoryId: metadata.repositoryId, updatedAt: '', files: [] };
    if (response.ContentLength > maximumManifestBytes) throw statusError('S3 manifest is too large or malformed.', 502);
    try {
      const json = JSON.parse((await streamToBuffer(response.Body, maximumManifestBytes)).toString('utf8'));
      return validateManifest(json, metadata.repositoryId, prefix);
    } catch (error) {
      if (error.status) throw error;
      throw statusError('S3 manifest could not be read. It was not applied.', 502);
    }
  }

  async function getManifest(repoPath) {
    if (!config?.bucket) return { files: [] };
    const metadata = await readRepositoryMetadata(repoPath, config);
    const manifest = await readManifestRecords(repoPath, metadata);
    return { files: manifest.files.map(({ path: filePath, size, sha256, updatedAt }) => ({ path: filePath, size, sha256, updatedAt })) };
  }

  async function createBackupPreview(repoPath, selectedPaths) {
    requireConfigured();
    if (!Array.isArray(selectedPaths) || selectedPaths.length === 0 || selectedPaths.length > maximumSelectedFiles) {
      throw statusError(`Select between 1 and ${maximumSelectedFiles} files.`);
    }
    const root = await realpath(repoPath);
    const names = selectedPaths.map(validateRelativePath);
    if (new Set(names).size !== names.length) throw statusError('A file was selected more than once.');
    const items = [];
    let totalBytes = 0;
    for (const name of names) {
      const details = await safeFileDetails(root, name);
      const before = await lstat(details.absolutePath);
      const digest = await digestFile(details.absolutePath);
      const after = await lstat(details.absolutePath);
      if (digest.size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw statusError('A selected file changed while the preview was being created. Preview again.', 409);
      }
      totalBytes += digest.size;
      if (totalBytes > maximumBackupBytes) throw statusError('A single backup selection is limited to 5 GiB.', 413);
      items.push({ ...details, size: digest.size, sha256: digest.sha256, mode: details.mode });
    }
    const previewId = savePreview({ type: 'backup', root, items });
    return { previewId, files: items.map(({ relativePath, size, sha256 }) => ({ path: relativePath, size, sha256 })), totalBytes };
  }

  async function uploadVerifiedObject(repoPath, item, key) {
    const before = await lstat(item.absolutePath);
    const firstDigest = await digestFile(item.absolutePath);
    if (firstDigest.sha256 !== item.sha256 || firstDigest.size !== item.size || before.mtimeMs !== item.mtimeMs) {
      throw statusError('A selected file changed after preview. Create a new backup preview.', 409);
    }
    const stagingKey = `${key.slice(0, key.lastIndexOf('/'))}/staging/${randomUUID()}`;
    const hash = createHash('sha256');
    let uploadedBytes = 0;
    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        uploadedBytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const source = createReadStream(item.absolutePath);
    source.pipe(transform);
    try {
      await send(client, new PutObjectCommand({
        Bucket: config.bucket,
        Key: stagingKey,
        Body: transform,
        ContentLength: item.size,
        ContentType: 'application/octet-stream',
        Metadata: { sha256: item.sha256 },
      }));
    } catch (error) {
      source.destroy();
      transform.destroy();
      await send(client, new DeleteObjectCommand({ Bucket: config.bucket, Key: stagingKey })).catch(() => {});
      throw error;
    }
    const digest = hash.digest('hex');
    const after = await lstat(item.absolutePath);
    if (uploadedBytes !== item.size || digest !== item.sha256 || after.size !== item.size || after.mtimeMs !== item.mtimeMs) {
      await send(client, new DeleteObjectCommand({ Bucket: config.bucket, Key: stagingKey })).catch(() => {});
      throw statusError('A selected file changed during backup. No manifest entry was published. Preview again.', 409);
    }
    try {
      const copySource = `${config.bucket}/${stagingKey.split('/').map(encodeURIComponent).join('/')}`;
      await send(client, new CopyObjectCommand({
        Bucket: config.bucket,
        Key: key,
        CopySource: copySource,
        MetadataDirective: 'REPLACE',
        ContentType: 'application/octet-stream',
        Metadata: { sha256: item.sha256 },
      }));
    } finally {
      await send(client, new DeleteObjectCommand({ Bucket: config.bucket, Key: stagingKey })).catch(() => {});
    }
  }

  async function publishManifest(metadata, current, replacements) {
    const prefix = repositoryPrefix(config, metadata.repositoryId);
    const files = new Map(current.files.map((file) => [file.path, file]));
    for (const file of replacements) files.set(file.path, file);
    const manifest = {
      version: manifestVersion,
      repositoryId: metadata.repositoryId,
      updatedAt: new Date().toISOString(),
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
    const body = Buffer.from(JSON.stringify(manifest));
    const versionKey = `${prefix}/manifest-versions/${Date.now()}-${randomUUID()}.json`;
    await send(client, new PutObjectCommand({ Bucket: config.bucket, Key: versionKey, Body: body, ContentLength: body.length, ContentType: 'application/json' }));
    await send(client, new PutObjectCommand({ Bucket: config.bucket, Key: `${prefix}/manifest.json`, Body: body, ContentLength: body.length, ContentType: 'application/json' }));
  }

  async function backup(previewId, repoPath) {
    requireConfigured();
    const root = await realpath(repoPath);
    const preview = getPreview(previewId, root, 'backup');
    if (preview.inProgress) throw statusError('This backup preview is already being used.', 409);
    const releaseTransfer = beginTransfer(root);
    preview.inProgress = true;
    try {
      const metadata = await readRepositoryMetadata(root, config, true);
      const current = await readManifestRecords(root, metadata);
      const prefix = repositoryPrefix(config, metadata.repositoryId);
      const changes = [];
      for (const item of preview.items) {
        const key = `${prefix}/objects/${item.sha256}`;
        await uploadVerifiedObject(root, item, key);
        changes.push({ path: item.relativePath, size: item.size, sha256: item.sha256, mode: item.mode, objectKey: key, updatedAt: new Date().toISOString() });
      }
      await publishManifest(metadata, current, changes);
      previews.delete(previewId);
      return { backedUp: changes.map(({ path: filePath }) => filePath) };
    } finally {
      preview.inProgress = false;
      releaseTransfer();
    }
  }

  async function createRestorePreview(repoPath, selectedPaths) {
    requireConfigured();
    if (!Array.isArray(selectedPaths) || selectedPaths.length === 0 || selectedPaths.length > maximumSelectedFiles) {
      throw statusError(`Select between 1 and ${maximumSelectedFiles} files.`);
    }
    const root = await realpath(repoPath);
    const names = selectedPaths.map(validateRelativePath);
    if (new Set(names).size !== names.length) throw statusError('A file was selected more than once.');
    const metadata = await readRepositoryMetadata(root, config);
    if (!metadata) throw statusError('No S3 backup is registered for this repository.', 404);
    const manifest = await readManifestRecords(root, metadata);
    const items = [];
    const selected = names.map((name) => {
      const stored = manifest.files.find((file) => file.path === name);
      if (!stored) throw statusError('The selected file is not present in the S3 manifest.', 404);
      return { name, stored };
    });
    const totalBytes = selected.reduce((total, { stored }) => total + stored.size, 0);
    if (totalBytes > maximumBackupBytes) throw statusError('A single restore selection is limited to 5 GiB.', 413);
    for (const { name, stored } of selected) {
      const details = await safeFileDetails(root, name, true);
      let currentSha256 = null;
      if (details.exists) {
        const digest = await digestFile(details.absolutePath);
        if (digest.size !== details.size) throw statusError('A local file changed while restore was being previewed. Preview again.', 409);
        currentSha256 = digest.sha256;
      }
      items.push({ ...details, stored, currentSha256, overwriteRequired: details.exists && currentSha256 !== stored.sha256 });
    }
    const previewId = savePreview({ type: 'restore', root, items });
    return { previewId, files: items.map((item) => ({ path: item.relativePath, size: item.stored.size, sha256: item.stored.sha256, exists: item.exists, overwriteRequired: item.overwriteRequired })) };
  }

  async function downloadVerifiedFile(item, temporaryPath) {
    const response = await send(client, new GetObjectCommand({ Bucket: config.bucket, Key: item.stored.objectKey }));
    if (response.ContentLength !== undefined && response.ContentLength !== item.stored.size) throw statusError('S3 object size does not match its manifest.', 502);
    const hash = createHash('sha256');
    let size = 0;
    const body = response.Body instanceof Readable || typeof response.Body?.[Symbol.asyncIterator] === 'function' ? response.Body : Readable.from([response.Body]);
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > item.stored.size) return callback(statusError('S3 object exceeded its manifest size.', 502));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(body, verifier, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    if (size !== item.stored.size || hash.digest('hex') !== item.stored.sha256) throw statusError('S3 object failed its SHA-256 integrity check.', 502);
    await chmod(temporaryPath, item.stored.mode);
  }

  async function verifyRestoreSnapshot(root, item) {
    const current = await safeFileDetails(root, item.relativePath, true).catch(() => null);
    if (!current) throw statusError('A restore path changed after preview. Create a new preview.', 409);
    if (current.exists !== item.exists) throw statusError('A local file appeared or disappeared after preview. Create a new preview.', 409);
    if (current.exists) {
      const digest = await digestFile(item.absolutePath);
      if (digest.sha256 !== item.currentSha256) throw statusError('A local file changed after preview. Create a new preview.', 409);
    }
  }

  async function restore(previewId, repoPath, confirmedOverwritePaths = []) {
    requireConfigured();
    const root = await realpath(repoPath);
    const preview = getPreview(previewId, root, 'restore');
    if (preview.inProgress) throw statusError('This restore preview is already being used.', 409);
    if (!Array.isArray(confirmedOverwritePaths) || confirmedOverwritePaths.some((value) => typeof value !== 'string')) throw statusError('Overwrite confirmation is invalid.');
    const confirmed = new Set(confirmedOverwritePaths);
    if ([...confirmed].some((value) => !preview.items.some((item) => item.relativePath === value))) throw statusError('Confirm only files shown in this restore preview.');
    const required = preview.items.filter((item) => item.overwriteRequired && !confirmed.has(item.relativePath)).map((item) => item.relativePath);
    if (required.length) throw statusError('Confirm overwriting these exact local files before restoring.', 409, { confirmPaths: required });
    for (const item of preview.items) await verifyRestoreSnapshot(root, item);

    const releaseTransfer = beginTransfer(root);
    preview.inProgress = true;

    const staged = [];
    const committed = [];
    const createdDirectories = [];
    let restoreSucceeded = false;
    try {
      for (const item of preview.items) {
        if (item.exists && item.currentSha256 === item.stored.sha256) continue;
        createdDirectories.push(...await ensureParentDirectories(root, item.relativePath));
        const temporaryPath = path.join(path.dirname(item.absolutePath), `.localgit-restore-${randomUUID()}.tmp`);
        await downloadVerifiedFile(item, temporaryPath);
        staged.push({ item, temporaryPath, backupPath: null });
      }
      for (const entry of staged) {
        await verifyRestoreSnapshot(root, entry.item);
        if (entry.item.exists) {
          entry.backupPath = `${entry.item.absolutePath}.localgit-restore-${randomUUID()}.tmp`;
          await copyFile(entry.item.absolutePath, entry.backupPath);
        }
        try {
          await rename(entry.temporaryPath, entry.item.absolutePath);
        } catch (error) {
          if (entry.backupPath) await copyFile(entry.backupPath, entry.item.absolutePath).catch(() => {});
          throw error;
        }
        committed.push(entry);
      }
      restoreSucceeded = true;
    } catch (error) {
      for (const entry of committed.reverse()) {
        if (entry.backupPath) await copyFile(entry.backupPath, entry.item.absolutePath).catch(() => {});
        else await unlink(entry.item.absolutePath).catch(() => {});
      }
      if (error.status) throw error;
      throw statusError('Restore failed. Local files were preserved or rolled back.', 500);
    } finally {
      for (const entry of staged) {
        await unlink(entry.temporaryPath).catch(() => {});
        if (entry.backupPath) await unlink(entry.backupPath).catch(() => {});
      }
      if (!restoreSucceeded) {
        for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => {});
      }
      preview.inProgress = false;
      releaseTransfer();
    }
    previews.delete(previewId);
    return { restored: preview.items.map(({ relativePath }) => relativePath) };
  }

  return Object.freeze({
    configuration: () => ({ enabled: !configError && Boolean(config?.bucket), configured: !configError, endpointConfigured: Boolean(config?.endpoint), region: config?.region || 'us-east-1' }),
    getManifest,
    createBackupPreview,
    backup,
    createRestorePreview,
    restore,
  });
}
