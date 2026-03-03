const $ = (id) => document.getElementById(id);

const healthBadge = $("health-badge");
const wikiResult = $("wiki-result");
const articleList = $("article-list");
const searchResults = $("search-results");
const askAnswer = $("ask-answer");
const askContexts = $("ask-contexts");
const calendarEvents = $("calendar-events");
const driveFiles = $("drive-files");
const noteText = $("note-text");
const notesStatus = $("notes-status");

let notesSocket = null;
let noteTimer = null;

function setHealth(text, ok = true) {
  healthBadge.textContent = text;
  healthBadge.style.borderColor = ok ? "rgba(28, 143, 115, 0.5)" : "rgba(224, 110, 62, 0.6)";
}

function prettyJson(obj) {
  return JSON.stringify(obj, null, 2);
}

function short(text, len = 340) {
  if (!text) return "";
  return text.length <= len ? text : `${text.slice(0, len)}...`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const detail = typeof body === "object" ? body.detail || prettyJson(body) : body;
    throw new Error(detail || `Request failed: ${response.status}`);
  }
  return body;
}

function renderItems(container, items, itemBuilder) {
  if (!items.length) {
    container.innerHTML = `<div class="item">No items yet.</div>`;
    return;
  }
  container.innerHTML = "";
  for (const item of items) {
    container.append(itemBuilder(item));
  }
}

function div(html) {
  const node = document.createElement("div");
  node.innerHTML = html.trim();
  return node.firstChild;
}

async function refreshHealth() {
  try {
    const data = await api("/api/health");
    setHealth(
      `Online • Embeddings: ${data.embedding_backend} • LLM: ${data.llm_backend}`,
      true
    );
  } catch (err) {
    setHealth(`Backend unavailable: ${err.message}`, false);
  }
}

async function refreshArticles() {
  const articles = await api("/api/wiki/articles");
  renderItems(articleList, articles, (article) =>
    div(`
      <article class="item">
        <div class="item-title">${article.title}</div>
        <div class="item-meta">${article.downloaded_at}</div>
        <a href="${article.url}" target="_blank" rel="noreferrer">open source</a>
      </article>
    `)
  );
}

async function refreshCalendar() {
  const events = await api("/api/calendar/events");
  renderItems(calendarEvents, events, (event) => {
    const node = div(`
      <article class="item">
        <div class="item-title">${event.title}</div>
        <div class="item-meta">${event.start_ts} -> ${event.end_ts}</div>
        <div>${short(event.details, 220)}</div>
        <div class="item-actions">
          <button data-delete-event="${event.id}">Delete</button>
        </div>
      </article>
    `);
    node.querySelector("button").addEventListener("click", async () => {
      await api(`/api/calendar/events/${event.id}`, { method: "DELETE" });
      await refreshCalendar();
    });
    return node;
  });
}

async function refreshDrive() {
  const files = await api("/api/drive/files");
  renderItems(driveFiles, files, (file) => {
    const node = div(`
      <article class="item">
        <div class="item-title">${file.filename}</div>
        <div class="item-meta">${file.modified_at} • ${file.size} bytes</div>
        <div class="item-actions">
          <a href="/api/drive/download/${encodeURIComponent(file.filename)}" target="_blank" rel="noreferrer">Download</a>
          <button data-delete-file="${file.filename}">Delete</button>
        </div>
      </article>
    `);
    node.querySelector("button").addEventListener("click", async () => {
      await api(`/api/drive/files/${encodeURIComponent(file.filename)}`, { method: "DELETE" });
      await refreshDrive();
    });
    return node;
  });
}

async function loadNote() {
  const note = await api("/api/notes");
  noteText.value = note.content || "";
  notesStatus.textContent = `Last update: ${note.updated_at || "unknown"}`;
}

function connectNoteSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/notes`;
  notesSocket = new WebSocket(wsUrl);

  notesSocket.onopen = () => {
    notesStatus.textContent = "Live sync connected";
  };

  notesSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "note" && typeof msg.content === "string") {
        if (noteText.value !== msg.content) {
          noteText.value = msg.content;
        }
        notesStatus.textContent = `Live update: ${msg.updated_at || "now"}`;
      }
    } catch (_) {
      notesStatus.textContent = "Live sync received an invalid update";
    }
  };

  notesSocket.onclose = () => {
    notesStatus.textContent = "Live sync disconnected, retrying...";
    setTimeout(connectNoteSocket, 1500);
  };
}

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = Array.from(document.querySelectorAll(".panel"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const id = tab.dataset.tab;
      $(`tab-${id}`).classList.add("active");
    });
  });
}

function setupForms() {
  $("wiki-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("wiki-title").value.trim();
    if (!title) return;
    wikiResult.textContent = "Downloading and indexing...";
    try {
      const result = await api("/api/wiki/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      wikiResult.textContent = prettyJson(result);
      await refreshArticles();
    } catch (err) {
      wikiResult.textContent = `Error: ${err.message}`;
    }
  });

  $("search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("search-query").value.trim();
    const top_k = Number($("search-topk").value || 4);
    if (!query) return;
    searchResults.innerHTML = `<div class="item">Searching...</div>`;
    try {
      const result = await api("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k }),
      });
      renderItems(searchResults, result.results || [], (item) =>
        div(`
          <article class="item">
            <div class="item-title">${item.title} [chunk ${item.chunk_index}]</div>
            <div class="item-meta">score ${item.score.toFixed(4)}</div>
            <div>${short(item.text)}</div>
          </article>
        `)
      );
    } catch (err) {
      searchResults.innerHTML = `<div class="item">Error: ${err.message}</div>`;
    }
  });

  $("ask-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = $("ask-question").value.trim();
    const top_k = Number($("ask-topk").value || 4);
    if (!question) return;
    askAnswer.textContent = "Thinking...";
    askContexts.innerHTML = "";
    try {
      const result = await api("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, top_k }),
      });
      askAnswer.textContent = result.answer;
      renderItems(askContexts, result.contexts || [], (ctx) =>
        div(`
          <article class="item">
            <div class="item-title">${ctx.title} [chunk ${ctx.chunk_index}]</div>
            <div class="item-meta">score ${ctx.score.toFixed(4)}</div>
            <div>${short(ctx.text)}</div>
          </article>
        `)
      );
    } catch (err) {
      askAnswer.textContent = `Error: ${err.message}`;
    }
  });

  $("calendar-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      title: $("event-title").value.trim(),
      start_ts: $("event-start").value,
      end_ts: $("event-end").value,
      details: $("event-details").value.trim(),
    };
    await api("/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("calendar-form").reset();
    await refreshCalendar();
  });

  $("drive-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fileInput = $("drive-file");
    if (!fileInput.files || !fileInput.files.length) return;
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    await api("/api/drive/upload", { method: "POST", body: fd });
    fileInput.value = "";
    await refreshDrive();
  });

  $("save-note").addEventListener("click", async () => {
    const payload = { content: noteText.value };
    await api("/api/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    notesStatus.textContent = "Saved";
  });

  noteText.addEventListener("input", () => {
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (notesSocket && notesSocket.readyState === WebSocket.OPEN) {
        notesSocket.send(JSON.stringify({ type: "note", content: noteText.value }));
      }
    }, 300);
  });
}

async function init() {
  setupTabs();
  setupForms();
  connectNoteSocket();
  await Promise.all([refreshHealth(), refreshArticles(), refreshCalendar(), refreshDrive(), loadNote()]);
}

init().catch((err) => {
  setHealth(`Failed to initialize UI: ${err.message}`, false);
});

