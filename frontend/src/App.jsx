import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bootstrapSession, get, post } from './lib/api.js';

function errorText(error) {
  return error?.message || 'The local operation failed.';
}

function fileState(file) {
  if (file.conflicted) return 'Conflict';
  if (file.untracked) return 'Untracked';
  if (file.staged && file.unstaged) return 'Staged + modified';
  if (file.staged) return 'Staged';
  if (file.unstaged) return 'Modified';
  return 'Changed';
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function App() {
  const [session, setSession] = useState(null);
  const [repositories, setRepositories] = useState([]);
  const [repo, setRepo] = useState(null);
  const [status, setStatus] = useState(null);
  const [branches, setBranches] = useState([]);
  const [remotes, setRemotes] = useState([]);
  const [history, setHistory] = useState([]);
  const [activeTab, setActiveTab] = useState('changes');
  const [selectedFile, setSelectedFile] = useState(null);
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [backupConfig, setBackupConfig] = useState(null);
  const [backupManifest, setBackupManifest] = useState([]);
  const [backupPathInput, setBackupPathInput] = useState('');
  const [backupPaths, setBackupPaths] = useState([]);
  const [backupPreview, setBackupPreview] = useState(null);
  const [restorePaths, setRestorePaths] = useState([]);
  const [restorePreview, setRestorePreview] = useState(null);
  const [overwritePaths, setOverwritePaths] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refreshLock = useRef(false);

  const selectedRepository = useMemo(() => repositories.find((item) => item.id === repo), [repositories, repo]);

  const refresh = useCallback(async (quiet = false) => {
    if (repo === null || refreshLock.current) return;
    refreshLock.current = true;
    try {
      const query = `?repo=${encodeURIComponent(repo)}`;
      const [nextStatus, nextBranches, nextRemotes, nextHistory] = await Promise.all([
        get(`/api/workspace/status${query}`),
        get(`/api/workspace/branches${query}`),
        get(`/api/workspace/remotes${query}`),
        get(`/api/workspace/history${query}`),
      ]);
      setStatus(nextStatus);
      setBranches(nextBranches.branches);
      setRemotes(nextRemotes.remotes);
      setHistory(nextHistory.commits);
      setSelectedFile((current) => current && nextStatus.files.some((item) => item.path === current) ? current : nextStatus.files[0]?.path || null);
      if (!quiet) setError('');
    } catch (failure) {
      if (!quiet) setError(errorText(failure));
    } finally {
      refreshLock.current = false;
    }
  }, [repo]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const initialSession = await bootstrapSession();
        const workspace = await get('/api/workspace');
        if (!active) return;
        setSession(initialSession);
        setRepositories(workspace.repositories);
        if (workspace.repositories.length) setRepo(workspace.repositories[0].id);
      } catch (failure) {
        if (active) setError(errorText(failure));
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (repo === null) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(true), 2500);
    return () => clearInterval(timer);
  }, [repo, refresh]);

  useEffect(() => {
    if (!selectedFile || repo === null) { setDiff(''); return undefined; }
    let active = true;
    setDiffLoading(true);
    const changed = status?.files.find((item) => item.path === selectedFile);
    const staged = Boolean(changed?.staged && !changed?.unstaged);
    const query = new URLSearchParams({ repo, path: selectedFile, staged: staged ? 'true' : 'false' });
    get(`/api/workspace/diff?${query}`)
      .then((payload) => { if (active) setDiff(payload.diff); })
      .catch((failure) => { if (active) setError(errorText(failure)); })
      .finally(() => { if (active) setDiffLoading(false); });
    return () => { active = false; };
  }, [selectedFile, repo, status]);

  useEffect(() => {
    if (activeTab !== 'backup' || repo === null) return undefined;
    let active = true;
    const query = `?repo=${encodeURIComponent(repo)}`;
    Promise.all([get('/api/backups/config'), get(`/api/backups/manifest${query}`)])
      .then(([configuration, manifest]) => {
        if (!active) return;
        setBackupConfig(configuration);
        setBackupManifest(manifest.files);
      })
      .catch((failure) => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [activeTab, repo]);

  async function perform(path, body, successMessage) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await post(path, { repo, ...body });
      setNotice(successMessage);
      await refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function initializeRepository() {
    setBusy(true);
    try {
      await post('/api/workspace/init', {});
      const workspace = await get('/api/workspace');
      setRepositories(workspace.repositories);
      setRepo(workspace.repositories[0]?.id ?? null);
      setNotice('Git repository initialized in the selected folder.');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  function addBackupPath(event) {
    event.preventDefault();
    const value = backupPathInput.trim().replaceAll('\\', '/');
    if (!value || backupPaths.includes(value)) return;
    setBackupPaths((items) => [...items, value]);
    setBackupPathInput('');
    setBackupPreview(null);
  }

  async function previewBackup() {
    setBusy(true); setError(''); setNotice('');
    try {
      const preview = await post('/api/backups/preview', { repo, paths: backupPaths });
      setBackupPreview(preview);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  async function startBackup() {
    setBusy(true); setError(''); setNotice('');
    try {
      await post('/api/backups/backup', { repo, previewId: backupPreview.previewId });
      setNotice('Selected files were backed up to your S3 bucket.');
      setBackupPreview(null); setBackupPaths([]);
      const manifest = await get(`/api/backups/manifest?repo=${encodeURIComponent(repo)}`);
      setBackupManifest(manifest.files);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  async function previewRestore() {
    setBusy(true); setError(''); setNotice('');
    try {
      const preview = await post('/api/backups/restore/preview', { repo, paths: restorePaths });
      setRestorePreview(preview); setOverwritePaths([]);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  async function startRestore() {
    setBusy(true); setError(''); setNotice('');
    try {
      await post('/api/backups/restore', { repo, previewId: restorePreview.previewId, confirmOverwritePaths: overwritePaths });
      setNotice('Selected files were restored and verified.');
      setRestorePreview(null); setRestorePaths([]); setOverwritePaths([]);
      const manifest = await get(`/api/backups/manifest?repo=${encodeURIComponent(repo)}`);
      setBackupManifest(manifest.files);
      await refresh();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  const stagedFiles = status?.files.filter((file) => file.staged) || [];
  const unstagedFiles = status?.files.filter((file) => file.unstaged || file.untracked) || [];
  const currentBranch = status?.branch || 'Detached HEAD';

  return <div className="shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="LocalGit Studio home"><span className="brand-mark">L</span>LocalGit Studio</a>
      <div className="topbar-right"><span className="local-indicator"><i /> Local workspace</span><span className="workspace-label">{session?.workspace?.name || 'Starting…'}</span></div>
    </header>
    <main className="main">
      <section className="intro">
        <div><p className="eyebrow">Your files, your Git</p><h1>Work with your local repository.</h1><p className="lede">Edit the same files in VS Code or another editor. This workspace reads Git directly from disk.</p></div>
        <div className="intro-note"><strong>VS Code</strong><span>Open the folder you selected with <code>--root</code> or <code>--repo</code>. Changes refresh here automatically.</span></div>
      </section>

      {error && <div className="banner error" role="alert">{error}</div>}
      {notice && !error && <div className="banner success" role="status">{notice}</div>}

      {!session && !error && <div className="loading-card">Connecting to the local workspace…</div>}
      {session && repositories.length === 0 && <section className="empty-workspace"><div className="empty-icon">⌘</div><h2>No Git repository found</h2><p>Create a Git repository in this selected folder to begin. Existing files stay in place.</p><button className="button primary" onClick={initializeRepository} disabled={busy || session.workspace.mode !== 'root'}>Initialize Git here</button>{session.workspace.mode === 'repo' && <p className="hint">This launch mode expects an existing repository. Restart with <code>--root &lt;directory&gt;</code> to initialize an empty folder.</p>}</section>}

      {selectedRepository && <>
        <section className="toolbar panel">
          <div className="repository-select"><span className="repo-icon">⌁</span>{repositories.length > 1 ? <select aria-label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)}>{repositories.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.path}</option>)}</select> : <div><strong>{selectedRepository.name}</strong><small>{selectedRepository.path === '.' ? 'Selected repository' : selectedRepository.path}</small></div>}</div>
          <div className="branch-control"><span className="branch-mark">⑂</span><select aria-label="Current branch" value={currentBranch} onChange={(event) => perform('/api/workspace/branch/switch', { name: event.target.value }, `Switched to ${event.target.value}.`)} disabled={!branches.length || busy}><option value="Detached HEAD">Detached HEAD</option>{branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}</select></div>
          <form className="new-branch" onSubmit={(event) => { event.preventDefault(); perform('/api/workspace/branch/create', { name: branchName }, `Created branch ${branchName}.`).then(() => setBranchName('')); }}><input aria-label="New branch name" placeholder="New branch" value={branchName} onChange={(event) => setBranchName(event.target.value)} /><button className="button subtle" type="submit" disabled={busy || !branchName.trim()}>Create</button></form>
          <div className="remote-actions">{remotes.length > 0 && <><button className="button subtle" onClick={() => perform('/api/workspace/remote/fetch', { name: remotes[0].name }, 'Fetched remote updates.')} disabled={busy}>Fetch</button><button className="button subtle" onClick={() => perform('/api/workspace/remote/pull', {}, 'Pulled fast-forward updates.')} disabled={busy}>Pull</button><button className="button primary" onClick={() => perform('/api/workspace/remote/push', { name: remotes[0].name }, 'Pushed the current branch.')} disabled={busy}>Push</button></>}</div>
        </section>

        <nav className="tabs" aria-label="Workspace sections"><button className={activeTab === 'changes' ? 'active' : ''} onClick={() => setActiveTab('changes')}>Changes <span>{status?.files.length || 0}</span></button><button className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}>History</button><button className={activeTab === 'backup' ? 'active' : ''} onClick={() => setActiveTab('backup')}>S3 backup</button></nav>

        {activeTab === 'changes' && <section className="change-layout">
          <aside className="file-panel panel">
            <div className="panel-heading"><div><strong>Working tree</strong><span>{status?.files.length || 0} changed files</span></div><button className="icon-button" title="Refresh" onClick={() => refresh()} aria-label="Refresh status">↻</button></div>
            <div className="file-list">
              {status?.files.map((file) => <button key={`${file.path}-${file.index}-${file.worktree}`} className={`file-item ${selectedFile === file.path ? 'selected' : ''}`} onClick={() => setSelectedFile(file.path)}><span className={`file-status ${file.conflicted ? 'conflict' : file.untracked ? 'new' : file.staged ? 'staged' : ''}`}>{file.conflicted ? '!' : file.untracked ? 'U' : file.staged ? 'S' : 'M'}</span><span className="file-name" title={file.path}>{file.path}</span><span className="file-kind">{fileState(file)}</span></button>)}
              {status && status.files.length === 0 && <div className="file-empty"><span className="clean-check">✓</span><strong>Working tree clean</strong><span>All changes are committed.</span></div>}
            </div>
            <div className="stage-controls">
              <div className="group-title"><span>Unstaged changes</span><span>{unstagedFiles.length}</span></div>
              <button className="button subtle full" disabled={!selectedFile || !unstagedFiles.some((file) => file.path === selectedFile) || busy} onClick={() => perform('/api/workspace/stage', { paths: [selectedFile] }, 'File staged.')}>Stage selected</button>
              <div className="group-title staged-title"><span>Staged changes</span><span>{stagedFiles.length}</span></div>
              <button className="button subtle full" disabled={!selectedFile || !stagedFiles.some((file) => file.path === selectedFile) || busy} onClick={() => perform('/api/workspace/unstage', { paths: [selectedFile] }, 'File unstaged.')}>Unstage selected</button>
              <form className="commit-form" onSubmit={(event) => { event.preventDefault(); perform('/api/workspace/commit', { message: commitMessage }, 'Commit created.').then(() => setCommitMessage('')); }}>
                <label htmlFor="commit-message">Commit message</label><input id="commit-message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe your changes" maxLength={4000} />
                <button className="button primary full" type="submit" disabled={busy || stagedFiles.length === 0 || !commitMessage.trim()}>Commit {stagedFiles.length ? `(${stagedFiles.length})` : ''}</button>
              </form>
            </div>
          </aside>
          <section className="diff-panel panel">
            <div className="panel-heading diff-heading"><div><strong>{selectedFile || 'Diff preview'}</strong><span>{selectedFile ? `${status?.files.find((file) => file.path === selectedFile) ? fileState(status.files.find((file) => file.path === selectedFile)) : ''} · ${status?.branch || 'detached'}` : 'Select a changed file'}</span></div></div>
            <div className="diff-content">{diffLoading ? <div className="center-muted">Loading diff…</div> : !selectedFile ? <div className="center-muted">Choose a file to inspect its diff.</div> : status?.files.find((file) => file.path === selectedFile)?.untracked && !status?.files.find((file) => file.path === selectedFile)?.staged ? <div className="center-muted">Stage this untracked file to review its content before committing.</div> : diff ? <pre className="diff-code">{diff.split('\n').map((line, index) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''} key={index}>{line}{'\n'}</span>)}</pre> : <div className="center-muted">No text diff is available for this file.</div>}</div>
          </section>
        </section>}

        {activeTab === 'history' && <section className="history-panel panel"><div className="panel-heading"><div><strong>Recent commits</strong><span>Git history for this repository</span></div><button className="icon-button" onClick={() => refresh()} aria-label="Refresh history">↻</button></div>{history.length ? <div className="history-list">{history.map((commit) => <article className="history-item" key={commit.hash}><span className="timeline-dot" /><div><strong>{commit.subject}</strong><p>{commit.author} · {new Date(commit.date).toLocaleString()}</p></div><code>{commit.hash.slice(0, 8)}</code></article>)}</div> : <div className="file-empty"><strong>No commits yet</strong><span>Stage files and create your first commit.</span></div>}</section>}

        {activeTab === 'backup' && <section className="backup-workspace">
          <div className="backup-panel panel"><div className="backup-icon">☁</div><div className="backup-intro"><p className="eyebrow">Personal storage</p><h2>S3 backups</h2><p>Back up only files you select to your S3-compatible bucket. Git remains the shared history; these personal backups are private to your bucket.</p>{backupConfig?.configured && backupConfig.enabled ? <p className="config-state"><i className="green-dot" /> S3 enabled · {backupConfig.region} · credentials stay on this machine</p> : <p className="config-state muted">S3 is optional and currently disabled. Set <code>LOCAL_GIT_S3_BUCKET</code> and your AWS profile or environment credentials, then restart LocalGit Studio.</p>}</div></div>
          <div className="backup-columns">
            <section className="panel backup-card"><div className="panel-heading"><div><strong>Back up files</strong><span>Choose repository-relative paths</span></div></div><div className="backup-card-body">
              <form className="backup-path-form" onSubmit={addBackupPath}><input aria-label="File path to back up" placeholder="assets/video.mp4" value={backupPathInput} onChange={(event) => setBackupPathInput(event.target.value)} disabled={!backupConfig?.enabled} /><button className="button subtle" type="submit" disabled={!backupConfig?.enabled || !backupPathInput.trim()}>Add</button></form>
              {backupPaths.length > 0 && <div className="selected-paths">{backupPaths.map((item) => <div className="selected-path" key={item}><code>{item}</code><button aria-label={`Remove ${item}`} onClick={() => { setBackupPaths((paths) => paths.filter((path) => path !== item)); setBackupPreview(null); }}>×</button></div>)}</div>}
              <button className="button primary" onClick={previewBackup} disabled={!backupConfig?.enabled || !backupPaths.length || busy}>Preview selected files</button>
              {backupPreview && <div className="preview-box"><strong>Ready to upload · {formatBytes(backupPreview.totalBytes)}</strong>{backupPreview.files.map((item) => <div className="preview-file" key={item.path}><code>{item.path}</code><span>{formatBytes(item.size)} · SHA-256 {item.sha256.slice(0, 12)}…</span></div>)}<button className="button primary" onClick={startBackup} disabled={busy}>Back up these files</button></div>}
              <p className="hint small-hint">Credentials, .env files, .git, SSH keys, and local settings are blocked. Files up to 2 GiB each are streamed and hash-checked.</p>
            </div></section>
            <section className="panel backup-card"><div className="panel-heading"><div><strong>Restore files</strong><span>{backupManifest.length} files in the remote manifest</span></div><button className="icon-button" aria-label="Refresh manifest" onClick={async () => { try { const manifest = await get(`/api/backups/manifest?repo=${encodeURIComponent(repo)}`); setBackupManifest(manifest.files); } catch (failure) { setError(errorText(failure)); } }}>↻</button></div><div className="backup-card-body">
              {backupManifest.length ? <div className="manifest-list">{backupManifest.map((item) => <label className="manifest-item" key={item.path}><input type="checkbox" checked={restorePaths.includes(item.path)} onChange={(event) => { setRestorePaths((paths) => event.target.checked ? [...paths, item.path] : paths.filter((path) => path !== item.path)); setRestorePreview(null); }} /><span><code>{item.path}</code><small>{formatBytes(item.size)} · SHA-256 {item.sha256.slice(0, 12)}…</small></span></label>)}</div> : <p className="center-muted compact">No backup manifest found for this repository.</p>}
              <button className="button subtle" onClick={previewRestore} disabled={!restorePaths.length || busy}>Preview restore</button>
              {restorePreview && <div className="preview-box"><strong>Restore preview</strong>{restorePreview.files.map((item) => <div className="restore-file" key={item.path}><div><code>{item.path}</code><span>{item.exists ? item.overwriteRequired ? 'Local file differs' : 'Local file matches' : 'File will be created'}</span></div>{item.overwriteRequired && <label className="overwrite-confirm"><input type="checkbox" checked={overwritePaths.includes(item.path)} onChange={(event) => setOverwritePaths((paths) => event.target.checked ? [...paths, item.path] : paths.filter((path) => path !== item.path))} /> Confirm overwrite of this exact file</label>}</div>)}<button className="button primary" onClick={startRestore} disabled={busy || restorePreview.files.some((item) => item.overwriteRequired && !overwritePaths.includes(item.path))}>Restore selected files</button></div>}
            </div></section>
          </div>
          <p className="hint s3-footnote">Restores are streamed to temporary files, checked against the manifest SHA-256, then written into this repository. Changed files require individual confirmation.</p>
        </section>}

        <footer className="workspace-footer"><span><i className="green-dot" /> Git working tree · refreshes every 2.5 seconds</span><span>Git is authoritative · no account or database required</span></footer>
      </>}
    </main>
  </div>;
}

export default App;
