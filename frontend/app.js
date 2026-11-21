"use strict";

const API = window.API_BASE || (location.port === "3000" ? "/api" : location.origin);
const STATUS = {
  reading: "Reading",
  completed: "Finished",
  dropped: "Dropped",
  plan_to_read: "Want to read",
  continue: "Paused",
  paused: "Paused",
};
const MAIN_TABS = ["discover", "library", "tiers", "community"];
const VIEW_TITLES = {
  discover: "Discover novels",
  library: "Your library",
  tiers: "Your tier list",
  models: "How NoveList works",
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
  models: "See how catalogue search and personal tier suggestions work.",
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
  savedBooks: new Map(),
  trashUnlocked: false,
  libraryRequest: 0,
  activeStatus: "all",
  tierDisplay: shelfLayout(localStorage.getItem("novellist-tier-display")) || "shelf",
  resultLayout: localStorage.getItem("novellist-results-layout") || "shelf",
  libraryLayout: localStorage.getItem("novellist-library-layout") || "shelf",
  cabinetOpen: false,
  reviewSuggestions: false,
  catalogueRequest: 0,
  resultSort: localStorage.getItem("novellist-results-sort") || "recent",
  results: [],
  currentQuery: "",
  selectedTags: new Set(),
  catalogueTags: [],
  page: 1,
  hasMore: false,
  loading: false,
  draggedId: null,
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

function coverMarkup(book, className = "cover") {
  const novelId = bookID(book) || 0;
  const remote = book.cover_url || "";
  if (!remote && !book.cover_cached) return fallbackCoverMarkup(book, className);
  const source = novelId ? `${API}/covers/${novelId}/proxy` : remote;
  return `<img class="${className} js-cover" draggable="false" data-source="${escapeHTML(source)}" data-novel-id="${novelId}" data-remote="${escapeHTML(remote)}" data-title="${escapeHTML(book.title)}" data-author="${escapeHTML(book.author)}" alt="Cover of ${escapeHTML(book.title || "novel")}" loading="lazy" referrerpolicy="no-referrer">`;
}

function fallbackCoverMarkup({ title, author }, className) {
  if (className === "book-jacket") {
    return `<span class="book-jacket cloth" aria-hidden="true"><strong>${escapeHTML(title || "Untitled")}</strong>${author ? `<small>${escapeHTML(author)}</small>` : ""}</span>`;
  }
  return `<span class="cover cover-empty" aria-label="Cover unavailable">${escapeHTML((title || "N")[0])}</span>`;
}

function showMissingCover(image) {
  if (!image.isConnected) return;
  const remote = image.dataset.remote;
  if (remote && image.src !== remote && !image.dataset.triedRemote) {
    image.dataset.triedRemote = "true";
    image.src = remote;
    return;
  }
  const className = image.classList.contains("book-jacket") ? "book-jacket" : "cover";
  image.insertAdjacentHTML("afterend", fallbackCoverMarkup(image.dataset, className));
  image.remove();
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
      const blob = await response.blob();
      if (!image.isConnected) return;
      const objectUrl = URL.createObjectURL(blob);
      const release = () => URL.revokeObjectURL(objectUrl);
      image.addEventListener("load", release, { once: true });
      image.addEventListener("error", release, { once: true });
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
  $("#reader-theme").textContent = theme === "dark" ? "Light appearance" : "Dark appearance";
}

function initTheme() {
  const saved = localStorage.getItem("novellist-theme");
  setTheme(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $$("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    $("#reader-menu").open = false;
  }));
}

function currentView() {
  const requested = location.hash.slice(1).split("?")[0];
  return Object.hasOwn(VIEW_TITLES, requested) ? requested : "discover";
}

let finishTabMotion;

function slideView(previous, next) {
  finishTabMotion?.();
  const entering = document.getElementById(next);
  const leaving = previous && document.getElementById(previous);
  $$(".view").forEach((view) => {
    view.classList.toggle("active", view === entering);
    view.inert = view !== entering;
  });
  const from = MAIN_TABS.indexOf(previous);
  const to = MAIN_TABS.indexOf(next);
  if (from < 0 || to < 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const stage = $("#route-stage");
  stage.classList.add("route-moving");
  leaving.classList.add("route-leaving");
  const distance = Math.sign(to - from) * Math.min(170, stage.clientWidth * .18);
  const options = { duration: 280, easing: "cubic-bezier(.22,.61,.36,1)" };
  const animations = [
    entering.animate([{ transform: `translateX(${distance}px)`, opacity: .4 }, { transform: "none", opacity: 1 }], options),
    leaving.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-distance}px)`, opacity: 0 }], options),
  ];
  const finish = () => {
    if (finishTabMotion !== finish) return;
    finishTabMotion = null;
    animations.forEach((animation) => animation.cancel());
    stage.classList.remove("route-moving");
    leaving.classList.remove("route-leaving");
  };
  finishTabMotion = finish;
  Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
}

function positionTabIndicator() {
  const nav = $(".primary-nav");
  const target = $(".active", nav);
  nav.toggleAttribute("data-has-active", Boolean(target));
  if (!target) return;
  nav.style.setProperty("--tab-left", `${target.offsetLeft}px`);
  nav.style.setProperty("--tab-width", `${target.offsetWidth}px`);
}

function showView(viewName = currentView()) {
  if (viewName === "admin" && state.user?.role !== "admin") viewName = "discover";
  const previousView = document.body.dataset.view;
  if (previousView === viewName) return;
  closeBookMenu();
  closeFilters();
  $("#reader-menu").open = false;
  if (previousView) window.scrollTo({ top: 0, behavior: "instant" });
  slideView(previousView, viewName);
  $$("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === viewName;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  positionTabIndicator();
  document.body.dataset.view = viewName;
  document.title = `${VIEW_TITLES[viewName]} | novelist`;
  $('meta[name="description"]').setAttribute("content", VIEW_DESCRIPTIONS[viewName]);
  $('meta[property="og:title"]').setAttribute("content", `${VIEW_TITLES[viewName]} | novelist`);
  $('meta[property="og:description"]').setAttribute("content", VIEW_DESCRIPTIONS[viewName]);
  if (viewName === "analytics") renderAnalytics();
  if (viewName === "community") renderCommunity();
  if (viewName === "account") renderAccount();
  if (viewName === "admin") refreshJobs();
}

function navigateTo(view) {
  if (location.hash !== `#${view}`) history.pushState(null, "", `#${view}`);
  showView(view);
}

function initRouting() {
  window.addEventListener("hashchange", () => showView());
  window.addEventListener("popstate", () => showView());
  new ResizeObserver(positionTabIndicator).observe($(".primary-nav"));
  const header = $(".site-header");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--header-height", `${header.offsetHeight}px`);
    positionFilters();
  }).observe(header);
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const view = event.target.closest('a[href^="#"]')?.getAttribute("href").slice(1);
    if (!Object.hasOwn(VIEW_TITLES, view)) return;
    event.preventDefault();
    $("#reader-menu").open = false;
    navigateTo(view);
  });
  showView();
}

function updatePreview(data) {
  $("#demo-banner").hidden = !state.user || !data.demo;
  const limited = !state.user;
  $("#preview-banner").hidden = !limited;
  if (limited) {
    $("#preview-copy").textContent = "Fictional catalogue preview";
  }
}

async function refreshCatalogueStats() {
  if (!state.user) return;
  const token = state.token;
  try {
    const data = await request("/catalogue/stats");
    if (token !== state.token) return;
    updatePreview(data);
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
  $$('[data-filter-tag]').forEach((button) => {
    const active = state.selectedTags.has(button.dataset.filterTag);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderTagCloud() {
  const query = $("#tag-query").value.trim().toLocaleLowerCase();
  const matching = query
    ? state.catalogueTags.filter((tag) => tag.name.toLocaleLowerCase().includes(query))
    : state.catalogueTags;
  const visible = matching.slice(0, query ? 80 : 40);
  const cloud = $("#tag-cloud");
  cloud.innerHTML = visible.length
    ? visible.map((tag) => `<button type="button" data-filter-tag="${escapeHTML(tag.name)}" title="${tag.count.toLocaleString()} novels">${escapeHTML(tag.name)} <small>${tag.count}</small></button>`).join("")
    : '<span class="subtle">No tags found.</span>';
  $("#tag-summary").textContent = query
    ? `${matching.length.toLocaleString()} matching tags`
    : "";
  $$('[data-filter-tag]', cloud).forEach((button) => button.addEventListener("click", () => toggleTag(button.dataset.filterTag)));
  updateSelectedTags();
}

async function loadTags() {
  const token = state.token;
  try {
    const tags = state.user ? (await request("/catalogue/tags")).tags : previewTags();
    if (token !== state.token) return;
    state.catalogueTags = tags;
    renderTagCloud();
  } catch (error) {
    $("#tag-cloud").textContent = error.message;
  }
}

function closeFilters(restoreFocus = false) {
  const panel = $("#tag-dialog");
  if (panel.open) panel.close();
  $("#open-filters").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("#open-filters").focus({ preventScroll: true });
}

function positionFilters() {
  const panel = $("#tag-dialog");
  if (!panel.open) return;
  const anchor = $("#open-filters").getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  if (anchor.bottom < 0 || anchor.top > clientHeight) { closeFilters(); return; }
  const below = clientHeight - anchor.bottom - 14;
  const above = anchor.top - 14;
  const openAbove = below < 220 && above > below;
  panel.style.setProperty("--filter-space", `${Math.max(120, openAbove ? above : below)}px`);
  const left = Math.max(8, Math.min(anchor.right - panel.offsetWidth, clientWidth - panel.offsetWidth - 8));
  const top = openAbove ? anchor.top - panel.offsetHeight - 6 : anchor.bottom + 6;
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.max(8, Math.min(top, clientHeight - panel.offsetHeight - 8))}px`;
}

function toggleTag(tag) {
  if (currentView() !== "discover") navigateTo("discover");
  if (state.selectedTags.has(tag)) state.selectedTags.delete(tag); else state.selectedTags.add(tag);
  updateSelectedTags();
  if (state.currentQuery) runSearch(true); else loadCatalogue(true);
}

function invalidateCatalogue() {
  state.catalogueRequest++;
  state.loading = false;
  state.hasMore = false;
  state.results = [];
  $("#search").disabled = false;
  closeBookMenu();
}

async function loadCatalogue(reset = false) {
  if (state.loading && !reset) return;
  if (reset) {
    closeBookMenu();
    state.page = 1;
    state.currentQuery = "";
    $("#browse-sort").hidden = false;
    state.resultSort = resultSortForBrowse();
    $("#result-sort").value = state.resultSort;
    $("#query").value = "";
  }
  const params = new URLSearchParams({ page: state.page, page_size: 40, sort: resultSortForBrowse() });
  state.selectedTags.forEach((tag) => params.append("tags", tag));
  await refreshResults(reset, async () => {
    if (state.user) return request(`/catalogue?${params}`);
    let items = previewMatches();
    if (state.resultSort === "title") items.sort((a,b) => a.title.localeCompare(b.title));
    if (state.resultSort === "random") items.sort((a,b) => ((bookID(a) * 2654435761) >>> 0) - ((bookID(b) * 2654435761) >>> 0));
    return { items, total: items.length, has_more: false, demo: true };
  });
}

async function runSearch(reset = true) {
  const query = (reset ? $("#query").value : state.currentQuery).trim();
  if (!query) return loadCatalogue(true);
  if (state.loading && !reset) return;
  if (reset) {
    closeBookMenu();
    state.page = 1;
    state.currentQuery = query;
    $("#browse-sort").hidden = true;
  }
  const body = { query, top_k: 600, page: state.page, page_size: 30, tags: [...state.selectedTags] };
  await refreshResults(reset, async () => state.user ? request("/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) : { results: previewMatches(query), has_more: false, demo: true }, query);
}

async function refreshResults(reset, load, query = "") {
  const generation = ++state.catalogueRequest;
  state.loading = true;
  if (reset) $("#catalogue-end").replaceChildren();
  $("#results").setAttribute("aria-busy", "true");
  $("#search").disabled = Boolean(query);
  updatePagination();
  try {
    const data = await load();
    if (generation !== state.catalogueRequest) return;
    const items = query ? data.results : data.items;
    state.results = reset ? items : mergeUnique(state.results, items);
    state.hasMore = data.has_more;
    updatePreview(data);
    $("#results-title").textContent = query ? `Results for “${query}”` : "Discover";
    const total = query ? state.results.length : data.total;
    $("#results-count").textContent = `${total.toLocaleString()} ${total === 1 ? "novel" : "novels"}${query && data.has_more ? " shown" : ""}`;
    renderResults();
    if (query && reset && state.user) maybeStartExactDiscovery(query, items);
  } catch (error) {
    if (generation !== state.catalogueRequest) return;
    setNotice(error.message, true);
    if (reset) {
      state.results = [];
      $("#results").innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
    } else state.page = Math.max(1, state.page - 1);
  } finally {
    if (generation === state.catalogueRequest) {
      state.loading = false;
      $("#search").disabled = false;
      $("#results").removeAttribute("aria-busy");
      updatePagination();
    }
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

function renderResults() {
  const target = $("#results");
  const books = state.results;
  const layout = state.resultLayout;
  target.className = "book-collection discovery-books";
  target.dataset.layout = layout;
  if (!books.length) {
    target.innerHTML = '<div class="empty">No novels match these filters.</div>';
    updatePagination();
    return;
  }
  const groups = state.currentQuery
    ? [{ title: "Search results", books }]
    : groupDiscoverBooks(books);
  drawBookGroups(target, groups, layout);
  restoreBookAnchor();
  updatePagination();
}

function groupDiscoverBooks(books) {
  const tagKey = (tag) => tag.toLocaleLowerCase();
  const catalogueTags = new Map(state.catalogueTags.map((tag) => [tagKey(tag.name), tag]));
  const featured = new Set([...state.catalogueTags]
    .sort((a, b) => b.count - a.count).slice(0, 8).map((tag) => tagKey(tag.name)));
  const selected = new Set([...state.selectedTags].map(tagKey));
  const shelves = new Map();
  const tagCount = (tag) => catalogueTags.get(tag)?.count || 1;
  const placeScore = (tag) => Math.log2(tagCount(tag) + 1) / (1 + (shelves.get(tag)?.books.length || 0) * .35);
  for (const book of books) {
    const tags = new Map((book.tags || []).map((tag) => [tagKey(tag), tag]));
    const matches = [...tags.keys()].filter((tag) => featured.has(tag));
    const preferred = [...tags.keys()].find((tag) => selected.has(tag));
    const candidates = matches.length ? matches : [...tags.keys()];
    const key = preferred || candidates.sort((a, b) => placeScore(b) - placeScore(a))[0] || "";
    if (!shelves.has(key)) {
      shelves.set(key, { title: catalogueTags.get(key)?.name || tags.get(key) || "Untagged", books: [] });
    }
    shelves.get(key).books.push(book);
  }
  const ordered = [...shelves.keys()].sort((a, b) =>
    Number(Boolean(b)) - Number(Boolean(a)) || tagCount(b) - tagCount(a) || a.localeCompare(b));
  return ordered.map((tag) => shelves.get(tag));
}

function updatePagination() {
  const button = $("#load-more");
  button.hidden = !state.hasMore;
  button.disabled = state.loading;
  button.textContent = state.loading ? "Loading" : "Load more";
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
    button.setAttribute("aria-pressed", String(button.dataset.resultLayout === state.resultLayout));
    button.addEventListener("click", () => {
      closeBookMenu();
      state.resultLayout = button.dataset.resultLayout;
      localStorage.setItem("novellist-results-layout", state.resultLayout);
      setSelectedLayout("result-view", "result-layout", state.resultLayout);
      renderResults();
    });
  });
  const sort = $("#result-sort");
  sort.value = state.resultSort;
  sort.addEventListener("change", () => {
    state.resultSort = sort.value;
    localStorage.setItem("novellist-results-sort", state.resultSort);
    loadCatalogue(true);
  });
}

function setLibrary({ items = [], trash_unlocked = false } = {}) {
  state.items = items;
  state.savedBooks = new Map(items.map((item) => [item.novel_id, item]));
  state.trashUnlocked = trash_unlocked;
}

let lastLibraryResponse = 0;

async function refreshLibrary({ keepBooks = false } = {}) {
  const token = state.token;
  const requestId = ++state.libraryRequest;
  if (!state.user) {
    setLibrary();
    drawLibrary();
    drawTierboard();
    return;
  }
  try {
    const data = await request("/collection");
    if (state.token !== token || requestId < lastLibraryResponse) return;
    lastLibraryResponse = requestId;
    const previous = state.savedBooks;
    setLibrary(data);
    drawLibrary(keepBooks);
    drawTierboard(keepBooks);
    if (keepBooks) {
      $$("#results [data-book-key], #collection-detail [data-book-key]").forEach((trigger) => {
        const book = shelfBooks.get(trigger);
        if (!book) return;
        const before = previous.get(bookID(book));
        const after = state.savedBooks.get(bookID(book));
        if (before?.status !== after?.status || before?.personal_rating !== after?.personal_rating) {
          updateBookControls(trigger, book);
        }
      });
    } else if (state.results.length) {
      renderResults();
    }
    restoreBookAnchor();
  } catch (error) {
    if (state.token === token) setNotice(error.message, true);
  }
}

function drawLibrary(keepBooks = false) {
  const target = $("#books");
  const filters = $("#filters");
  const toolbar = $("#library-toolbar");
  const layout = state.libraryLayout;
  const closed = layout === "shelf" && !state.cabinetOpen;
  toolbar.hidden = !state.user || closed;
  setSelectedLayout("library-view", "library-layout", layout);
  if (!state.user) {
    target.innerHTML = '<div class="empty">Sign in to start a personal library.</div>';
    return;
  }
  const status = state.activeStatus;
  if (!keepBooks || !filters.firstElementChild) {
    filters.innerHTML = timelineMarkup("Reading status", "filter", READING_STOPS, status, status === "all" ? "All statuses" : STATUS[status]) +
      `<button type="button" class="text-button library-all" aria-pressed="${status === "all"}">All</button>`;
    wireTimeline(filters, "filter", READING_STOPS, status, (next) => changeLibraryFilter(next, "#book-track-filter"));
    $(".library-all", filters).onclick = () => changeLibraryFilter("all", ".library-all");
  }
  const groups = READING_STOPS.map(([value, title]) => ({
    title, books: status === "all" || status === value ? state.items.filter((item) => displayStatus(item.status) === value) : [],
  })).filter((group) => group.books.length);
  const canReuse = keepBooks && target.dataset.layout === layout;
  target.dataset.layout = layout;
  const empty = '<div class="empty">No saved novels in this reading state.</div>';
  const shelves = layout === "shelf" ? $(".cabinet-interior", target) : target;
  if (canReuse && shelves) {
    if (groups.length) {
      $(":scope > .empty", shelves)?.remove();
      syncBookGroups(shelves, groups, layout);
    } else if (!$(":scope > .empty", shelves)) {
      shelves.innerHTML = empty;
    }
    return;
  }
  if (layout === "shelf") {
    const offsets = shelfOffsets(target);
    target.innerHTML = `<div class="library-cabinet" ${closed ? "" : "data-open"}>
      <div class="cabinet-interior" ${closed ? "inert" : ""}>${groups.length ? groupMarkup(groups, layout) : empty}</div>
      <div class="cabinet-doors" ${closed ? "" : "inert"}>
        <button type="button" class="cabinet-door left" aria-label="Open left cabinet door"><span aria-hidden="true"></span></button>
        <button type="button" class="cabinet-door right" aria-label="Open right cabinet door"><span aria-hidden="true"></span></button>
      </div></div>`;
    bindBookGroups(target, groups);
    restoreShelfOffsets(target, offsets);
    $$(".cabinet-door", target).forEach((door) => door.addEventListener("click", (event) => {
      state.cabinetOpen = true;
      const cabinet = $(".library-cabinet", target);
      cabinet.setAttribute("data-open", "");
      $(".cabinet-interior", cabinet).inert = false;
      $(".cabinet-doors", cabinet).inert = true;
      toolbar.hidden = false;
      if (event.detail === 0) $("#book-track-filter").focus({ preventScroll: true });
    }));
  } else if (groups.length) {
    drawBookGroups(target, groups, layout);
  } else {
    target.innerHTML = empty;
  }
}

function changeLibraryFilter(status, focusSelector) {
  if (state.activeStatus === status) return;
  closeBookMenu();
  state.activeStatus = status;
  drawLibrary();
  $(focusSelector, $("#filters"))?.focus({ preventScroll: true });
}

async function cacheCover(novelId, button) {
  button.disabled = true;
  try {
    await request(`/collection/${novelId}/cover/cache`, { method: "POST" });
    await refreshLibrary();
    if (menuState.book && bookID(menuState.book) === novelId) refreshBookMenu("", true);
    setNotice("Cover cached.");
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function drawTierboard(keepBooks = false) {
  const layout = state.tierDisplay;
  setSelectedLayout("tier-view", "display", layout);
  const target = $("#tierboard");
  const suggestions = state.items.filter((item) => item.tier && item.tier_source === "suggested");
  const review = $("#review-suggestions");
  review.hidden = !suggestions.length && !state.reviewSuggestions;
  review.setAttribute("aria-pressed", String(state.reviewSuggestions));
  review.innerHTML = `${glyph("Sparkles")} ${state.reviewSuggestions ? "Done reviewing" : "Review suggestions"}${suggestions.length ? ` <span>${suggestions.length}</span>` : ""}`;
  if (!state.user || (!state.trashUnlocked && !state.items.some((item) => item.tier))) {
    target.innerHTML = `<div class="empty">${state.user ? "Save a novel to receive its first suggested tier." : "Sign in to arrange your tier list."}</div>`;
    return;
  }
  const tiers = state.trashUnlocked ? [...TIERS, TRASH_TIER] : TIERS;
  const groups = tiers.map((tier) => ({ tier, title: tier === TRASH_TIER ? "Trash" : `Tier ${tier}`, books:
    state.items.filter((item) => item.tier === tier).sort((a, b) => (a.tier_position ?? 0) - (b.tier_position ?? 0)) }));
  const options = { tiers: true, draggable: true };
  if (keepBooks && target.dataset.layout === layout) {
    $(":scope > .empty", target)?.remove();
    syncBookGroups(target, groups, layout, options);
  } else {
    drawBookGroups(target, groups, layout, options);
  }
  const trashDrop = $(".trash-drop", target);
  if (state.trashUnlocked) {
    trashDrop?.remove();
  } else if (!trashDrop) {
    target.insertAdjacentHTML("beforeend", `<div class="trash-drop" data-drop-tier="${TRASH_TIER}" aria-hidden="true"></div>`);
  }
  bindTierDrag(target, async (id, tier, order) => {
    try {
      await request(`/collection/${id}/move`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, ordered_novel_ids: order }) });
      await refreshLibrary({ keepBooks: true });
      setNotice("Tier list updated.");
    } catch (error) { setNotice(error.message, true); }
  });
}

const tierDragBound = new WeakSet();

function bindTierDrag(root, onDrop) {
  const zones = $$("[data-drop-tier]", root);
  const clearDrag = () => {
    state.draggedId = null;
    $$("[data-dragged],[data-drag-over],[data-insert]", root).forEach((el) => {
      el.removeAttribute("data-dragged");
      el.removeAttribute("data-drag-over");
      el.removeAttribute("data-insert");
    });
  };
  const context = (zone, event) => {
    const target = event.target.closest("[data-book-key]");
    const other = target && Number(target.dataset.bookKey) !== state.draggedId ? target : null;
    const rect = other?.getBoundingClientRect();
    const list = zone.closest("[data-layout]")?.dataset.layout === "list";
    const after = rect && (list ? event.clientY >= rect.top + rect.height / 2 : event.clientX >= rect.left + rect.width / 2);
    return { target, other, after };
  };
  $$('[draggable="true"]', root).forEach((trigger) => {
    if (tierDragBound.has(trigger)) return;
    tierDragBound.add(trigger);
    trigger.addEventListener("dragstart", (event) => {
      state.draggedId = Number(trigger.dataset.bookKey);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(state.draggedId));
      requestAnimationFrame(() => { if (state.draggedId !== null) trigger.setAttribute("data-dragged", ""); });
    });
    trigger.addEventListener("dragend", clearDrag);
  });
  zones.forEach((zone) => {
    if (tierDragBound.has(zone)) return;
    tierDragBound.add(zone);
    zone.addEventListener("dragover", (event) => {
      if (state.draggedId === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      $$("[data-drag-over],[data-insert]", root).forEach((el) => {
        el.removeAttribute("data-drag-over");
        el.removeAttribute("data-insert");
      });
      zone.setAttribute("data-drag-over", "");
      const { other, after } = context(zone,event);
      if (other) other.dataset.insert = after ? "after" : "before";
    });
    zone.addEventListener("dragleave", (event) => {
      if (zone.contains(event.relatedTarget)) return;
      zone.removeAttribute("data-drag-over");
      $$("[data-insert]", zone).forEach((el) => el.removeAttribute("data-insert"));
    });
    zone.addEventListener("drop", (event) => {
      if (state.draggedId === null) return;
      event.preventDefault();
      const id = state.draggedId;
      const { target, other, after } = context(zone,event);
      const books = $$("[data-book-key]", zone).map((el) => Number(el.dataset.bookKey)).filter((key) => key !== id);
      const neighbour = other && books.indexOf(Number(other.dataset.bookKey));
      const index = neighbour !== null && neighbour >= 0 ? neighbour + Number(after) : books.length;
      books.splice(index, 0, id);
      clearDrag();
      if (Number(target?.dataset.bookKey) !== id) onDrop(id, zone.dataset.dropTier, books);
    });
  });
}

function initCollectionControls() {
  $("#library-view").addEventListener("click", (event) => {
    const layout = event.target.closest("[data-library-layout]")?.dataset.libraryLayout;
    if (!layout || layout === state.libraryLayout) return;
    closeBookMenu();
    state.libraryLayout = layout;
    localStorage.setItem("novellist-library-layout", layout);
    drawLibrary();
  });
  $("#tier-view").addEventListener("click", (event) => {
    const layout = event.target.closest("[data-display]")?.dataset.display;
    if (!layout || layout === state.tierDisplay) return;
    closeBookMenu();
    state.tierDisplay = layout;
    localStorage.setItem("novellist-tier-display", layout);
    drawTierboard();
  });
  $("#review-suggestions").addEventListener("click", () => {
    state.reviewSuggestions = !state.reviewSuggestions;
    closeBookMenu();
    drawTierboard();
    if (state.reviewSuggestions) nextSuggestedBook();
  });
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
  const reader = state.user;
  if (!reader) {
    target.innerHTML = '<div class="empty">Sign in to view your profile and account controls.</div>';
    return;
  }
  try {
    const data = await request("/profile");
    if (state.user !== reader) return;
    target.innerHTML = `<article class="profile-card">
      <div class="reader-identity"><div class="profile-avatar" aria-hidden="true">${escapeHTML(reader.username[0].toUpperCase())}</div>
      <div><h2>${escapeHTML(reader.username)}</h2><p class="subtle">${reader.role === "admin" ? "Administrator" : "Reader"} · ${data.library_count} saved · ${data.tier_counts.S || 0} in S tier</p></div></div>
      ${data.favorite_tags?.length ? `<div class="taste-tags">${data.favorite_tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join("")}</div>` : ""}
      <div class="profile-actions">
        <button type="button" class="outline-button" data-profile-action="public">View public profile</button>
        <button type="button" class="text-button" data-profile-action="logout">Sign out</button>
      </div></article>`;
  } catch (error) {
    if (state.user === reader) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

async function renderCommunity() {
  const target = $("#shared-collections");
  try {
    const data = await request("/shared-collections");
    target.innerHTML = data.collections.length ? data.collections.map((collection) => `<article class="collection-card"><h2>${escapeHTML(collection.name)}</h2><button class="text-button byline" data-reader="${escapeHTML(collection.username)}" type="button">by ${escapeHTML(collection.username)}</button>${collection.description ? `<p>${escapeHTML(collection.description)}</p>` : ""}<div class="collection-actions"><button class="small-button" data-open-collection="${collection.id}" type="button">Open tier list</button><button class="small-button" data-follow-collection="${collection.id}" data-following="${collection.following ? "true" : "false"}" type="button">${collection.following ? "Unfollow" : "Follow"} · ${collection.followers}</button></div></article>`).join("") : '<div class="empty">No public collections yet. Create the first one.</div>';
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
  closeBookMenu();
  openModal("collection-modal");
  const target = $("#collection-detail");
  target.innerHTML = '<div class="skeleton wide"></div>';
  try {
    const [collection, comments] = await Promise.all([request(`/shared-collections/${collectionId}`), request(`/shared-collections/${collectionId}/comments`)]);
    const savedOptions = state.items.map((item) => `<option value="${item.novel_id}">${escapeHTML(item.title)}</option>`).join("");
    const owned = state.user?.id === collection.user_id;
    const groups = TIERS.map((tier) => ({ tier, title: `Tier ${tier}`, books:
      collection.items.filter((book) => (book.tier || "C") === tier).sort((a,b) => a.position - b.position) }));
    target.innerHTML = `<h2>${escapeHTML(collection.name)}</h2><p class="subtle">by ${escapeHTML(collection.username)} · ${collection.followers} followers</p><p>${escapeHTML(collection.description)}</p>
      <div class="book-collection shared-books" data-layout="list">${collection.items.length ? groupMarkup(owned ? groups : groups.filter((group) => group.books.length), "list", { tiers: true, draggable: owned }) : '<div class="empty">No novels have been added yet.</div>'}</div>
      ${state.user?.id === collection.user_id ? `<div class="collection-actions" style="margin-top:12px"><select id="collection-item-select">${savedOptions || '<option value="">Save a novel first</option>'}</select><button id="add-collection-item" class="small-button" type="button">Add saved novel</button></div>` : ""}
      <h3>Comments</h3><div class="comment-list">${comments.comments.length ? comments.comments.map((comment) => `<div class="comment"><strong>${escapeHTML(comment.username)}</strong> ${escapeHTML(comment.body)}</div>`).join("") : '<p class="subtle">No comments yet.</p>'}</div>
      <form id="collection-comment-form" class="collection-actions" style="margin-top:10px"><input id="collection-comment" maxlength="2000" required placeholder="Add to the discussion"><button class="small-button" type="submit">Comment</button></form>`;
    if (collection.items.length) {
      bindBookGroups(target, owned ? groups : groups.filter((group) => group.books.length));
      if (owned) bindTierDrag(target, async (id, tier, order) => {
        try {
          await request(`/shared-collections/${collectionId}/items/${id}/move`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, ordered_novel_ids: order }),
          });
          await openCollection(collectionId);
          setNotice("Collection updated.");
        } catch (error) { setNotice(error.message, true); }
      });
    }
    $("#add-collection-item")?.addEventListener("click", () => addCollectionItem(collectionId));
    $("#collection-comment-form").addEventListener("submit", (event) => submitCollectionComment(event, collectionId));
  } catch (error) { target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`; }
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

function openBookEditor(novelId, selectedBook) {
  if (state.user?.role !== "admin") return;
  const book = selectedBook || state.results.find((item) => Number(item.novel_id || item.id) === novelId)
    || state.savedBooks.get(novelId);
  if (!book) return setNotice("Reload the catalogue before editing this record.", true);
  state.editingNovelId = novelId;
  $("#editor-record-id").textContent = `Record #${novelId}`;
  $("#editor-title").value = book.title || "";
  $("#editor-aliases").value = (book.title_aliases || []).join("\n");
  $("#editor-author").value = book.author || "";
  $("#editor-synopsis").value = book.synopsis || "";
  $("#editor-tags").value = (book.tags || []).join(", ");
  $("#editor-status").value = book.publication ?? book.status ?? "";
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
  if (id === "collection-modal" && menuState.host?.id === "collection-detail") closeBookMenu();
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
  setLibrary();
  state.cabinetOpen = false;
  state.activeStatus = "all";
  state.reviewSuggestions = false;
  state.catalogueTags = [];
  state.selectedTags.clear();
  updateSelectedTags();
  invalidateCatalogue();
  localStorage.removeItem("novellist-token");
  syncReaderMenu();
  applyBookZoom();
  drawLibrary();
  drawTierboard();
  renderAnalytics();
  renderAccount();
  loadTags();
  if (state.currentQuery) runSearch(true); else loadCatalogue(true);
}

async function signOut() {
  try { await request("/auth/logout", { method: "POST" }); } catch { /* local session is still cleared */ }
  clearSession();
  if (currentView() === "admin") navigateTo("discover");
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
    invalidateCatalogue();
    state.selectedTags.clear();
    updateSelectedTags();
    $("#results").innerHTML = '<div class="skeleton wide"></div>';
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

function syncReaderMenu() {
  const menu = $("#reader-menu");
  menu.hidden = !state.user;
  if (menu.hidden) menu.open = false;
  $("#auth").hidden = Boolean(state.user);
  $("#theme").hidden = Boolean(state.user);
  $("#reader-menu-user").textContent = state.user?.username || "";
  $("#admin").hidden = state.user?.role !== "admin";
  $("#admin-nav").hidden = state.user?.role !== "admin";
  $("#account-controls").hidden = !state.user;
}

function updateAccountUI() {
  syncReaderMenu();
  applyBookZoom();
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
  $("#close-collection").addEventListener("click", () => closeModal("collection-modal"));
  $$(".modal").forEach((modal) => modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(modal.id); }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.defaultPrevented) $$(".modal.open").forEach((modal) => closeModal(modal.id)); });
  $("#login-form").addEventListener("submit", (event) => { event.preventDefault(); authenticate(false); });
  $("#register").addEventListener("click", () => authenticate(true));
  $("#open-reset").addEventListener("click", () => { closeModal("login-modal"); openModal("reset-modal"); $("#reset-username").focus(); });
  $("#reset-form").addEventListener("submit", resetPassword);
  $("#copy-recovery").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#recovery-code").textContent); $("#copy-recovery").textContent = "Copied"; }
    catch { setNotice("Copy the recovery code manually.", true); }
  });
  $("#password-form").addEventListener("submit", changePassword);
  $("#import-library").addEventListener("click", importLibrary);
  $("#account-summary").addEventListener("click", (event) => {
    const action = event.target.closest("[data-profile-action]")?.dataset.profileAction;
    if (action === "public" && state.user) openReaderProfile(state.user.username);
    if (action === "logout") signOut();
  });
  document.addEventListener("pointerdown", (event) => {
    const readerMenu = $("#reader-menu");
    if (readerMenu.open && !readerMenu.contains(event.target)) readerMenu.open = false;
  });
  $("#reader-menu").addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.currentTarget.open = false;
    $("summary", event.currentTarget).focus();
  });
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
  $("#open-filters").addEventListener("click", () => {
    const panel = $("#tag-dialog");
    if (panel.open) return closeFilters(true);
    panel.show();
    $("#open-filters").setAttribute("aria-expanded", "true");
    positionFilters();
    renderTagCloud();
    $("#tag-query").focus({ preventScroll: true });
  });
  $("#close-filters").addEventListener("click", () => closeFilters(true));
  document.addEventListener("pointerdown", (event) => {
    if ($("#tag-dialog").open && !event.target.closest("#tag-dialog,#open-filters")) closeFilters();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#tag-dialog").open) closeFilters(true);
  });
  window.addEventListener("resize", positionFilters);
  window.addEventListener("scroll", positionFilters, { passive: true });
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
  initCollectionControls();
  initBookZoom();
  initShelfMenus();
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
