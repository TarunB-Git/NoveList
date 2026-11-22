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
  favorites: "My favorites",
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
  favorites: "The novelist owner’s S-tier bookshelf.",
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
  bookLayout: shelfLayout(localStorage.getItem("novellist-book-layout") || localStorage.getItem("novellist-results-layout")) || "shelf",
  cabinetOpen: false,
  reviewSuggestions: false,
  reviewBookId: null,
  catalogueRequest: 0,
  resultSort: localStorage.getItem("novellist-results-sort") || "recent",
  results: [],
  discoverGroups: [],
  genreBrowse: null,
  currentQuery: "",
  scopedQueries: {},
  collections: [],
  discussions: [],
  communityPanel: "collections",
  favorites: [],
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
    if (options.signal?.aborted) throw options.signal.reason;
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
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
  $("#theme").setAttribute("aria-label", label);
  $("#theme").title = label;
}

function initTheme() {
  const saved = localStorage.getItem("novellist-theme");
  setTheme(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("#theme").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    $("#reader-menu").open = false;
  });
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
  syncScopedSearch(viewName);
  syncLayoutControl(viewName);
  const notice = $("#notice");
  if (viewName === "library") $("#library-toolbar").append(notice);
  else $("#route-stage").before(notice);
  document.title = `${VIEW_TITLES[viewName]} | novelist`;
  $('meta[name="description"]').setAttribute("content", VIEW_DESCRIPTIONS[viewName]);
  $('meta[property="og:title"]').setAttribute("content", `${VIEW_TITLES[viewName]} | novelist`);
  $('meta[property="og:description"]').setAttribute("content", VIEW_DESCRIPTIONS[viewName]);
  if (viewName === "analytics") renderAnalytics();
  if (viewName === "community") renderCommunity();
  if (viewName === "favorites") renderFavorites();
  if (viewName === "account") renderAccount();
  if (viewName === "admin") refreshJobs();
  if (viewName === "library") balanceCabinetShelves();
  if (viewName === "discover") packDiscoverSections();
  queueSpineTitles();
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
    $("#preview-copy").textContent = "Preview with classics and sample novels";
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

const SEARCH_SCOPES = {
  discover: ["Search catalogue", "Title or story idea"],
  library: ["Search library", "Find a saved novel"],
  tiers: ["Search tier list", "Find a novel on your tier list"],
  community: ["Search community", "Collection, reader, or novel"],
};

let searchOptions = [];
let activeSearchOption = -1;
let searchTimer;
let suggestionRequest;

function clearSuggestions() {
  clearTimeout(searchTimer);
  suggestionRequest?.abort();
  searchOptions = [];
  activeSearchOption = -1;
  $("#search-suggestions").hidden = true;
  $("#query").setAttribute("aria-expanded", "false");
  $("#query").removeAttribute("aria-activedescendant");
}

function syncScopedSearch(view) {
  clearSuggestions();
  const scope = SEARCH_SCOPES[view];
  $("#discover-search").hidden = !scope;
  $("#open-filters").hidden = view !== "discover";
  $("#browse-sort").hidden = view !== "discover" || Boolean(state.currentQuery);
  if (!scope) return;
  $("#discover-search").setAttribute("aria-label", scope[0]);
  $("#search-label").textContent = scope[0];
  $("#query").placeholder = view === "community" && state.communityPanel === "discussion" ? "Collection or comment" : scope[1];
  $("#query").value = view === "discover" ? state.currentQuery : state.scopedQueries[view] || "";
}

function searchText(value) {
  return String(value || "").normalize("NFKD").toLocaleLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function scopedMatches(items, query) {
  const text = searchText(query);
  if (!text) return items;
  const terms = text.split(" ");
  return items.flatMap((item) => {
    const name = searchText(item.title || item.name);
    const meta = searchText([item.author, item.username, item.description, item.synopsis,
      ...(item.tags || []), ...(item.title_aliases || [])].filter(Boolean).join(" "));
    if (!terms.every((term) => name.includes(term) || meta.includes(term))) return [];
    const score = Number(name === text) * 10 + Number(name.startsWith(text)) * 4 + terms.filter((term) => name.includes(term)).length;
    return [{ item, score }];
  }).sort((a, b) => b.score - a.score).map(({ item }) => item);
}

function communityBookMatches(query) {
  return state.collections.flatMap((collection) => scopedMatches(collection.books || [], query)
    .map((book) => ({ ...book, collectionId: collection.id, collectionName: collection.name })));
}

function communityMatches(query, books = communityBookMatches(query)) {
  const matches = new Map(scopedMatches(state.collections, query).map((collection) => [collection.id, collection]));
  const bookCollections = new Set(books.map((book) => book.collectionId));
  for (const collection of state.collections) {
    if (bookCollections.has(collection.id)) matches.set(collection.id, collection);
  }
  return [...matches.values()];
}

function queueSuggestions() {
  clearSuggestions();
  const input = $("#query");
  const query = input.value.trim();
  const view = document.body.dataset.view;
  if (!query || !SEARCH_SCOPES[view]) return;
  const controller = new AbortController();
  suggestionRequest = controller;
  searchTimer = setTimeout(async () => {
    try {
      let matches;
      if (view === "discover") {
        if (state.user) {
          if (query.length < 2) return;
          const data = await request("/search", {
            method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ query, top_k: 6, page_size: 6, tags: [...state.selectedTags] }),
          });
          matches = data.results;
        } else {
          matches = previewMatches(query);
        }
      } else if (view === "community") {
        if (state.communityPanel === "discussion") matches = scopedMatches(state.discussions, query);
        else {
          const books = communityBookMatches(query);
          matches = [...books.slice(0, 4), ...communityMatches(query, books)];
        }
      } else {
        matches = scopedMatches(view === "tiers" ? state.items.filter((item) => item.tier) : state.items, query);
      }
      if (controller.signal.aborted) return;
      searchOptions = matches.slice(0, 6);
      if (!searchOptions.length) return;
      const list = $("#search-suggestions");
      list.innerHTML = searchOptions.map((item, index) => {
        const detail = item.collectionName || item.author || item.username;
        return `<button type="button" class="search-option" id="search-option-${index}" role="option" tabindex="-1" data-search-option="${index}" aria-selected="false"><span>${escapeHTML(item.title || item.name)}</span>${detail ? `<small>${escapeHTML(detail)}</small>` : ""}</button>`;
      }).join("");
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    } catch (error) {
      if (!controller.signal.aborted && error.name !== "AbortError") clearSuggestions();
    }
  }, view === "discover" && state.user ? 180 : 50);
}

async function submitScopedSearch(option, keyboard = false) {
  const view = document.body.dataset.view;
  const query = (option?.title || option?.name || $("#query").value).trim();
  clearSuggestions();
  closeBookMenu();
  if (option) $("#query").value = query;
  if (view === "discover") {
    await runSearch(true, query);
  } else {
    state.scopedQueries[view] = query;
    if (view === "library") {
      if (query) {
        state.activeStatus = "all";
        state.cabinetOpen = true;
      }
      drawLibrary();
    }
    if (view === "tiers") drawTierboard();
    if (view === "community") {
      drawCommunity();
      if (option?.thread_id) openDiscussion(option.thread_id);
      else if (option?.collection_id) openCollection(option.collection_id, { discussion: true, keyboard });
      else if (option) openCollection(option.collectionId || option.id, { novelId: option.novel_id, keyboard });
      return;
    }
  }
  if (!option || view !== document.body.dataset.view) return;
  const book = $(`[data-book-key="${bookID(option)}"]`, document.getElementById(view));
  if (!book) return;
  book.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (book.matches(BOOK_TRIGGER)) openBookMenu(book, { pin: true, keyboard });
  else $("input", book)?.focus({ preventScroll: true });
}

function bindScopedSearch() {
  const form = $("#discover-search");
  const input = $("#query");
  const list = $("#search-suggestions");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitScopedSearch();
  });
  input.addEventListener("input", () => {
    const view = document.body.dataset.view;
    const applied = view === "discover" ? state.currentQuery : state.scopedQueries[view];
    if (!input.value && applied) submitScopedSearch();
    else queueSuggestions();
  });
  input.addEventListener("focus", queueSuggestions);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      clearSuggestions();
    }
    if (event.key === "Enter" && activeSearchOption >= 0) {
      event.preventDefault();
      submitScopedSearch(searchOptions[activeSearchOption], true);
    }
    if (!searchOptions.length || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const last = searchOptions.length - 1;
    activeSearchOption = event.key === "ArrowDown"
      ? (activeSearchOption + 1) % searchOptions.length
      : activeSearchOption <= 0 ? last : activeSearchOption - 1;
    const active = list.children[activeSearchOption];
    $$("[role=option]", list).forEach((option) => option.setAttribute("aria-selected", String(option === active)));
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  });
  list.addEventListener("pointerdown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-search-option]");
    if (option) submitScopedSearch(searchOptions[Number(option.dataset.searchOption)]);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!form.contains(event.target)) clearSuggestions();
  });
  input.addEventListener("blur", clearSuggestions);
}

function invalidateCatalogue() {
  state.catalogueRequest++;
  state.loading = false;
  state.hasMore = false;
  state.results = [];
  state.discoverGroups = [];
  clearGenreBrowse();
  $("#search").disabled = false;
  closeBookMenu();
}

async function loadCatalogue(reset = false) {
  if (state.loading && !reset) return;
  if (reset) {
    closeBookMenu();
    state.page = 1;
    state.currentQuery = "";
    state.resultSort = resultSortForBrowse();
    $("#result-sort").value = state.resultSort;
    if (document.body.dataset.view === "discover") syncScopedSearch("discover");
  }
  if (state.bookLayout === "shelf") return loadGenrePage(reset);
  clearGenreBrowse();
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

async function runSearch(reset = true, queryText = state.currentQuery) {
  const query = queryText.trim();
  if (!query) return loadCatalogue(true);
  if (state.loading && !reset) return;
  if (reset) {
    closeBookMenu();
    clearGenreBrowse();
    state.page = 1;
    state.currentQuery = query;
    if (document.body.dataset.view === "discover") $("#browse-sort").hidden = true;
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
    const total = query ? state.results.length : data.total;
    $("#results-count").textContent = `${total.toLocaleString()} ${total === 1 ? "novel" : "novels"}${query && data.has_more ? " shown" : ""}`;
    renderResults({ append: !reset });
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

function renderResults({ append = false } = {}) {
  const target = $("#results");
  const books = state.results;
  const layout = state.bookLayout;
  const keepBooks = append && target.dataset.layout === layout && $(".book-section", target);
  const anchor = keepBooks ? discoverScrollAnchor(target) : null;
  target.className = "book-collection discovery-books";
  target.dataset.layout = layout;
  if (!books.length) {
    target.innerHTML = '<div class="empty">No novels match these filters.</div>';
    updatePagination();
    return;
  }
  const groups = state.currentQuery
    ? [{ title: "Search results", books }]
    : groupDiscoverBooks(books, keepBooks ? state.discoverGroups : []);
  state.discoverGroups = groups;
  if (keepBooks) syncBookGroups(target, groups, layout);
  else drawBookGroups(target, groups, layout);
  packDiscoverSections(Boolean(keepBooks));
  if (anchor?.book.isConnected) {
    const shift = anchor.book.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) >= 1) window.scrollBy({ top: shift, behavior: "instant" });
  }
  restoreBookAnchor();
  updatePagination();
}

function discoverScrollAnchor(target) {
  if (document.body.dataset.view !== "discover" || !window.scrollY) return null;
  const header = $(".site-header").getBoundingClientRect().bottom;
  for (const book of $$("[data-book-key]", target)) {
    const box = book.getBoundingClientRect();
    if (box.bottom > header && box.top < innerHeight && box.left < innerWidth && box.right > 0) {
      return { book, top: box.top };
    }
  }
  return null;
}

function packDiscoverSections(keepWidths = false) {
  const target = $("#results");
  const layout = target.dataset.layout;
  if (!target.clientWidth || !["shelf", "grid", "dense"].includes(layout)) return;
  const zoom = Number($("#header-zoom-slider").value) / 100;
  for (const section of $$(":scope > .book-section", target)) {
    if (keepWidths && section.style.getPropertyValue("--genre-width")) continue;
    const books = $$("[data-book-key]", section);
    const width = layout === "shelf"
      ? books.reduce((total, book) => total + $(".book-spine", book).offsetWidth + 3, 18)
      : books.length * (layout === "grid" ? 122 * zoom + 16 : Math.max(86, 92 * zoom) + 6);
    section.style.setProperty("--genre-width", `${Math.ceil(Math.max(158, width))}px`);
  }
}

const genreRows = new WeakMap();
const genreVisibility = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) maybeLoadShelfBooks(entry.target);
}, { rootMargin: "140px" });

function clearGenreBrowse() {
  state.genreBrowse?.rows.forEach((row) => genreVisibility.unobserve(row));
  state.genreBrowse = null;
}

function genreParams(browse, page) {
  const params = new URLSearchParams({ page, sort: browse.sort });
  browse.tags.forEach((tag) => params.append("tags", tag));
  return params;
}

async function loadGenrePage(reset = false) {
  if (reset) {
    invalidateCatalogue();
    state.genreBrowse = { page: 0, sort: resultSortForBrowse(), tags: [...state.selectedTags], rows: [] };
    $("#catalogue-end").replaceChildren();
  }
  const browse = state.genreBrowse;
  if (!browse || state.loading) return;
  const page = browse.page + 1;
  const target = $("#results");
  state.loading = true;
  target.setAttribute("aria-busy", "true");
  updatePagination();
  try {
    let result;
    if (state.user) {
      result = await request(`/catalogue/shelves?${genreParams(browse, page)}`);
    } else {
      const books = previewMatches();
      if (browse.sort === "title") books.sort((a, b) => a.title.localeCompare(b.title));
      if (browse.sort === "random") books.sort((a, b) => ((bookID(a) * 2654435761) >>> 0) - ((bookID(b) * 2654435761) >>> 0));
      result = { total: books.length, demo: true, has_more: false, shelves: PREVIEW_SECTIONS.map((title, section) => ({
        tag: title, title, books: books.filter((book) => book.section === section), has_more: false,
      })).filter((shelf) => shelf.books.length) };
    }
    if (state.genreBrowse !== browse) return;
    browse.page = page;
    state.hasMore = result.has_more;
    updatePreview(result);
    $("#results-count").textContent = `${result.total.toLocaleString()} ${result.total === 1 ? "novel" : "novels"}`;
    if (reset) {
      target.dataset.layout = "shelf";
      target.replaceChildren();
    }
    if (!result.shelves.length && reset) target.innerHTML = '<div class="empty">No novels match these filters.</div>';
    for (const shelf of result.shelves) {
      const section = shelfElement(groupMarkup([shelf], "shelf"));
      target.append(section);
      const row = $(".book-row", section);
      $$('[data-book-key]', row).forEach((trigger, index) => bindShelfBook(trigger, shelf.books[index]));
      row.tabIndex = 0;
      row.setAttribute("aria-label", shelf.title);
      const pager = { browse, shelf, page: 1, loading: false, seen: new Set(shelf.books.map(bookID)) };
      genreRows.set(row, pager);
      browse.rows.push(row);
      if (shelf.has_more) {
        row.addEventListener("scroll", () => maybeLoadShelfBooks(row), { passive: true });
        genreVisibility.observe(row);
      }
    }
    packDiscoverSections(!reset);
    queueSpineTitles();
  } catch (error) {
    if (state.genreBrowse === browse) {
      if (reset) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
      else setNotice(error.message, true);
    }
  } finally {
    if (state.genreBrowse === browse) {
      state.loading = false;
      target.removeAttribute("aria-busy");
      updatePagination();
      if (browse.page === page && state.hasMore && document.body.dataset.view === "discover") {
        requestAnimationFrame(() => {
          if (state.genreBrowse === browse && $("#scroll-sentinel").getBoundingClientRect().top <= innerHeight + 120) loadNextPage();
        });
      }
    }
  }
}

async function maybeLoadShelfBooks(row) {
  const pager = genreRows.get(row);
  if (!pager || !pager.shelf.has_more || pager.loading || pager.browse !== state.genreBrowse ||
      !row.clientWidth || document.body.dataset.view !== "discover" || row.scrollWidth - row.clientWidth - row.scrollLeft > 120) return;
  pager.loading = true;
  row.setAttribute("aria-busy", "true");
  try {
    const params = genreParams(pager.browse, pager.page + 1);
    params.set("shelf", pager.shelf.tag);
    const data = await request(`/catalogue/shelves?${params}`);
    if (!row.isConnected || state.genreBrowse !== pager.browse) return;
    pager.page++;
    pager.shelf.has_more = data.has_more;
    if (!data.has_more) genreVisibility.unobserve(row);
    for (const book of data.items) {
      const id = bookID(book);
      if (pager.seen.has(id)) continue;
      pager.seen.add(id);
      const trigger = shelfElement(bookMarkup(book, "shelf"));
      row.append(trigger);
      bindShelfBook(trigger, book);
    }
    queueSpineTitles();
  } catch (error) {
    if (row.isConnected && state.genreBrowse === pager.browse) setNotice(error.message, true);
  } finally {
    pager.loading = false;
    row.removeAttribute("aria-busy");
    if (!row.isConnected) genreVisibility.unobserve(row);
  }
}

function groupDiscoverBooks(books, previous = []) {
  if (!state.user && !state.selectedTags.size) {
    return PREVIEW_SECTIONS.map((title, section) => ({ title, books: books.filter((book) => book.section === section) }));
  }
  const tagKey = (tag) => tag.toLocaleLowerCase();
  const catalogueTags = new Map(state.catalogueTags.map((tag) => [tagKey(tag.name), tag]));
  const featured = new Set([...state.catalogueTags]
    .sort((a, b) => b.count - a.count).slice(0, 8).map((tag) => tagKey(tag.name)));
  const selected = new Set([...state.selectedTags].map(tagKey));
  const shelves = new Map(previous.map((group) => [group.key, { ...group, books: [...group.books] }]));
  const placed = new Set(previous.flatMap((group) => group.books.map(bookID)));
  const tagCount = (tag) => catalogueTags.get(tag)?.count || 1;
  const placeScore = (tag) => Math.log2(tagCount(tag) + 1) / (1 + (shelves.get(tag)?.books.length || 0) * .35);
  for (const book of books) {
    if (placed.has(bookID(book))) continue;
    const tags = new Map((book.tags || []).map((tag) => [tagKey(tag), tag]));
    const matches = [...tags.keys()].filter((tag) => featured.has(tag));
    const preferred = [...tags.keys()].find((tag) => selected.has(tag));
    const candidates = matches.length ? matches : [...tags.keys()];
    const key = preferred || candidates.sort((a, b) => placeScore(b) - placeScore(a))[0] || "";
    if (!shelves.has(key)) {
      shelves.set(key, { key, title: catalogueTags.get(key)?.name || tags.get(key) || "Untagged", books: [] });
    }
    shelves.get(key).books.push(book);
  }
  if (previous.length) return [...shelves.values()];
  const ordered = [...shelves.keys()].sort((a, b) =>
    Number(Boolean(b)) - Number(Boolean(a)) || tagCount(b) - tagCount(a) || a.localeCompare(b));
  return ordered.map((tag) => shelves.get(tag));
}

function updatePagination() {
  const button = $("#load-more");
  button.hidden = !state.hasMore;
  button.disabled = state.loading;
  button.textContent = state.loading ? "Loading" : state.genreBrowse ? "More shelves" : "Load more";
  if (state.hasMore) $("#catalogue-end").textContent = "";
}

async function loadNextPage() {
  if (!state.hasMore || state.loading) return;
  if (state.genreBrowse) return loadGenrePage();
  state.page += 1;
  if (state.currentQuery) await runSearch(false); else await loadCatalogue(false);
}

const BOOK_VIEWS = new Set(["discover", "library", "tiers", "favorites"]);

function syncLayoutControl(view) {
  const control = $("#book-layout");
  control.hidden = !BOOK_VIEWS.has(view);
  $$('[data-layout-choice]', control).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.layoutChoice === state.bookLayout));
  });
}

function initResultControls() {
  $("#book-layout").addEventListener("click", (event) => {
    const view = document.body.dataset.view;
    const layout = event.target.closest("[data-layout-choice]")?.dataset.layoutChoice;
    if (!BOOK_VIEWS.has(view) || !layout || layout === state.bookLayout) return;
    closeBookMenu();
    const changedShelfMode = layout === "shelf" || state.bookLayout === "shelf";
    state.bookLayout = layout;
    localStorage.setItem("novellist-book-layout", layout);
    syncLayoutControl(view);
    if (changedShelfMode && !state.currentQuery) loadCatalogue(true);
    else if (state.results.length) renderResults();
    drawLibrary();
    drawTierboard();
    if (state.favorites.length) drawFavorites();
    if (view === "tiers" && state.reviewSuggestions && !focusReviewBook(state.reviewBookId)) nextSuggestedBook();
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
  const layout = state.bookLayout;
  const closed = layout === "shelf" && !state.cabinetOpen;
  toolbar.hidden = !state.user;
  filters.inert = closed;
  const status = state.activeStatus;
  if (state.user && filters.dataset.status !== status) {
    filters.dataset.status = status;
    filters.innerHTML = timelineMarkup("Reading status", "filter", READING_STOPS, status, status === "all" ? "All statuses" : STATUS[status]) +
      `<button type="button" class="text-button library-all" aria-pressed="${status === "all"}">All</button>`;
    wireTimeline(filters, "filter", READING_STOPS, status, (next) => changeLibraryFilter(next, "#book-track-filter"));
    $(".library-all", filters).onclick = () => changeLibraryFilter("all", ".library-all");
  }
  const query = state.scopedQueries.library;
  const books = scopedMatches(state.items, query);
  const groups = READING_STOPS.map(([value, title]) => ({
    title, books: status === "all" || status === value ? books.filter((item) => displayStatus(item.status) === value) : [],
  })).filter((group) => layout === "shelf" || group.books.length);
  const hasBooks = groups.some((group) => group.books.length);
  const canReuse = keepBooks && target.dataset.layout === layout;
  target.dataset.layout = layout;
  const empty = !state.user ? "Sign in to start a personal library." : query
    ? "No saved novels match this search." : "No saved novels in this reading state.";
  const shelves = layout === "shelf" ? $(".cabinet-interior", target) : target;
  if (canReuse && shelves && layout === "shelf") {
    syncBookGroups(shelves, groups, layout);
    const inscription = $(".cabinet-inscription", shelves);
    inscription.hidden = hasBooks;
    inscription.textContent = empty;
    balanceCabinetShelves();
    queueSpineTitles();
    return;
  }
  if (canReuse && layout !== "shelf") {
    if (groups.length) {
      $(":scope > .empty", shelves)?.remove();
      syncBookGroups(shelves, groups, layout);
    } else if (!$(":scope > .empty", shelves)) {
      shelves.innerHTML = `<div class="empty">${empty}</div>`;
    }
    return;
  }
  if (layout === "shelf") {
    target.innerHTML = `<div class="library-cabinet" ${closed ? "" : "data-open"}>
      <div class="cabinet-interior" ${closed ? "inert" : ""}>${groupMarkup(groups, layout)}
        <p class="cabinet-inscription" ${hasBooks ? "hidden" : ""}>${empty}</p></div>
      <div class="cabinet-doors">
        ${["left", "right"].map((side) => `<button type="button" class="cabinet-door ${side}" data-cabinet-side="${side}" aria-label="${closed ? "Open" : "Close"} ${side} cabinet door" aria-expanded="${!closed}"><span aria-hidden="true"></span></button>`).join("")}
      </div></div>`;
    bindBookGroups(target, groups);
    balanceCabinetShelves();
    queueSpineTitles();
  } else if (groups.length) {
    drawBookGroups(target, groups, layout);
  } else {
    target.innerHTML = `<div class="empty">${empty}</div>`;
  }
}

function balanceCabinetShelves() {
  const interior = $(".cabinet-interior", $("#books"));
  if (!interior) return;
  const rows = $$(".book-row", interior);
  const width = rows[0]?.clientWidth;
  if (!width) return;
  const style = getComputedStyle(rows[0]);
  const capacity = width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const gap = parseFloat(style.columnGap) || 0;
  const home = READING_STOPS.map(() => []);
  for (const book of $$("[data-book-key]", interior)) {
    const status = displayStatus(shelfBooks.get(book)?.status);
    const index = READING_STOPS.findIndex(([value]) => value === status);
    if (index >= 0) home[index].push({ book, width: $(".book-spine", book).offsetWidth });
  }
  const destinations = rows.map(() => []);
  home.forEach((books, homeIndex) => {
    if (!books.length) return;
    let rowIndex = homeIndex;
    let used = 0;
    for (const { book, width: spineWidth } of books) {
      if (used && used + gap + spineWidth > capacity && rowIndex + 1 < rows.length && !home[rowIndex + 1].length) {
        rowIndex++;
        used = 0;
      }
      destinations[rowIndex].push(book);
      used += spineWidth + (used ? gap : 0);
    }
  });
  rows.forEach((row, index) => {
    const shelf = row.parentElement;
    const label = $(".shelf-label", shelf);
    const title = home[index].length ? READING_STOPS[index][1] : "";
    if (label.textContent !== title) label.textContent = title;
    const first = destinations[index][0];
    const description = title || (first ? `${STATUS[shelfBooks.get(first).status]} continued` : "");
    if (description && shelf.getAttribute("aria-label") !== description) shelf.setAttribute("aria-label", description);
    else if (!description) shelf.removeAttribute("aria-label");
    $(".shelf-empty", row)?.remove();
    let next = row.firstElementChild;
    for (const book of destinations[index]) {
      if (book !== next) {
        if (row.moveBefore) row.moveBefore(book, next);
        else row.insertBefore(book, next);
      }
      next = book.nextElementSibling;
    }
  });
}

function setCabinetOpen(open) {
  const cabinet = $(".library-cabinet");
  if (!cabinet) return;
  if (!open) closeBookMenu();
  state.cabinetOpen = open;
  cabinet.toggleAttribute("data-open", open);
  $(".cabinet-interior", cabinet).inert = !open;
  $("#filters").inert = !open;
  $$(".cabinet-door", cabinet).forEach((door) => {
    door.setAttribute("aria-label", `${open ? "Close" : "Open"} ${door.dataset.cabinetSide} cabinet door`);
    door.setAttribute("aria-expanded", String(open));
  });
}

function changeLibraryFilter(status, focusSelector) {
  if (state.activeStatus === status) {
    if (status === "all") return;
    status = "all";
  }
  closeBookMenu();
  state.activeStatus = status;
  drawLibrary(true);
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
  const layout = state.bookLayout;
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
  const books = scopedMatches(state.items, state.scopedQueries.tiers);
  const groups = tiers.map((tier) => ({ tier, title: tier === TRASH_TIER ? "Trash" : `Tier ${tier}`, books:
    books.filter((item) => item.tier === tier).sort((a, b) => (a.tier_position ?? 0) - (b.tier_position ?? 0)) }));
  const options = { tiers: true, draggable: true, review: state.reviewSuggestions, scope: target.id };
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
      if (state.reviewSuggestions && state.savedBooks.get(id)?.tier_source === "suggested") setReviewBook(id);
      if (state.scopedQueries.tiers) {
        const complete = state.items.filter((book) => book.tier === tier && book.novel_id !== id)
          .sort((a, b) => a.tier_position - b.tier_position).map((book) => book.novel_id);
        const index = order.indexOf(id);
        const next = complete.indexOf(order[index + 1]);
        const previous = complete.indexOf(order[index - 1]);
        complete.splice(next >= 0 ? next : previous >= 0 ? previous + 1 : complete.length, 0, id);
        order = complete;
      }
      await request(`/collection/${id}/move`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, ordered_novel_ids: order }) });
      await refreshLibrary({ keepBooks: true });
      if (!advanceReview(id)) setNotice("Tier list updated.");
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
  new ResizeObserver(balanceCabinetShelves).observe($("#books"));
  $("#books").addEventListener("click", (event) => {
    if (event.target.closest(".cabinet-door")) setCabinetOpen(!state.cabinetOpen);
  });
  $("#review-suggestions").addEventListener("click", () => {
    state.reviewSuggestions = !state.reviewSuggestions;
    state.reviewBookId = null;
    closeBookMenu();
    drawTierboard();
    if (state.reviewSuggestions && !nextSuggestedBook(suggestedBookIds()) && state.scopedQueries.tiers) {
      setNotice("No suggestions match this search.");
    }
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
      </div></article>`;
  } catch (error) {
    if (state.user === reader) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

async function renderCommunity() {
  const token = state.token;
  try {
    const data = await request("/shared-collections");
    if (token !== state.token) return;
    state.collections = data.collections;
    state.discussions = (data.discussion || []).map((entry) => ({ ...entry, description: entry.body }));
    drawCommunity();
    if (document.body.dataset.view === "community" && document.activeElement === $("#query")) queueSuggestions();
  } catch (error) {
    if (token !== state.token) return;
    const message = `<div class="empty">${escapeHTML(error.message)}</div>`;
    $("#shared-collections").innerHTML = message;
    $("#community-discussions").innerHTML = message;
  }
}

function discussionTime(created_at) {
  const date = new Date(created_at);
  const elapsed = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  const time = elapsed < 1 ? "Just now" : elapsed < 60 ? `${elapsed}m ago` : elapsed < 1440
    ? `${Math.floor(elapsed / 60)}h ago` : `${Math.floor(elapsed / 1440)}d ago`;
  return `<time datetime="${escapeHTML(created_at)}">${time}</time>`;
}

function discussionMarkup({ collection_id, thread_id, name, body, username, created_at, comment_count }) {
  const target = thread_id ? `data-open-thread="${thread_id}"` : `data-open-discussion="${collection_id}"`;
  const noun = thread_id ? (comment_count === 1 ? "reply" : "replies") : (comment_count === 1 ? "comment" : "comments");
  return `<article class="discussion-item">
    <button type="button" class="collection-title" ${target}>${escapeHTML(name)}</button>
    <p>${escapeHTML(body)}</p>
    <div class="discussion-item-meta"><small>${escapeHTML(username)} · ${comment_count} ${noun} · ${discussionTime(created_at)}</small>
      <button type="button" class="text-button" ${target} data-focus-reply aria-label="Reply to ${escapeHTML(name)}">Reply</button></div>
  </article>`;
}

function drawCommunity() {
  const target = $("#shared-collections");
  const query = state.scopedQueries.community;
  const collections = query ? communityMatches(query) : state.collections;
  const discussions = scopedMatches(state.discussions, query);
  $("#community-discussions").innerHTML = discussions.map(discussionMarkup).join("") ||
    `<div class="empty">${query ? "No discussions match this search." : "No public discussion yet."}</div>`;
  $("#discussion-highlights").innerHTML = discussions.slice(0, 4).map(discussionMarkup).join("") ||
    '<p class="subtle">No recent comments.</p>';
  if (!collections.length) {
    target.innerHTML = `<div class="empty">${query ? "No collections match this search." : "No public collections yet."}</div>`;
    return;
  }
  target.innerHTML = collections.map(({ id, name, username, description, following, followers, books }) => `<article class="collection-card">
    ${books?.length ? `<button class="collection-preview" data-open-collection="${id}" type="button" aria-label="Open ${escapeHTML(name)}">
      ${books.slice(0, 3).map((book) => `<span class="book-face shelf-book" data-binding="${book.novel_id % 8}">${coverMarkup(book, "book-jacket")}</span>`).join("")}</button>` : ""}
    <div class="collection-summary">
      <h2><button class="collection-title" data-open-collection="${id}" type="button">${escapeHTML(name)}</button></h2>
      ${description ? `<p>${escapeHTML(description)}</p>` : ""}
      <div class="collection-meta"><button class="text-button byline" data-reader="${escapeHTML(username)}" type="button">${glyph("CircleUserRound")} ${escapeHTML(username)}</button>
        <button class="text-button collection-discuss" data-open-discussion="${id}" data-focus-reply type="button">Discuss</button>
        <button class="outline-button" data-follow-collection="${id}" aria-pressed="${Boolean(following)}" type="button">${following ? "Following" : "Follow"}${followers ? ` · ${followers}` : ""}</button></div>
    </div>
  </article>`).join("");
  bindCoverFallbacks(target);
}

function selectCommunityPanel(panel, focus = false) {
  state.communityPanel = panel;
  $("#shared-collections").hidden = panel !== "collections";
  $("#community-discussions").hidden = panel !== "discussion";
  $("#discussion-preview").hidden = panel === "discussion";
  $("#community-request").hidden = panel === "discussion";
  if (panel === "discussion") $("#community-request").open = false;
  $$("#community-tabs [role=tab]").forEach((tab) => {
    const selected = tab.dataset.communityPanel === panel;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  syncScopedSearch("community");
}

async function renderFavorites() {
  const target = $("#owner-favorites");
  try {
    state.favorites = (await request("/favorites")).items;
    drawFavorites();
  } catch (error) {
    target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

function drawFavorites() {
  const target = $("#owner-favorites");
  if (state.favorites.length) drawBookGroups(target, [{ title: "S tier", books: state.favorites }], state.bookLayout);
  else target.innerHTML = '<div class="empty">No S-tier favorites have been added yet.</div>';
}

async function createSharedCollection(event) {
  event.preventDefault();
  if (!state.user) return openLogin();
  try {
    await request("/shared-collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#collection-name").value, description: $("#collection-description").value, visibility: "public" }) });
    event.target.reset();
    event.target.closest("details").open = false;
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

function openCommunityDetail() {
  closeBookMenu();
  openModal("collection-modal");
  const target = $("#collection-detail");
  target.parentElement.scrollTop = 0;
  target.innerHTML = '<div class="skeleton wide"></div>';
  return target;
}

function openDiscussionComposer() {
  if (!state.user) return openLogin();
  const target = openCommunityDetail();
  target.innerHTML = `<div class="community-detail-header"><h2>Start a discussion</h2></div>
    <form id="discussion-topic-form" class="discussion-composer discussion-topic-form">
      <label>Title<input name="title" required maxlength="120" placeholder="What do you want to talk about?"></label>
      <label>Message<textarea name="body" required maxlength="2000" rows="4"></textarea></label>
      <div class="discussion-submit"><p class="form-message" role="status"></p><button class="primary-button" type="submit">Post discussion</button></div>
    </form>`;
  const form = $("#discussion-topic-form", target);
  $("input", form).focus();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $('button[type="submit"]', form);
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      const { id } = await request("/discussions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (form.isConnected && $("#collection-modal").classList.contains("open")) await openDiscussion(id);
      state.scopedQueries.community = "";
      selectCommunityPanel("discussion");
      renderCommunity();
    } catch (error) {
      $(".form-message", form).textContent = error.message;
      $(".form-message", form).dataset.state = "error";
    } finally {
      submit.disabled = false;
    }
  });
}

function communityMessage({ username, created_at, body }) {
  return `<article class="community-message"><header><strong>${escapeHTML(username)}</strong>${discussionTime(created_at)}</header><p>${escapeHTML(body)}</p></article>`;
}

function communityConversation(messages, empty, label) {
  return `<div class="community-messages" aria-live="polite">${messages.map(communityMessage).join("") || `<p class="subtle" data-empty-thread>${empty}</p>`}</div>
    <form class="discussion-composer" id="collection-comment-form">
      <textarea id="collection-comment" name="body" aria-label="${label}" maxlength="2000" required rows="3" placeholder="${label}"></textarea>
      <div class="discussion-submit"><p class="form-message" role="status"></p><button class="primary-button" type="submit">Post reply</button></div>
    </form>`;
}

function bindConversation(target, endpoint) {
  const form = $(".discussion-composer", target);
  const field = $("textarea", form);
  const submit = $('button[type="submit"]', form);
  const feedback = $(".form-message", form);
  const messages = $(".community-messages", target);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.user) return openLogin();
    if (submit.disabled) return;
    const body = field.value;
    submit.disabled = true;
    try {
      const message = await request(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }),
      });
      if (form.isConnected) {
        $("[data-empty-thread]", messages)?.remove();
        messages.insertAdjacentHTML("beforeend", communityMessage(message));
        if (field.value === body) field.value = "";
        feedback.dataset.state = "";
        feedback.textContent = "Reply posted.";
        const tab = $("[data-collection-panel=discussion]");
        if (tab) tab.textContent = `Discussion · ${messages.childElementCount}`;
      }
      renderCommunity();
    } catch (error) {
      feedback.dataset.state = "error";
      feedback.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

async function openDiscussion(threadId, focusReply = false) {
  const target = openCommunityDetail();
  const loading = target.firstElementChild;
  try {
    const thread = await request(`/discussions/${threadId}`);
    if (!loading.isConnected || !$("#collection-modal").classList.contains("open")) return;
    target.innerHTML = `<div class="community-detail-header"><h2 tabindex="-1">${escapeHTML(thread.title)}</h2></div>
      <div class="thread-opening">${communityMessage(thread)}</div>
      <div class="thread-conversation">${communityConversation(thread.replies, "No replies yet.", "Write a reply")}</div>`;
    bindConversation(target, `/discussions/${threadId}/replies`);
    $(focusReply ? "#collection-comment" : "h2", target).focus({ preventScroll: !focusReply });
  } catch (error) {
    if (loading.isConnected) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

async function openCollection(collectionId, { novelId, keyboard = false, discussion = false, focusReply = false } = {}) {
  const target = openCommunityDetail();
  const loading = target.firstElementChild;
  try {
    const [collection, comments] = await Promise.all([request(`/shared-collections/${collectionId}`), request(`/shared-collections/${collectionId}/comments`)]);
    if (!loading.isConnected || !$("#collection-modal").classList.contains("open")) return;
    const savedOptions = state.items.map((item) => `<option value="${item.novel_id}">${escapeHTML(item.title)}</option>`).join("");
    const owned = state.user?.id === collection.user_id;
    const groups = TIERS.map((tier) => ({ tier, title: `Tier ${tier}`, books:
      collection.items.filter((book) => (book.tier || "C") === tier).sort((a,b) => a.position - b.position) }));
    const layout = state.bookLayout;
    target.innerHTML = `<header class="community-detail-header"><h2 tabindex="-1">${escapeHTML(collection.name)}</h2>
      <p class="subtle">${escapeHTML(collection.username)} · ${collection.items.length} ${collection.items.length === 1 ? "novel" : "novels"}</p>
      ${collection.description ? `<p>${escapeHTML(collection.description)}</p>` : ""}</header>
      <div class="segmented collection-panels" role="group" aria-label="Collection view">
        <button type="button" data-collection-panel="gallery" aria-controls="collection-gallery" aria-pressed="${!discussion}">Gallery</button>
        <button type="button" data-collection-panel="discussion" aria-controls="collection-discussion" aria-pressed="${discussion}">Discussion · ${comments.comments.length}</button>
      </div>
      <div id="collection-gallery" ${discussion ? "hidden" : ""}>
        <div class="book-collection shared-books">${collection.items.length ? "" : '<div class="empty">No novels have been added yet.</div>'}</div>
        ${owned ? `<div class="collection-actions collection-add"><select id="collection-item-select" aria-label="Saved novel">${savedOptions || '<option value="">Save a novel first</option>'}</select><button id="add-collection-item" class="outline-button" type="button">Add saved novel</button></div>` : ""}
      </div>
      <div id="collection-discussion" ${discussion ? "" : "hidden"}>${communityConversation([...comments.comments].reverse(), "Start the conversation.", "Write a comment")}</div>`;
    if (collection.items.length) {
      drawBookGroups($(".shared-books", target), owned ? groups : groups.filter((group) => group.books.length), layout,
        { tiers: true, draggable: owned, scope: `shared-${collectionId}` });
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
    bindConversation(target, `/shared-collections/${collectionId}/comments`);
    $(".collection-panels", target).addEventListener("click", (event) => {
      const button = event.target.closest("[data-collection-panel]");
      if (!button) return;
      closeBookMenu();
      const thread = button.dataset.collectionPanel === "discussion";
      $("#collection-gallery", target).hidden = thread;
      $("#collection-discussion", target).hidden = !thread;
      $$("[data-collection-panel]", target).forEach((tab) => tab.setAttribute("aria-pressed", String(tab === button)));
      if (!thread) queueSpineTitles();
    });
    $(focusReply ? "#collection-comment" : "h2", target).focus({ preventScroll: !focusReply });
    if (!discussion && novelId) {
      const novel = $(`[data-book-key="${novelId}"]`, target);
      if (novel?.closest(".modal.open")) {
        novel.scrollIntoView({ block: "nearest" });
        if (novel.matches(BOOK_TRIGGER)) openBookMenu(novel, { pin: true, keyboard });
        else $("input", novel)?.focus({ preventScroll: true });
      }
    }
  } catch (error) {
    if (loading.isConnected) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
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

async function openReaderProfile(username) {
  const target = openCommunityDetail();
  const loading = target.firstElementChild;
  try {
    const data = await request(`/profiles/${encodeURIComponent(username)}`);
    if (!loading.isConnected || !$("#collection-modal").classList.contains("open")) return;
    target.innerHTML = `<p class="eyebrow">Reader profile</p><h2>${escapeHTML(data.username)}</h2><p class="subtle">${data.library_count} saved novels</p><div class="taste-tags">${data.favorite_tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join("")}</div><h3>S-tier favourites</h3><div class="collection-detail-grid">${data.favorites.length ? data.favorites.map((book) => `<article class="collection-detail-book">${coverMarkup(book)}<strong>${escapeHTML(book.title)}</strong></article>`).join("") : '<div class="empty">No confirmed public favourites yet.</div>'}</div>`;
    bindCoverFallbacks(target);
  } catch (error) {
    if (loading.isConnected) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
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
  state.scopedQueries = {};
  state.collections = [];
  state.discussions = [];
  state.activeStatus = "all";
  state.reviewSuggestions = false;
  state.reviewBookId = null;
  state.catalogueTags = [];
  state.selectedTags.clear();
  updateSelectedTags();
  invalidateCatalogue();
  localStorage.removeItem("novellist-token");
  syncReaderMenu();
  syncScopedSearch(document.body.dataset.view);
  applyBookZoom();
  drawLibrary();
  drawTierboard();
  renderAnalytics();
  renderAccount();
  renderCommunity();
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
  if (document.body.dataset.view === "community") renderCommunity();
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
  });
  $("#reader-signout").addEventListener("click", signOut);
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
  $("#start-discussion").addEventListener("click", openDiscussionComposer);
  $("#community-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-community-panel]");
    if (tab) selectCommunityPanel(tab.dataset.communityPanel);
  });
  $("#community-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const panel = event.key === "Home" ? "collections" : event.key === "End" ? "discussion"
      : state.communityPanel === "collections" ? "discussion" : "collections";
    selectCommunityPanel(panel, true);
  });
  $("#community").addEventListener("click", (event) => {
    const action = event.target.closest("[data-open-collection], [data-open-discussion], [data-open-thread], [data-follow-collection], [data-reader]");
    if (!action) return;
    const focusReply = action.hasAttribute("data-focus-reply");
    if (action.dataset.openCollection) openCollection(Number(action.dataset.openCollection));
    if (action.dataset.openDiscussion) openCollection(Number(action.dataset.openDiscussion), { discussion: true, focusReply });
    if (action.dataset.openThread) openDiscussion(Number(action.dataset.openThread), focusReply);
    if (action.dataset.followCollection) followCollection(Number(action.dataset.followCollection), action.getAttribute("aria-pressed") !== "true");
    if (action.dataset.reader) openReaderProfile(action.dataset.reader);
  });
  $("#request-novel").addEventListener("click", submitNovelRequest);
  $("#scrape-form").addEventListener("submit", startScrape);
  $("#custom-scrape-form").addEventListener("submit", startCustomScrape);
  $("#catalogue-editor").addEventListener("submit", saveCatalogueRecord);
  $("#editor-reset").addEventListener("click", resetBookEditor);
  $("#direct-form").addEventListener("submit", startDirectDiscovery);
  bindScopedSearch();
  $("#open-filters").addEventListener("click", () => {
    const panel = $("#tag-dialog");
    if (panel.open) return closeFilters(true);
    panel.show();
    $("#open-filters").setAttribute("aria-expanded", "true");
    positionFilters();
    renderTagCloud();
    $("#tag-query").focus({ preventScroll: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if ($("#tag-dialog").open && !event.target.closest("#tag-dialog,#open-filters")) closeFilters();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#tag-dialog").open) closeFilters(true);
  });
  window.addEventListener("resize", positionFilters);
  window.addEventListener("scroll", positionFilters, { passive: true });
  $("#tag-query").addEventListener("input", renderTagCloud);
  $("#clear-tags").addEventListener("click", () => {
    const hadTags = state.selectedTags.size > 0;
    state.selectedTags.clear();
    $("#tag-query").value = "";
    renderTagCloud();
    if (hadTags) state.currentQuery ? runSearch(true) : loadCatalogue(true);
    $("#tag-query").focus({ preventScroll: true });
  });
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
