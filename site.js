const CATEGORY_PALETTE = {
  // Government, law, and civil rights
  "Congress":                                      "#b1927b",
  "Government Operations and Politics":            "#79706e",
  "Law":                                           "#dabe8a",
  "Crime and Law Enforcement":                     "#ff9da7",
  "Civil Rights and Liberties, Minority Issues":   "#b07aa1",
  "Native Americans":                              "#a0522d",

  // Borders, foreign affairs, and defense
  "Immigration":                                   "#9c755f",
  "International Affairs":                         "#3aa6dc",
  "Armed Forces and National Security":            "#627e2d",
  "Foreign Trade and International Finance":       "#ab58c6",

  // Economy, money, and work
  "Commerce":                                      "#ee9b00",
  "Finance and Financial Sector":                  "#e4b200",
  "Economics and Public Finance":                  "#759842",
  "Taxation":                                      "#ffcc00",
  "Labor and Employment":                          "#f28e2b",

  // Health, welfare, and household
  "Health":                                        "#e15759",
  "Families":                                      "#fabfd2",
  "Social Welfare":                                "#d37295",
  "Housing and Community Development":             "#8a5948",
  "Education":                                     "#c74f4f",

  // Land, environment, and resources
  "Agriculture and Food":                          "#59a14f",
  "Animals":                                       "#53210b",
  "Environmental Protection":                      "#15650c",
  "Public Lands and Natural Resources":            "#8cd17d",
  "Water Resources Development":                   "#85c7d4",
  "Energy":                                        "#edc948",

  // Infrastructure, science, and response
  "Transportation and Public Works":               "#bab0ac",
  "Science, Technology, Communications":           "#76b7b2",
  "Emergency Management":                          "#ca1316",

  // Culture and recreation
  "Arts, Culture, Religion":                       "#d4a6c8",
  "Sports and Recreation":                         "#499894",

  "Other":                                         "#cccccc",
};

import {
  groupBillsByYear,
  makeSecondaryName,
  makePrimaryName,
  formatBillId,
  billPageUrl,
  DOLLAR_SIGN_BASE,
  BUILDING_BASE,
  HEALTH_CROSS_BASE,
  SCIENCE_BASE,
  ENVIRONMENT_BASE,
  EDUCATION_CAP_BASE,
  CRIME_BADGE_BASE,
  ARMED_FORCES_BASE,
  ENERGY_BOLT_BASE,
  LABOR_BASE,
  INTERNATIONAL_AFFAIRS_BASE,
  TRANSPORTATION_BASE,
  AGRICULTURE_BASE,
  IMMIGRATION_BASE,
  GAVEL_BASE,
  HOUSE_BASE,
  ANIMALS_PAW_BASE,
  ARTS_NOTE_BASE,
  CIVIL_RIGHTS_BASE,
  COMMERCE_CART_BASE,
  ECONOMICS_CHART_BASE,
  EMERGENCY_ALERT_BASE,
  FAMILIES_HEART_BASE,
  FINANCE_BASE,
  FOREIGN_TRADE_SHIP_BASE,
  LAW_SCALES_BASE,
  NATIVE_AMERICANS_BASE,
  OTHER_QUESTION_BASE,
  PUBLIC_LANDS_BASE,
  SOCIAL_WELFARE_BASE,
  SPORTS_TROPHY_BASE,
  WATER_DROPLET_BASE,
  fitShapeToCount,
} from "./utils.js";
import { summarizeBillsWithClaude, getFocusAreas } from "./claude-utils.js";
import { getMemberDetails, getSponsoredLegislation, getBillDescriptions, getBillsChamberPassage, recordBillStage, emptyBillStages, CHAMBER_BY_TYPE, countBillsByPolicyArea, searchMembers } from "./congress-utils.js";

function mutedColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 0.3;
  return `rgb(${Math.round(r * f + 255 * (1 - f))},${Math.round(g * f + 255 * (1 - f))},${Math.round(b * f + 255 * (1 - f))})`;
}


function getTooltipElement() {
  let tooltip = document.getElementById("bill-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "bill-tooltip";
    tooltip.className = "bill-tooltip";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

// A clicked bill pins its description open so it can be read without holding the
// cursor still. While something is pinned, hovering other bills leaves it alone —
// otherwise sliding the mouse off to read would immediately replace the text.
let pinnedEl = null;
// Rebuilds the pinned tooltip's markup; kept so a summary landing after the pin
// can repaint it (see refreshPinnedTooltip).
let pinnedRender = null;
// The click that pins also bubbles to the document closer below. Set on the way
// past so that one click doesn't undo itself; the closer clears it.
let skipNextDocumentClose = false;

function unpinTooltip() {
  if (pinnedEl) pinnedEl.classList.remove("bill-pinned");
  document.getElementById("bill-tooltip")?.classList.remove("is-pinned");
  pinnedEl = null;
  pinnedRender = null;
}

function hideBillTooltip() {
  unpinTooltip();
  const tooltip = document.getElementById("bill-tooltip");
  if (tooltip) tooltip.style.display = "none";
}

// A re-render can replace the element a pin points at. Only pins whose element
// actually went away are dropped, so repainting one section doesn't close a
// description opened from another.
function dropStalePinnedTooltip() {
  if (pinnedEl && !pinnedEl.isConnected) hideBillTooltip();
}

// Summaries are written onto the bills as they arrive, so a tooltip pinned before
// its summary landed would otherwise sit there missing the one line it's for.
function refreshPinnedTooltip() {
  if (pinnedRender) pinnedRender();
}

// Registered once, in the bubble phase, and deliberately does not stopPropagation
// anywhere — the search results have their own document-level closer that must
// keep seeing these clicks.
document.addEventListener("click", (e) => {
  if (skipNextDocumentClose) {
    skipNextDocumentClose = false;
    return;
  }
  // A click on the card itself is aimed at its link, not at dismissing it.
  const tooltip = document.getElementById("bill-tooltip");
  if (tooltip?.contains(e.target)) return;
  hideBillTooltip();
});

// CRS summaries run to a few hundred words — far more than a hover card can hold.
// Cut at a word boundary so the visible text never ends mid-word.
const CRS_TOOLTIP_MAX_CHARS = 320;
// Mirrors .bill-tooltip's max-width. Kept here too because positionAt caps the
// tooltip against the viewport before measuring it, and a fixed CSS width can't
// react to a window narrower than the tooltip itself.
const TOOLTIP_MAX_WIDTH = 520;
const TOOLTIP_EDGE_PAD = 14;

function truncateForTooltip(text, max = CRS_TOOLTIP_MAX_CHARS) {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).replace(/[.,;:]$/, "")}…`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// The boxed arrow (not a bare "↗") is what marks the title as a link out to
// another site, so it's drawn rather than left to a font's arbitrary glyph.
const EXTERNAL_LINK_ICON =
  '<svg class="tt-external-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
  '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

const STEP_CHECK_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 7"/></svg>';

// Simple resolutions only ever go through their own chamber, and concurrent
// resolutions never go to the President — the tracker only lists stages a bill
// of its type can actually reach. Otherwise the chamber of origin comes first.
const SIMPLE_RESOLUTION_TYPES = new Set(["HRES", "SRES"]);
const CONCURRENT_RESOLUTION_TYPES = new Set(["HCONRES", "SCONRES"]);

function billStageTracker(bill) {
  const type = String(bill.type || "").toUpperCase();
  const origin = CHAMBER_BY_TYPE[type] || "House";
  const other = origin === "House" ? "Senate" : "House";
  // bill._stages lands after the tooltip's first paint (see
  // getBillsChamberPassage); until then latestAction alone is the best guess.
  const stages = bill._stages || recordBillStage(emptyBillStages(), bill.latestAction);

  const steps = [{ label: "Introduced", reached: true }];
  steps.push({ label: `Passed ${origin}`, reached: stages.passed.has(origin) });
  if (!SIMPLE_RESOLUTION_TYPES.has(type)) {
    steps.push({ label: `Passed ${other}`, reached: stages.passed.has(other) });
    if (!CONCURRENT_RESOLUTION_TYPES.has(type)) {
      steps.push({ label: "To President", reached: stages.president });
      steps.push({ label: "Became Law", reached: stages.law });
    }
  }
  // A later stage implies every earlier one, even where the action history
  // skips saying so, so the furthest one reached is the bill's current stage.
  let current = 0;
  steps.forEach((step, i) => { if (step.reached) current = i; });

  return (
    `<ol class="tt-tracker">` +
    steps
      .map((step, i) => {
        const cls = `tt-bill-status${i <= current ? " is-reached" : ""}${i === current ? " is-current" : ""}`;
        return (
          `<li class="${cls}"${i === current ? ' aria-current="step"' : ""}>` +
          `<span class="tt-bill-status-dot">${i <= current ? STEP_CHECK_ICON : ""}</span>` +
          `<span class="tt-bill-status-label">${escapeHtml(step.label)}</span></li>`
        );
      })
      .join("") +
    `</ol>`
  );
}

// The end dots sit centred over their labels, and those labels start and end
// at the tooltip's text margins — so each end dot is inset by half its label's
// width, which only a measurement can tell. Must run once the tooltip is shown.
function alignTrackerEnds(tooltip) {
  const tracker = tooltip.querySelector(".tt-tracker");
  if (!tracker) return;
  const inset = (label, dot) => `${Math.max(0, (label.offsetWidth - dot.offsetWidth) / 2)}px`;
  const first = tracker.firstElementChild;
  const last = tracker.lastElementChild;
  tracker.style.paddingLeft = inset(first.querySelector(".tt-bill-status-label"), first.querySelector(".tt-bill-status-dot"));
  tracker.style.paddingRight = inset(last.querySelector(".tt-bill-status-label"), last.querySelector(".tt-bill-status-dot"));
}

function attachBillTooltip(el, bill, color, category, tooltip) {
  const primary = makePrimaryName(bill);
  const secondary = makeSecondaryName(bill, primary);
  const billId = formatBillId(bill);
  const introduced = bill.introducedDate || "";
  const pageUrl = billPageUrl(bill);

  const render = () => {
    // The generated line is a condensed version of the description below it, so
    // it supersedes it. Until it arrives the raw description beats nothing.
    const summary =
      bill._summary || (bill._description ? truncateForTooltip(bill._description.text) : "");
    tooltip.innerHTML =
      `<div class="tt-category" style="color:${color}">${escapeHtml(category)}</div>` +
      `<div class="tt-primary">` +
        (billId ? `<span class="tt-bill-id">${escapeHtml(billId)}</span> ` : "") +
        // The title itself is the link to congress.gov once pinned — see
        // .tt-title-link, which only turns on pointer/underline styling then, the
        // same as the tooltip's own pointer-events. The arrow marks it as a link
        // even on hover, before it's actually clickable.
        (pageUrl
          ? `<a class="tt-title-link" href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">` +
            `${escapeHtml(primary)}${EXTERNAL_LINK_ICON}</a>`
          : escapeHtml(primary)) +
        `</div>` +
      (introduced ? `<div class="tt-date">${escapeHtml(introduced)}</div>` : "") +
      (summary ? `<div class="tt-summary">${escapeHtml(summary)}</div>` : "") +
      (secondary ? `<div class="tt-secondary">${escapeHtml(secondary)}</div>` : "") +
      billStageTracker(bill);
    tooltip.style.display = "block";
    alignTrackerEnds(tooltip);
  };

  const positionAt = (clientX, clientY) => {
    const pad = TOOLTIP_EDGE_PAD;
    // clientWidth/Height exclude the scrollbars that innerWidth/Height count, so
    // measuring against the latter lets the tooltip slip under one and clip.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Shrink to fit before measuring: in a window narrower than the tooltip,
    // flipping sides can't help, because neither side has room for it.
    const capW = `${Math.min(TOOLTIP_MAX_WIDTH, vw - pad * 2)}px`;
    const capH = `${vh - pad * 2}px`;
    // Only write when it actually changes — this runs on every mousemove, and a
    // style write followed by the offsetWidth read below forces a sync layout.
    if (tooltip.style.maxWidth !== capW) tooltip.style.maxWidth = capW;
    if (tooltip.style.maxHeight !== capH) tooltip.style.maxHeight = capH;

    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;

    // Prefer below-right of the cursor, flipping to the far side when the
    // preferred one would overflow.
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + tw > vw - pad) x = clientX - tw - pad;
    if (y + th > vh - pad) y = clientY - th - pad;

    // The flip alone can still land off-screen — cursor close to the far edge, or
    // a tooltip taller than the viewport — so clamp into view as the last step.
    // Low side wins the tie when it simply doesn't fit, pinning it to the edge.
    x = Math.max(pad, Math.min(x, vw - tw - pad));
    y = Math.max(pad, Math.min(y, vh - th - pad));
    // A pinned tooltip is positioned absolute (page coordinates), so the
    // viewport-relative x/y above need the scroll offset added; a hovering one
    // stays fixed (viewport coordinates) and skips it.
    if (tooltip.classList.contains("is-pinned")) {
      x += window.scrollX;
      y += window.scrollY;
    }
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  };

  el.addEventListener("mouseenter", () => {
    if (pinnedEl) return;
    render();
  });
  el.addEventListener("mousemove", (e) => {
    if (pinnedEl) return;
    positionAt(e.clientX, e.clientY);
  });
  el.addEventListener("mouseleave", () => {
    if (pinnedEl) return;
    tooltip.style.display = "none";
  });
  el.addEventListener("click", (e) => {
    // Clicking the pinned bill again closes it, so the square you opened is also
    // the obvious place to click to dismiss. The document closer below finishes
    // the job — this just declines to re-pin.
    if (pinnedEl === el) return;
    unpinTooltip();
    render();
    tooltip.classList.add("is-pinned");
    positionAt(e.clientX, e.clientY);
    pinnedEl = el;
    pinnedRender = render;
    el.classList.add("bill-pinned");
    skipNextDocumentClose = true;
  });
}

function makeBillSquare(bill, color, category, tooltip) {
  const sq = document.createElement("div");
  sq.className = "bill-square";
  sq.style.backgroundColor = color;
  attachBillTooltip(sq, bill, color, category, tooltip);
  return sq;
}

function groupBillsByPolicyArea(bills) {
  const groups = new Map();
  for (const bill of bills) {
    const category = bill.policyArea?.name || "Other";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(bill);
  }
  return Array.from(groups, ([category, categoryBills]) => ({
    category,
    count: categoryBills.length,
    bills: categoryBills,
  })).sort((a, b) => b.count - a.count);
}


const ui = {
  memberQuery: document.getElementById("member-query"),
  memberState: document.getElementById("member-state"),
  memberDistrict: document.getElementById("member-district"),
  searchBtn: document.getElementById("member-search-btn"),
  memberQueryToggle: document.getElementById("member-query-toggle"),
  results: document.getElementById("member-results"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  raw: document.getElementById("raw"),
  sessions: document.getElementById("sessions"),
  memberProfile: document.getElementById("member-profile"),
  memberName: document.getElementById("member-name"),
  memberTitle: document.getElementById("member-title"),
  memberFacts: document.getElementById("member-facts"),
  focusAreasSection: document.getElementById("focus-areas-section"),
  focusAreas: document.getElementById("focus-areas"),
  focusAreasBar: document.getElementById("focus-areas-bar"),
  focusAreasMeta: document.getElementById("focus-areas-meta"),
  focusAreasProgress: document.getElementById("focus-areas-progress"),
  focusAreasToggle: document.getElementById("focus-areas-toggle"),
  memberMap: document.getElementById("member-map"),
  memberMapPanel: document.getElementById("member-map-panel"),
};

// Keeps the status line out of the layout entirely when it has nothing to say,
// so it doesn't leave a stray gap under the timeline.
function setStatus(text) {
  ui.status.textContent = text || "";
  ui.status.hidden = !text;
}

// The only thing still missing while Claude works is the per-area summary text,
// so the waiting state lives on the focus-area rows themselves — a note in the
// section header and placeholder bars in the description column — instead of a
// loose status line shoving the layout around above it.
function setFocusAreasPending(pending) {
  ui.focusAreasSection.classList.toggle("is-generating", pending);
  ui.focusAreasProgress.hidden = !pending;
}

const TOP_FOCUS_AREA_COUNT = 4;

function capitalizeFirst(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

// Uneven widths so the placeholder reads as a line of prose rather than a bar
// chart. Rotated by row so the rows don't stack into one identical block, and
// keyed off the row index rather than random so re-renders don't reshuffle it.
const DESC_SKELETON_WIDTHS = ["34%", "22%", "27%", "19%"];

function buildDescSkeleton(rowIndex) {
  const skeleton = document.createElement("span");
  skeleton.className = "focus-area-skeleton";
  skeleton.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) {
    const bar = document.createElement("span");
    bar.className = "focus-area-skeleton-bar";
    bar.style.width = DESC_SKELETON_WIDTHS[(rowIndex + i) % DESC_SKELETON_WIDTHS.length];
    skeleton.appendChild(bar);
  }
  return skeleton;
}

// Categories past the top few are one-off enough that asking Claude to write a
// bullet list for each of them isn't worth the calls — the bill's own title
// stands in instead, so an expanded row costs nothing to render.
const EXTRA_FOCUS_ITEM_MAX_CHARS = 60;

// Populated by every renderFocusAreas call so the expand toggle can repaint
// from the same data without re-fetching or re-summarizing anything.
let focusAreasState = { topGroups: [], areaTexts: null, yearBills: [], extraGroups: [] };
let focusAreasExpanded = false;

function renderFocusAreas(topGroups, areaTexts, yearBills = [], extraGroups = []) {
  focusAreasState = { topGroups, areaTexts, yearBills, extraGroups };
  if (!topGroups.length) focusAreasExpanded = false;
  paintFocusAreas();
}

function paintFocusAreas() {
  const { topGroups, areaTexts, yearBills, extraGroups } = focusAreasState;
  ui.focusAreas.innerHTML = "";
  ui.focusAreasBar.innerHTML = "";
  if (!topGroups.length) {
    ui.focusAreasSection.hidden = true;
    ui.focusAreasToggle.hidden = true;
    return;
  }

  const tooltip = getTooltipElement();
  const shown = topGroups.reduce((sum, g) => sum + g.count, 0);
  const total = Math.max(yearBills.length, shown);

  ui.focusAreasMeta.textContent = `${total} sponsored bill${total === 1 ? "" : "s"}`;

  // One pixel per sponsored bill, each in its own policy area's colour and
  // ordered by area size, so the top focus areas lead the line.
  ui.focusAreasBar.setAttribute(
    "aria-label",
    `${total} sponsored bills, ${shown} in the top focus areas`
  );

  const barBills = yearBills.length ? yearBills : topGroups.flatMap((g) => g.bills);
  for (const g of groupBillsByPolicyArea(barBills)) {
    const color = CATEGORY_PALETTE[g.category] ?? "#cccccc";
    for (const bill of g.bills) {
      const px = document.createElement("span");
      px.style.backgroundColor = color;
      attachBillTooltip(px, bill, color, g.category, tooltip);
      ui.focusAreasBar.appendChild(px);
    }
  }

  // Shared by both the top rows (Claude-labeled) and the expanded ones below
  // (labeled from the bills' own titles) so the two look like one list.
  const buildRow = (g, color, fillDesc) => {
    const li = document.createElement("li");
    li.className = "focus-area-item";

    const key = document.createElement("div");
    key.className = "focus-area-key";

    const dot = document.createElement("span");
    dot.className = "focus-area-dot";
    dot.style.backgroundColor = color;

    const name = document.createElement("span");
    name.className = "focus-area-name";
    name.textContent = g.category;
    const count = document.createElement("span");
    count.className = "focus-area-count";
    count.textContent = ` · ${g.count}`;
    name.appendChild(count);

    key.append(dot, name);

    const desc = document.createElement("div");
    desc.className = "focus-area-desc";
    fillDesc(desc);

    li.append(key, desc);
    return li;
  };

  // A row's items joined with " · " separators — used identically whether the
  // labels came from Claude or straight from a bill's own title.
  const appendItems = (desc, items, getBill, color, category) => {
    items.forEach((label, i) => {
      const span = document.createElement("span");
      span.className = "focus-area-list-item";
      span.textContent = i === 0 ? capitalizeFirst(label) : label;

      const bill = getBill(i);
      if (bill) {
        attachBillTooltip(span, bill, color, category, tooltip);
        if (/became public law/i.test(bill.latestAction?.text || "")) {
          span.classList.add("focus-area-list-item-law");
        }
      }

      desc.appendChild(span);
      if (i < items.length - 1) {
        const sep = document.createElement("span");
        sep.className = "focus-area-sep";
        sep.textContent = " · ";
        desc.appendChild(sep);
      }
    });
  };

  for (const [rowIndex, g] of topGroups.entries()) {
    const color = CATEGORY_PALETTE[g.category] ?? "#cccccc";
    const row = buildRow(g, color, (desc) => {
      const items = Array.isArray(areaTexts?.[g.category]) ? areaTexts[g.category] : [];
      // Shown only while .is-generating is set, so a row whose summaries failed
      // or came back empty collapses to its reserved height rather than pulsing
      // forever.
      if (!items.length) desc.appendChild(buildDescSkeleton(rowIndex));
      appendItems(
        desc,
        items.map((item) => String(item.label || "").trim()),
        (i) => g.bills[items[i].bill - 1],
        color,
        g.category
      );
    });
    ui.focusAreas.appendChild(row);
  }

  // Categories too small to make the top few — no Claude call for these, so
  // they cost nothing to render and appear the instant the toggle is opened.
  if (focusAreasExpanded) {
    for (const g of extraGroups) {
      const color = CATEGORY_PALETTE[g.category] ?? "#cccccc";
      const row = buildRow(g, color, (desc) => {
        appendItems(
          desc,
          g.bills.map((bill) => truncateForTooltip(makePrimaryName(bill), EXTRA_FOCUS_ITEM_MAX_CHARS)),
          (i) => g.bills[i],
          color,
          g.category
        );
      });
      row.classList.add("focus-area-item-extra");
      ui.focusAreas.appendChild(row);
    }
  }

  ui.focusAreasToggle.hidden = extraGroups.length === 0;
  if (extraGroups.length) {
    // No visible label, so the reason to click and the state it leaves behind
    // both live in the accessible name rather than on-screen text.
    ui.focusAreasToggle.setAttribute(
      "aria-label",
      focusAreasExpanded
        ? "Show fewer categories"
        : `Show ${extraGroups.length} more ${extraGroups.length === 1 ? "category" : "categories"}`
    );
    ui.focusAreasToggle.setAttribute("aria-expanded", String(focusAreasExpanded));
    ui.focusAreasToggle.classList.toggle("is-expanded", focusAreasExpanded);
  }

  ui.focusAreasSection.hidden = false;
  dropStalePinnedTooltip();
}

// Built once — .is-expanded (toggled per paint above) rotates it via CSS rather
// than swapping markup for an "up" version.
ui.focusAreasToggle.innerHTML =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

ui.focusAreasToggle.addEventListener("click", () => {
  focusAreasExpanded = !focusAreasExpanded;
  paintFocusAreas();
});

const SHAPED_CATEGORIES = {
  "Taxation":                             { base: DOLLAR_SIGN_BASE },
  "Health":                               { base: HEALTH_CROSS_BASE },
  "Crime and Law Enforcement":            { base: CRIME_BADGE_BASE },
  "Science, Technology, Communications":  { base: SCIENCE_BASE },
  "Environmental Protection":             { base: ENVIRONMENT_BASE },
  "Government Operations and Politics":   { base: BUILDING_BASE, gap: "1px" },
  "Armed Forces and National Security":   { base: ARMED_FORCES_BASE },
  "Education":                            { base: EDUCATION_CAP_BASE },
  "Energy":                               { base: ENERGY_BOLT_BASE },
  "Labor and Employment":                 { base: LABOR_BASE },
  "International Affairs":                { base: INTERNATIONAL_AFFAIRS_BASE },
  "Transportation and Public Works":      { base: TRANSPORTATION_BASE },
  "Agriculture and Food":                 { base: AGRICULTURE_BASE },
  "Immigration":                          { base: IMMIGRATION_BASE },
  "Congress":                             { base: GAVEL_BASE },
  "Housing and Community Development":   { base: HOUSE_BASE },
  "Animals":                              { base: ANIMALS_PAW_BASE },
  "Arts, Culture, Religion":              { base: ARTS_NOTE_BASE },
  "Civil Rights and Liberties, Minority Issues": { base: CIVIL_RIGHTS_BASE },
  "Commerce":                             { base: COMMERCE_CART_BASE },
  "Economics and Public Finance":         { base: ECONOMICS_CHART_BASE },
  "Emergency Management":                 { base: EMERGENCY_ALERT_BASE },
  "Families":                             { base: FAMILIES_HEART_BASE },
  "Finance and Financial Sector":         { base: FINANCE_BASE },
  "Foreign Trade and International Finance": { base: FOREIGN_TRADE_SHIP_BASE },
  "Law":                                  { base: LAW_SCALES_BASE },
  "Native Americans":                     { base: NATIVE_AMERICANS_BASE },
  "Other":                                { base: OTHER_QUESTION_BASE },
  "Public Lands and Natural Resources":   { base: PUBLIC_LANDS_BASE },
  "Social Welfare":                       { base: SOCIAL_WELFARE_BASE },
  "Sports and Recreation":                { base: SPORTS_TROPHY_BASE },
  "Water Resources Development":          { base: WATER_DROPLET_BASE },
};

function fillPixelArtSquares(squares, base, gap, bills, fillerCount, color, filler, category, tooltip) {
  const totalForCategory = bills.length + fillerCount;
  const { positions, rows, cols } = fitShapeToCount(base, totalForCategory);

  squares.style.display = "grid";
  squares.style.gridTemplateColumns = `repeat(${cols}, 5px)`;
  squares.style.gridTemplateRows = `repeat(${rows}, 5px)`;
  squares.style.gap = gap;
  squares.style.flex = "none";

  let posIdx = 0;
  for (const bill of bills) {
    if (posIdx >= positions.length) break;
    const { row, col } = positions[posIdx++];
    const sq = makeBillSquare(bill, color, category, tooltip);
    sq.style.gridColumn = String(col + 1);
    sq.style.gridRow = String(row + 1);
    squares.appendChild(sq);
  }
  for (let i = 0; i < fillerCount && posIdx < positions.length; i++, posIdx++) {
    const { row, col } = positions[posIdx];
    const sq = document.createElement("div");
    sq.className = "bill-square";
    sq.style.backgroundColor = filler;
    sq.style.gridColumn = String(col + 1);
    sq.style.gridRow = String(row + 1);
    squares.appendChild(sq);
  }
}

// `totalCounts` is null until the chamber-wide counts arrive, which lets the grid
// paint from the member's own bills alone: no filler squares, no "/ total", and
// ordered by the member's own count until the real totals can reorder it.
function renderGroups(groups, totalCounts = null) {
  ui.grid.innerHTML = "";

  const sponsoredMap = new Map(groups.map((g) => [g.category, g]));
  const allCategoryNames = new Set([
    ...Object.keys(totalCounts ?? {}),
    ...groups.map((g) => g.category),
  ]);

  if (!allCategoryNames.size) {
    ui.grid.innerHTML = '<div class="muted">No bills found.</div>';
    return;
  }

  const allGroups = Array.from(allCategoryNames)
    .map((category) => {
      const g = sponsoredMap.get(category);
      return {
        category,
        bills: g?.bills ?? [],
        count: g?.count ?? 0,
        total: totalCounts?.[category] ?? 0,
      };
    })
    .sort((a, b) => (totalCounts ? b.total - a.total : b.count - a.count));

  const tooltip = getTooltipElement();

  const grid = document.createElement("div");
  grid.className = "policy-grid";

  for (const g of allGroups) {
    const color = CATEGORY_PALETTE[g.category] ?? "#cccccc";
    const filler = mutedColor(color);

    const cell = document.createElement("div");
    cell.className = "policy-cell";

    const label = document.createElement("div");
    label.className = "policy-cell-label";
    label.textContent = g.category;
    label.style.color = color;

    const counts = document.createElement("div");
    counts.className = "policy-cell-counts";
    counts.textContent = totalCounts ? `${g.count} / ${g.total}` : String(g.count);

    const squares = document.createElement("div");
    squares.className = "policy-squares";

    const fillerCount = Math.max(0, g.total - g.count);
    const shapedCfg = SHAPED_CATEGORIES[g.category];
    if (shapedCfg) {
      fillPixelArtSquares(squares, shapedCfg.base, shapedCfg.gap ?? "0px", g.bills, fillerCount, color, filler, g.category, tooltip);
    } else {
      for (const bill of g.bills) {
        squares.appendChild(makeBillSquare(bill, color, g.category, tooltip));
      }
      for (let i = 0; i < fillerCount; i++) {
        const sq = document.createElement("div");
        sq.className = "bill-square";
        sq.style.backgroundColor = filler;
        squares.appendChild(sq);
      }
    }

    cell.appendChild(label);
    cell.appendChild(counts);
    cell.appendChild(squares);
    grid.appendChild(cell);
  }

  ui.grid.appendChild(grid);
  dropStalePinnedTooltip();
}

// Bumped on every year/member selection, so a slow response belonging to a view
// the user has already navigated away from can't paint over the current one.
let billViewToken = 0;

// Paints everything derivable from the bills already in hand, then lets each
// remote piece upgrade the view as it lands — so the grid and focus areas are on
// screen while Claude is still summarizing, rather than only afterwards.
async function renderYearView(bioguideId, group) {
  const token = ++billViewToken;
  const grouped = groupBillsByPolicyArea(group.bills);
  const topGroups = grouped.slice(0, TOP_FOCUS_AREA_COUNT);
  const extraGroups = grouped.slice(TOP_FOCUS_AREA_COUNT);

  // Each year selection starts collapsed — an expansion from the last one
  // shouldn't carry over onto bills it was never about.
  focusAreasExpanded = false;
  // The focus-area list and its bar come straight off the bills already in hand.
  renderFocusAreas(topGroups, null, group.bills, extraGroups);
  setFocusAreasPending(true);
  setStatus("");

  // One piece failing shouldn't blank the pieces that did load, so each is
  // tracked on its own instead of a single rejection aborting the batch.
  const failed = [];
  const track = (label, promise) =>
    promise.catch((err) => {
      failed.push(label);
      console.error(`${label} failed: ${err?.message ?? err}`);
    });

  // All three start together; only the paints below wait on them.
  const counts = track("bill counts", countBillsByPolicyArea(group.congress));
  // Tooltips read bill._summary at hover time, so summaries need no re-render:
  // they start appearing as soon as they've been written onto the bills.
  // Descriptions first: they are what Claude summarizes, so the two calls are a
  // chain, not a race. The raw description shows in tooltips as soon as it lands,
  // and the generated line replaces it a moment later.
  const described = track("bill descriptions", getBillDescriptions(group.bills)).then((result) => {
    if (token !== billViewToken || !result) return;
    refreshPinnedTooltip();
    const { crs = 0, titles = 0, "bill-text": billText = 0 } = result.bySource || {};
    console.info(
      `bill descriptions: ${crs} from CRS, ${titles} from bill titles, ` +
      `${billText} from bill text, ` +
      `${result.checked - crs - titles - billText} undescribed (of ${result.checked})`
    );
  });
  // A failed description fetch is not fatal: track() already swallowed it, and
  // those bills fall back to their short title.
  const summaries = described.then(() =>
    track("summaries", summarizeBillsWithClaude(group.bills)).then(() => {
      if (token === billViewToken) refreshPinnedTooltip();
    })
  );
  const focus = track("focus areas", getFocusAreas(bioguideId, group.year, topGroups)).then(
    (areaTexts) => {
      if (token === billViewToken && areaTexts) renderFocusAreas(topGroups, areaTexts, group.bills, extraGroups);
    }
  );
  // Tooltips read bill._stages at hover time, same as summaries,
  // so this needs no re-render either — just a refresh for whichever tooltip is
  // pinned when it lands.
  const chamberPassage = track("chamber passage", getBillsChamberPassage(group.bills)).then(() => {
    if (token === billViewToken) refreshPinnedTooltip();
  });

  // A category's pixel art is sized to its chamber-wide total, not to this member's
  // slice of it, so painting the grid before the counts land would draw every icon
  // at a fraction of its final size and then snap it ~10x larger. Only the session's
  // first selection in a congress actually waits (~200ms, a KV cache hit) — after
  // that countBillsByPolicyArea resolves from memory. The seconds-long Claude calls
  // above hold nothing back, and if the counts fail the grid still draws without them.
  const totalCounts = await counts;
  if (token !== billViewToken) return;
  renderGroups(grouped, totalCounts ?? null);

  await Promise.all([summaries, focus, described, chamberPassage]);
  if (token !== billViewToken) return;
  setFocusAreasPending(false);
  setStatus(failed.length ? `Could not load ${failed.join(", ")}.` : "");
}

function renderYearTimeline(yearGroups, activeKey, bioguideId, member) {
  ui.sessions.innerHTML = "";
  if (!yearGroups.length) return;

  const byYear = new Map(yearGroups.map((g) => [g.year, g]));
  const currentYear = new Date().getFullYear();

  for (let year = currentYear; year >= currentYear - 4; year--) {
    const group = byYear.get(year);

    const node = document.createElement("button");
    node.type = "button";
    node.className = `timeline-year${group ? " served" : ""}${group?.key === activeKey ? " active" : ""}`;
    node.disabled = !group;

    const dot = document.createElement("span");
    dot.className = "timeline-dot";
    node.appendChild(dot);

    const label = document.createElement("span");
    label.className = "timeline-label";
    label.textContent = String(year);
    node.appendChild(label);

    if (group) {
      node.addEventListener("click", () => {
        renderYearTimeline(yearGroups, group.key, bioguideId, member);
        renderMemberProfile(member, group.year);
        renderYearView(bioguideId, group);
      });
    }

    ui.sessions.appendChild(node);
  }
}

// The term covering a given year. Carries chamber, stateCode and district, so the
// label and the map both come from one lookup and stay consistent across redistricting.
function termForYear(member, year) {
  const terms = Array.isArray(member.terms) ? member.terms : [];
  if (year == null) return terms[terms.length - 1] ?? null;
  return terms.find((t) => t.startYear <= year && (t.endYear == null || year <= t.endYear)) ?? null;
}

// Party can change mid-career (Sinema, Manchin), so pick the entry covering the
// selected year rather than whatever is current.
function partyForYear(member, year) {
  const history = Array.isArray(member.partyHistory) ? [...member.partyHistory] : [];
  if (!history.length) return null;
  history.sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  const target = year ?? new Date().getFullYear();
  const covering = history.filter((p) => (p.startYear ?? 0) <= target);
  const party = covering.length ? covering[covering.length - 1] : history[0];
  return party.partyAbbreviation || (party.partyName ? party.partyName[0] : null);
}

// Every seat has a shape at 1:5,000,000 — including the island delegations the
// coarser 1:20,000,000 file left out. Kept as a guard so an unexpected state code
// skips the fetch rather than 404ing.
const STATES_WITH_SHAPES = new Set(["AK","AL","AR","AS","AZ","CA","CO","CT","DC","DE","FL","GA","GU","HI","IA","ID","IL","IN","KS","KY","LA","MA","MD","ME","MI","MN","MO","MP","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH","OK","OR","PA","PR","RI","SC","SD","TN","TX","UT","VA","VI","VT","WA","WI","WV","WY"]);

const districtShapeCache = new Map();
let latestMapToken = 0;
let renderedMapState = null;

// Setting .hidden on an SVG element is a no-op (HTML-only property), so toggle the
// attribute and clear the geometry — otherwise the previous state stays on screen.
function hideDistrictMap() {
  ui.memberMapPanel.hidden = true;
  ui.memberMap.innerHTML = "";
  ui.memberMap.removeAttribute("aria-label");
  renderedMapState = null;
}

function loadDistrictShapes(stateCode) {
  if (!STATES_WITH_SHAPES.has(stateCode)) return Promise.resolve(null);
  if (!districtShapeCache.has(stateCode)) {
    districtShapeCache.set(
      stateCode,
      fetch(`./geo-boundaries/${stateCode}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    );
  }
  return districtShapeCache.get(stateCode);
}

// Equirectangular projection into a unit-height box. One state spans a small
// enough extent that a real projection is overkill, but longitude still has to be
// scaled by cos(latitude) or the state comes out stretched sideways.
function projectFeatures(features) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const eachRing = (geom, fn) => {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) for (const ring of poly) fn(ring);
  };
  for (const f of features) {
    eachRing(f.geometry, (ring) => {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    });
  }
  if (!Number.isFinite(minLon)) return null;

  // Alaska's Aleutians cross the antimeridian, so its raw bounding box spans ~359°
  // and would squash the state into a sliver. Shift the western islands past 180°
  // to keep the state contiguous.
  const wraps = maxLon - minLon > 180;
  const lonOf = (lon) => (wraps && lon < 0 ? lon + 360 : lon);
  if (wraps) {
    minLon = Infinity;
    maxLon = -Infinity;
    for (const f of features) {
      eachRing(f.geometry, (ring) => {
        for (const [lon] of ring) {
          const L = lonOf(lon);
          if (L < minLon) minLon = L;
          if (L > maxLon) maxLon = L;
        }
      });
    }
  }

  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  const spanX = Math.max((maxLon - minLon) * k, 1e-9);
  const spanY = Math.max(maxLat - minLat, 1e-9);
  const height = 100;
  const scale = height / spanY;
  const width = spanX * scale;

  const paths = features.map((f) => {
    let d = "";
    eachRing(f.geometry, (ring) => {
      ring.forEach(([lon, lat], i) => {
        const x = ((lonOf(lon) - minLon) * k * scale).toFixed(2);
        const y = ((maxLat - lat) * scale).toFixed(2);
        d += (i ? "L" : "M") + x + "," + y;
      });
      d += "Z";
    });
    return { d, district: f.properties.d };
  });
  return { paths, width, height };
}

function renderDistrictMap(term) {
  const token = ++latestMapToken;
  const stateCode = (term && term.stateCode) || null;

  // Drop the old map up front when the state changes, so another state's outline is
  // never left showing while this one loads (or fails to).
  if (stateCode !== renderedMapState) hideDistrictMap();
  if (!stateCode) return;

  loadDistrictShapes(stateCode).then((geo) => {
    if (token !== latestMapToken) return;                  // a newer year won the race
    if (!geo || !geo.features || !geo.features.length) {
      hideDistrictMap();                                   // e.g. GU/AS/MP/VI have no shapes
      return;
    }
    const projected = projectFeatures(geo.features);
    if (!projected) {
      hideDistrictMap();
      return;
    }

    // Senators represent the whole state, so nothing is singled out. At-large
    // reps have no district in the member-detail payload, so chamber is the
    // reliable signal — their state has a single district either way.
    const isHouse = /house/i.test(term.chamber || "");
    const target = term.district ?? null;
    ui.memberMap.setAttribute("viewBox", `0 0 ${projected.width.toFixed(2)} ${projected.height}`);
    ui.memberMap.innerHTML = projected.paths
      .map((p) => {
        const active = !isHouse || target == null || p.district === target;
        return `<path d="${p.d}" class="${active ? "is-active" : ""}"></path>`;
      })
      .join("");
    ui.memberMap.setAttribute(
      "aria-label",
      isHouse && target != null
        ? `${term.stateName || stateCode}, district ${target} highlighted`
        : `${term.stateName || stateCode}`
    );
    ui.memberMapPanel.hidden = false;
    renderedMapState = stateCode;
  });
}

function renderMemberProfile(member, year) {
  const name = member.directOrderName || member.invertedOrderName || member.name || "";
  const party = partyForYear(member, year);
  ui.memberName.textContent = party ? `${name} (${party})` : name;

  const term = termForYear(member, year);
  const district = term ? term.district ?? null : member.district;
  const districtLabel = district != null ? `District ${district}` : null;
  renderDistrictMap(term);
  // Chamber comes from the term, not the member, so someone who moved from the
  // House to the Senate reads correctly for whichever year is selected.
  const chamber = term ? term.chamber || "" : "";
  const title = /senate/i.test(chamber)
    ? "Senator"
    : /house/i.test(chamber)
      ? "Representative"
      : "";
  ui.memberTitle.textContent = title;
  ui.memberTitle.hidden = !title;
  const facts = [
    member.state,
    districtLabel,
  ].filter(Boolean);
  ui.memberFacts.textContent = facts.join(" · ");

  ui.memberProfile.hidden = false;
}

async function loadBills(bioguideId) {
  if (!bioguideId) return;
  setStatus("Loading bills…");
  ui.raw.textContent = "";
  ui.grid.innerHTML = "";
  ui.sessions.innerHTML = "";
  ui.focusAreasSection.hidden = true;
  ui.focusAreasToggle.hidden = true;
  focusAreasExpanded = false;
  setFocusAreasPending(false);
  hideBillTooltip();
  ui.memberProfile.hidden = true;

  try {
    const [member, bills] = await Promise.all([
      getMemberDetails(bioguideId),
      getSponsoredLegislation(bioguideId),
    ]);
    const yearGroups = groupBillsByYear(bills);
    const activeYear = yearGroups[0];
    renderMemberProfile(member, activeYear ? activeYear.year : undefined);
    renderYearTimeline(yearGroups, activeYear ? activeYear.key : null, bioguideId, member);

    if (activeYear) {
      await renderYearView(bioguideId, activeYear);
    } else {
      setStatus(`Found ${bills.length} sponsored bills.`);
    }

  } catch (err) {
    setStatus("Failed to load bills.");
    ui.raw.textContent = String(err && err.message ? err.message : err);
  }
}

// Seats per state in the 119th Congress, counted off the shapes in geo-boundaries/.
// 0 means a single at-large seat (the API reports its district as 0), so there is
// nothing to choose between.
const STATE_DISTRICT_COUNTS = {
  "Alabama": 7,
  "Alaska": 0,
  "American Samoa": 0,
  "Arizona": 9,
  "Arkansas": 4,
  "California": 52,
  "Colorado": 8,
  "Connecticut": 5,
  "Delaware": 0,
  "District of Columbia": 0,
  "Florida": 28,
  "Georgia": 14,
  "Guam": 0,
  "Hawaii": 2,
  "Idaho": 2,
  "Illinois": 17,
  "Indiana": 9,
  "Iowa": 4,
  "Kansas": 4,
  "Kentucky": 6,
  "Louisiana": 6,
  "Maine": 2,
  "Maryland": 8,
  "Massachusetts": 9,
  "Michigan": 13,
  "Minnesota": 8,
  "Mississippi": 4,
  "Missouri": 8,
  "Montana": 2,
  "Nebraska": 3,
  "Nevada": 4,
  "New Hampshire": 2,
  "New Jersey": 12,
  "New Mexico": 3,
  "New York": 26,
  "North Carolina": 14,
  "North Dakota": 0,
  "Northern Mariana Islands": 0,
  "Ohio": 15,
  "Oklahoma": 5,
  "Oregon": 6,
  "Pennsylvania": 17,
  "Puerto Rico": 0,
  "Rhode Island": 2,
  "South Carolina": 7,
  "South Dakota": 0,
  "Tennessee": 9,
  "Texas": 38,
  "Utah": 4,
  "Vermont": 0,
  "Virgin Islands": 0,
  "Virginia": 11,
  "Washington": 10,
  "West Virginia": 2,
  "Wisconsin": 8,
  "Wyoming": 0,
};

// The district picker only makes sense once a state narrows it down, so it stays
// disabled until then and lists exactly the districts that state has.
function populateDistricts() {
  const state = ui.memberState.value;
  const count = STATE_DISTRICT_COUNTS[state];
  ui.memberDistrict.innerHTML = "";
  const any = document.createElement("option");
  any.value = "";
  any.textContent = "District";
  ui.memberDistrict.appendChild(any);

  if (!state) {
    ui.memberDistrict.disabled = true;
    return;
  }
  if (count === 0) {
    const atLarge = document.createElement("option");
    atLarge.value = "0";
    atLarge.textContent = "At-large";
    ui.memberDistrict.appendChild(atLarge);
  } else {
    for (let d = 1; d <= count; d++) {
      const opt = document.createElement("option");
      opt.value = String(d);
      opt.textContent = String(d);
      ui.memberDistrict.appendChild(opt);
    }
  }
  ui.memberDistrict.disabled = false;
}

let searchDebounceTimer = null;
let latestSearchToken = 0;

function clearResults() {
  ui.results.innerHTML = "";
  ui.results.hidden = true;
}

// Senators represent a whole state and have no district to order by, so they
// lead the list; Representatives follow in ascending district order.
function sortMembersForDisplay(members) {
  return [...members].sort((a, b) => {
    const aSenate = a.chamber === "Senate";
    const bSenate = b.chamber === "Senate";
    if (aSenate !== bSenate) return aSenate ? -1 : 1;
    if (aSenate) return 0;
    return (a.district ?? 0) - (b.district ?? 0);
  });
}

function renderResults(members) {
  ui.results.innerHTML = "";
  if (!members.length) {
    const li = document.createElement("li");
    li.className = "member-results-empty";
    li.textContent = "No results found.";
    ui.results.appendChild(li);
    ui.results.hidden = false;
    return;
  }
  for (const m of sortMembersForDisplay(members)) {
    const li = document.createElement("li");
    const districtLabel =
      m.chamber === "Senate" ? "Senate" : m.district != null ? `District ${m.district}` : "";
    const meta = [m.state, districtLabel, m.partyName].filter(Boolean).join(" · ");
    const nameEl = document.createElement("span");
    nameEl.className = "mr-name";
    nameEl.textContent = m.name;
    const metaEl = document.createElement("span");
    metaEl.className = "mr-meta";
    metaEl.textContent = meta;
    li.appendChild(nameEl);
    li.appendChild(metaEl);
    li.addEventListener("click", () => selectMember(m));
    ui.results.appendChild(li);
  }
  ui.results.hidden = false;
}

function selectMember(member) {
  clearResults();
  ui.memberQuery.value = member.name;
  ui.memberState.value = member.state || "";
  populateDistricts();                                   // options first, then the value
  ui.memberDistrict.value = member.district != null ? String(member.district) : "";
  loadBills(member.bioguideId);
}

async function runSearch() {
  const q = ui.memberQuery.value.trim();
  const state = ui.memberState.value.trim();
  const district = ui.memberDistrict.value.trim();
  if (!q && !state && !district) {
    clearResults();
    return;
  }

  const token = ++latestSearchToken;
  try {
    const { members } = await searchMembers({ q, state, district });
    if (token !== latestSearchToken) return;
    renderResults(members);
  } catch (err) {
    if (token !== latestSearchToken) return;
    setStatus(`Search failed: ${err.message}`);
    clearResults();
  }
}

function scheduleSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 300);
}

ui.memberQuery.addEventListener("input", scheduleSearch);

// A pick is discrete — no keystrokes to wait out.
ui.memberDistrict.addEventListener("change", () => {
  clearTimeout(searchDebounceTimer);
  runSearch();
});

// Picking a state means "show me this state's members", so drop the name and
// district left over from the last selection — they AND with the state and would
// otherwise match nothing.
ui.memberState.addEventListener("change", () => {
  ui.memberQuery.value = "";
  populateDistricts();
  clearTimeout(searchDebounceTimer);
  runSearch();
});
ui.searchBtn.addEventListener("click", () => {
  clearTimeout(searchDebounceTimer);
  runSearch();
});

// Reopens an already-fetched dropdown without refetching; closes it back up on
// a second click. If nothing has been fetched yet, runs the search current
// field values would produce.
ui.memberQueryToggle.addEventListener("click", () => {
  if (!ui.results.hidden) {
    ui.results.hidden = true;
    return;
  }
  if (ui.results.children.length) {
    ui.results.hidden = false;
    return;
  }
  clearTimeout(searchDebounceTimer);
  runSearch();
});

document.addEventListener("click", (e) => {
  // Browsing a state is a persistent roster, not a typeahead dropdown — leave it
  // up until the state is cleared or another search replaces it.
  if (ui.memberState.value) return;
  if (
    !ui.results.contains(e.target) &&
    e.target !== ui.memberQuery &&
    e.target !== ui.memberState &&
    !ui.memberQueryToggle.contains(e.target)
  ) {
    clearResults();
  }
});
