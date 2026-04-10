// ─── State ─────────────────────────────────────────────────────────────────
let urlCount = 1;
let selectedFiles = [];
let currentJobId = null;
let eventSource = null;
let pollInterval = null;

// ─── URL Management ──────────────────────────────────────────────────────────
function addUrl() {
  const list = document.getElementById('urlList');
  const row = document.createElement('div');
  row.className = 'url-row';
  row.dataset.index = urlCount;
  row.innerHTML = `
    <div class="input-wrap">
      <span class="input-icon">🌐</span>
      <input type="url" class="url-input" id="url-${urlCount}" placeholder="https://...article URL..." autocomplete="off" />
      <button type="button" class="btn-remove-url" onclick="removeUrl(this)" title="Remove">✕</button>
    </div>`;
  list.appendChild(row);
  urlCount++;
  row.querySelector('input').focus();
}

function removeUrl(btn) {
  const list = document.getElementById('urlList');
  const row = btn.closest('.url-row');
  if (list.children.length > 1) row.remove();
  else row.querySelector('input').value = '';
}

function getUrls() {
  return [...document.querySelectorAll('.url-input')]
    .map(i => i.value.trim()).filter(Boolean);
}

// ─── Image Upload ─────────────────────────────────────────────────────────────
function onDragOver(e) { e.preventDefault(); document.getElementById('dropZone').classList.add('dragover'); }
function onDragLeave()  { document.getElementById('dropZone').classList.remove('dragover'); }
function onDrop(e)      { e.preventDefault(); onDragLeave(); addFiles([...e.dataTransfer.files]); }
function onFilePicked(e){ addFiles([...e.target.files]); e.target.value = ''; }

function addFiles(newFiles) {
  newFiles.forEach(f => {
    if (!f.type.startsWith('image/')) return;
    if (f.size > 20 * 1024 * 1024) { alert(`${f.name} is too large (max 20MB)`); return; }
    selectedFiles.push(f);
  });
  renderImagePreviews();
}
function removeFile(idx) { selectedFiles.splice(idx, 1); renderImagePreviews(); }
function renderImagePreviews() {
  const grid = document.getElementById('imagePreviewGrid');
  grid.innerHTML = '';
  selectedFiles.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    const item = document.createElement('div');
    item.className = 'img-preview-item';
    item.innerHTML = `<img src="${url}" alt="${file.name}" /><button class="remove-img" onclick="removeFile(${i})">✕</button>`;
    grid.appendChild(item);
  });
}

// ─── Post Type Management ───────────────────────────────────────────────────
const postTypeConfigs = {
  editorial: {
    title: 'UPSC Editorial',
    desc: 'Drop article URLs or upload images — our AI pipeline extracts content, writes a structured UPSC article, generates a thumbnail, and publishes it to Blogger automatically.',
    btn: '🚀 Generate & Publish UPSC Post'
  },
  job_posting: {
    title: 'Job Posting',
    desc: 'Paste recruitment links or upload job notification images. Our AI will extract structured data, generate high-intent HTML with SEO Schema, and post it instantly.',
    btn: '💼 Generate & Publish Job Post'
  },
  normal: {
    title: 'Normal Blog',
    desc: 'Standard blog post generation. Extracts key points from any source and writes a clean, engaging article for your Blogger audience.',
    btn: '📝 Generate & Publish Blog Post'
  }
};

document.getElementById('postType').addEventListener('change', (e) => {
  const config = postTypeConfigs[e.target.value];
  if (!config) return;
  
  document.getElementById('dynamicType').textContent = config.title;
  document.getElementById('heroDesc').textContent = config.desc;
  document.getElementById('submitText').textContent = config.btn;
});

// ─── Form Submit ──────────────────────────────────────────────────────────────
document.getElementById('generateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const urls = getUrls();
  if (urls.length === 0 && selectedFiles.length === 0) {
    alert('Please add at least one URL or upload at least one image.'); return;
  }
  const btn = document.getElementById('submitBtn');
  document.getElementById('submitText').style.display = 'none';
  document.getElementById('submitLoader').style.display = 'block';
  btn.disabled = true;

  const formData = new FormData();
  formData.append('urls', JSON.stringify(urls));
  formData.append('postType', document.getElementById('postType').value);
  selectedFiles.forEach(f => formData.append('images', f));

  try {
    const resp = await fetch('/api/generate', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Server error');
    currentJobId = data.jobId;
    showProgressCard();
    startConnecting(currentJobId);
  } catch (err) {
    alert('Error: ' + err.message);
    resetSubmitBtn();
  }
});

// ─── Card switching ────────────────────────────────────────────────────────────
function showProgressCard() {
  document.getElementById('formCard').style.display = 'none';
  document.getElementById('progressCard').style.display = 'block';
  document.getElementById('resultCard').style.display = 'none';
}
function showResultCard() {
  // Keep progressCard visible — result card appears above it
  document.getElementById('resultCard').style.display = 'block';
  document.getElementById('progressCard').classList.add('pipeline-done');
  // smooth scroll to result
  setTimeout(() => document.getElementById('resultCard').scrollIntoView({ behavior:'smooth', block:'start' }), 150);
}
function resetForm() {
  document.getElementById('formCard').style.display = 'block';
  document.getElementById('progressCard').style.display = 'none';
  document.getElementById('progressCard').classList.remove('pipeline-done');
  document.getElementById('resultCard').style.display = 'none';
  document.getElementById('stepLogItems').innerHTML = '';
  const vb = document.getElementById('viewPostBtn');
  if (vb) { vb.style.display = 'none'; vb.href = '#'; }
  const jp = document.getElementById('jsonPreview');
  if (jp) jp.style.display = 'none';
  _lastStatus = null;
  resetSubmitBtn();
  currentJobId = null;
}
function resetSubmitBtn() {
  document.getElementById('submitText').style.display = 'inline';
  document.getElementById('submitLoader').style.display = 'none';
  document.getElementById('submitBtn').disabled = false;
}

// ─── SSE + always-on polling (belt & suspenders) ───────────────────────────
function startConnecting(jobId) {
  if (eventSource) eventSource.close();
  if (pollInterval) clearInterval(pollInterval);

  // 1. SSE (fast real-time updates)
  try {
    eventSource = new EventSource(`/api/status/${jobId}`);
    eventSource.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        updateProgress(data);
        if (data.status === 'done' || data.status === 'error') eventSource.close();
      } catch (_) {}
    };
    eventSource.onerror = () => eventSource.close();
  } catch (_) {}

  // 2. Polling as safety net (runs always, every 2s)
  pollInterval = setInterval(async () => {
    try {
      const resp = await fetch(`/api/job/${jobId}`);
      if (!resp.ok) return;
      const data = await resp.json();
      updateProgress(data);
      if (data.status === 'done' || data.status === 'error') clearInterval(pollInterval);
    } catch (_) {}
  }, 2000);
}

// ─── Progress Update ─────────────────────────────────────────────────────────
let _lastStatus = null;
function updateProgress(data) {
  const pct = data.progress || 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';
  document.getElementById('progressStep').textContent = data.step || '';

  updatePipelineDots(data.stepResults || []);
  renderStepLog(data.stepResults || []);

  // Fire done/error handling only once
  if (_lastStatus === data.status) return;
  _lastStatus = data.status;

  if (data.status === 'done') {
    document.getElementById('progressIcon').textContent = '✅';
    document.getElementById('progressTitle').textContent = 'Pipeline Complete — scroll down to review all steps';
    document.getElementById('progressStep').textContent = 'Click any step below to expand its output';
    showResult(data.result);
  } else if (data.status === 'error') {
    document.getElementById('progressIcon').textContent = '❌';
    document.getElementById('progressTitle').textContent = 'Pipeline Error';
    showResult(null, data.error);
  }
}

// Map step id → pipe dot id
const PIPE_MAP = { fetch:'pipe-fetch', ocr:'pipe-ocr', ai:'pipe-ai', thumb:'pipe-thumb', drive:'pipe-drive', html:'pipe-html', publish:'pipe-publish', index:'pipe-index' };

function updatePipelineDots(stepResults) {
  // Reset all
  Object.values(PIPE_MAP).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active','done','error');
  });
  stepResults.forEach(sr => {
    const dotId = PIPE_MAP[sr.id];
    if (!dotId) return;
    const el = document.getElementById(dotId);
    if (!el) return;
    if (sr.status === 'active')          el.classList.add('active');
    else if (sr.status === 'done' || sr.status === 'skipped') el.classList.add('done');
    else if (sr.status === 'error')      el.classList.add('error');
  });
}

// ─── Step Log Renderer ─────────────────────────────────────────────────────────
function renderStepLog(stepResults) {
  try {
    _renderStepLog(stepResults);
  } catch (err) {
    console.error('Step log render error:', err);
  }
}

function _renderStepLog(stepResults) {
  const container = document.getElementById('stepLogItems');
  stepResults.forEach(sr => {
    let el = document.getElementById('sl-' + sr.id);
    const isNew = !el;
    if (!el) {
      el = document.createElement('div');
      el.id = 'sl-' + sr.id;
      container.appendChild(el);
    }

    const wasOpen = el.classList.contains('open');
    el.className = 'sl-item status-' + sr.status + (wasOpen ? ' open' : '');

    const statusLabels = { active:'running', done:'done', skipped:'skipped', error:'error' };
    const spinnerOrChevron = sr.status === 'active'
      ? `<div class="sl-spinner"></div>`
      : `<span class="sl-chevron">▼</span>`;

    const subText = buildSubText(sr);

    el.innerHTML = `
      <div class="sl-header" onclick="toggleStep('sl-${sr.id}')">
        <div class="sl-icon">${sr.icon}</div>
        <div class="sl-meta">
          <div class="sl-label">${sr.label}</div>
          ${subText ? `<div class="sl-sub">${subText}</div>` : ''}
        </div>
        <span class="sl-status-badge">${statusLabels[sr.status] || sr.status}</span>
        ${spinnerOrChevron}
      </div>
      <div class="sl-body">
        ${buildStepBody(sr)}
      </div>`;

    // New steps auto-open; active steps always open; preserve open state on re-render
    if (isNew || sr.status === 'active') {
      el.classList.add('open');
    }
  });
}

function toggleStep(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

// Subtitle text under each step label
function buildSubText(sr) {
  if (!sr.data) return sr.status === 'active' ? 'Processing...' : '';
  const d = sr.data;
  if (d.type === 'url_fetch') return `${d.fetched} URL(s) fetched · ${(d.totalChars/1000).toFixed(1)}K chars`;
  if (d.type === 'ocr')       return d.skipped ? 'No images provided' : `${d.processed} image(s) processed`;
  if (d.type === 'article')   return d.title || '';
  if (d.type === 'thumbnail') return d.error ? 'Failed — continuing without image' : 'Image ready';
  if (d.type === 'drive')     return d.fileId ? `File ID: ${d.fileId}` : '';
  if (d.type === 'html')      return `${(d.chars/1000).toFixed(1)}K chars HTML`;
  if (d.type === 'blogger')   return d.postUrl || (d.error ? 'Credentials not configured' : '');
  if (d.type === 'indexing')  return d.skipped ? 'Skipped — no post URL' : (d.url || '');
  if (d.type === 'sitemap')   return d.url || '';
  return '';
}

// Full body content per step type
function buildStepBody(sr) {
  if (!sr.data) {
    if (sr.status === 'active') return `<div class="sl-working"><div class="sl-working-dot"></div>Working...</div>`;
    return '<div class="sl-skipped-notice">No data available</div>';
  }
  const d = sr.data;

  // ── URL Fetch ──────────────────────────────────────────────────────────────
  if (d.type === 'url_fetch') {
    if (!d.results || d.results.length === 0) return '<div class="sl-skipped-notice">No URLs were provided.</div>';
    const statsHtml = `<div class="sl-stats">
      <div class="sl-stat"><div class="sl-stat-val">${d.fetched}</div><div class="sl-stat-key">Fetched</div></div>
      <div class="sl-stat"><div class="sl-stat-val">${d.failed}</div><div class="sl-stat-key">Failed</div></div>
      <div class="sl-stat"><div class="sl-stat-val">${(d.totalChars/1000).toFixed(1)}K</div><div class="sl-stat-key">Chars</div></div>
    </div>`;
    const listHtml = d.results.map(r => {
      if (r.error) return `<div class="sl-url-item error-item"><div class="url-line">${esc(r.url)}</div><div class="url-error">❌ ${esc(r.error)}</div></div>`;
      return `<div class="sl-url-item">
        <div class="url-line">${esc(r.url)}</div>
        <div class="url-stats">${(r.chars/1000).toFixed(1)}K chars extracted</div>
        <div class="url-preview">${esc(r.preview)}</div>
      </div>`;
    }).join('');
    return statsHtml + `<div class="sl-url-list">${listHtml}</div>`;
  }

  // ── OCR ────────────────────────────────────────────────────────────────────
  if (d.type === 'ocr') {
    if (d.skipped) return '<div class="sl-skipped-notice">No images were uploaded — OCR step skipped.</div>';
    if (!d.results || d.results.length === 0) return '<div class="sl-error">No OCR results.</div>';
    const statsHtml = `<div class="sl-stats">
      <div class="sl-stat"><div class="sl-stat-val">${d.processed}</div><div class="sl-stat-key">Processed</div></div>
    </div>`;
    const listHtml = d.results.map(r => {
      if (r.error) return `<div class="sl-url-item error-item"><div class="url-line">${esc(r.name)}</div><div class="url-error">❌ ${esc(r.error)}</div></div>`;
      return `<div class="sl-url-item">
        <div class="url-line">📄 ${esc(r.name)}</div>
        <div class="url-stats">${(r.chars/1000).toFixed(1)}K chars extracted</div>
        <div class="url-preview">${esc(r.preview)}</div>
      </div>`;
    }).join('');
    return statsHtml + `<div class="sl-url-list">${listHtml}</div>`;
  }

  // ── Article (AI) ───────────────────────────────────────────────────────────
  if (d.type === 'article') {
    const kwChips = (d.keywords || []).map(k => `<span class="sl-chip primary">${esc(k)}</span>`).join('');
    const tagChips = (d.tags || []).map(t => `<span class="sl-chip accent">${esc(t)}</span>`).join('');
    const labelChips = (d.labels || []).map(l => `<span class="sl-chip success">${esc(l)}</span>`).join('');
    const caItems = (d.currentAffairs || []).map(c => `<li>${esc(c)}</li>`).join('');
    const wfItems = (d.wayForward || []).map(w => `<li>${esc(w)}</li>`).join('');
    return `
      <div class="sl-article-title">${esc(d.title)}</div>
      <div class="sl-article-meta">/${esc(d.slug)} · ${d.mcqCount} MCQs · ${d.backgroundCount} background points</div>

      <div class="sl-section-label">📌 Meta Description</div>
      <div class="sl-intro-text">${esc(d.metaDescription)}</div>

      <div class="sl-section-label">🎯 Exam Relevance</div>
      <div class="sl-intro-text">${esc(d.examRelevance)}</div>

      <div class="sl-section-label">🧭 Introduction (preview)</div>
      <div class="sl-intro-text">${esc(d.introduction)}</div>

      <div class="sl-section-label">📰 Current Affairs Add-on</div>
      <ul class="sl-list">${caItems}</ul>

      <div class="sl-section-label">🚀 Way Forward (sample)</div>
      <ul class="sl-list">${wfItems}</ul>

      <div class="sl-section-label">📝 Mains Q (150 words)</div>
      <div class="sl-kv"><span class="sl-v">${esc(d.mains150Q || '')}</span></div>

      <div class="sl-section-label">📝 Mains Q (250 words)</div>
      <div class="sl-kv"><span class="sl-v">${esc(d.mains250Q || '')}</span></div>

      <div class="sl-section-label">🔑 Keywords</div>
      <div class="sl-chips">${kwChips}</div>

      <div class="sl-section-label">🏷️ Tags</div>
      <div class="sl-chips">${tagChips}</div>

      <div class="sl-section-label">🏷️ Labels</div>
      <div class="sl-chips">${labelChips}</div>

      <div class="sl-kv"><span class="sl-k">Canonical</span><span class="sl-v"><a href="${esc(d.canonical)}" target="_blank">${esc(d.canonical)}</a></span></div>
    `;
  }

  // ── Thumbnail ──────────────────────────────────────────────────────────────
  if (d.type === 'thumbnail') {
    if (d.error) return `<div class="sl-error">❌ ${esc(d.error)}</div><div class="sl-skipped-notice">Pipeline continues without a thumbnail.</div>`;
    return `
      <div class="sl-kv"><span class="sl-k">Title</span><span class="sl-v">${esc(d.title)}</span></div>
      <div class="sl-kv"><span class="sl-k">RenderForm URL</span><span class="sl-v"><a href="${esc(d.renderFormUrl)}" target="_blank">View original ↗</a></span></div>
      <img class="sl-thumb-img" src="${esc(d.renderFormUrl)}" alt="Thumbnail" />
    `;
  }

  // ── Google Drive ───────────────────────────────────────────────────────────
  if (d.type === 'drive') {
    return `
      <div class="sl-kv"><span class="sl-k">File ID</span><span class="sl-v">${esc(d.fileId)}</span></div>
      <div class="sl-kv"><span class="sl-k">Drive Link</span><span class="sl-v"><a href="${esc(d.driveLink)}" target="_blank">Open in Drive ↗</a></span></div>
      <img class="sl-thumb-img" src="${esc(d.imageUrl)}" alt="Uploaded thumbnail" />
    `;
  }

  // ── HTML ───────────────────────────────────────────────────────────────────
  if (d.type === 'html') {
    return `
      <div class="sl-stats">
        <div class="sl-stat"><div class="sl-stat-val">${(d.chars/1000).toFixed(1)}K</div><div class="sl-stat-key">HTML Chars</div></div>
      </div>
      <div class="sl-section-label">HTML Preview</div>
      <div class="sl-preview">${esc(d.preview)}</div>
    `;
  }

  // ── Blogger ────────────────────────────────────────────────────────────────
  if (d.type === 'blogger') {
    if (d.error) return `<div class="sl-error">❌ ${esc(d.error)}<br><br>Tip: Add your BLOGGER_CLIENT_ID, BLOGGER_CLIENT_SECRET and BLOGGER_REFRESH_TOKEN to .env</div>`;
    return `
      <div class="sl-post-card">
        <div class="sl-post-title">${esc(d.title)}</div>
        <div class="sl-kv"><span class="sl-k">Post ID</span><span class="sl-v">${esc(d.postId)}</span></div>
        <div class="sl-kv"><span class="sl-k">Published</span><span class="sl-v">${d.published ? new Date(d.published).toLocaleString() : '—'}</span></div>
        <div class="sl-kv"><span class="sl-k">Labels</span><span class="sl-v">${(d.labels||[]).join(', ')}</span></div>
        <div class="sl-kv" style="margin-top:10px"><span class="sl-k">Post URL</span></div>
        <a class="sl-post-url" href="${esc(d.postUrl)}" target="_blank">🔗 ${esc(d.postUrl)}</a>
      </div>
    `;
  }

  // ── Indexing ───────────────────────────────────────────────────────────────
  if (d.type === 'indexing') {
    if (d.skipped) return '<div class="sl-skipped-notice">⚠️ Skipped — no Blogger post URL (Blogger credentials may not be configured).</div>';
    return `
      <div class="sl-kv"><span class="sl-k">URL Submitted</span><span class="sl-v"><a href="${esc(d.url)}" target="_blank">${esc(d.url)}</a></span></div>
      <div class="sl-kv"><span class="sl-k">Response</span><span class="sl-v">${d.response ? JSON.stringify(d.response) : '✅ Accepted'}</span></div>
    `;
  }

  // ── Sitemap ────────────────────────────────────────────────────────────────
  if (d.type === 'sitemap') {
    return `<div class="sl-kv"><span class="sl-k">Pinged</span><span class="sl-v"><a href="${esc(d.url)}" target="_blank">${esc(d.url)}</a></span></div>`;
  }

  return '<div class="sl-skipped-notice">Step completed.</div>';
}

// HTML escape helper
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Show Result ──────────────────────────────────────────────────────────────
function showResult(result, errorMsg) {
  showResultCard();
  if (errorMsg) {
    document.getElementById('resultIcon').textContent = '❌';
    document.getElementById('resultIcon').className = 'result-icon error';
    document.getElementById('resultTitle').textContent = 'Pipeline Failed';
    document.getElementById('resultSubtitle').textContent = errorMsg;
    return;
  }
  document.getElementById('resultTitle').textContent = result.title || 'Blog Post Published!';
  document.getElementById('resultSubtitle').textContent = result.postUrl ? `Live at: ${result.postUrl}` : 'Article generated (Blogger credentials not configured)';

  const grid = document.getElementById('resultGrid');
  const items = [
    { label: 'Status',      value: result.postUrl ? '✅ Published' : '⚠️ Skipped' },
    { label: 'Title',       value: result.title || '—' },
    { label: 'Slug',        value: result.slug || '—' },
    { label: 'Drive Image', value: result.driveFileId ? '✅ Uploaded' : '—' },
    { label: 'Post ID',     value: result.postId || '—' },
  ];
  grid.innerHTML = items.map(it => `
    <div class="result-item">
      <div class="result-item-label">${it.label}</div>
      <div class="result-item-value">${it.value}</div>
    </div>`).join('');

  if (result.postUrl) {
    const viewBtn = document.getElementById('viewPostBtn');
    viewBtn.href = result.postUrl;
    viewBtn.style.display = 'flex';
  }
  if (result.articleData) {
    document.getElementById('jsonPreview').style.display = 'block';
    document.getElementById('jsonOutput').textContent = JSON.stringify(result.articleData, null, 2);
  }
}

// Keyboard shortcut
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter')
    document.getElementById('generateForm').dispatchEvent(new Event('submit'));
});

function expandAllSteps() {
  document.querySelectorAll('.sl-item').forEach(el => el.classList.add('open'));
}
function collapseAllSteps() {
  document.querySelectorAll('.sl-item').forEach(el => el.classList.remove('open'));
}
