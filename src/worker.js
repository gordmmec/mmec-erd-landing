// erd-mmec-ca worker
//
// Responsibilities:
//   1. Serve the combined erd.mmec.ca/ index — email-published projects at top,
//      then the existing static repository-based sections (rendered from
//      index.html in this repo via env.ASSETS).
//   2. Accept email-driven submissions at PUT /_submit/e/<name>/[<digit>/]index.html
//      from the erd-worker@mmec.ca Apps Script (gated by env.SUBMIT_TOKEN).
//   3. Serve published email pages at GET /e/<name>/ and /e/<name>/<digit>/
//      from the EMAIL_BUCKET R2 bucket.
//   4. Anything else — robots.txt, favicons, etc. — falls through to
//      env.ASSETS (i.e. the files committed to this repo).
//
// Existing per-project zone routes (erd.mmec.ca/gm1/*, /ae2/*, etc.) are
// unaffected — they take precedence and never reach this worker.

const TITLE_MAX_LEN = 42;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

async function getTitleForKey(env, key, name) {
  try {
    const obj = await env.EMAIL_BUCKET.get(key);
    if (!obj) return null;
    const text = await obj.text();
    const m = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return null;
    const title = m[1].trim().replace(/\s+/g, " ");
    if (!title || title.toLowerCase() === name.toLowerCase()) return null;
    return title;
  } catch (e) {
    return null;
  }
}

// Lists all email-published names + their default and numbered slots.
// Returns { name: [{ slot, url, title }] }, sorted name then slot.
async function getEmailProjects(env) {
  const grouped = {};
  let cursor = undefined;
  do {
    const listed = await env.EMAIL_BUCKET.list({ prefix: "e/", cursor });
    for (const obj of (listed.objects || [])) {
      const m = obj.key.match(/^e\/([a-z0-9][a-z0-9-]*)\/(?:(\d)\/)?index\.html$/i);
      if (!m) continue;
      const name = m[1].toLowerCase();
      const slot = m[2] !== undefined ? Number(m[2]) : null;
      if (!grouped[name]) grouped[name] = [];
      grouped[name].push({ key: obj.key, slot });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Fetch titles in parallel; sort default-first then 0..9
  await Promise.all(Object.entries(grouped).map(async ([name, items]) => {
    items.sort((a, b) => {
      if (a.slot === null) return -1;
      if (b.slot === null) return 1;
      return a.slot - b.slot;
    });
    await Promise.all(items.map(async item => {
      item.title = await getTitleForKey(env, item.key, name);
      item.url = item.slot !== null ? `/e/${name}/${item.slot}/` : `/e/${name}/`;
    }));
  }));

  return grouped;
}

function renderProjectLine(p) {
  const titleHtml = p.title
    ? escapeHtml(truncate(p.title, TITLE_MAX_LEN))
    : "(untitled)";
  const slotLabel = p.slot !== null
    ? `<span class="erd-email-slot">[${p.slot}]</span> `
    : "";
  return `${slotLabel}<a href="${p.url}">${titleHtml}</a>`;
}

function renderEmailSection(emailProjects) {
  const names = Object.keys(emailProjects).sort();
  if (names.length === 0) {
    // No content yet — render the heading anyway so users know the section exists
    return `<h2>Erd via erd-worker@mmec.ca</h2>
<p class="erd-email-empty">No published pages yet. Email an .html attachment to <code>erd-worker@mmec.ca</code> to publish.</p>`;
  }

  const items = names.map(name => {
    const projects = emailProjects[name];
    const lines = projects.map(renderProjectLine).join("<br>\n      ");
    return `    <li><span class="erd-email-slug">${escapeHtml(name)}</span> ${lines}</li>`;
  }).join("\n");

  return `<h2>Erd via erd-worker@mmec.ca</h2>
<ul class="erd-email-roster">
${items}
</ul>`;
}

const EMAIL_SECTION_CSS = `<style>
ul.erd-email-roster {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  columns: 2 320px;
  column-gap: 2rem;
}
ul.erd-email-roster li { padding: 0.5rem 0; break-inside: avoid; }
.erd-email-slug { font-family: monospace; font-weight: 500; color: #222; margin-right: 0.5em; }
.erd-email-slot { font-family: monospace; color: #888; margin-right: 0.25em; }
.erd-email-empty { color: #666; font-style: italic; }
</style>`;

async function renderCombined(env, request) {
  const emailProjects = await getEmailProjects(env);
  const emailSection = renderEmailSection(emailProjects);

  // Fetch the existing static index.html via the assets binding.
  const assetReq = new Request(new URL("/index.html", request.url));
  const assetResp = await env.ASSETS.fetch(assetReq);
  let html = await assetResp.text();

  // Inject the email CSS before </head>, and the email section before the first <h2>.
  html = html.replace(/<\/head>/i, `${EMAIL_SECTION_CSS}\n</head>`);
  html = html.replace(/<h2/i, `${emailSection}\n<h2`);

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

// PUT /_submit/e/<name>/[<digit>/]index.html — Apps Script writes here.
async function handleSubmit(request, env, url) {
  const token = request.headers.get("X-Submit-Token");
  if (!env.SUBMIT_TOKEN || token !== env.SUBMIT_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }
  const key = url.pathname.replace("/_submit/", "");
  // Only accept writes under e/<name>/ ... and only index.html files
  if (!/^e\/[a-z0-9][a-z0-9-]*\/(?:\d\/)?index\.html$/i.test(key)) {
    return new Response("Bad key", { status: 400 });
  }
  await env.EMAIL_BUCKET.put(key, request.body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  return new Response("OK\n");
}

// GET /e/<name>/ or /e/<name>/<digit>/ → R2 read
async function serveEmailContent(env, url) {
  let key = url.pathname.slice(1); // strip leading /
  if (key.endsWith("/")) key += "index.html";
  const obj = await env.EMAIL_BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "PUT" && url.pathname.startsWith("/_submit/")) {
      return handleSubmit(request, env, url);
    }

    if (url.pathname.startsWith("/e/")) {
      return serveEmailContent(env, url);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return renderCombined(env, request);
    }

    // Anything else (robots.txt, favicons, etc.) is served from the repo as a static asset.
    return env.ASSETS.fetch(request);
  },
};
