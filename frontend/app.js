"use strict";

const API = window.API_BASE || (location.port === "3000" ? "/api" : location.origin);
const STATUS = {
  reading: "Reading",
  completed: "Completed",
  dropped: "Dropped",
  plan_to_read: "Need to read",
  continue: "Need to continue",
  paused: "Paused",
};
const TIERS = ["S", "A", "B", "C", "D"];
const VIEW_TITLES = {
  discover: "Discover novels",
  library: "Your library",
  tiers: "Your tier list",
  models: "What is NoveList?",
  analytics: "Reading analytics",
  community: "Community collections",
  account: "Reader profile",
  admin: "Catalogue administration",
  faq: "Frequently asked questions",
};
const VIEW_DESCRIPTIONS = {
  discover: "Search and filter the NoveList catalogue by title, author, premise, and exact tags.",
  library: "Manage saved novels and keep every reading state current.",
  tiers: "Edit a personal novel tier list and refine future tentative placements.",
  models: "Learn how local semantic search and personal tier suggestions work.",
  analytics: "Explore reading-state, ranking, taste, activity, and storage analytics.",
  community: "Follow reader tier lists, publish collections, reviews, and comments.",
  account: "View your reader profile, import a library, and manage account security.",
  admin: "Run controlled catalogue discovery and metadata collection jobs.",
  faq: "Answers about ranking, metadata, covers, requests, and reader data.",
};

const state = {
  user: null,
  token: localStorage.getItem("novellist-token") || "",
  items: [],
  activeStatus: "all",
  tierDisplay: localStorage.getItem("novellist-tier-display") || "title",
  resultLayout: localStorage.getItem("novellist-results-layout") || "grid",
  resultSort: localStorage.getItem("novellist-results-sort") || "recent",
  results: [],
  currentQuery: "",
  selectedTags: new Set(),
  catalogueTags: [],
  catalogueTotal: 0,
  page: 1,
  hasMore: false,
  loading: false,
  draggedId: null,
  reviewingNovelId: null,
  exactJobs: new Set(),
  lastCompletedDirectJob: 0,
  editingNovelId: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function setNotice(message = "", isError = false) {
  const target = $("#notice");
  target.textContent = message;
  target.dataset.state = isError ? "error" : "";
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(API + path, { ...options, headers });
  } catch {
    throw new Error(`Could not reach the service at ${API}. Check the server address and try again.`);
  }
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch { /* response had no JSON body */ }
    if (response.status === 401 && state.token) clearSession();
    const detail = Array.isArray(body.detail)
      ? body.detail.map((issue) => issue.msg || "Invalid input").join(" ")
      : body.detail;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function titleKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\b(light novel|webnovel|novel)\b/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function statusOptions(selected, allowUnsaved = false) {
  const placeholder = allowUnsaved ? `<option value="" ${selected ? "" : "selected"}>Save to collection</option>` : "";
  return placeholder + Object.entries(STATUS).map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function ratingOptions(selected) {
  return `<option value="">Rate</option>${[5, 4, 3, 2, 1].map((value) => `<option value="${value}" ${value === Number(selected) ? "selected" : ""}>${value} ${"★".repeat(value)}</option>`).join("")}`;
}

function coverMarkup(book, className = "cover") {
  const novelId = Number(book.novel_id || book.id || 0);
  const remote = book.cover_url || "";
  if (!remote && !book.cover_cached) return `<div class="${className} cover-empty" aria-label="Cover unavailable">${escapeHTML((book.title || "N")[0])}</div>`;
  const source = novelId ? `${API}/covers/${novelId}/proxy` : remote;
  return `<img class="${className} js-cover" data-source="${escapeHTML(source)}" data-novel-id="${novelId}" data-remote="${escapeHTML(remote)}" data-title="${escapeHTML(book.title || "Novel")}" alt="Cover of ${escapeHTML(book.title || "novel")}" loading="lazy" referrerpolicy="no-referrer">`;
}

function showMissingCover(image) {
  const remote = image.dataset.remote;
  if (remote && image.src !== remote && !image.dataset.triedRemote) {
    image.dataset.triedRemote = "true";
    image.src = remote;
    return;
  }
  const placeholder = document.createElement("div");
  placeholder.className = `${image.className.replace("js-cover", "")} cover-empty`;
  placeholder.setAttribute("aria-label", "Cover unavailable");
  placeholder.textContent = (image.dataset.title || "N")[0];
  image.replaceWith(placeholder);
}

const coverObserver = new IntersectionObserver((entries) => {
  entries.forEach(async (entry) => {
    if (!entry.isIntersecting) return;
    const image = entry.target;
    coverObserver.unobserve(image);
    const source = image.dataset.source;
    if (!state.token || !Number(image.dataset.novelId)) {
      image.src = source;
      return;
    }
    try {
      const response = await fetch(source, { headers: { Authorization: `Bearer ${state.token}` } });
      if (!response.ok) throw new Error("Cover unavailable");
      const objectUrl = URL.createObjectURL(await response.blob());
      image.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });
      image.src = objectUrl;
    } catch {
      showMissingCover(image);
    }
  });
}, { rootMargin: "300px" });

function bindCoverFallbacks(root = document) {
  $$("img.js-cover", root).forEach((image) => {
    image.addEventListener("error", () => showMissingCover(image));
    coverObserver.observe(image);
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("novellist-theme", theme);
  $("#theme").textContent = theme === "dark" ? "Light" : "Dark";
}

function initTheme() {
  const saved = localStorage.getItem("novellist-theme");
  setTheme(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("#theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
}

function currentView() {
  const requested = location.hash.slice(1).split("?")[0];
  return VIEW_TITLES[requested] ? requested : "discover";
}

function showView(viewName = currentView()) {
  if (viewName === "admin" && state.user?.role !== "admin") viewName = "discover";
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === viewName));
  $$("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === viewName));
  document.title = `${VIEW_TITLES[viewName]} | NoveList`;
  $('meta[name="description"]').setAttribute("content", VIEW_DESCRIPTIONS[viewName]);
  $('meta[property="og:title"]').setAttribute("content", `${VIEW_TITLES[viewName]} | NoveList`);
  $('meta[property="og:description"]').setAttribute("content", VIEW_DESCRIPTIONS[viewName]);
  if (viewName === "analytics") renderAnalytics();
  if (viewName === "community") renderCommunity();
  if (viewName === "account") renderAccount();
  if (viewName === "admin") refreshJobs();
}

function initRouting() {
  window.addEventListener("hashchange", () => showView());
  $$('a[href^="#"]').forEach((link) => link.addEventListener("click", () => {
    const target = link.getAttribute("href").slice(1);
    if (VIEW_TITLES[target]) setTimeout(() => showView(target));
  }));
  showView();
}

function updatePreview(data) {
  $("#demo-banner").hidden = !data.demo;
  const limited = Boolean(data.limited);
  $("#preview-banner").hidden = !limited;
  if (limited) {
    $("#preview-copy").textContent = `Previewing ${data.visible_total ?? data.total_indexed ?? data.novels ?? data.total} of ${data.catalogue_total} catalogue entries. Sign in to browse and search the full collection.`;
  }
}

async function refreshCatalogueStats() {
  try {
    const data = await request("/catalogue/stats");
    state.catalogueTotal = data.novels;
    updatePreview(data);
    if ($("#model-catalogue-size")) $("#model-catalogue-size").textContent = `${data.novels.toLocaleString()} ${data.limited ? "preview " : ""}records`;
  } catch {
    setNotice("Catalogue statistics are unavailable.", true);
  }
}

function setAbsoluteMetadata() {
  const origin = location.origin;
  $("#og-image").setAttribute("content", `${origin}/social-card.svg`);
  let canonical = $('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = `${origin}/`;
}

function resultSortForBrowse() {
  return ["recent", "title", "random"].includes(state.resultSort) ? state.resultSort : "recent";
}

function updateSelectedTags() {
  const target = $("#selected-tags");
  $("#filter-count").textContent = state.selectedTags.size ? `(${state.selectedTags.size})` : "";
  target.innerHTML = [...state.selectedTags].map((tag) => `<button type="button" data-remove-tag="${escapeHTML(tag)}">${escapeHTML(tag)} ×</button>`).join("");
  $$('[data-remove-tag]', target).forEach((button) => button.addEventListener("click", () => toggleTag(button.dataset.removeTag)));
  $$('[data-filter-tag]').forEach((button) => button.classList.toggle("active", state.selectedTags.has(button.dataset.filterTag)));
}

function renderTagCloud() {
  const query = $("#tag-query").value.trim().toLocaleLowerCase();
  const matching = query
    ? state.catalogueTags.filter((tag) => tag.name.toLocaleLowerCase().includes(query))
    : state.catalogueTags;
  const visible = matching.slice(0, query ? 80 : 40);
  const cloud = $("#tag-cloud");
  cloud.innerHTML = visible.length
    ? visible.map((tag) => `<button type="button" data-filter-tag="${escapeHTML(tag.name)}" style="--tag-weight:${tag.weight}" title="${tag.count.toLocaleString()} novels">${escapeHTML(tag.name)} <small>${tag.count}</small></button>`).join("")
    : '<span class="subtle">No tags found.</span>';
  $("#tag-summary").textContent = query
    ? `${matching.length.toLocaleString()} matching tags`
    : `Showing ${visible.length} of ${state.catalogueTags.length.toLocaleString()} tags. Search for more.`;
  $$('[data-filter-tag]', cloud).forEach((button) => button.addEventListener("click", () => toggleTag(button.dataset.filterTag)));
  updateSelectedTags();
}

async function loadTags() {
  try {
    const data = await request("/catalogue/tags");
    state.catalogueTags = data.tags;
    renderTagCloud();
  } catch (error) {
    $("#tag-cloud").textContent = error.message;
  }
}

function toggleTag(tag) {
  if (state.selectedTags.has(tag)) state.selectedTags.delete(tag); else state.selectedTags.add(tag);
  updateSelectedTags();
  if (state.currentQuery) runSearch(true); else loadCatalogue(true);
}

async function loadCatalogue(reset = false) {
  if (state.loading) return;
  if (currentView() !== "discover") {
    location.hash = "#discover";
    showView("discover");
  }
  if (reset) {
    state.page = 1;
    state.results = [];
    state.currentQuery = "";
    state.resultSort = resultSortForBrowse();
    $("#result-sort").value = state.resultSort;
    $("#query").value = "";
    $("#results").innerHTML = '<div class="skeleton-grid"><div></div><div></div><div></div></div>';
  }
  state.loading = true;
  updatePagination();
  try {
    const params = new URLSearchParams({ page: state.page, page_size: 40, sort: resultSortForBrowse() });
    state.selectedTags.forEach((tag) => params.append("tags", tag));
    const data = await request(`/catalogue?${params}`);
    state.results = reset ? data.items : mergeUnique(state.results, data.items);
    state.catalogueTotal = data.total;
    updatePreview(data);
    state.hasMore = data.has_more;
    $("#results-title").textContent = state.selectedTags.size ? "Filtered catalogue" : "Latest in the catalogue";
    $("#results-count").textContent = `${data.total.toLocaleString()} novels${state.selectedTags.size ? " match every selected tag" : ""}`;
    renderResults();
  } catch (error) {
    setNotice(error.message, true);
    if (reset) $("#results").innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  } finally {
    state.loading = false;
    updatePagination();
  }
}

async function runSearch(reset = true) {
  const query = $("#query").value.trim();
  if (!query) return loadCatalogue(true);
  if (state.loading) return;
  if (currentView() !== "discover") {
    location.hash = "#discover";
    showView("discover");
  }
  if (reset) {
    if (query !== state.currentQuery) {
      state.resultSort = "relevance";
      $("#result-sort").value = "relevance";
    }
    state.page = 1;
    state.results = [];
    state.currentQuery = query;
    $("#results").innerHTML = '<div class="skeleton-grid"><div></div><div></div><div></div></div>';
  }
  state.loading = true;
  $("#search").disabled = true;
  setNotice("Searching the catalogue");
  updatePagination();
  try {
    const data = await request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: 600, page: state.page, page_size: 30, tags: [...state.selectedTags] }),
    });
    state.results = reset ? data.results : mergeUnique(state.results, data.results);
    state.hasMore = data.has_more;
    updatePreview(data);
    $("#results-title").textContent = `Results for “${query}”`;
    $("#results-count").textContent = `${state.results.length.toLocaleString()} shown from ${data.total_indexed.toLocaleString()} catalogue entries`;
    renderResults();
    setNotice(data.results.length ? "" : "No matching catalogue entries yet.");
    if (reset) maybeStartExactDiscovery(query, data.results);
  } catch (error) {
    setNotice(error.message, true);
    if (reset) $("#results").innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  } finally {
    state.loading = false;
    $("#search").disabled = false;
    updatePagination();
  }
}

function mergeUnique(existing, incoming) {
  const byId = new Map(existing.map((book) => [book.novel_id || book.id, book]));
  incoming.forEach((book) => byId.set(book.novel_id || book.id, book));
  return [...byId.values()];
}

function maybeStartExactDiscovery(query, results) {
  const queryKey = titleKey(query);
  const exact = results.some((book) => [book.title, ...(book.title_aliases || [])].some((title) => titleKey(title) === queryKey));
  if (exact) return;
  const end = $("#catalogue-end");
  if (state.user?.role === "admin") {
    end.innerHTML = `<button id="exact-action" class="text-button" type="button">Search external metadata sources for “${escapeHTML(query)}”</button>`;
    $("#exact-action").addEventListener("click", () => queueExactTitle(query));
    if (!state.exactJobs.has(queryKey)) queueExactTitle(query);
  } else {
    end.innerHTML = `<button id="exact-action" class="text-button" type="button">Request this exact title for the catalogue</button>`;
    $("#exact-action").addEventListener("click", () => requestExactTitle(query));
  }
}

async function queueExactTitle(title) {
  const key = titleKey(title);
  if (state.exactJobs.has(key)) return;
  state.exactJobs.add(key);
  try {
    const data = await request("/admin/discover-title", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    if (data.status === "already_indexed") {
      setNotice(`${data.novel.title} is already in the catalogue.`);
    } else {
      setNotice(`Exact-title job #${data.job_id} started. Related series titles will be checked too.`);
      refreshJobs();
    }
    return data;
  } catch (error) {
    state.exactJobs.delete(key);
    setNotice(error.message, true);
    return null;
  }
}

async function requestExactTitle(title) {
  if (!state.user) return openLogin();
  try {
    await request("/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: title, note: "Requested from Discover exact-title search" }) });
    setNotice(`Request sent for ${title}.`);
  } catch (error) { setNotice(error.message, true); }
}

function displayResults() {
  if (state.currentQuery && state.resultSort === "title") return [...state.results].sort((a, b) => a.title.localeCompare(b.title));
  if (state.currentQuery && state.resultSort === "recent") return [...state.results].sort((a, b) => Number(b.novel_id || b.id) - Number(a.novel_id || a.id));
  if (state.currentQuery && state.resultSort === "random") return [...state.results].sort((a, b) => ((Number(a.novel_id || a.id) * 2654435761) >>> 0) - ((Number(b.novel_id || b.id) * 2654435761) >>> 0));
  return state.results;
}

function renderResults() {
  const target = $("#results");
  target.className = `results ${state.resultLayout}`;
  const books = displayResults();
  if (!books.length) {
    target.innerHTML = state.catalogueTotal === 0
      ? '<div class="empty">The catalogue is empty. An administrator can add records from the Admin tab.</div>'
      : '<div class="empty">No catalogue entries match this search and tag combination.</div>';
    updatePagination();
    return;
  }
  const saved = new Map(state.items.map((item) => [item.novel_id, item]));
  target.innerHTML = books.map((book) => {
    const novelId = book.novel_id || book.id;
    const savedItem = saved.get(novelId);
    const sources = (book.urls || []).slice(0, 2).map((link) => `<a class="source" href="${escapeHTML(link.url)}" target="_blank" rel="noreferrer">${escapeHTML(link.site || "Source")} ↗</a>`).join("");
    const reason = book.reason || (state.currentQuery ? "Metadata match" : "Recently added to the catalogue");
    return `<article class="result" data-novel-id="${novelId}">
      ${coverMarkup(book)}
      <div class="result-main">
        <div class="result-top"><h3 class="result-title">${escapeHTML(book.title)}</h3></div>
        ${(book.title_aliases || []).length ? `<div class="alias">Also known as ${escapeHTML(book.title_aliases.slice(0, 2).join(" · "))}</div>` : ""}
        ${book.author ? `<div class="author">${escapeHTML(book.author)}</div>` : ""}
        <div class="reason">${escapeHTML(reason)}</div>
        <div class="chips">${(book.tags || []).slice(0, 8).map((tag) => `<button class="chip" type="button" data-result-tag="${escapeHTML(tag)}">${escapeHTML(tag)}</button>`).join("")}</div>
        <div class="result-actions">
          <select data-auto-status="${novelId}" aria-label="Save or change reading status">${statusOptions(savedItem?.status || "", !savedItem)}</select>
          <select data-auto-rating="${novelId}" aria-label="Personal rating">${ratingOptions(savedItem?.personal_rating)}</select>
          <button class="small-button" type="button" data-review="${novelId}">Reviews</button>${state.user?.role === "admin" ? `<button class="small-button" type="button" data-edit-book="${novelId}">Edit</button>` : ""}${sources}
        </div>
        ${book.synopsis ? `<details><summary>Description</summary><p>${escapeHTML(book.synopsis)}</p></details>` : ""}
      </div>
    </article>`;
  }).join("");
  bindCoverFallbacks(target);
  $$('[data-result-tag]', target).forEach((button) => button.addEventListener("click", () => toggleTag(button.dataset.resultTag)));
  $$('[data-auto-status]', target).forEach((select) => select.addEventListener("change", () => {
    if (!select.value) return;
    const novelId = Number(select.dataset.autoStatus);
    autoSaveResult(novelId, { status: select.value }, select);
  }));
  $$('[data-auto-rating]', target).forEach((select) => select.addEventListener("change", () => {
    if (!select.value) return;
    autoSaveResult(Number(select.dataset.autoRating), { rating: Number(select.value) }, select);
  }));
  $$('[data-review]', target).forEach((button) => button.addEventListener("click", () => openReviews(Number(button.dataset.review))));
  $$('[data-edit-book]', target).forEach((button) => button.addEventListener("click", () => openBookEditor(Number(button.dataset.editBook))));
  updatePagination();
}

function updatePagination() {
  const button = $("#load-more");
  button.hidden = !state.hasMore;
  button.disabled = state.loading;
  button.textContent = state.loading ? "Loading" : "Load more";
  if (!state.hasMore && state.results.length && !$("#catalogue-end").querySelector("button")) $("#catalogue-end").textContent = "End of results";
  if (state.hasMore) $("#catalogue-end").textContent = "";
}

async function loadNextPage() {
  if (!state.hasMore || state.loading) return;
  state.page += 1;
  if (state.currentQuery) await runSearch(false); else await loadCatalogue(false);
}

function initResultControls() {
  const layout = $("#result-view");
  $$('[data-result-layout]', layout).forEach((button) => {
    button.classList.toggle("active", button.dataset.resultLayout === state.resultLayout);
    button.addEventListener("click", () => {
      state.resultLayout = button.dataset.resultLayout;
      localStorage.setItem("novellist-results-layout", state.resultLayout);
      $$('[data-result-layout]', layout).forEach((control) => control.classList.toggle("active", control === button));
      renderResults();
    });
  });
  const sort = $("#result-sort");
  sort.value = state.resultSort;
  sort.addEventListener("change", () => {
    state.resultSort = sort.value;
    localStorage.setItem("novellist-results-sort", state.resultSort);
    if (state.currentQuery) renderResults(); else loadCatalogue(true);
  });
}

async function autoSaveResult(novelId, changes, control) {
  if (!state.user) {
    renderResults();
    return openLogin();
  }
  const book = state.results.find((item) => Number(item.novel_id || item.id) === novelId);
  if (!book) return;
  control.disabled = true;
  try {
    await request(`/collection/${novelId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
    await refreshLibrary();
    setNotice(changes.rating ? `${book.title} rated ${changes.rating}/5 and saved.` : `${book.title} saved to ${STATUS[changes.status]}.`);
  } catch (error) {
    control.disabled = false;
    setNotice(error.message, true);
  }
}

async function refreshLibrary() {
  if (!state.user) {
    state.items = [];
    drawLibrary();
    drawTierboard();
    return;
  }
  try {
    const data = await request("/collection");
    state.items = data.items;
    drawLibrary();
    drawTierboard();
    if (state.results.length) renderResults();
  } catch (error) { setNotice(error.message, true); }
}

function drawLibrary() {
  const filters = $("#filters");
  filters.innerHTML = [["all", "All"], ...Object.entries(STATUS)].map(([value, label]) => `<button class="${state.activeStatus === value ? "active" : ""}" type="button" data-status-filter="${value}">${label}</button>`).join("");
  $$('[data-status-filter]', filters).forEach((button) => button.addEventListener("click", () => {
    state.activeStatus = button.dataset.statusFilter;
    drawLibrary();
  }));
  const target = $("#books");
  if (!state.user) {
    target.innerHTML = '<div class="empty">Sign in to start a personal library.</div>';
    return;
  }
  const visible = state.activeStatus === "all" ? state.items : state.items.filter((item) => item.status === state.activeStatus);
  if (!visible.length) {
    target.innerHTML = '<div class="empty">No saved novels in this reading state.</div>';
    return;
  }
  target.innerHTML = visible.map((item) => `<article class="library-book">
    ${coverMarkup(item)}
    <div><h3>${escapeHTML(item.title)}</h3><p>${item.tier_source === "suggested" ? `Suggested ${item.tier} tier` : item.tier ? `Tier ${item.tier}` : "Not placed"}</p>
    ${item.tier_source === "suggested" && item.prediction_reason ? `<p>${escapeHTML(item.prediction_reason)}</p>` : ""}
    <div class="book-controls"><select data-library-status="${item.novel_id}">${statusOptions(item.status)}</select><select data-library-rating="${item.novel_id}" aria-label="Personal rating">${ratingOptions(item.personal_rating)}</select>${item.tier_source === "suggested" ? `<button class="small-button" data-confirm-tier="${item.novel_id}" type="button">Confirm</button>` : ""}</div></div>
    ${item.cover_url && !item.cover_cached ? `<button class="cache-button" data-cache-cover="${item.novel_id}" type="button">Cache cover</button>` : ""}
  </article>`).join("");
  bindCoverFallbacks(target);
  $$('[data-library-status]', target).forEach((select) => select.addEventListener("change", () => updateStatus(Number(select.dataset.libraryStatus), select.value)));
  $$('[data-library-rating]', target).forEach((select) => select.addEventListener("change", () => {
    if (select.value) updateLibraryItem(Number(select.dataset.libraryRating), { rating: Number(select.value) }, "Personal rating updated.");
  }));
  $$('[data-confirm-tier]', target).forEach((button) => button.addEventListener("click", () => confirmTier(Number(button.dataset.confirmTier))));
  $$('[data-cache-cover]', target).forEach((button) => button.addEventListener("click", () => cacheCover(Number(button.dataset.cacheCover), button)));
}

async function updateStatus(novelId, status) {
  return updateLibraryItem(novelId, { status }, "Reading state updated.");
}

async function updateLibraryItem(novelId, changes, successMessage) {
  try {
    await request(`/collection/${novelId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
    await refreshLibrary();
    setNotice(successMessage);
  } catch (error) { setNotice(error.message, true); }
}

async function confirmTier(novelId) {
  try {
    await request(`/collection/${novelId}/tier`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm_prediction: true }) });
    await refreshLibrary();
    setNotice("Placement confirmed and added to your ranking feedback.");
  } catch (error) { setNotice(error.message, true); }
}

async function cacheCover(novelId, button) {
  button.disabled = true;
  button.textContent = "Caching";
  try {
    await request(`/collection/${novelId}/cover/cache`, { method: "POST" });
    await refreshLibrary();
    refreshCatalogueStats();
    setNotice("Cover cached locally.");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Cache cover";
    setNotice(error.message, true);
  }
}

function drawTierboard() {
  const controls = $("#tier-view");
  $$('[data-display]', controls).forEach((button) => {
    button.classList.toggle("active", button.dataset.display === state.tierDisplay);
    button.onclick = () => {
      state.tierDisplay = button.dataset.display;
      localStorage.setItem("novellist-tier-display", state.tierDisplay);
      drawTierboard();
    };
  });
  const target = $("#tierboard");
  if (!state.user) {
    target.innerHTML = '<div class="empty">Sign in to arrange your tier list.</div>';
    return;
  }
  if (!state.items.some((item) => item.tier)) {
    target.innerHTML = '<div class="empty">Save a novel to receive its first tentative placement.</div>';
    return;
  }
  target.innerHTML = TIERS.map((tier) => `<div class="tier-row" data-tier="${tier}"><div class="tier-label">${tier}</div><div class="dropzone" data-tier="${tier}">${state.items.filter((item) => item.tier === tier).sort((a, b) => (a.tier_position ?? 0) - (b.tier_position ?? 0)).map(tierCardMarkup).join("")}</div></div>`).join("");
  bindCoverFallbacks(target);
  bindTierDragAndDrop(target);
}

function tierCardMarkup(item) {
  const coverMode = state.tierDisplay === "cover";
  return `<div class="tier-card ${coverMode ? "cover-mode" : ""}" draggable="true" data-tier-card="${item.novel_id}" title="Drag to rank ${escapeHTML(item.title)}">
    ${coverMarkup(item)}<span class="card-name">${escapeHTML(item.title)}${item.tier_source === "suggested" ? '<br><span class="suggested">tentative placement</span>' : ""}</span><select class="tier-quick" data-quick-tier="${item.novel_id}" aria-label="Move ${escapeHTML(item.title)} to tier">${TIERS.map((tier) => `<option value="${tier}" ${tier === item.tier ? "selected" : ""}>${tier}</option>`).join("")}</select>
  </div>`;
}

function bindTierDragAndDrop(root) {
  $$('[data-quick-tier]', root).forEach((select) => select.addEventListener("change", () => quickMoveTier(Number(select.dataset.quickTier), select.value)));
  $$('[data-tier-card]', root).forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      state.draggedId = Number(card.dataset.tierCard);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(state.draggedId));
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    card.addEventListener("dragend", () => {
      state.draggedId = null;
      $$(".dragging,.drag-over", root).forEach((element) => element.classList.remove("dragging", "drag-over"));
    });
  });
  $$(".dropzone", root).forEach((zone) => {
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("drag-over");
      const moving = $(`[data-tier-card="${state.draggedId}"]`, root);
      if (!moving) return;
      const siblings = $$('[data-tier-card]:not(.dragging)', zone);
      const after = siblings.find((card) => event.clientX < card.getBoundingClientRect().left + card.offsetWidth / 2);
      zone.insertBefore(moving, after || null);
    });
    zone.addEventListener("dragleave", (event) => { if (!zone.contains(event.relatedTarget)) zone.classList.remove("drag-over"); });
    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      zone.classList.remove("drag-over");
      const novelId = state.draggedId || Number(event.dataTransfer.getData("text/plain"));
      if (!novelId) return;
      const order = $$('[data-tier-card]', zone).map((card) => Number(card.dataset.tierCard));
      try {
        await request(`/collection/${novelId}/move`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: zone.dataset.tier, ordered_novel_ids: order }) });
        await refreshLibrary();
        setNotice("Tier list updated. The move now informs future placements.");
      } catch (error) {
        await refreshLibrary();
        setNotice(error.message, true);
      }
    });
  });
}

async function quickMoveTier(novelId, tier) {
  const order = state.items.filter((item) => item.tier === tier && item.novel_id !== novelId).sort((a, b) => (a.tier_position ?? 0) - (b.tier_position ?? 0)).map((item) => item.novel_id);
  order.push(novelId);
  try {
    await request(`/collection/${novelId}/move`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, ordered_novel_ids: order }) });
    await refreshLibrary();
    setNotice("Tier updated and recorded as ranking feedback.");
  } catch (error) {
    await refreshLibrary();
    setNotice(error.message, true);
  }
}

function metricCard(label, value, hint = "") {
  return `<article class="metric-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong>${hint ? `<small class="subtle">${escapeHTML(hint)}</small>` : ""}</article>`;
}

function barChart(values, labels = {}) {
  const entries = Object.entries(values || {});
  const highest = Math.max(...entries.map(([, value]) => value), 1);
  return `<div class="bar-chart">${entries.map(([key, value]) => `<div class="bar-row"><span>${escapeHTML(labels[key] || key)}</span><div class="bar-track"><div class="bar-value" style="width:${(value / highest) * 100}%"></div></div><strong>${value}</strong></div>`).join("")}</div>`;
}

async function renderAnalytics() {
  const target = $("#analytics-content");
  if (!state.user) {
    target.innerHTML = '<div class="empty">Sign in to view reader analytics.</div>';
    $("#storage").textContent = "";
    return;
  }
  target.innerHTML = '<div class="skeleton wide"></div>';
  try {
    const [data, storage] = await Promise.all([request("/analytics"), request("/storage")]);
    const storageEntries = [["Catalogue", storage.catalogue], ["Covers", storage.covers], ["Index", storage.index], ["Models", storage.models], ["Library", storage.library]];
    const total = Math.max(storage.total, .01);
    target.innerHTML = `<div class="analytics-grid">
      ${metricCard("Saved novels", data.library_count, `${data.active_count} currently active`)}
      ${metricCard("Completion rate", `${data.completion_rate}%`, `${data.status_counts.completed || 0} completed`)}
      ${metricCard("Taste signals", data.feedback_count, "Ratings and direct placements")}
      ${metricCard("Activity events", data.event_count, "Reading and ranking changes")}
    </div><div class="chart-grid">
      <article class="chart-panel"><h2>Reading states</h2>${barChart(data.status_counts, STATUS)}</article>
      <article class="chart-panel"><h2>Tier distribution</h2>${barChart(data.tier_counts)}</article>
      <article class="chart-panel"><h2>Favourite signals</h2><div class="taste-tags">${(data.favorite_tags || []).map((tag) => `<span>${escapeHTML(tag)}</span>`).join("") || '<span>Confirm more placements to build this view</span>'}</div><h2 style="margin-top:24px">Frequently saved authors</h2><div class="taste-tags">${(data.authors || []).map((author) => `<span>${escapeHTML(author)}</span>`).join("") || '<span>No author signal yet</span>'}</div></article>
      <article class="chart-panel"><h2>Local storage</h2><div class="storage-stack">${storageEntries.map(([, value]) => `<span style="width:${Math.max(1, value / total * 100)}%"></span>`).join("")}</div><div class="storage-legend">${storageEntries.map(([label, value]) => `<span>${label} ${value} MB</span>`).join("")}</div></article>
    </div>`;
    $("#storage").textContent = `${storage.total} MB total local footprint`;
  } catch (error) {
    target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

async function renderAccount() {
  const target = $("#account-summary");
  if (!state.user) {
    target.innerHTML = '<div class="empty">Sign in to view your profile and account controls.</div>';
    return;
  }
  try {
    const data = await request("/profile");
    target.innerHTML = `<article class="profile-card"><div class="profile-avatar">${escapeHTML(state.user.username[0].toUpperCase())}</div><h2>${escapeHTML(state.user.username)}</h2><p class="subtle">${escapeHTML(state.user.role)} account</p><div class="taste-tags">${(data.favorite_tags || []).map((tag) => `<span>${escapeHTML(tag)}</span>`).join("") || "No favourite tags yet"}</div></article>
      <article class="chart-panel"><h2>Public reading summary</h2><div class="analytics-grid">${metricCard("Saved", data.library_count)}${metricCard("Taste signals", data.feedback_count)}${metricCard("Events", data.event_count)}${metricCard("S tier", data.tier_counts.S || 0)}</div><div style="margin-top:18px">${barChart(data.status_counts, STATUS)}</div></article>`;
  } catch (error) { target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`; }
}

async function openReviews(novelId) {
  state.reviewingNovelId = novelId;
  const book = state.results.find((item) => Number(item.novel_id || item.id) === novelId) || state.items.find((item) => item.novel_id === novelId);
  $("#review-title").textContent = book ? `Reviews of ${book.title}` : "Reviews";
  $("#review-list").innerHTML = '<p class="subtle">Loading reviews</p>';
  $("#review-form").hidden = !state.user;
  openModal("review-modal");
  try {
    const data = await request(`/novels/${novelId}/reviews`);
    $("#review-list").innerHTML = (data.reviews.length ? data.reviews.map((review) => `<article class="review-entry"><strong>${escapeHTML(review.username)}${review.rating ? ` · ${review.rating}/5` : ""}</strong><small> · ${escapeHTML(review.created_at)}</small><p>${escapeHTML(review.body)}</p></article>`).join("") : '<p class="subtle">No reviews yet.</p>') + (!state.user ? '<button id="review-login" class="outline-button" type="button">Sign in to write a review</button>' : "");
    $("#review-login")?.addEventListener("click", () => { closeModal("review-modal"); openLogin(); });
  } catch (error) { $("#review-list").textContent = error.message; }
}

async function submitReview(event) {
  event.preventDefault();
  if (!state.reviewingNovelId) return;
  try {
    await request(`/novels/${state.reviewingNovelId}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: $("#review-body").value, rating: $("#review-rating").value ? Number($("#review-rating").value) : null }) });
    event.target.reset();
    await openReviews(state.reviewingNovelId);
    setNotice("Review posted.");
  } catch (error) { setNotice(error.message, true); }
}

async function renderCommunity() {
  const target = $("#shared-collections");
  try {
    const data = await request("/shared-collections");
    target.innerHTML = data.collections.length ? data.collections.map((collection) => `<article class="collection-card"><h2>${escapeHTML(collection.name)}</h2><button class="text-button byline" data-reader="${escapeHTML(collection.username)}" type="button">by ${escapeHTML(collection.username)}</button><p>${escapeHTML(collection.description || "A reader-made collection")}</p><div class="collection-actions"><button class="small-button" data-open-collection="${collection.id}" type="button">Open tier list</button><button class="small-button" data-follow-collection="${collection.id}" data-following="${collection.following ? "true" : "false"}" type="button">${collection.following ? "Unfollow" : "Follow"} · ${collection.followers}</button></div></article>`).join("") : '<div class="empty">No public collections yet. Create the first one.</div>';
    $$('[data-open-collection]', target).forEach((button) => button.addEventListener("click", () => openCollection(Number(button.dataset.openCollection))));
    $$('[data-follow-collection]', target).forEach((button) => button.addEventListener("click", () => followCollection(Number(button.dataset.followCollection), button.dataset.following !== "true")));
    $$('[data-reader]', target).forEach((button) => button.addEventListener("click", () => openReaderProfile(button.dataset.reader)));
  } catch (error) { target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`; }
}

async function createSharedCollection(event) {
  event.preventDefault();
  if (!state.user) return openLogin();
  try {
    await request("/shared-collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#collection-name").value, description: $("#collection-description").value, visibility: "public" }) });
    event.target.reset();
    await renderCommunity();
    setNotice("Collection created.");
  } catch (error) { setNotice(error.message, true); }
}

async function followCollection(collectionId, following) {
  if (!state.user) return openLogin();
  try {
    await request(`/shared-collections/${collectionId}/follow`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ following }) });
    await renderCommunity();
    setNotice(following ? "Collection followed." : "Collection unfollowed.");
  } catch (error) { setNotice(error.message, true); }
}

async function openCollection(collectionId) {
  openModal("collection-modal");
  const target = $("#collection-detail");
  target.innerHTML = '<div class="skeleton wide"></div>';
  try {
    const [collection, comments] = await Promise.all([request(`/shared-collections/${collectionId}`), request(`/shared-collections/${collectionId}/comments`)]);
    const savedOptions = state.items.map((item) => `<option value="${item.novel_id}">${escapeHTML(item.title)}</option>`).join("");
    target.innerHTML = `<p class="eyebrow">Community tier list</p><h2>${escapeHTML(collection.name)}</h2><p class="subtle">by ${escapeHTML(collection.username)} · ${collection.followers} followers</p><p>${escapeHTML(collection.description)}</p>
      ${collection.items.length ? `<div class="tierboard shared-tierboard">${TIERS.map((tier) => `<div class="tier-row" data-tier="${tier}"><div class="tier-label">${tier}</div><div class="dropzone" data-shared-zone="${tier}">${collection.items.filter((book) => (book.tier || "C") === tier).sort((a,b) => a.position-b.position).map((book) => `<article class="collection-detail-book" ${state.user?.id===collection.user_id?'draggable="true"':''} data-shared-card="${book.novel_id}">${coverMarkup(book)}<strong>${escapeHTML(book.title)}</strong></article>`).join("")}</div></div>`).join("")}</div>` : '<div class="empty">No novels have been added yet.</div>'}
      ${state.user?.id === collection.user_id ? `<div class="collection-actions" style="margin-top:12px"><select id="collection-item-select">${savedOptions || '<option value="">Save a novel first</option>'}</select><button id="add-collection-item" class="small-button" type="button">Add saved novel</button></div>` : ""}
      <h3>Comments</h3><div class="comment-list">${comments.comments.length ? comments.comments.map((comment) => `<div class="comment"><strong>${escapeHTML(comment.username)}</strong> ${escapeHTML(comment.body)}</div>`).join("") : '<p class="subtle">No comments yet.</p>'}</div>
      <form id="collection-comment-form" class="collection-actions" style="margin-top:10px"><input id="collection-comment" maxlength="2000" required placeholder="Add to the discussion"><button class="small-button" type="submit">Comment</button></form>`;
    bindCoverFallbacks(target);
    if (state.user?.id === collection.user_id) bindSharedTierDrag(collectionId);
    $("#add-collection-item")?.addEventListener("click", () => addCollectionItem(collectionId));
    $("#collection-comment-form").addEventListener("submit", (event) => submitCollectionComment(event, collectionId));
  } catch (error) { target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`; }
}

function bindSharedTierDrag(collectionId) {
  let movingId = null;
  $$('[data-shared-card]').forEach((card) => {
    card.addEventListener("dragstart", (event) => { movingId=Number(card.dataset.sharedCard); event.dataTransfer.setData("text/plain",String(movingId)); requestAnimationFrame(() => card.classList.add("dragging")); });
    card.addEventListener("dragend", () => { movingId=null; card.classList.remove("dragging"); $$(".drag-over").forEach((zone) => zone.classList.remove("drag-over")); });
  });
  $$('[data-shared-zone]').forEach((zone) => {
    zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("drag-over"); const moving=$(`[data-shared-card="${movingId}"]`); if (!moving) return; const after=$$('[data-shared-card]:not(.dragging)',zone).find((card) => event.clientX < card.getBoundingClientRect().left + card.offsetWidth/2); zone.insertBefore(moving,after||null); });
    zone.addEventListener("drop", async (event) => { event.preventDefault(); const novelId=movingId||Number(event.dataTransfer.getData("text/plain")); const order=$$('[data-shared-card]',zone).map((card)=>Number(card.dataset.sharedCard)); try { await request(`/shared-collections/${collectionId}/items/${novelId}/move`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({tier:zone.dataset.sharedZone,ordered_novel_ids:order})}); await openCollection(collectionId); setNotice("Collection tier list updated."); } catch(error) { await openCollection(collectionId); setNotice(error.message,true); } });
  });
}

async function addCollectionItem(collectionId) {
  const novelId = Number($("#collection-item-select").value);
  if (!novelId) return;
  try {
    await request(`/shared-collections/${collectionId}/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ novel_id: novelId }) });
    await openCollection(collectionId);
    setNotice("Novel added to the collection.");
  } catch (error) { setNotice(error.message, true); }
}

async function submitCollectionComment(event, collectionId) {
  event.preventDefault();
  if (!state.user) return openLogin();
  try {
    await request(`/shared-collections/${collectionId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: $("#collection-comment").value }) });
    await openCollection(collectionId);
    setNotice("Comment posted.");
  } catch (error) { setNotice(error.message, true); }
}

async function openReaderProfile(username) {
  openModal("collection-modal");
  const target = $("#collection-detail");
  target.innerHTML = '<div class="skeleton wide"></div>';
  try {
    const data = await request(`/profiles/${encodeURIComponent(username)}`);
    target.innerHTML = `<p class="eyebrow">Reader profile</p><h2>${escapeHTML(data.username)}</h2><p class="subtle">${data.library_count} saved novels</p><div class="taste-tags">${data.favorite_tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join("")}</div><h3>S-tier favourites</h3><div class="collection-detail-grid">${data.favorites.length ? data.favorites.map((book) => `<article class="collection-detail-book">${coverMarkup(book)}<strong>${escapeHTML(book.title)}</strong></article>`).join("") : '<div class="empty">No confirmed public favourites yet.</div>'}</div>`;
    bindCoverFallbacks(target);
  } catch (error) { target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`; }
}

async function submitNovelRequest() {
  const title = $("#request-title").value.trim();
  if (!title) return $("#request-title").focus();
  if (!state.user) return openLogin();
  try {
    await request("/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: title, note: "Requested from Community" }) });
    $("#request-title").value = "";
    setNotice("Catalogue request sent.");
  } catch (error) { setNotice(error.message, true); }
}

async function refreshJobs() {
  if (state.user?.role !== "admin") return;
  try {
    const [jobs, requests] = await Promise.all([request("/admin/scrapes"), request("/admin/requests")]);
    const jobRows = jobs.jobs.map((job) => `<div class="job-row"><strong>#${job.id} ${escapeHTML(job.source)}</strong><span>${escapeHTML(job.status)}</span><code>${escapeHTML(job.detail || "Queued")}</code></div>`).join("");
    const requested = requests.requests.slice(0, 12).map((item) => `<div class="job-row"><strong>${escapeHTML(item.username)}</strong><span>${escapeHTML(item.status)}</span><div><code>${escapeHTML(item.query)}${item.note ? `\n${escapeHTML(item.note)}` : ""}</code>${item.status === "open" ? `<div class="collection-actions"><button class="small-button" data-collect-request="${item.id}" data-request-title="${escapeHTML(item.query)}" type="button">Collect</button><button class="small-button" data-close-request="${item.id}" type="button">Decline</button></div>` : item.status === "collecting" ? `<button class="small-button" data-resolve-request="${item.id}" type="button">Resolve</button>` : ""}</div></div>`).join("");
    $("#scrape-jobs").innerHTML = `<h2>Recent jobs</h2>${jobRows || '<p class="subtle">No jobs yet.</p>'}<h2>Reader requests</h2>${requested || '<p class="subtle">No open requests.</p>'}`;
    $$('[data-collect-request]', $("#scrape-jobs")).forEach((button) => button.addEventListener("click", () => collectRequestedTitle(Number(button.dataset.collectRequest), button.dataset.requestTitle)));
    $$('[data-close-request]', $("#scrape-jobs")).forEach((button) => button.addEventListener("click", () => setRequestStatus(Number(button.dataset.closeRequest), "declined")));
    $$('[data-resolve-request]', $("#scrape-jobs")).forEach((button) => button.addEventListener("click", () => setRequestStatus(Number(button.dataset.resolveRequest), "resolved")));
    const completedDirect = jobs.jobs.find((job) => job.source === "direct_search" && job.status === "completed");
    if (completedDirect && completedDirect.id > state.lastCompletedDirectJob) {
      state.lastCompletedDirectJob = completedDirect.id;
      if (state.currentQuery) {
        setNotice("Exact-title collection completed. Refreshing the search.");
        runSearch(true);
      }
    }
    refreshCatalogueStats();
  } catch (error) { setNotice(error.message, true); }
}

async function setRequestStatus(requestId, status) {
  try {
    await request(`/admin/requests/${requestId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    await refreshJobs();
    setNotice(`Catalogue request marked ${status}.`);
  } catch (error) { setNotice(error.message, true); }
}

async function collectRequestedTitle(requestId, title) {
  const job = await queueExactTitle(title);
  if (!job) return;
  await setRequestStatus(requestId, job.status === "already_indexed" ? "resolved" : "collecting");
}

async function startScrape(event) {
  event.preventDefault();
  try {
    const data = await request("/admin/scrapes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: $("#scrape-source").value, limit: Number($("#scrape-limit").value) }) });
    setNotice(`Collection job #${data.job_id} queued.`);
    refreshJobs();
  } catch (error) { setNotice(error.message, true); }
}

async function startCustomScrape(event) {
  event.preventDefault();
  const sourceUrl = $("#custom-source-url").value.trim();
  if (!sourceUrl) return;
  try {
    const data = await request("/admin/scrapes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "custom", source_url: sourceUrl, limit: 1 }),
    });
    event.target.reset();
    setNotice(`Metadata job #${data.job_id} queued.`);
    refreshJobs();
  } catch (error) { setNotice(error.message, true); }
}

function resetBookEditor() {
  state.editingNovelId = null;
  $("#catalogue-editor").reset();
  $("#editor-record-id").textContent = "New record";
}

function openBookEditor(novelId) {
  if (state.user?.role !== "admin") return;
  const book = state.results.find((item) => Number(item.novel_id || item.id) === novelId)
    || state.items.find((item) => Number(item.novel_id) === novelId);
  if (!book) return setNotice("Reload the catalogue before editing this record.", true);
  state.editingNovelId = novelId;
  $("#editor-record-id").textContent = `Record #${novelId}`;
  $("#editor-title").value = book.title || "";
  $("#editor-aliases").value = (book.title_aliases || []).join("\n");
  $("#editor-author").value = book.author || "";
  $("#editor-synopsis").value = book.synopsis || "";
  $("#editor-tags").value = (book.tags || []).join(", ");
  $("#editor-status").value = book.status || "";
  $("#editor-source").value = book.source || "";
  $("#editor-cover").value = book.cover_url || "";
  $("#editor-links").value = (book.urls || []).map((link) => `${link.site || "Source"} | ${link.url}`).join("\n");
  location.hash = "admin";
  setTimeout(() => $("#catalogue-editor").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

function editorPayload() {
  const urls = $("#editor-links").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("|");
    return separator < 0
      ? { site: "", url: line }
      : { site: line.slice(0, separator).trim(), url: line.slice(separator + 1).trim() };
  });
  return {
    title: $("#editor-title").value.trim(),
    title_aliases: $("#editor-aliases").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    author: $("#editor-author").value.trim(),
    synopsis: $("#editor-synopsis").value.trim(),
    tags: $("#editor-tags").value.split(",").map((value) => value.trim()).filter(Boolean),
    source: $("#editor-source").value.trim(), status: $("#editor-status").value.trim(),
    cover_url: $("#editor-cover").value.trim(), urls,
  };
}

async function saveCatalogueRecord(event) {
  event.preventDefault();
  const novelId = state.editingNovelId;
  try {
    const data = await request(novelId ? `/admin/novels/${novelId}` : "/admin/novels", {
      method: novelId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editorPayload()),
    });
    resetBookEditor();
    setNotice(`${data.novel.title} saved. Index job #${data.job_id} is running.`);
    refreshJobs();
  } catch (error) { setNotice(error.message, true); }
}

async function startDirectDiscovery(event) {
  event.preventDefault();
  const title = $("#direct-title").value.trim();
  if (!title) return;
  await queueExactTitle(title);
  $("#direct-title").value = "";
}

function openModal(id) {
  const modal = $(`#${id}`);
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal(id) {
  const modal = $(`#${id}`);
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (id === "recovery-modal") $("#recovery-code").textContent = "";
}

function setAuthMessage(message, isError = false) {
  const target = $("#auth-message");
  target.textContent = message;
  target.dataset.state = isError ? "error" : "";
}

function showRecoveryCode(code, lead) {
  $("#recovery-lead").textContent = lead;
  $("#recovery-code").textContent = code;
  $("#copy-recovery").textContent = "Copy code";
  openModal("recovery-modal");
}

async function rotateRecoveryCode() {
  if (!state.user) return openLogin();
  try {
    const data = await request("/auth/recovery-code", { method: "POST" });
    showRecoveryCode(data.recovery_code, "The previous recovery code is no longer valid.");
  } catch (error) { setNotice(error.message, true); }
}

async function resetPassword(event) {
  event.preventDefault();
  const message = $("#reset-message");
  message.textContent = "Resetting password";
  message.dataset.state = "";
  try {
    const data = await request("/auth/reset", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("#reset-username").value.trim(), recovery_code: $("#reset-code").value.trim(), new_password: $("#reset-password").value }),
    });
    event.target.reset();
    closeModal("reset-modal");
    showRecoveryCode(data.recovery_code, "Password reset. This replacement code can be used once.");
    setNotice("Password reset. Sign in with the new password.");
  } catch (error) {
    message.textContent = error.message;
    message.dataset.state = "error";
  }
}

function openLogin() {
  if (state.user) { location.hash = "account"; return; }
  setAuthMessage("Use an existing account or create one with a password of at least 10 characters.");
  openModal("login-modal");
  $("#username").focus();
}

function clearSession() {
  state.user = null;
  state.token = "";
  state.items = [];
  localStorage.removeItem("novellist-token");
  $("#auth").textContent = "Sign in";
  $("#admin").hidden = true;
  $("#admin-nav").hidden = true;
  $("#account-controls").hidden = true;
  drawLibrary();
  drawTierboard();
  renderAnalytics();
  renderAccount();
}

async function signOut() {
  try { await request("/auth/logout", { method: "POST" }); } catch { /* local session is still cleared */ }
  clearSession();
  state.selectedTags.clear();
  updateSelectedTags();
  if (currentView() === "admin") location.hash = "discover";
  await Promise.all([loadTags(), refreshCatalogueStats()]);
  if (state.currentQuery) await runSearch(true); else await loadCatalogue(true);
  setNotice("Signed out.");
}

async function authenticate(registering = false) {
  const username = $("#username").value.trim();
  const password = $("#password").value;
  if (registering && password.length < 10) return setAuthMessage("New passwords need at least 10 characters.", true);
  const buttons = [$("#sign-in"), $("#register")];
  buttons.forEach((button) => { button.disabled = true; });
  setAuthMessage(registering ? "Creating account" : "Signing in");
  try {
    const data = await request(registering ? "/auth/register" : "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("novellist-token", state.token);
    $("#password").value = "";
    closeModal("login-modal");
    updateAccountUI();
    await Promise.all([refreshLibrary(), loadTags(), refreshCatalogueStats()]);
    if (state.currentQuery) await runSearch(true); else await loadCatalogue(true);
    setNotice(registering ? `Account created. Signed in as ${state.user.username}.` : `Signed in as ${state.user.username}.`);
    if (data.recovery_code) showRecoveryCode(data.recovery_code, "This code is shown once and can reset the account password.");
  } catch (error) { setAuthMessage(error.message, true); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

function updateAccountUI() {
  $("#auth").textContent = state.user ? state.user.username : "Sign in";
  $("#admin").hidden = state.user?.role !== "admin";
  $("#admin-nav").hidden = state.user?.role !== "admin";
  $("#account-controls").hidden = !state.user;
  renderAccount();
  renderAnalytics();
  renderCommunity();
  if (state.user?.role === "admin") refreshJobs();
}

async function changePassword(event) {
  event.preventDefault();
  if (!state.user) return openLogin();
  try {
    await request("/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: $("#current-password").value, new_password: $("#new-password").value }) });
    event.target.reset();
    clearSession();
    setNotice("Password updated. Sign in again with the new password.");
  } catch (error) { setNotice(error.message, true); }
}

function csvCells(line) {
  const cells = []; let value = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
    } else if (character === "," && !quoted) { cells.push(value.trim()); value = ""; } else value += character;
  }
  cells.push(value.trim());
  return cells;
}

async function importLibrary() {
  if (!state.user) return openLogin();
  const file = $("#library-import-file").files[0];
  if (!file) return setNotice("Choose a CSV file first.", true);
  try {
    const lines = (await file.text()).split(/\r?\n/).filter(Boolean);
    const headers = csvCells(lines.shift() || "").map((value) => value.toLocaleLowerCase());
    const titleIndex = headers.indexOf("title");
    const statusIndex = headers.indexOf("status");
    if (titleIndex < 0) throw new Error("The CSV needs a title column.");
    const normalizedStatus = (value) => {
      const input = String(value || "").trim().toLocaleLowerCase();
      return STATUS[input] ? input : Object.entries(STATUS).find(([, label]) => label.toLocaleLowerCase() === input)?.[0] || "plan_to_read";
    };
    const items = lines.map(csvCells).filter((row) => row[titleIndex]).map((row) => ({ title: row[titleIndex], status: normalizedStatus(row[statusIndex]) }));
    const result = await request("/collection/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    await refreshLibrary();
    setNotice(`Imported ${result.saved} novels${result.missing_count ? `; ${result.missing_count} could not be matched` : ""}.`);
  } catch (error) { setNotice(error.message, true); }
}

function bindStaticEvents() {
  $("#auth").addEventListener("click", () => state.user ? location.hash="account" : openLogin());
  $("#preview-signin").addEventListener("click", openLogin);
  $("#close-login").addEventListener("click", () => closeModal("login-modal"));
  $("#close-reset").addEventListener("click", () => closeModal("reset-modal"));
  $("#close-recovery").addEventListener("click", () => { $("#recovery-code").textContent = ""; closeModal("recovery-modal"); });
  $("#close-reviews").addEventListener("click", () => closeModal("review-modal"));
  $("#close-collection").addEventListener("click", () => closeModal("collection-modal"));
  $$(".modal").forEach((modal) => modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(modal.id); }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") $$(".modal.open").forEach((modal) => closeModal(modal.id)); });
  $("#login-form").addEventListener("submit", (event) => { event.preventDefault(); authenticate(false); });
  $("#register").addEventListener("click", () => authenticate(true));
  $("#open-reset").addEventListener("click", () => { closeModal("login-modal"); openModal("reset-modal"); $("#reset-username").focus(); });
  $("#reset-form").addEventListener("submit", resetPassword);
  $("#copy-recovery").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#recovery-code").textContent); $("#copy-recovery").textContent = "Copied"; }
    catch { setNotice("Copy the recovery code manually.", true); }
  });
  $("#review-form").addEventListener("submit", submitReview);
  $("#password-form").addEventListener("submit", changePassword);
  $("#import-library").addEventListener("click", importLibrary);
  $("#logout").addEventListener("click", signOut);
  $("#rotate-recovery").addEventListener("click", rotateRecoveryCode);
  $("#collection-form").addEventListener("submit", createSharedCollection);
  $("#request-novel").addEventListener("click", submitNovelRequest);
  $("#scrape-form").addEventListener("submit", startScrape);
  $("#custom-scrape-form").addEventListener("submit", startCustomScrape);
  $("#catalogue-editor").addEventListener("submit", saveCatalogueRecord);
  $("#editor-reset").addEventListener("click", resetBookEditor);
  $("#direct-form").addEventListener("submit", startDirectDiscovery);
  $("#search").addEventListener("click", () => runSearch(true));
  $("#query").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(true); });
  const tagDialog = $("#tag-dialog");
  $("#open-filters").addEventListener("click", () => {
    tagDialog.showModal();
    $("#open-filters").setAttribute("aria-expanded", "true");
    $("#tag-query").focus();
  });
  $("#close-filters").addEventListener("click", () => tagDialog.close());
  $("#apply-filters").addEventListener("click", () => tagDialog.close());
  tagDialog.addEventListener("close", () => $("#open-filters").setAttribute("aria-expanded", "false"));
  tagDialog.addEventListener("click", (event) => {
    if (event.target === tagDialog) tagDialog.close();
  });
  $("#tag-query").addEventListener("input", renderTagCloud);
  $("#clear-tags").addEventListener("click", () => { state.selectedTags.clear(); updateSelectedTags(); state.currentQuery ? runSearch(true) : loadCatalogue(true); });
  $("#load-more").addEventListener("click", loadNextPage);
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && currentView() === "discover") loadNextPage();
  }, { rootMargin: "500px" }).observe($("#scroll-sentinel"));
}

async function bootstrap() {
  initTheme();
  setAbsoluteMetadata();
  initRouting();
  initResultControls();
  bindStaticEvents();
  if (state.token) {
    try { state.user = await request("/auth/me"); }
    catch { clearSession(); setNotice("Your saved session expired. Sign in again.", true); }
  }
  updateAccountUI();
  showView();
  await Promise.all([refreshCatalogueStats(), loadTags(), refreshLibrary()]);
  await loadCatalogue(true);
  setInterval(refreshCatalogueStats, 30000);
  setInterval(() => { if (state.user?.role === "admin") refreshJobs(); }, 5000);
}

bootstrap();
