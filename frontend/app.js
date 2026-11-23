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
const COMMUNITY_VIEWS = new Set(["community", "collection", "new-collection", "discussion", "new-discussion"]);
const VIEW_TITLES = {
  discover: "Discover novels",
  library: "Your library",
  tiers: "Your tier list",
  models: "How NoveList works",
  analytics: "Reading analytics",
  community: "Community",
  collection: "Collection",
  "new-collection": "Create a collection",
  discussion: "Discussion",
  "new-discussion": "Start a discussion",
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
  collection: "Browse novels and join the conversation about this collection.",
  "new-collection": "Create a collection to share with other readers.",
  discussion: "Follow a conversation with other readers.",
  "new-discussion": "Start a conversation with other readers.",
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
let shownRoute;
let collectionPage;

function routeParams() {
  return new URLSearchParams(location.hash.split("?")[1]);
}

function collectionRoute(id, panel = "gallery") {
  return `collection?id=${id}${panel === "discussion" ? "&panel=discussion" : ""}`;
}

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

function showView(options = {}) {
  let viewName = currentView();
  if (viewName === "admin" && state.user?.role !== "admin") viewName = "discover";
  const route = location.hash.slice(1);
  const previousView = document.body.dataset.view;
  if (previousView === viewName && shownRoute === route && !options.focusReply && !options.novelId) return;
  shownRoute = route;
  if (previousView === "collection" && viewName === "collection" && collectionPage?.data.id === Number(routeParams().get("id"))) {
    selectCollectionPanel(routeParams().get("panel"));
    focusCollectionContent(options);
    return;
  }
  collectionPage = null;
  closeBookMenu();
  closeFilters();
  $("#reader-menu").open = false;
  if (previousView) window.scrollTo({ top: 0, behavior: "instant" });
  slideView(previousView, viewName);
  $$("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === (COMMUNITY_VIEWS.has(viewName) ? "community" : viewName);
    link.classList.toggle("active", active);
    if (link.dataset.nav === viewName) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
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
  if (viewName === "community") {
    if (COMMUNITY_VIEWS.has(previousView)) selectCommunityPanel("collections");
    renderCommunity();
    if (state.communityPanel === "requests") loadNovelRequests();
  }
  if (viewName === "new-collection") $("#new-collection-heading").focus({ preventScroll: true });
  if (viewName === "new-discussion") $("#new-discussion-heading").focus({ preventScroll: true });
  if (viewName === "collection") {
    renderCollectionPage(options);
    renderCommunity();
  }
  if (viewName === "discussion") renderDiscussionPage(options);
  if (viewName === "favorites") renderFavorites();
  if (viewName === "account") renderAccount();
  if (viewName === "admin") refreshJobs();
  if (viewName === "library") balanceCabinetShelves();
  if (viewName === "discover") packDiscoverSections();
  queueSpineTitles();
}

function navigateTo(route, options) {
  if (location.hash !== `#${route}`) history.pushState(null, "", `#${route}`);
  showView(options);
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
    const link = event.target.closest('a[href^="#"]');
    const route = link?.getAttribute("href").slice(1);
    if (!route || !Object.hasOwn(VIEW_TITLES, route.split("?")[0])) return;
    event.preventDefault();
    $("#reader-menu").open = false;
    navigateTo(route, { focusReply: link.hasAttribute("data-focus-reply") });
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
  const inRequests = view === "community" && state.communityPanel === "requests";
  const scope = inRequests ? ["Search novel requests", "Novel title or requester"] : SEARCH_SCOPES[view];
  $("#discover-search").hidden = !scope;
  $("#open-filters").hidden = view !== "discover";
  $("#browse-sort").hidden = view !== "discover" || Boolean(state.currentQuery);
  if (!scope) return;
  $("#discover-search").setAttribute("aria-label", scope[0]);
  $("#search-label").textContent = scope[0];
  $("#query").placeholder = scope[1];
  $("#query").value = view === "discover" ? state.currentQuery : state.scopedQueries[inRequests ? "requests" : view] || "";
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
        if (state.communityPanel === "requests") {
          if (!state.user) return;
          const params = new URLSearchParams({ q: query.slice(0, 300) });
          const data = await request(`/requests?${params}`, { signal: controller.signal });
          matches = data.requests.map(({ query: title, username }) => ({ title, username }));
        } else {
          const books = communityBookMatches(query);
          matches = [...books.slice(0, 4), ...communityMatches(query, books), ...scopedMatches(state.discussions, query)];
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
  if (view === "community" && state.communityPanel === "requests") {
    state.scopedQueries.requests = query.slice(0, 300);
    await loadNovelRequests();
    return;
  }
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
      if (option?.thread_id) navigateTo(`discussion?id=${option.thread_id}`);
      else if (option?.collection_id) navigateTo(collectionRoute(option.collection_id, "discussion"));
      else if (option) navigateTo(collectionRoute(option.collectionId || option.id), { novelId: option.novel_id, keyboard });
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

function usesHorizontalRows(layout) {
  return layout === "shelf" || layout === "grid";
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
  if (usesHorizontalRows(state.bookLayout)) return loadGenrePage(reset);
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
  let rendered = false;
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
    rendered = true;
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
      if (rendered && horizontalSearchRow && state.hasMore) {
        requestAnimationFrame(() => loadMoreDiscoverRow(horizontalSearchRow));
      }
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
    observeHorizontalSearch(null);
    target.innerHTML = '<div class="empty">No novels match these filters.</div>';
    updatePagination();
    return;
  }
  const groups = state.currentQuery
    ? [{ title: "Search results", books }]
    : groupDiscoverBooks(books, keepBooks ? state.discoverGroups : []);
  state.discoverGroups = groups;
  const options = { horizontal: layout === "grid" };
  if (keepBooks) syncBookGroups(target, groups, layout, options);
  else drawBookGroups(target, groups, layout, options);
  observeHorizontalSearch(state.currentQuery && layout === "grid" ? $(".book-row", target) : null);
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
  const sections = $$(":scope > .book-section", target);
  if (layout === "dense") {
    packCompactGenres(target, sections, zoom);
    return;
  }
  for (const section of sections) {
    if (keepWidths && section.style.getPropertyValue("--genre-width")) continue;
    const books = $$("[data-book-key]", section);
    const row = $(".book-row", section);
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const width = books.reduce((total, book) => total + (layout === "shelf" ? $(".book-spine", book) : book).offsetWidth + gap, 18);
    section.style.setProperty("--genre-width", `${Math.ceil(Math.max(158, width))}px`);
  }
}

function packCompactGenres(target, sections, zoom) {
  if (!sections.length) return;
  const gap = 12;
  const width = target.clientWidth;
  const columns = Math.max(1, Math.floor((width + gap) / (Math.max(70, 77 * zoom) + 18 + gap)));
  const stride = (width + gap) / columns;
  const spans = sections.map((section) => {
    const count = Math.max(1, $(".book-row", section).children.length);
    const span = sections.length === 1 ? columns : Math.min(columns, count, Math.ceil(Math.sqrt(count * 1.5)));
    section.style.setProperty("--genre-width", `${span * stride - gap}px`);
    return span;
  });
  const heights = sections.map((section) => section.offsetHeight);
  const bottoms = Array(columns).fill(0);
  sections.forEach((section, index) => {
    const span = spans[index];
    let top = Infinity;
    let column = 0;
    for (let start = 0; start + span <= columns; start++) {
      const available = Math.max(...bottoms.slice(start, start + span));
      if (available < top) {
        top = available;
        column = start;
      }
    }
    section.style.setProperty("--genre-x", `${column * stride}px`);
    section.style.setProperty("--genre-y", `${top}px`);
    bottoms.fill(top + heights[index] + gap, column, column + span);
  });
  target.style.setProperty("--genre-height", `${Math.max(...bottoms) - gap}px`);
}

const genreRows = new WeakMap();
let horizontalSearchRow;
const genreVisibility = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) loadMoreDiscoverRow(entry.target);
}, { rootMargin: "140px" });

function observeHorizontalSearch(row) {
  if (horizontalSearchRow === row) return;
  if (horizontalSearchRow) genreVisibility.unobserve(horizontalSearchRow);
  horizontalSearchRow = row;
  if (row) genreVisibility.observe(row);
}

function clearGenreBrowse() {
  state.genreBrowse?.rows.forEach((row) => genreVisibility.unobserve(row));
  state.genreBrowse = null;
  observeHorizontalSearch(null);
}

function genreParams(browse, page) {
  const params = new URLSearchParams({ page, sort: browse.sort });
  browse.tags.forEach((tag) => params.append("tags", tag));
  return params;
}

async function loadGenrePage(reset = false) {
  if (reset) {
    invalidateCatalogue();
    state.genreBrowse = { layout: state.bookLayout, page: 0, sort: resultSortForBrowse(), tags: [...state.selectedTags], rows: [] };
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
      target.dataset.layout = browse.layout;
      target.replaceChildren();
    }
    if (!result.shelves.length && reset) target.innerHTML = '<div class="empty">No novels match these filters.</div>';
    for (const shelf of result.shelves) {
      const section = shelfElement(groupMarkup([shelf], browse.layout, { horizontal: true }));
      target.append(section);
      const row = $(".book-row", section);
      $$('[data-book-key]', row).forEach((trigger, index) => bindShelfBook(trigger, shelf.books[index]));
      const pager = { browse, shelf, page: 1, loading: false, seen: new Set(shelf.books.map(bookID)) };
      genreRows.set(row, pager);
      browse.rows.push(row);
      if (shelf.has_more) genreVisibility.observe(row);
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

async function loadMoreDiscoverRow(row) {
  if (!row?.isConnected || !row.clientWidth || document.body.dataset.view !== "discover" ||
      row.scrollWidth - row.clientWidth - row.scrollLeft > 120) return;
  if (row === horizontalSearchRow) {
    if (state.currentQuery && state.bookLayout === "grid") await loadNextPage();
    return;
  }
  const pager = genreRows.get(row);
  if (!pager || !pager.shelf.has_more || pager.loading || pager.browse !== state.genreBrowse) return;
  pager.loading = true;
  let advanced = false;
  row.setAttribute("aria-busy", "true");
  try {
    const params = genreParams(pager.browse, pager.page + 1);
    params.set("shelf", pager.shelf.tag);
    const data = await request(`/catalogue/shelves?${params}`);
    if (!row.isConnected || state.genreBrowse !== pager.browse) return;
    pager.page++;
    advanced = data.has_more;
    pager.shelf.has_more = data.has_more;
    if (!data.has_more) genreVisibility.unobserve(row);
    for (const book of data.items) {
      const id = bookID(book);
      if (pager.seen.has(id)) continue;
      pager.seen.add(id);
      const trigger = shelfElement(bookMarkup(book, pager.browse.layout));
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
    else if (advanced) requestAnimationFrame(() => loadMoreDiscoverRow(row));
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

const BOOK_VIEWS = new Set(["discover", "library", "tiers", "favorites", "collection"]);

function syncLayoutControl(view) {
  const control = $("#book-layout");
  control.hidden = !BOOK_VIEWS.has(view);
  $$('[data-layout-choice]', control).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.layoutChoice === state.bookLayout));
  });
}

function initResultControls() {
  let resultsWidth;
  const results = $("#results");
  new ResizeObserver(([{ contentRect: { width } }]) => {
    if (!width || width === resultsWidth) return;
    resultsWidth = width;
    if (results.dataset.layout === "dense") packDiscoverSections();
  }).observe(results);
  results.addEventListener("scroll", ({ target }) => {
    if (target.matches(".book-row")) loadMoreDiscoverRow(target);
  }, { capture: true, passive: true });
  $("#book-layout").addEventListener("click", (event) => {
    const view = document.body.dataset.view;
    const layout = event.target.closest("[data-layout-choice]")?.dataset.layoutChoice;
    if (!BOOK_VIEWS.has(view) || !layout || layout === state.bookLayout) return;
    closeBookMenu();
    const changedGenreLayout = usesHorizontalRows(layout) || usesHorizontalRows(state.bookLayout);
    state.bookLayout = layout;
    localStorage.setItem("novellist-book-layout", layout);
    syncLayoutControl(view);
    if (changedGenreLayout && !state.currentQuery) loadCatalogue(true);
    else if (state.results.length) renderResults();
    drawLibrary();
    drawTierboard();
    if (view === "collection" && collectionPage) drawCollectionGallery();
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
    collectionPage?.refreshPicker?.();
    if (!keepBooks && collectionPage) drawCollectionGallery();
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
  const covers = layout === "grid";
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
  })).filter((group) => usesHorizontalRows(layout) || group.books.length);
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
    const options = { horizontal: covers };
    if (canReuse) {
      $(":scope > .empty", target)?.remove();
      syncBookGroups(target, groups, layout, options);
    } else drawBookGroups(target, groups, layout, options);
    if (covers && !hasBooks) target.insertAdjacentHTML("afterbegin", `<p class="empty library-cover-inscription">${empty}</p>`);
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
  const options = { tiers: true, draggable: true, review: state.reviewSuggestions, scope: target.id, horizontal: layout === "grid" };
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
    drawRelatedCollections();
    if (document.body.dataset.view === "community" && state.communityPanel === "collections" &&
        document.activeElement === $("#query")) queueSuggestions();
  } catch (error) {
    if (token !== state.token) return;
    const message = `<div class="empty">${escapeHTML(error.message)}</div>`;
    $("#shared-collections").innerHTML = message;
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
  const href = thread_id ? `#discussion?id=${thread_id}` : `#${collectionRoute(collection_id, "discussion")}`;
  const noun = thread_id ? (comment_count === 1 ? "reply" : "replies") : (comment_count === 1 ? "comment" : "comments");
  return `<article class="discussion-item">
    <a class="collection-title" href="${href}">${escapeHTML(name)}</a>
    <p>${escapeHTML(body)}</p>
    <div class="discussion-item-meta"><small>${escapeHTML(username)} · ${comment_count} ${noun} · ${discussionTime(created_at)}</small>
      <a class="text-link" href="${href}" data-focus-reply aria-label="Reply to ${escapeHTML(name)}">Reply</a></div>
  </article>`;
}

function drawCommunity() {
  const target = $("#shared-collections");
  const query = state.scopedQueries.community;
  const collections = query ? communityMatches(query) : state.collections;
  const discussions = scopedMatches(state.discussions, query);
  $("#discussion-highlights").innerHTML = discussions.slice(0, 4).map(discussionMarkup).join("") ||
    `<p class="subtle">${query ? "No discussions match this search." : "No recent discussions."}</p>`;
  if (!collections.length) {
    target.innerHTML = `<div class="empty">${query ? "No collections match this search." : "No public collections yet."}</div>`;
    return;
  }
  target.innerHTML = collections.map(({ id, name, username, description, following, followers, books }) => `<article class="collection-card">
    <a class="collection-preview" href="#${collectionRoute(id)}" aria-label="Open ${escapeHTML(name)}">
      ${books.length ? books.slice(0, 3).map((book) => `<span class="book-face shelf-book" data-binding="${book.novel_id % 8}">${coverMarkup(book, "book-jacket")}</span>`).join("") : `<span class="collection-preview-empty">${glyph("LibraryBig")}</span>`}</a>
    <div class="collection-summary">
      <h2><a class="collection-title" href="#${collectionRoute(id)}">${escapeHTML(name)}</a></h2>
      ${description ? `<p>${escapeHTML(description)}</p>` : ""}
      <div class="collection-meta"><button class="text-button byline" data-reader="${escapeHTML(username)}" type="button">${glyph("CircleUserRound")} ${escapeHTML(username)}</button>
        <a class="text-link" href="#${collectionRoute(id, "discussion")}">Discuss</a>
        <button class="outline-button" data-follow-collection="${id}" aria-pressed="${Boolean(following)}" type="button">${following ? "Following" : "Follow"}${followers ? ` · ${followers}` : ""}</button></div>
    </div>
  </article>`).join("");
  bindCoverFallbacks(target);
}

function selectCommunityPanel(panel, focus = false) {
  const changed = state.communityPanel !== panel;
  state.communityPanel = panel;
  $("#collections-panel").hidden = panel !== "collections";
  $("#community-actions").hidden = panel !== "collections";
  $("#novel-requests-panel").hidden = panel !== "requests";
  $$("#community-tabs [role=tab]").forEach((tab) => {
    const selected = tab.dataset.communityPanel === panel;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  if (changed) {
    syncScopedSearch("community");
    if (panel === "requests") loadNovelRequests();
  }
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
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const feedback = $(".form-message", form);
  if (button.disabled) return;
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  feedback.textContent = "";
  try {
    const { id } = await request("/shared-collections", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    form.reset();
    if (currentView() !== "new-collection") {
      if (currentView() === "community") renderCommunity();
      return;
    }
    state.scopedQueries.community = "";
    navigateTo(collectionRoute(id));
    setNotice("Collection created.");
  } catch (error) {
    feedback.dataset.state = "error";
    feedback.textContent = error.message;
  } finally { button.disabled = false; }
}

async function followCollection(collectionId, following) {
  if (!state.user) return openLogin();
  try {
    await request(`/shared-collections/${collectionId}/follow`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ following }) });
    await renderCommunity();
    setNotice(following ? "Collection followed." : "Collection unfollowed.");
  } catch (error) { setNotice(error.message, true); }
}

async function createDiscussion(event) {
  event.preventDefault();
  if (!state.user) return openLogin();
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  const feedback = $(".form-message", form);
  if (submit.disabled) return;
  submit.disabled = true;
  feedback.textContent = "";
  try {
    const data = Object.fromEntries(new FormData(form));
    const { id } = await request("/discussions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    form.reset();
    if (currentView() === "new-discussion") navigateTo(`discussion?id=${id}`);
    else if (currentView() === "community") renderCommunity();
  } catch (error) {
    feedback.dataset.state = "error";
    feedback.textContent = error.message;
  } finally { submit.disabled = false; }
}

function communityMessage({ username, created_at, body }) {
  return `<article class="community-message"><header><strong>${escapeHTML(username)}</strong>${discussionTime(created_at)}</header><p>${escapeHTML(body)}</p></article>`;
}

function communityConversation(messages, empty, label) {
  return `<div class="community-messages" aria-live="polite">${messages.map(communityMessage).join("") || `<p class="subtle" data-empty-thread>${empty}</p>`}</div>
    <form class="discussion-composer">
      <textarea name="body" aria-label="${label}" maxlength="2000" required rows="3" placeholder="${label}"></textarea>
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
        const tab = $("[data-collection-panel=discussion]", target);
        if (tab) tab.textContent = `Discussion · ${messages.childElementCount}`;
      }
    } catch (error) {
      feedback.dataset.state = "error";
      feedback.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

async function renderDiscussionPage({ focusReply = false } = {}) {
  const threadId = Number(routeParams().get("id"));
  const target = $("#discussion-detail");
  if (!Number.isSafeInteger(threadId) || threadId < 1) {
    target.innerHTML = '<div class="empty">Discussion not found.</div>';
    return;
  }
  target.innerHTML = '<div class="skeleton wide"></div>';
  const loading = target.firstElementChild;
  try {
    const thread = await request(`/discussions/${threadId}`);
    if (!loading.isConnected || currentView() !== "discussion") return;
    target.innerHTML = `<header class="community-detail-header"><h1 tabindex="-1">${escapeHTML(thread.title)}</h1></header>
      <div class="thread-opening">${communityMessage(thread)}</div>
      ${communityConversation(thread.replies, "No replies yet.", "Write a reply")}`;
    bindConversation(target, `/discussions/${threadId}/replies`);
    $(focusReply ? "textarea" : "h1", target).focus({ preventScroll: !focusReply });
  } catch (error) {
    if (loading.isConnected) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

function drawRelatedCollections() {
  const target = $("#related-collections");
  const current = collectionPage?.data;
  target.hidden = true;
  if (!current) return;
  const ids = new Set(current.items.map(bookID));
  const authors = new Set(current.items.map((book) => searchText(book.author)).filter((name) => name && name !== "unknown"));
  const related = state.collections.filter((collection) => collection.id !== current.id).map((collection) => {
    const shared = collection.books.filter((book) => ids.has(bookID(book))).length;
    const sameAuthors = new Set(collection.books.map((book) => searchText(book.author)).filter((name) => authors.has(name)));
    return { collection, score: shared * 4 + sameAuthors.size };
  }).sort((a, b) => b.score - a.score || b.collection.followers - a.collection.followers);
  if (!related.length) return;
  const similar = related.filter(({ score }) => score > 0);
  target.innerHTML = `<h2>${similar.length ? "Similar collections" : "More collections"}</h2><div class="related-collection-list">${(similar.length ? similar : related).slice(0, 5).map(({ collection }) => `<article class="discussion-item">
    <a class="collection-title" href="#${collectionRoute(collection.id)}">${escapeHTML(collection.name)}</a>
    ${collection.description ? `<p>${escapeHTML(collection.description)}</p>` : ""}
    <small>${escapeHTML(collection.username)} · ${collection.books.length} ${collection.books.length === 1 ? "novel" : "novels"}</small>
  </article>`).join("")}</div>`;
  target.hidden = false;
}

function drawCollectionGallery() {
  const { data, owned } = collectionPage;
  const target = $("#shared-books");
  if (!data.items.length) {
    target.removeAttribute("data-layout");
    target.innerHTML = '<div class="empty">No novels have been added yet.</div>';
    return;
  }
  const groups = TIERS.map((tier) => ({ tier, title: `Tier ${tier}`, books:
    data.items.filter((book) => (book.tier || "C") === tier).sort((a, b) => a.position - b.position) }));
  drawBookGroups(target, owned ? groups : groups.filter((group) => group.books.length), state.bookLayout,
    { tiers: true, draggable: owned, scope: `shared-${data.id}` });
  if (owned) bindTierDrag(target, collectionPage.moveBook);
}

function selectCollectionPanel(panel) {
  const thread = panel === "discussion";
  closeBookMenu();
  $("#collection-gallery").hidden = thread;
  $("#collection-discussion").hidden = !thread;
  const actions = $(".collection-gallery-actions", $("#collection-detail"));
  if (actions) actions.hidden = thread;
  $$("[data-collection-panel]").forEach((tab) => {
    const active = (tab.dataset.collectionPanel === "discussion") === thread;
    tab.classList.toggle("active", active);
    if (active) tab.setAttribute("aria-current", "true"); else tab.removeAttribute("aria-current");
  });
  if (!thread) queueSpineTitles();
}

function focusCollectionContent({ focusReply = false, novelId, keyboard = false } = {}) {
  const target = $("#collection-detail");
  if (focusReply && !$("#collection-discussion").hidden) {
    $("#collection-discussion textarea").focus();
  } else if (novelId && !$("#collection-gallery").hidden) {
    const novel = $(`[data-book-key="${novelId}"]`, target);
    if (!novel) return;
    novel.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (novel.matches(BOOK_TRIGGER)) openBookMenu(novel, { pin: true, keyboard });
    else $("input", novel)?.focus({ preventScroll: true });
  }
}

async function renderCollectionPage(options = {}) {
  const params = routeParams();
  const id = Number(params.get("id"));
  const target = $("#collection-detail");
  const token = state.token;
  collectionPage = null;
  $("#related-collections").hidden = true;
  if (!Number.isSafeInteger(id) || id < 1) {
    target.innerHTML = '<div class="empty">Collection not found.</div>';
    return;
  }
  target.innerHTML = '<div class="skeleton wide"></div>';
  const loading = target.firstElementChild;
  const endpoint = `/shared-collections/${id}`;
  try {
    const [data, { comments }] = await Promise.all([request(endpoint), request(`${endpoint}/comments`)]);
    if (!loading.isConnected || currentView() !== "collection" || token !== state.token) return;
    const owned = state.user?.id === data.user_id;
    const page = { data, owned };
    if (owned) page.moveBook = async (novelId, tier, order) => {
      try {
        await request(`${endpoint}/items/${novelId}/move`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, ordered_novel_ids: order }),
        });
        const updated = await request(endpoint);
        if (collectionPage === page) updateCollectionBooks(updated);
      } catch (error) { if (collectionPage === page) setNotice(error.message, true); }
    };
    collectionPage = page;
    target.innerHTML = `<header class="community-detail-header"><h1 tabindex="-1">${escapeHTML(data.name)}</h1>
      <p class="subtle">${escapeHTML(data.username)} · <span id="collection-size"></span></p>
      ${data.description ? `<p>${escapeHTML(data.description)}</p>` : ""}</header>
      <div class="collection-page-toolbar">
        <nav class="segmented collection-panels" aria-label="Collection sections">
          <a href="#${collectionRoute(id)}" data-collection-panel="gallery">Gallery</a>
          <a href="#${collectionRoute(id, "discussion")}" data-collection-panel="discussion">Discussion · ${comments.length}</a>
        </nav>
        ${owned ? `<div class="collection-gallery-actions">
          <p id="collection-picker-feedback" class="form-message" role="status"></p>
          <button id="toggle-collection-picker" type="button" class="outline-button" aria-expanded="false" aria-controls="collection-picker">${glyph("BookPlus")} Add saved novels</button>
        </div>` : ""}
      </div>
      <div id="collection-gallery">
        ${owned ? collectionPickerMarkup() : ""}
        <div id="shared-books" class="book-collection shared-books"></div>
      </div>
      <div id="collection-discussion" hidden>${communityConversation([...comments].reverse(), "Start the conversation.", "Write a comment")}</div>`;
    updateCollectionBooks(data);
    if (owned) bindCollectionPicker(page, endpoint);
    bindConversation(target, `${endpoint}/comments`);
    selectCollectionPanel(params.get("panel"));
    $("h1", target).focus({ preventScroll: true });
    focusCollectionContent(options);
  } catch (error) {
    if (loading.isConnected) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

function updateCollectionBooks(data) {
  closeBookMenu();
  collectionPage.data = data;
  const count = data.items.length;
  $("#collection-size").textContent = `${count} ${count === 1 ? "novel" : "novels"}`;
  drawCollectionGallery();
  drawRelatedCollections();
  collectionPage.refreshPicker?.();
}

function collectionPickerMarkup() {
  return `<form id="collection-picker" class="collection-picker" hidden>
    <label for="collection-picker-search">Search your library</label>
    <input id="collection-picker-search" type="search" placeholder="Title, author, or tag" autocomplete="off">
    <div id="collection-picker-results" class="collection-picker-results" aria-label="Saved novels"></div>
    <div class="collection-picker-actions">
      <button type="button" id="collection-picker-more" class="text-button" hidden>Show more novels</button>
      <button type="submit" class="primary-button" disabled>Add selected</button>
    </div>
  </form>`;
}

function bindCollectionPicker(page, endpoint) {
  const form = $("#collection-picker");
  const toggle = $("#toggle-collection-picker");
  const search = $("#collection-picker-search");
  const results = $("#collection-picker-results");
  const feedback = $("#collection-picker-feedback");
  const more = $("#collection-picker-more");
  const submit = $('button[type="submit"]', form);
  const selected = new Set();
  const pageSize = 48;
  let limit = pageSize;
  let saving = false;

  const updateButton = () => {
    submit.disabled = saving || !selected.size;
    submit.textContent = selected.size ? `Add ${selected.size} ${selected.size === 1 ? "novel" : "novels"}` : "Add selected";
  };

  function drawPicker() {
    if (form.hidden) return;
    const included = new Set(page.data.items.map(bookID));
    for (const id of selected) if (included.has(id) || !state.savedBooks.has(id)) selected.delete(id);
    const sorted = [...state.items].sort((a, b) => a.title.localeCompare(b.title));
    const matching = scopedMatches(sorted, search.value);
    const offset = results.scrollTop;
    results.innerHTML = matching.slice(0, limit).map((book) => {
      const id = bookID(book);
      const added = included.has(id);
      return `<label class="collection-picker-book">
        <input type="checkbox" value="${id}" ${selected.has(id) ? "checked" : ""} ${added ? "disabled" : ""}>
        <span class="book-face shelf-book" data-binding="${id % 8}">${coverMarkup(book, "book-jacket")}</span>
        <span><strong>${escapeHTML(book.title)}</strong>${book.author ? `<small>${escapeHTML(book.author)}</small>` : ""}</span>
        ${added ? '<small class="picker-added">Already added</small>' : ""}
      </label>`;
    }).join("") || `<p class="subtle">${state.items.length ? "No saved novels match your search." : "Your library is empty."}</p>`;
    bindCoverFallbacks(results);
    results.scrollTop = offset;
    more.hidden = matching.length <= limit;
    updateButton();
  }

  page.refreshPicker = drawPicker;
  function setOpen(open) {
    form.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      drawPicker();
      search.focus({ preventScroll: true });
    }
  }

  toggle.addEventListener("click", () => setOpen(form.hidden));
  search.addEventListener("input", () => {
    limit = pageSize;
    results.scrollTop = 0;
    drawPicker();
  });
  more.addEventListener("click", () => {
    limit += pageSize;
    drawPicker();
  });
  results.addEventListener("change", ({ target }) => {
    if (!target.matches('input[type="checkbox"]')) return;
    const id = Number(target.value);
    if (target.checked) selected.add(id); else selected.delete(id);
    updateButton();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || !selected.size) return;
    const ids = [...selected];
    saving = true;
    updateButton();
    feedback.textContent = "";
    feedback.dataset.state = "";
    try {
      const { added } = await request(`${endpoint}/items`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ novel_ids: ids }),
      });
      const updated = await request(endpoint);
      if (collectionPage !== page) return;
      ids.forEach((id) => selected.delete(id));
      updateCollectionBooks(updated);
      if (!selected.size && !form.hidden) {
        setOpen(false);
        if (!$("#collection-gallery").hidden) toggle.focus({ preventScroll: true });
      }
      feedback.textContent = added ? `${added} ${added === 1 ? "novel" : "novels"} added.` : "The selected novels were already added.";
    } catch (error) {
      feedback.textContent = error.message;
      feedback.dataset.state = "error";
    } finally {
      saving = false;
      updateButton();
    }
  });
}

async function openReaderProfile(username) {
  closeBookMenu();
  openModal("reader-profile-modal");
  const target = $("#reader-profile-detail");
  target.parentElement.scrollTop = 0;
  target.innerHTML = '<div class="skeleton wide"></div>';
  const loading = target.firstElementChild;
  try {
    const data = await request(`/profiles/${encodeURIComponent(username)}`);
    if (!loading.isConnected || !$("#reader-profile-modal").classList.contains("open")) return;
    target.innerHTML = `<p class="eyebrow">Reader profile</p><h2>${escapeHTML(data.username)}</h2><p class="subtle">${data.library_count} saved novels</p><div class="taste-tags">${data.favorite_tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join("")}</div><h3>S-tier favourites</h3><div class="collection-detail-grid">${data.favorites.length ? data.favorites.map((book) => `<article class="collection-detail-book">${coverMarkup(book)}<strong>${escapeHTML(book.title)}</strong></article>`).join("") : '<div class="empty">No confirmed public favourites yet.</div>'}</div>`;
    bindCoverFallbacks(target);
  } catch (error) {
    if (loading.isConnected) target.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

const REQUEST_STATUSES = { open: "Open", collecting: "Collecting", resolved: "Resolved", declined: "Declined" };
let olderRequestsCursor;
let requestHistoryVersion = 0;

async function loadNovelRequests(older = false) {
  const version = ++requestHistoryVersion;
  const query = state.scopedQueries.requests || "";
  const list = $("#request-history-list");
  const feedback = $("#request-history-state");
  const button = $("#older-novel-requests");
  $("#request-history-signin").hidden = Boolean(state.user);
  if (!older) {
    list.replaceChildren();
    olderRequestsCursor = null;
    button.hidden = true;
  }
  feedback.textContent = "";
  if (!state.user) {
    list.removeAttribute("aria-busy");
    return;
  }
  const params = new URLSearchParams({ q: query });
  if (older && olderRequestsCursor) params.set("before", olderRequestsCursor);
  button.disabled = true;
  list.setAttribute("aria-busy", "true");
  if (!older) feedback.textContent = "Loading requests…";
  try {
    const { requests, next_before } = await request(`/requests?${params}`);
    if (version !== requestHistoryVersion) return;
    list.insertAdjacentHTML("beforeend", requests.map(({ query: title, username, status, created_at }) => `
      <li><div><strong>${escapeHTML(title)}</strong><small>Requested by ${escapeHTML(username)}</small></div>
        <div class="request-history-meta"><span>${escapeHTML(REQUEST_STATUSES[status] || status)}</span>${discussionTime(created_at)}</div></li>`).join(""));
    olderRequestsCursor = next_before;
    button.hidden = !next_before;
    feedback.textContent = list.childElementCount ? "" : query ? "No matching requests." : "No novels requested yet.";
  } catch (error) {
    if (version === requestHistoryVersion) feedback.textContent = error.message;
  } finally {
    if (version === requestHistoryVersion) {
      button.disabled = false;
      list.removeAttribute("aria-busy");
    }
  }
}

async function submitNovelRequest(event) {
  event.preventDefault();
  const title = $("#request-title").value.trim();
  if (!title) return $("#request-title").focus();
  if (!state.user) return openLogin();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const feedback = $("#novel-request-feedback");
  if (button.disabled) return;
  button.disabled = true;
  feedback.textContent = "";
  feedback.dataset.state = "";
  try {
    await request("/requests", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: title }),
    });
    if ($("#request-title").value.trim() === title) form.reset();
    feedback.textContent = "Request sent.";
    state.scopedQueries.requests = "";
    if (currentView() === "community" && state.communityPanel === "requests") syncScopedSearch("community");
    loadNovelRequests();
  } catch (error) {
    feedback.dataset.state = "error";
    feedback.textContent = error.message;
  } finally { button.disabled = false; }
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
  if (currentView() === "collection") renderCollectionPage();
  loadNovelRequests();
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
  if (document.body.dataset.view === "community") {
    renderCommunity();
    if (state.communityPanel === "requests") loadNovelRequests();
  }
  if (document.body.dataset.view === "collection") renderCollectionPage();
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
  $("#close-reader-profile").addEventListener("click", () => closeModal("reader-profile-modal"));
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
  $("#discussion-topic-form").addEventListener("submit", createDiscussion);
  $("#community-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-community-panel]");
    if (tab) selectCommunityPanel(tab.dataset.communityPanel);
  });
  $("#community-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const panel = event.key === "Home" ? "collections" : event.key === "End" ? "requests"
      : state.communityPanel === "collections" ? "requests" : "collections";
    selectCommunityPanel(panel, true);
  });
  $("#community").addEventListener("click", (event) => {
    const action = event.target.closest("[data-follow-collection], [data-reader]");
    if (!action) return;
    if (action.dataset.followCollection) followCollection(Number(action.dataset.followCollection), action.getAttribute("aria-pressed") !== "true");
    if (action.dataset.reader) openReaderProfile(action.dataset.reader);
  });
  $("#novel-request-form").addEventListener("submit", submitNovelRequest);
  $("#older-novel-requests").addEventListener("click", () => loadNovelRequests(true));
  $("#request-history-signin").addEventListener("click", openLogin);
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
    if (entries[0].isIntersecting && currentView() === "discover" && !(state.currentQuery && state.bookLayout === "grid")) loadNextPage();
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
