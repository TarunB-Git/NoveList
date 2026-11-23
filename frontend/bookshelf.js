"use strict";

const PREVIEW_SECTIONS = ["Fantasy & adventure", "Mystery & suspense", "Science fiction", "Life & literature"];
const PREVIEW_BOOKS = [
  ["The Copper Atlas", "Mira Vale", 0, "A surveyor follows a changing atlas across disputed borders, where each new map redraws the path home.", 0, ["Maps", "Exploration"]],
  ["A House of Moths", "Ellis Hart", 1, "An archivist finds letters hidden in the walls of an abandoned house. One of them is addressed to her.", 1, ["Archives", "Haunted house"]],
  ["The Glass Observatory", "Iona Chen", 2, "An apprentice astronomer challenges the forecasts that govern her city when the night sky starts to disagree.", 2, ["Astronomy", "City life"]],
  ["Night Market Radio", "Ren Sato", 2, "A late-night broadcaster receives calls describing tomorrow’s market. The next caller knows his name.", 3, ["City life", "Time anomalies"]],
  ["The Third Bell", "Avery Rowan", 1, "A bellmaker investigates why one tower rings at dusk when it has no bell.", 4, ["Small towns", "Investigation"]],
  ["A Map of Rain", "Noor Ellis", 0, "A hydrologist searches for a vanished river and the village that once stood on its banks.", 5, ["Maps", "Climate"]],
  ["The Salt Road", "Imani West", 0, "Two siblings carry a disputed map across a drought-struck plain.", null, ["Maps", "Exploration"]],
  ["The Harbour Clock", "June Voss", 1, "A watchmaker traces the source of a town’s missing hour.", null, ["Small towns", "Time anomalies"]],
  ["A City of Stairs", "R. Okafor", 0, "A courier searches a vertical city for the architect who drew its missing levels.", null, ["City life", "Maps"]],
  ["Signal at the Edge", "Ada Vo", 2, "A remote research crew must decide whether a repeating signal is a warning.", null, ["Space", "Exploration"]],
  ["The Summer Archive", "Eli Santos", 3, "A librarian assembles a town’s lost summer from borrowed photographs.", null, ["Archives", "Small towns"]],
  ["Orchard in Winter", "Kit Lind", 3, "A grower inherits an orchard and a ledger of unexplained harvests.", null, ["Family", "Small towns"]],
  ["The Museum of Keys", "Lena Cho", 1, "A locksmith finds a door that was left off every plan.", null, ["Archives", "Investigation"]],
  ["A Small Season", "Amal Noor", 3, "Three neighbours rebuild a greenhouse after their town’s final nursery closes.", null, ["Community", "Small towns"]],
  ["Under Cedar Light", "Devi Shah", 0, "A forest ranger documents unfamiliar tracks before a road reaches the valley.", null, ["Forests", "Exploration"]],
  ["Tomorrow’s Postmark", "Nina Lark", 2, "A postal worker discovers that one undeliverable letter arrives each morning.", null, ["Time anomalies", "Small towns"]],
  ["The River Census", "Robin Day", 1, "A census worker finds more households along the river than the maps allow.", null, ["Maps", "Investigation"]],
  ["The Last Seedkeeper", "Joel Ives", 2, "An apprentice preserves a rare seed collection through a changing climate.", null, ["Climate", "Space"]],
  ["Letters to the Tides", "Isla Lind", 3, "A marine biologist answers notes left in bottles along an empty shore.", null, ["Romance", "Coastal"]],
  ["Seven Stops North", "Emi Sato", 1, "Strangers on a delayed train unravel a message meant for one of them.", null, ["Investigation", "Travel"]],
  ["The Paper Bridge", "Mara Sy", 3, "A student restores a bridge from plans no one remembers drawing.", null, ["Community", "City life"]],
  ["The Blue Workshop", "Cam Arden", 1, "A craftswoman opens a workshop where every commission comes with a secret.", null, ["Small towns", "Investigation"]],
  ["The Lantern Survey", "Zia Stone", 2, "An engineer maps lights that appear beyond the city’s power grid.", null, ["City life", "Investigation"]],
  ["Where the Snow Ends", "Alex Rhee", 0, "Two climbers take different routes toward the same weather station.", null, ["Travel", "Survival"]]
].map(([title, author, section, synopsis, illustration, tags], index) => ({
  novel_id: -(index + 1), title, author, section, synopsis, illustration,
  tags: [PREVIEW_SECTIONS[section], ...tags], source: "Fictional preview catalogue",
}));

const GUTENBERG_PREVIEW = [
  [11, "Alice’s Adventures in Wonderland", "Lewis Carroll", 0, "Portal fantasy", "Alice follows a rabbit into a world that refuses to follow her rules."],
  [12, "Through the Looking-Glass", "Lewis Carroll", 0, "Portal fantasy", "A mirror opens onto a world arranged like a chessboard."],
  [55, "The Wonderful Wizard of Oz", "L. Frank Baum", 0, "Quests", "Dorothy and three companions follow the yellow brick road."],
  [120, "Treasure Island", "Robert Louis Stevenson", 0, "Exploration", "A stolen map leads Jim Hawkins into a pirate mutiny."],
  [1184, "The Count of Monte Cristo", "Alexandre Dumas", 0, "Revenge", "A man betrayed and imprisoned returns with a new identity."],
  [1257, "The Three Musketeers", "Alexandre Dumas", 0, "Historical fiction", "D’Artagnan befriends three swordsmen and takes on the intrigues of the French court."],
  [1268, "The Mysterious Island", "Jules Verne", 0, "Exploration", "Five castaways make a home on an island with an unseen ally."],
  [521, "The Life and Adventures of Robinson Crusoe", "Daniel Defoe", 0, "Survival", "A shipwrecked sailor recounts decades spent surviving on an island."],
  [829, "Gulliver’s Travels", "Jonathan Swift", 0, "Satire", "A ship’s surgeon visits kingdoms whose customs expose his own absurdities."],
  [236, "The Jungle Book", "Rudyard Kipling", 0, "Wilderness", "Mowgli grows up among wolves and learns how to live in the jungle."],
  [1661, "The Adventures of Sherlock Holmes", "Arthur Conan Doyle", 1, "Detectives", "Holmes and Watson investigate a string of unusual cases in Victorian England."],
  [244, "A Study in Scarlet", "Arthur Conan Doyle", 1, "Detectives", "Watson’s new flatmate unravels a murder that reaches far beyond London."],
  [2852, "The Hound of the Baskervilles", "Arthur Conan Doyle", 1, "Gothic", "Holmes investigates a family curse on the Devon moors."],
  [155, "The Moonstone", "Wilkie Collins", 1, "Detectives", "A stolen diamond draws a household into a tangled investigation."],
  [583, "The Woman in White", "Wilkie Collins", 1, "Gothic", "A midnight encounter with a stranger leads to an inheritance plot."],
  [863, "The Mysterious Affair at Styles", "Agatha Christie", 1, "Detectives", "Hercule Poirot investigates a poisoning at an English country house."],
  [1155, "The Secret Adversary", "Agatha Christie", 1, "Espionage", "Two friends looking for work stumble into a conspiracy over a missing document."],
  [345, "Dracula", "Bram Stoker", 1, "Gothic", "Letters and diaries trace a count’s journey from Transylvania to England."],
  [43, "The Strange Case of Dr. Jekyll and Mr. Hyde", "Robert Louis Stevenson", 1, "Gothic", "A lawyer looks into the connection between a respected doctor and a violent stranger."],
  [103, "Around the World in Eighty Days", "Jules Verne", 0, "Travel", "A wager sends Phileas Fogg and his valet around the world."],
  [84, "Frankenstein", "Mary Shelley", 2, "Gothic", "A scientist brings a creature to life and abandons it."],
  [35, "The Time Machine", "H. G. Wells", 2, "Time travel", "A Victorian inventor travels to a distant future divided between two peoples."],
  [36, "The War of the Worlds", "H. G. Wells", 2, "First contact", "An eyewitness describes a Martian invasion of England."],
  [5230, "The Invisible Man", "H. G. Wells", 2, "Inventions", "A scientist discovers invisibility and finds it harder to live unseen than he imagined."],
  [159, "The Island of Doctor Moreau", "H. G. Wells", 2, "Experiments", "A castaway discovers a scientist’s experiments on a remote island."],
  [164, "Twenty Thousand Leagues Under the Seas", "Jules Verne", 2, "Exploration", "A marine scientist joins Captain Nemo aboard the Nautilus."],
  [18857, "A Journey to the Centre of the Earth", "Jules Verne", 2, "Exploration", "A coded manuscript leads an expedition into an Icelandic volcano."],
  [83, "From the Earth to the Moon", "Jules Verne", 2, "Space", "An American gun club decides to launch a projectile to the Moon."],
  [62, "A Princess of Mars", "Edgar Rice Burroughs", 2, "Space", "John Carter wakes on Mars and becomes caught in its rivalries."],
  [97, "Flatland", "Edwin A. Abbott", 2, "Satire", "A square encounters worlds with dimensions beyond his own."],
  [1342, "Pride and Prejudice", "Jane Austen", 3, "Romance", "Elizabeth Bennet reconsiders her first impressions of Mr Darcy."],
  [158, "Emma", "Jane Austen", 3, "Romance", "An enthusiastic matchmaker misreads the people closest to her."],
  [161, "Sense and Sensibility", "Jane Austen", 3, "Family", "Two sisters respond differently to heartbreak and changed circumstances."],
  [1260, "Jane Eyre", "Charlotte Brontë", 3, "Romance", "An orphan becomes a governess at a house with a closely guarded secret."],
  [768, "Wuthering Heights", "Emily Brontë", 3, "Gothic", "A family’s story of love and vengeance unfolds on the Yorkshire moors."],
  [514, "Little Women", "Louisa May Alcott", 3, "Family", "The four March sisters come of age during and after the American Civil War."],
  [45, "Anne of Green Gables", "L. M. Montgomery", 3, "Coming of age", "An imaginative orphan finds a home on Prince Edward Island."],
  [1400, "Great Expectations", "Charles Dickens", 3, "Coming of age", "A mysterious benefactor changes the course of young Pip’s life."],
  [2701, "Moby-Dick", "Herman Melville", 3, "Seafaring", "Ishmael sails with a captain obsessed with finding one white whale."],
  [74, "The Adventures of Tom Sawyer", "Mark Twain", 3, "Coming of age", "Tom’s pursuit of adventure gets him into trouble along the Mississippi."],
].map(([id, title, author, section, tag, synopsis]) => ({
  novel_id: -1000 - id, title, author, section, synopsis, tags: [PREVIEW_SECTIONS[section], tag],
  source: "Project Gutenberg", urls: [{ site: "Read on Project Gutenberg", url: `https://www.gutenberg.org/ebooks/${id}` }],
}));

const GUEST_BOOKS = [...PREVIEW_BOOKS, ...GUTENBERG_PREVIEW];

const READING_STOPS = [
  ["plan_to_read", "Want to read", "BookPlus"],
  ["reading", "Reading", "BookOpenText"],
  ["paused", "Paused", "CirclePause"],
  ["completed", "Finished", "CircleCheck"],
  ["dropped", "Dropped", "CircleX"],
];
const TIERS = ["S", "A", "B", "C", "D"];
const TRASH_TIER = "trash";
const TIER_STOPS = TIERS.map((tier) => [tier, tier]);
const BOOK_MENU_TITLE = { status: "Reading status and tier", rating: "Rating and reviews", details: "Book details" };
const BOOK_TRIGGER = '[data-book-key][aria-controls="book-popover"]';

const shelfBooks = new WeakMap();
const compactControls = new WeakMap();
const menuState = {
  book: null, anchor: null, host: null, pane: "", pinned: false, timer: 0, dismiss: 0,
  ignored: null, skipClick: null, reviews: "", reviewData: null, expanded: new Set(), draft: "", scrollSpace: null,
};
const bookJobs = new Map();
const bookID = (book) => Number(book.novel_id ?? book.id);
const displayStatus = (status) => status === "continue" ? "paused" : status;
const glyph = (name) => `<svg class="book-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="/book-icons.svg?v=2#${name}"></use></svg>`;

function previewTags() {
  const counts = new Map();
  for (const book of GUEST_BOOKS) {
    for (const tag of book.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function previewMatches(query = "") {
  const normalized = query.toLocaleLowerCase().replaceAll("’", "'");
  const terms = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const matches = [];
  for (const book of GUEST_BOOKS) {
    if (![...state.selectedTags].every((tag) => book.tags.includes(tag))) continue;
    const title = book.title.toLocaleLowerCase().replaceAll("’", "'");
    const tags = book.tags.join(" ").toLocaleLowerCase();
    const metadata = `${book.author} ${book.synopsis}`.toLocaleLowerCase();
    if (!terms.every((term) => title.includes(term) || tags.includes(term) || metadata.includes(term))) continue;
    const score = title === normalized ? 100 : title.startsWith(normalized) ? 30 : 0;
    const relevance = terms.reduce((total, term) => total + (title.includes(term) ? 5 : tags.includes(term) ? 2 : 1), score);
    matches.push({ book, relevance });
  }
  return matches.sort((a, b) => b.relevance - a.relevance).map(({ book }) => book);
}

function shelfLayout(value) {
  return ({ title: "shelf", cover: "grid" }[value] || value);
}

function bookZoomKey() {
  return state.user ? `novellist-book-zoom-${state.user.id}` : "novellist-book-zoom-guest";
}

function applyBookZoom() {
  const saved = Number(localStorage.getItem(bookZoomKey()));
  const slider = $("#header-zoom-slider");
  const percent = saved >= Number(slider.min) && saved <= Number(slider.max) ? saved : 100;
  document.documentElement.style.setProperty("--book-zoom", percent / 100);
  slider.value = percent;
  slider.setAttribute("aria-valuetext", `${percent}%`);
  $("#header-zoom output").value = `${percent}%`;
  $$("[data-zoom-step]").forEach((button) => {
    const atLimit = Number(button.dataset.zoomStep) < 0
      ? percent <= Number(slider.min)
      : percent >= Number(slider.max);
    button.setAttribute("aria-disabled", String(atLimit));
  });
  balanceCabinetShelves();
  packDiscoverSections();
  queueSpineTitles();
  if (menuState.anchor) positionBookMenu();
}

function initBookZoom() {
  const slider = $("#header-zoom-slider");
  const change = () => {
    localStorage.setItem(bookZoomKey(), slider.value);
    applyBookZoom();
  };
  slider.addEventListener("input", change);
  $("#header-zoom").addEventListener("click", (event) => {
    const step = event.target.closest("[data-zoom-step]");
    if (!step || step.getAttribute("aria-disabled") === "true") return;
    if (Number(step.dataset.zoomStep) < 0) slider.stepDown();
    else slider.stepUp();
    change();
  });
  applyBookZoom();
}

function bookMarkup(book, layout, { draggable = false, scope = "", review = false } = {}) {
  const id = bookID(book);
  const titleLength = [...book.title].length;
  const art = Number.isInteger(book.illustration) ? ` style="--art-x:${(book.illustration % 3) * 50}%;--art-y:${Math.floor(book.illustration / 3) * 100}%"` : "";
  const jacket = art ? `<span class="book-jacket art" ${art} aria-hidden="true"></span>`
    : coverMarkup(book, "book-jacket");
  const item = state.savedBooks.get(id);
  const identity = `data-book-key="${id}" data-binding="${Math.abs(id) % 8}"`;
  if (layout === "dense") return compactBookMarkup(book, item, identity, jacket, { draggable, scope, review });
  return `<button type="button" class="shelf-book" ${identity} ${titleLength > 28 ? "data-long-title" : ""}
    ${draggable ? 'draggable="true"' : ""} aria-controls="book-popover" aria-expanded="false"
    aria-label="${escapeHTML(book.title)}${book.author ? ` by ${escapeHTML(book.author)}` : ""}" title="${escapeHTML(book.title)}"
    style="--book-height:${110 + Math.abs(id * 7) % 30}px;--spine-width:${38 + Math.abs(id * 11) % 15}px">
    <span class="book-spine" aria-hidden="true"><strong><span>${escapeHTML(book.title)}</span></strong>${book.author && titleLength <= 14 ? `<small>${escapeHTML(book.author)}</small>` : ""}</span>
    <span class="book-face">${jacket}</span>
    ${layout === "shelf" ? "" : `<span class="book-type"><strong>${escapeHTML(book.title)}</strong>
      <small>${escapeHTML(bookByline(book, item))}</small>
      ${layout === "list" && book.synopsis ? `<span class="book-list-synopsis">${escapeHTML(book.synopsis)}</span>` : ""}</span>`}
  </button>`;
}

function bookByline(book, item) {
  return [book.author, STATUS[item?.status]].filter(Boolean).join(" · ");
}

let spineFrame = 0;
const spineMetrics = new WeakMap();
const spineMeasure = document.createElement("canvas").getContext("2d");
const titleSegments = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function wrapSpineTitle(title, space, columns) {
  const lines = [];
  let remaining = titleSegments ? Array.from(titleSegments.segment(title), ({ segment }) => segment) : Array.from(title);
  for (let column = 0; column < columns && remaining.length; column++) {
    const last = column === columns - 1;
    if (spineMeasure.measureText(remaining.join("")).width <= space) {
      lines.push(remaining.join(""));
      break;
    }
    const allowance = last ? space - spineMeasure.measureText("…").width : space;
    let low = 0;
    let high = remaining.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (spineMeasure.measureText(remaining.slice(0, middle).join("")).width <= allowance) low = middle;
      else high = middle - 1;
    }
    if (!last) {
      const breakAt = remaining.slice(0, low + 1).findLastIndex((part) => /\s/u.test(part));
      if (breakAt > 0) low = breakAt;
    }
    const count = Math.max(1, low);
    lines.push(remaining.slice(0, last ? low : count).join("").trimEnd() + (last ? "…" : ""));
    remaining = remaining.slice(count);
    while (remaining.length && /\s/u.test(remaining[0])) remaining.shift();
  }
  return lines;
}

function queueSpineTitles() {
  if (spineFrame || !spineMeasure) return;
  spineFrame = requestAnimationFrame(() => {
    spineFrame = 0;
    const updates = [];
    const visibleShelves = '.view.active [data-layout="shelf"], .modal.open [data-layout="shelf"]';
    for (const shelf of $$(visibleShelves)) {
      for (const trigger of $$("[data-book-key]", shelf)) {
        const heading = $(".book-spine strong", trigger);
        const title = shelfBooks.get(trigger)?.title;
        if (!title || !heading?.clientHeight) continue;
        const style = getComputedStyle(heading);
        const lineHeight = parseFloat(style.lineHeight);
        const columns = Math.max(1, Math.floor(heading.clientWidth / lineHeight));
        const space = heading.clientHeight - 2;
        const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = `${title}|${font}|${space}|${columns}`;
        if (spineMetrics.get(heading) === metrics) continue;
        spineMetrics.set(heading, metrics);
        spineMeasure.font = font;
        updates.push([heading, wrapSpineTitle(title, space, columns)]);
      }
    }
    for (const [heading, lines] of updates) {
      heading.replaceChildren(...lines.flatMap((line, index) => {
        const column = document.createElement("span");
        column.textContent = line;
        return index ? [" ", column] : [column];
      }));
    }
  });
}

function compactBookMarkup(book, item, identity, jacket, { draggable, scope, review }) {
  const key = `compact-${scope}-${bookID(book)}`;
  const title = escapeHTML(book.title);
  const status = displayStatus(item?.status);
  const placement = TIERS.includes(item?.tier) ? item.tier : null;
  return `<article class="shelf-book compact-book" ${identity} data-compact-key="${key}" ${review ? "data-compact-review" : ""}
    ${draggable ? 'draggable="true"' : ""} aria-labelledby="${key}-name">
    <span class="book-face">${jacket}</span>
    <strong class="compact-title" id="${key}-name" title="${title}">${title}</strong>
    ${ratingTrackMarkup(item, `${key}-rating`, `Rate ${book.title}`, false)}
    ${review
      ? timelineMarkup(`Tier for ${book.title}`, `${key}-tier`, TIER_STOPS, placement, compactTierCaption(item), true)
      : timelineMarkup(`Reading status for ${book.title}`, `${key}-status`, READING_STOPS, status, STATUS[status] || "Unsaved", true)}
  </article>`;
}

function compactTierCaption(item) {
  if (!TIERS.includes(item?.tier)) return "Unplaced";
  return `${item.tier_source === "suggested" ? "Suggested tier" : "Tier"} ${item.tier}`;
}

function groupMarkup(groups, layout, options = {}) {
  const { tiers = false, horizontal = false } = options;
  return groups.map(({ title, books, tier }) => `<section class="book-section${tiers ? " ranked-shelf" : ""}"
      ${tier ? `data-tier="${tier}"` : ""} data-book-group="${escapeHTML(title)}" aria-label="${escapeHTML(title)}">
    <h2 class="shelf-label"${tier === TRASH_TIER ? ' aria-label="Trash"' : ""}>${tier === TRASH_TIER ? glyph("Trash2") : escapeHTML(tier && layout === "shelf" ? tier : title)}</h2>
    <div class="book-row" ${tier ? `data-drop-tier="${tier}"` : ""}${horizontal ? ` tabindex="0" aria-label="${escapeHTML(title)}"` : ""}>
      ${books.length ? books.map((book) => bookMarkup(book, layout, options)).join("") : '<p class="shelf-empty">Empty shelf</p>'}
    </div></section>`).join("");
}

function bindBookGroups(target, groups) {
  $$(".book-section", target).forEach((section, index) => {
    $$("[data-book-key]", section).forEach((trigger, position) => bindShelfBook(trigger, groups[index].books[position]));
  });
}

function bindShelfBook(trigger, book) {
  shelfBooks.set(trigger, book);
  bindCoverFallbacks(trigger);
  if (!trigger.classList.contains("compact-book")) return;
  const key = trigger.dataset.compactKey;
  const item = state.savedBooks.get(bookID(book));
  const rate = wireBookRating(trigger, `${key}-rating`, item,
    (rating) => changeCompactBook(book, { rating }, `#book-track-${key}-rating`));
  const review = trigger.hasAttribute("data-compact-review");
  const field = review ? "tier" : "status";
  const placement = review ? item?.tier : displayStatus(item?.status);
  const setPlacement = wireTimeline(trigger, `${key}-${field}`, review ? TIER_STOPS : READING_STOPS, placement,
    (value) => changeCompactBook(book, { [field]: value }, `#book-track-${key}-${field}`));
  compactControls.set(trigger, { rate, setPlacement, review });
}

function drawBookGroups(target, groups, layout, options) {
  const offsets = shelfOffsets(target);
  target.dataset.layout = layout;
  target.innerHTML = groupMarkup(groups, layout, { scope: target.id, ...options });
  bindBookGroups(target, groups);
  restoreShelfOffsets(target, offsets);
  if (layout === "shelf") queueSpineTitles();
}

function shelfElement(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.firstElementChild;
}

function updateBookControls(trigger, book) {
  const item = state.savedBooks.get(bookID(book));
  const compact = compactControls.get(trigger);
  if (compact) {
    const status = displayStatus(item?.status);
    compact.rate(item?.personal_rating || 0);
    if (compact.review) compact.setPlacement(item?.tier, compactTierCaption(item));
    else compact.setPlacement(status, STATUS[status] || "Unsaved");
  }
  const byline = $(".book-type small", trigger);
  if (byline) {
    const text = bookByline(book, item);
    if (byline.textContent !== text) byline.textContent = text;
  }
}

function syncBookGroups(target, groups, layout, options) {
  options = { scope: target.id, ...options };
  const sections = new Map($$(":scope > .book-section", target)
    .map((section) => [section.dataset.bookGroup, section]));
  const books = new Map($$("[data-book-key]", target).map((trigger) => [Number(trigger.dataset.bookKey), trigger]));
  const rows = [];
  let nextSection = target.firstElementChild;
  for (const group of groups) {
    const { title } = group;
    const section = sections.get(title) || shelfElement(groupMarkup([{ ...group, books: [] }], layout, options));
    sections.delete(title);
    if (section !== nextSection) target.insertBefore(section, nextSection);
    nextSection = section.nextElementSibling;
    const row = $(".book-row", section);
    rows.push(row);
    let nextBook = row.firstElementChild;
    for (const book of group.books) {
      const id = bookID(book);
      const existing = books.get(id);
      const trigger = existing || shelfElement(bookMarkup(book, layout, options));
      books.delete(id);
      if (trigger !== nextBook) {
        if (trigger.isConnected && row.moveBefore) row.moveBefore(trigger, nextBook);
        else row.insertBefore(trigger, nextBook);
      }
      nextBook = trigger.nextElementSibling;
      if (existing) {
        shelfBooks.set(trigger, book);
        updateBookControls(trigger, book);
      } else {
        bindShelfBook(trigger, book);
      }
    }
  }
  for (const trigger of books.values()) trigger.remove();
  for (const section of sections.values()) section.remove();
  for (const row of rows) {
    const placeholder = $(".shelf-empty", row);
    if (row.querySelector("[data-book-key]")) placeholder?.remove();
    else if (!placeholder) row.innerHTML = '<p class="shelf-empty">Empty shelf</p>';
  }
  if (layout === "shelf") queueSpineTitles();
}

function shelfOffsets(target) {
  return new Map($$(".book-section", target).map((section) => [
    section.dataset.bookGroup, $(".book-row", section).scrollLeft,
  ]));
}

function restoreShelfOffsets(target, offsets) {
  $$(".book-section", target).forEach((section) => {
    $(".book-row", section).scrollLeft = offsets.get(section.dataset.bookGroup) || 0;
  });
}

function timelineMarkup(label, key, stops, current, caption, compact = false) {
  const index = stops.findIndex(([value]) => value === current);
  return `<div class="book-timeline" data-timeline="${key}">
    <div class="timeline-title${compact ? " sr-only" : ""}"><label for="book-track-${key}">${escapeHTML(label)}</label><span aria-hidden="true">${escapeHTML(caption)}</span></div>
    <div class="timeline-rail" style="--stop:${Math.max(index, 0)}" ${index < 0 ? "" : 'data-placed'}>
      <div class="timeline-connector" aria-hidden="true"></div><div class="timeline-progress" aria-hidden="true"></div>
      <div class="timeline-stops" aria-hidden="true">${stops.map(([, text, icon], stop) => `<div class="timeline-stop" ${index === stop ? "data-active" : ""}>
        <span class="stop-mark">${icon ? glyph(icon) : text}</span>${icon && !compact ? `<span class="stop-name">${text}</span>` : ""}
      </div>`).join("")}</div>
      <input type="range" id="book-track-${key}" class="book-track" min="0" max="${stops.length - 1}" step="1"
        value="${index < 0 && stops === TIER_STOPS ? 2 : Math.max(index, 0)}" aria-valuetext="${escapeHTML(caption)}">
    </div></div>`;
}

function bindBookRange(input, valueAt, paint, restore, commit) {
  let pointer = null;
  const pick = (event) => {
    const rect = input.getBoundingClientRect();
    const fraction = input.closest(".book-popover[data-vertical]")
      ? (event.clientY - rect.top) / rect.height
      : (event.clientX - rect.left) / rect.width;
    return valueAt(Math.max(0, Math.min(.999999, fraction)));
  };
  input.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    input.setPointerCapture(event.pointerId);
    pointer = event.pointerId;
    paint(pick(event));
  });
  input.addEventListener("pointermove", (event) => {
    if (pointer === event.pointerId || (pointer === null && event.pointerType === "mouse" && !event.buttons)) paint(pick(event));
  });
  input.addEventListener("pointerup", (event) => {
    if (pointer !== event.pointerId) return;
    pointer = null;
    restore();
    commit(pick(event));
  });
  input.addEventListener("lostpointercapture", () => { pointer = null; restore(); });
  input.addEventListener("pointerleave", () => { if (pointer === null) restore(); });
  input.addEventListener("input", () => { if (pointer === null) { restore(); commit(Number(input.value)); } });
  input.addEventListener("keydown", (event) => {
    if (input.closest(".book-popover[data-vertical]") && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "ArrowDown") input.stepUp();
      else input.stepDown();
      commit(Number(input.value));
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(Number(input.value));
    }
  });
}

function wireTimeline(root, key, stops, current, commit) {
  const group = $(`[data-timeline="${key}"]`, root);
  if (!group) return;
  const input = $("input", group);
  const rail = $(".timeline-rail", group);
  const caption = $(".timeline-title span", group);
  let chosen = stops.findIndex(([value]) => value === current);
  let chosenText = caption.textContent;
  const tier = stops === TIER_STOPS;
  const inputValue = () => chosen < 0 && tier ? 2 : Math.max(chosen, 0);
  function draw(index, text, preview) {
    rail.style.setProperty("--stop", Math.max(index, 0));
    rail.toggleAttribute("data-placed", index >= 0);
    rail.toggleAttribute("data-preview", preview);
    $$(".timeline-stop", rail).forEach((stop, i) => stop.toggleAttribute("data-active", i === index));
    caption.textContent = text;
  }
  const restore = () => draw(chosen, chosenText, false);
  bindBookRange(input, (fraction) => Math.floor(fraction * stops.length),
    (index) => index === chosen ? restore() : draw(index, tier ? `Tier ${stops[index][1]}` : stops[index][1], true),
    restore, (index) => {
      input.value = inputValue();
      commit(stops[index][0]);
    });
  return (value, text) => {
    const index = stops.findIndex(([stop]) => stop === value);
    if (index === chosen && text === chosenText) return;
    chosen = index;
    chosenText = text;
    input.value = inputValue();
    input.setAttribute("aria-valuetext", text);
    restore();
  };
}

function menuAction(name, label, icon, attributes = "") {
  return `<button type="button" class="book-menu-icon" data-book-action="${name}" aria-label="${label}" title="${label}" ${attributes}>${glyph(icon)}</button>`;
}

function bookStatusMarkup(item) {
  return timelineMarkup("Reading status", "status", READING_STOPS, displayStatus(item?.status), item ? STATUS[item.status] : "Unsaved") +
    bookTierMarkup(item);
}

function bookTierMarkup(item) {
  const tier = TIERS.includes(item?.tier) ? item.tier : null;
  const suggestion = item?.tier_source === "suggested";
  const canReview = menuState.host?.id === "tierboard" && state.reviewSuggestions &&
    state.items.some((entry) => entry.tier_source === "suggested" && entry.novel_id !== bookID(menuState.book));
  return timelineMarkup("Tier", "tier", TIER_STOPS, tier, tier ? `${suggestion ? "Suggested" : "Tier"} ${tier}` : "Unplaced") +
    `<div class="book-placement">${suggestion ? menuAction("confirm", "Confirm suggested tier", "Check") : ""}${canReview ? menuAction("next", "Next suggestion", "ArrowRight") : ""}</div>`;
}

function starFill(value, index) {
  return Math.max(0, Math.min(1, value - index)) * 100;
}

function ratingTrackMarkup(item, key = "rating", label = "Personal rating", showValue = true) {
  const value = item?.personal_rating || 0;
  return `<div class="book-rating" data-rating-track="${key}"><div class="rating-stars">
    <div aria-hidden="true">${Array.from({ length: 5 }, (_, index) => `<span class="book-star" style="--fill:${starFill(value,index)}%">${glyph("Star")}<span>${glyph("Star")}</span></span>`).join("")}</div>
    <input class="book-track" id="book-track-${key}" type="range" min="0" max="5" value="${value}" step="0.5" aria-label="${escapeHTML(label)}" aria-valuetext="${value ? `${value} out of 5` : "Unrated"}">
    </div>${showValue ? `<output class="book-rating-value" aria-hidden="true">${value || "—"}</output>` : ""}</div>`;
}

function wireBookRating(root, key, item, commit) {
  const group = $(`[data-rating-track="${key}"]`, root);
  const input = $("input", group);
  const output = $("output", group);
  const stars = $$(".book-star", group);
  let value = item?.personal_rating || 0;
  function paint(score) {
    if (output) output.value = score || "—";
    stars.forEach((star, index) => star.style.setProperty("--fill", `${starFill(score, index)}%`));
  }
  bindBookRange(input, (fraction) => Math.max(.5, Math.ceil(fraction * 10) / 2), paint, () => paint(value), (score) => {
    input.value = value;
    if (score) commit(score);
  });
  return (score) => {
    if (score === value) return;
    value = score;
    input.value = score;
    input.setAttribute("aria-valuetext", score ? `${score} out of 5` : "Unrated");
    paint(score);
  };
}

function bookRatingMarkup(item) {
  const scope = menuState.reviews ||= state.user ? "mine" : "others";
  const tabs = state.user ? [["mine", "My reviews"], ["others", "Other reviews"]] : [["others", "Other reviews"]];
  return ratingTrackMarkup(item) + `
    ${state.user ? `<form id="inline-review" class="inline-review">
      <textarea id="inline-review-body" aria-label="Review" rows="2" required maxlength="2000" placeholder="Write a review">${escapeHTML(menuState.draft)}</textarea>
      <button type="submit" class="small-button" aria-label="Post review">Post</button>
    </form>` : '<button type="button" class="text-button" data-book-action="sign-in">Sign in to review</button>'}
    <div id="inline-review-tabs" class="review-tabs" role="tablist" aria-label="Reviews">${tabs.map(([id, label]) =>
      `<button type="button" id="review-tab-${id}" class="text-button" role="tab" aria-controls="inline-review-list" data-book-action="${id}"
        aria-selected="${scope === id}" tabindex="${scope === id ? 0 : -1}">${label}</button>`).join("")}</div>
    <div id="inline-review-list" class="inline-review-list" role="tabpanel" aria-labelledby="review-tab-${scope}" aria-live="polite"></div>`;
}

function plainExcerpt(text, limit) {
  const sample = [...text];
  return sample.length > limit ? sample.slice(0, limit).join("").replace(/\s+\S*$/, "") + "…" : text;
}

function excerptMarkup(key, title, text, limit) {
  const expanded = menuState.expanded.has(key);
  const short = plainExcerpt(text, limit);
  return `<div class="book-excerpt"><strong>${title}</strong><p id="book-excerpt-${key}">${escapeHTML(expanded ? text : short)}</p>
    ${short !== text ? `<button type="button" class="text-button" data-book-action="${key}" aria-expanded="${expanded}" aria-controls="book-excerpt-${key}" aria-label="${expanded ? "Collapse" : "Expand"} ${title.toLowerCase()}">${expanded ? "Less" : "More"}</button>` : ""}</div>`;
}

function safeBookURL(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function bookCatalogueText(book) {
  return [book.author && `By ${book.author}`, book.title_aliases?.length && `Also known as ${book.title_aliases.join(", ")}`,
    book.source, book.publication ?? (book.id || book.reason ? book.status : "")].filter(Boolean).join(" · ");
}

function bookDetailsMarkup(book, item) {
  const catalogue = bookCatalogueText(book);
  const links = (book.urls || []).flatMap((source) => {
    const url = safeBookURL(source.url);
    return url ? [`<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.site || "Source")}</a>`] : [];
  });
  return `<p class="book-detail-title">${escapeHTML(book.title)}</p>` +
    excerptMarkup("synopsis", "Synopsis", book.synopsis || "No synopsis available.", 234) +
    excerptMarkup("catalogue", "Catalogue info", catalogue || "No additional catalogue info.", 166) +
    `<div class="book-tags" aria-label="Book tags">${(book.tags || []).map((tag) => `<button type="button" class="chip" data-book-action="tag" data-tag="${escapeHTML(tag)}">${escapeHTML(tag)}</button>`).join("")}</div>
    ${book.reason ? `<p class="book-result-reason">${escapeHTML(book.reason)}</p>` : ""}
    <div class="book-extra">${links.join("")}${item?.cover_url && !item.cover_cached ? '<button type="button" class="text-button" data-book-action="cache">Cache cover</button>' : ""}
    ${state.user?.role === "admin" ? '<button type="button" class="text-button" data-book-action="edit">Edit record</button>' : ""}</div>`;
}

function suggestionMarkup(book, item) {
  const expanded = menuState.expanded.has("review-info");
  return `${ratingTrackMarkup(item, "rating", "Personal rating")}
    ${bookTierMarkup(item)}
    <div id="suggestion-information" class="suggestion-information" ${expanded ? "" : "hidden"}>
      ${excerptMarkup("synopsis", "Synopsis", book.synopsis || "No synopsis available.", 234)}
      ${excerptMarkup("catalogue", "Catalogue info", bookCatalogueText(book) || "No additional catalogue info.", 166)}
    </div>`;
}

function currentMenuItem() {
  return menuState.book && state.savedBooks.get(bookID(menuState.book));
}

function positionBookMenu(reveal = false) {
  const menu = $("#book-popover");
  const anchor = menuState.anchor;
  if (menu.hidden || !anchor?.isConnected) return;
  const rect = anchor.getBoundingClientRect();
  const { clientWidth: width, clientHeight: height } = document.documentElement;
  const headerBottom = $(".site-header").getBoundingClientRect().bottom;
  const shelfRow = anchor.closest('[data-layout="shelf"] .book-row');
  const rowBounds = shelfRow?.getBoundingClientRect();
  const cabinet = anchor.closest(".cabinet-interior")?.getBoundingClientRect();
  if (rect.bottom <= Math.max(headerBottom, cabinet?.top ?? 0) || rect.top >= Math.min(height, cabinet?.bottom ?? height) ||
      (rowBounds && (rect.right <= rowBounds.left || rect.left >= rowBounds.right))) {
    closeBookMenu();
    return;
  }
  const cover = $(".book-face", anchor);
  const coverWidth = cover.offsetWidth;
  const menuWidth = Math.min(coverWidth, width - 16);
  menu.style.width = `${menuWidth}px`;
  menu.style.maxHeight = `${Math.max(0, height - Math.max(0, headerBottom) - 24)}px`;
  menu.toggleAttribute("data-narrow", menuWidth < 112);
  menu.toggleAttribute("data-vertical", menuWidth < 69);
  const coverLeft = shelfRow ? rect.left : cover.getBoundingClientRect().left;
  const left = Math.min(coverLeft, width - menuWidth - 8);
  const top = rect.bottom + 4;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;

  const needed = top + menu.offsetHeight + 8 - height;
  if (reveal && needed > 0) {
    const modal = anchor.closest(".collection-detail");
    const spacer = modal || document.body;
    const previous = parseFloat(spacer.style.getPropertyValue("--book-scroll-space")) || 0;
    spacer.style.setProperty("--book-scroll-space", `${previous + Math.ceil(needed)}px`);
    spacer.setAttribute("data-book-scroll-space", "");
    menuState.scrollSpace = spacer;
    (modal || window).scrollBy({ top: needed, behavior: "instant" });
    positionBookMenu();
  }
}

function reviewingSuggestion() {
  return menuState.host?.id === "tierboard" && state.reviewSuggestions;
}

function refreshBookMenu(focusSelector = "", preserveScroll = false) {
  const book = menuState.book;
  if (!book) return;
  const menu = $("#book-popover");
  const rail = $(".book-menu-rail", menu);
  const panel = $(".book-menu-body", menu);
  const previousScroll = preserveScroll ? panel.scrollTop : 0;
  const item = currentMenuItem();
  const pane = menuState.pane;
  const review = reviewingSuggestion();
  const active = review ? "Review suggested tier" : pane && BOOK_MENU_TITLE[pane];
  const saved = item ? "Remove from library" : "Save to library";
  const panes = [
    ["status", "Reading status", "ListChecks"],
    ["rating", "Rating and reviews", "Star"],
    ["details", "Book details", "Info"],
  ];
  menu.setAttribute("aria-label", `Actions for ${book.title}`);
  menu.toggleAttribute("data-reviewing", review);
  rail.innerHTML = review
    ? `<div class="suggestion-heading"><strong class="suggestion-title">${escapeHTML(book.title)}</strong>
      ${book.author ? `<small>${escapeHTML(book.author)}</small>` : ""}</div>${menuAction("review-info", "Book info", "Info",
      `aria-controls="suggestion-information" aria-expanded="${menuState.expanded.has("review-info")}"`)}`
    : menuAction("bookmark", saved, "Bookmark", `aria-pressed="${Boolean(item)}"`) +
    '<span class="book-menu-divider" aria-hidden="true"></span>' +
    panes.map(([key, label, icon]) => menuAction(key, label, icon, `aria-controls="book-menu-body" aria-expanded="${pane === key}"`)).join("");
  panel.hidden = !active;
  panel.dataset.pane = review ? "suggestion" : pane;
  panel.setAttribute("aria-label", active || "Book actions");
  if (active) panel.innerHTML = review ? suggestionMarkup(book, item)
    : { status: () => bookStatusMarkup(item), rating: () => bookRatingMarkup(item), details: () => bookDetailsMarkup(book, item) }[pane]();
  panel.scrollTop = previousScroll;
  menu.toggleAttribute("data-busy", bookJobs.has(bookID(book)));
  if (!review && pane === "status") {
    wireTimeline(panel, "status", READING_STOPS, displayStatus(item?.status), (status) => changeMenuBook({ status }, "#book-track-status"));
  }
  if (review || pane === "status") {
    wireTimeline(panel, "tier", TIER_STOPS, item?.tier, (tier) => changeMenuBook({ tier }, "#book-track-tier"));
  }
  if (review || pane === "rating") {
    wireBookRating(panel, "rating", item, (rating) => changeMenuBook({ rating }, "#book-track-rating"));
    if (!review && menuState.reviews) showInlineReviews();
  }
  positionBookMenu(menuState.pinned);
  if (focusSelector && !menu.hidden) $(focusSelector, menu)?.focus({ preventScroll: true });
}

function openBookMenu(anchor, { pin = false, keyboard = false } = {}) {
  const book = shelfBooks.get(anchor);
  if (!book || !anchor.isConnected) return;
  const menu = $("#book-popover");
  if (anchor !== menuState.anchor) {
    closeBookMenu();
    menuState.book = book;
    menuState.anchor = anchor;
    menuState.host = anchor.closest("#results,#books,#tierboard,#collection-detail,#owner-favorites");
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("data-book-open", "");
    menu.hidden = false;
  }
  if (pin) {
    menuState.pinned = true;
    menuState.pane ||= "status";
  }
  if (reviewingSuggestion() && state.savedBooks.get(bookID(book))?.tier_source === "suggested") setReviewBook(bookID(book));
  refreshBookMenu(keyboard ? reviewingSuggestion() ? "#book-track-rating" : '[data-book-action="bookmark"]' : "");
}

function closeBookMenu(restoreFocus = false) {
  clearTimeout(menuState.timer);
  clearTimeout(menuState.dismiss);
  const { anchor } = menuState;
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    anchor.removeAttribute("data-book-open");
  }
  const menu = $("#book-popover");
  if (menu) {
    menu.hidden = true;
  }
  menuState.scrollSpace?.style.removeProperty("--book-scroll-space");
  menuState.scrollSpace?.removeAttribute("data-book-scroll-space");
  Object.assign(menuState, { book: null, anchor: null, host: null, pinned: false, pane: "", reviews: "", reviewData: null, draft: "", scrollSpace: null });
  menuState.dismiss = 0;
  menuState.expanded.clear();
  if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
}

function restoreBookAnchor() {
  if (!menuState.book) return;
  if (!menuState.anchor.isConnected) {
    const id = bookID(menuState.book);
    const next = $(`${BOOK_TRIGGER}[data-book-key="${id}"]`, menuState.host);
    if (!next) { closeBookMenu(); return; }
    menuState.anchor = next;
    next.setAttribute("aria-expanded", "true");
    next.setAttribute("data-book-open", "");
  }
}

function menuLogin() {
  closeBookMenu();
  openLogin();
}

function changeMenuBook(changes, focusSelector = "", operation = "save") {
  return changeBook(menuState.book, changes, { focusSelector, operation });
}

function changeCompactBook(book, changes, focusSelector) {
  const control = $(focusSelector);
  return changeBook(book, changes, { focusSelector, control });
}

async function changeBook(book, changes, { focusSelector, control, operation = "save" }) {
  if (!book) return;
  if (!state.user) { menuLogin(); return; }
  const id = bookID(book);
  if (bookJobs.has(id)) return;
  const item = state.savedBooks.get(id);
  const epoch = state.token;
  const job = Symbol();
  bookJobs.set(id, job);
  const menu = $("#book-popover");
  const compact = control?.closest(".compact-book");
  const review = state.reviewSuggestions && document.body.dataset.view === "tiers" &&
    (reviewingSuggestion() || compact?.closest("#tierboard"));
  if (review && item?.tier_source === "suggested") setReviewBook(id);
  const actionSurface = compact || menu;
  actionSurface.setAttribute("data-busy", "");
  const sameBook = () => menuState.book && bookID(menuState.book) === id && state.token === epoch;
  try {
    if (operation === "remove") {
      await request(`/collection/${id}`, { method: "DELETE" });
    } else {
      const path = operation === "confirm" ? `/collection/${id}/tier` : `/collection/${id}`;
      const body = operation === "confirm" ? { confirm_prediction: true } : { ...(!item ? { status: "reading" } : {}), ...changes };
      await request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    if (state.token !== epoch) return;
    const restoreFocus = control && document.activeElement === control;
    await refreshLibrary({ keepBooks: true });
    if (review && advanceReview(id)) return;
    if (review && state.reviewBookId === id && (changes.rating || changes.tier || operation === "confirm")) {
      if (focusReviewBook(id, changes.rating ? "tier" : "rating")) return;
    }
    if (sameBook()) refreshBookMenu(focusSelector, true);
    else if (restoreFocus && document.activeElement === document.body) $(focusSelector)?.focus({ preventScroll: true });
    if (operation === "remove") setNotice("Removed from your library.");
    else if (operation === "confirm") setNotice("Tier confirmed.");
    else if (!item && !compact) setNotice(`Saved to ${STATUS[changes.status || "reading"]}.`);
  } catch (error) {
    if (state.token === epoch) setNotice(error.message, true);
  } finally {
    if (bookJobs.get(id) === job) bookJobs.delete(id);
    if (compact || sameBook()) actionSurface.removeAttribute("data-busy");
  }
}

function selectReviewTab(scope, focus = false) {
  menuState.reviews = scope;
  $$("#inline-review-tabs [role=tab]").forEach((tab) => {
    const selected = tab.dataset.bookAction === scope;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus({ preventScroll: true });
  });
  $("#inline-review-list").setAttribute("aria-labelledby", `review-tab-${scope}`);
  showInlineReviews(true);
}

async function showInlineReviews(reveal = false) {
  const book = menuState.book;
  const account = state.token;
  const scope = menuState.reviews;
  const target = $("#inline-review-list");
  if (!target || !scope) return;
  const current = () => target.isConnected && menuState.book === book && menuState.reviews === scope && state.token === account;
  if (!menuState.reviewData) {
    const id = bookID(book);
    menuState.reviewData = id < 0 ? Promise.resolve({ reviews: [] }) : request(`/novels/${id}/reviews`);
    target.textContent = "Loading reviews…";
  }
  const pending = menuState.reviewData;
  try {
    const data = await pending;
    if (!current() || menuState.reviewData !== pending) return;
    const entries = data.reviews.filter((entry) => (entry.user_id === state.user?.id) === (scope === "mine"));
    target.innerHTML = entries.length ? entries.map((entry) => `<article class="review-entry"><strong>${escapeHTML(entry.username)}${entry.rating ? ` · ${entry.rating}/5` : ""}</strong><p>${escapeHTML(entry.body)}</p></article>`).join("") : "<p>No reviews yet.</p>";
    if (reveal) target.scrollIntoView({ block: "nearest", container: "nearest" });
  } catch (error) {
    if (current()) target.textContent = error.message;
    if (menuState.reviewData === pending) menuState.reviewData = null;
  }
}

async function postInlineReview(event) {
  event.preventDefault();
  if (!state.user) return menuLogin();
  const book = menuState.book;
  if (!book) return;
  const form = event.target;
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    await request(`/novels/${bookID(book)}/reviews`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: $("#inline-review-body").value, rating: currentMenuItem()?.personal_rating ?? null }),
    });
    if (menuState.book !== book) return;
    menuState.draft = "";
    menuState.reviewData = null;
    if (menuState.pane === "rating") {
      form.reset();
      $("#inline-review-body").value = "";
      selectReviewTab("mine", true);
    }
    setNotice("Review posted.");
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function setBookPane(pane, focusSelector = "") {
  if (menuState.pane === pane) {
    if (focusSelector) $(focusSelector)?.focus({ preventScroll: true });
    return;
  }
  menuState.pane = pane;
  const book = menuState.book;
  refreshBookMenu(focusSelector);
  if (pane === "details") await loadBookDetails(book, () => menuState.pane === "details");
}

async function loadBookDetails(book, relevant) {
  if (bookID(book) < 0 || book.id) return;
  try {
    const details = await request(`/novels/${bookID(book)}`);
    if (menuState.book !== book) return;
    Object.assign(book, { ...details, publication: details.status, status: book.status });
    if (relevant()) refreshBookMenu("", true);
  } catch { /* Keep the metadata available in the current view. */ }
}

function suggestedBookIds() {
  return $$("[data-book-key]", $("#tierboard")).map((trigger) => Number(trigger.dataset.bookKey))
    .filter((id) => state.savedBooks.get(id)?.tier_source === "suggested");
}

let nextReviewIds = [];

function setReviewBook(id) {
  if (id !== state.reviewBookId) {
    const suggestions = suggestedBookIds();
    const index = suggestions.indexOf(id);
    nextReviewIds = [...suggestions.slice(index + 1), ...suggestions.slice(0, Math.max(index, 0))];
  }
  state.reviewBookId = id;
  $$("[data-book-key]", $("#tierboard")).forEach((element) => {
    element.toggleAttribute("data-review-current", Number(element.dataset.bookKey) === id);
  });
}

function nextSuggestedBook(candidates = [...nextReviewIds, ...suggestedBookIds()]) {
  for (const id of candidates) {
    if (id === state.reviewBookId || state.savedBooks.get(id)?.tier_source !== "suggested") continue;
    if (focusReviewBook(id)) return true;
  }
  return false;
}

function focusReviewBook(id, field = "rating") {
  const book = $(`[data-book-key="${id}"]`, $("#tierboard"));
  if (!book) return false;
  setReviewBook(id);
  book.scrollIntoView({ block: "center", inline: "nearest" });
  if (book.matches(BOOK_TRIGGER)) {
    openBookMenu(book, { pin: true, keyboard: true });
    if (field === "tier" && menuState.anchor === book) $("#book-track-tier")?.focus();
  } else {
    $(`input[id$="-${field}"]`, book)?.focus({ preventScroll: true });
  }
  return true;
}

function advanceReview(id) {
  const item = state.savedBooks.get(id);
  if (!state.reviewSuggestions || document.body.dataset.view !== "tiers" || state.reviewBookId !== id ||
      !item?.personal_rating || !TIERS.includes(item.tier) || item.tier_source === "suggested") return false;
  const choices = [...nextReviewIds, ...suggestedBookIds()];
  setReviewBook(null);
  if (!nextSuggestedBook(choices)) {
    closeBookMenu();
    $("#review-suggestions").focus({ preventScroll: true });
    setNotice("Suggestions reviewed.");
  }
  return true;
}

function initShelfMenus() {
  const menu = $("#book-popover");
  let hoverPane;
  function cancelDismissal() {
    clearTimeout(menuState.dismiss);
    menuState.dismiss = 0;
  }
  function dismissAway() {
    if (!menuState.dismiss) menuState.dismiss = setTimeout(closeBookMenu, 175);
  }
  document.addEventListener("pointermove", (event) => {
    if (!menuState.anchor || event.pointerType !== "mouse" || event.buttons) return;
    if (menu.contains(event.target) || menuState.anchor.contains(event.target)) cancelDismissal();
    else dismissAway();
  });
  document.documentElement.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && menuState.anchor) dismissAway();
  });
  document.addEventListener("pointerdown", (event) => {
    menuState.skipClick = null;
    if (!menuState.anchor || menu.contains(event.target) || menuState.anchor.contains(event.target)) return;
    const other = event.target.closest(BOOK_TRIGGER);
    if (other && menuState.pinned) {
      menuState.ignored = other;
      menuState.skipClick = other;
    }
    closeBookMenu();
  }, true);
  document.addEventListener("dragstart", (event) => {
    const trigger = event.target.closest(BOOK_TRIGGER);
    if (!trigger) return;
    menuState.ignored = trigger;
    closeBookMenu();
  }, true);
  document.addEventListener("pointerover", (event) => {
    const trigger = event.target.closest(BOOK_TRIGGER);
    if (!trigger || menuState.ignored === trigger || menuState.pinned || state.draggedId !== null ||
        event.pointerType !== "mouse" || event.buttons || trigger.contains(event.relatedTarget) || menuState.anchor === trigger) return;
    clearTimeout(menuState.timer);
    cancelDismissal();
    menuState.timer = setTimeout(() => openBookMenu(trigger), 145);
  });
  document.addEventListener("pointerout", (event) => {
    const trigger = event.target.closest(BOOK_TRIGGER);
    if (!trigger || trigger.contains(event.relatedTarget)) return;
    if (trigger === menuState.ignored) menuState.ignored = null;
    if (!menuState.pinned) clearTimeout(menuState.timer);
  });
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest(BOOK_TRIGGER);
    if (!trigger) return;
    if (trigger === menuState.skipClick || (event.detail === 0 && menuState.pinned && menuState.anchor !== trigger)) {
      menuState.skipClick = null;
      closeBookMenu();
      return;
    }
    openBookMenu(trigger, { pin: true, keyboard: event.detail === 0 });
  });
  menu.addEventListener("pointerenter", () => { clearTimeout(menuState.timer); cancelDismissal(); });
  menu.addEventListener("pointerdown", () => {
    clearTimeout(hoverPane);
    menuState.pinned = true;
  });
  menu.addEventListener("pointerover", (event) => {
    const action = event.target.closest("[aria-expanded][data-book-action]");
    if (!action || !BOOK_MENU_TITLE[action.dataset.bookAction] || event.pointerType !== "mouse" || action.contains(event.relatedTarget)) return;
    clearTimeout(hoverPane);
    hoverPane = setTimeout(() => {
      if (action.isConnected && !menu.hidden) setBookPane(action.dataset.bookAction);
    }, 100);
  });
  menu.addEventListener("pointerout", (event) => {
    const action = event.target.closest("[aria-expanded][data-book-action]");
    if (action && !action.contains(event.relatedTarget)) clearTimeout(hoverPane);
  });
  menu.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-book-action]");
    if (!trigger || !menuState.book) return;
    menuState.pinned = true;
    const action = trigger.dataset.bookAction;
    if (BOOK_MENU_TITLE[action]) {
      setBookPane(action, event.detail === 0 ? "#book-menu-body input,#book-menu-body button" : "");
    } else if (action === "review-info") {
      const wasOpen = menuState.expanded.delete("review-info");
      if (!wasOpen) menuState.expanded.add("review-info");
      refreshBookMenu('[data-book-action="review-info"]');
      if (!wasOpen) {
        const panel = $("#book-menu-body");
        const info = $("#suggestion-information");
        panel.scrollTop = info.offsetTop - panel.offsetTop;
        loadBookDetails(menuState.book, () => reviewingSuggestion() && menuState.expanded.has("review-info"));
      }
    } else if (action === "bookmark") {
      if (!state.user) return menuLogin();
      if (!currentMenuItem()) {
        menuState.pane = "status";
        changeMenuBook({}, '[data-book-action="bookmark"]');
      } else changeMenuBook({}, '[data-book-action="bookmark"]', "remove");
    } else if (action === "confirm") {
      changeMenuBook({}, "#book-track-tier", "confirm");
    } else if (action === "next") {
      nextSuggestedBook();
    } else if (action === "synopsis" || action === "catalogue") {
      if (menuState.expanded.has(action)) menuState.expanded.delete(action);
      else menuState.expanded.add(action);
      refreshBookMenu(`[data-book-action="${action}"]`, true);
    } else if (action === "mine" || action === "others") {
      selectReviewTab(action);
    } else if (action === "sign-in") {
      menuLogin();
    } else if (action === "edit") {
      const book = menuState.book;
      closeBookMenu();
      openBookEditor(bookID(book), book);
    } else if (action === "cache") {
      cacheCover(bookID(menuState.book), trigger);
    } else if (action === "tag") {
      closeBookMenu();
      toggleTag(trigger.dataset.tag);
    }
  });
  menu.addEventListener("input", (event) => {
    if (event.target.id === "inline-review-body") menuState.draft = event.target.value;
  });
  menu.addEventListener("keydown", (event) => {
    const tabs = event.target.closest("#inline-review-tabs");
    if (!tabs || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const first = tabs.firstElementChild;
    const last = tabs.lastElementChild;
    const next = event.key === "Home" ? first : event.key === "End" ? last : event.target === first ? last : first;
    selectReviewTab(next.dataset.bookAction, true);
  });
  menu.addEventListener("submit", postInlineReview);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeBookMenu(true);
    }
  });
  window.addEventListener("resize", () => positionBookMenu(menuState.pinned));
  document.addEventListener("scroll", (event) => {
    if (event.target.matches?.('[data-layout="shelf"] .book-row') && event.target.scrollTop) {
      event.target.scrollTop = 0;
    }
    if (event.target === document || event.target.closest?.(".modal,.book-row,.cabinet-interior")) positionBookMenu();
  }, { capture: true, passive: true });
}
