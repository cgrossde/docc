// ─── API layer — all fetch() calls ───
// All functions return { ok, data } for consistent error handling.

async function post(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function get(url) {
  const res = await fetch(url);
  const data = await res.json();
  return { ok: res.ok, data };
}

export async function listPdfs() {
  return get('/api/pdfs');
}

export async function listFolders() {
  return get('/api/folders');
}

export async function classify(filename) {
  return post('/api/classify', { filename });
}

export async function suggestNames(filename, folder, signal) {
  return post('/api/suggest-names', { filename, folder }, signal);
}

export async function move(body) {
  return post('/api/move', body);
}

export async function deletePdf(body) {
  return post('/api/delete', body);
}

export async function folderFiles(folder, filename) {
  let qp = 'folder=' + encodeURIComponent(folder);
  if (filename) qp += '&filename=' + encodeURIComponent(filename);
  return get('/api/folder-files?' + qp);
}

export async function openFolder(folder) {
  return post('/api/open-folder', { folder });
}

export async function log(body) {
  return post('/api/log', body);
}

export async function fetchStats() {
  return get('/api/stats');
}
