const CATEGORY_PALETTE = {
  "Agriculture and Food":                          "#59a14f",
  "Animals":                                       "#53210b",
  "Armed Forces and National Security":            "#627e2d",
  "Arts, Culture, Religion":                       "#d4a6c8",
  "Civil Rights and Liberties, Minority Issues":   "#b07aa1",
  "Commerce":                                      "#084481",
  "Congress":                                      "#b1927b",
  "Crime and Law Enforcement":                     "#ff9da7",
  "Economics and Public Finance":                  "#759842",
  "Education":                                     "#c74f4f",
  "Emergency Management":                          "#ca1316",
  "Energy":                                        "#edc948",
  "Environmental Protection":                      "#15650c",
  "Families":                                      "#fabfd2",
  "Finance and Financial Sector":                  "#e4b200",
  "Foreign Trade and International Finance":       "#ab58c6",
  "Government Operations and Politics":            "#79706e",
  "Health":                                        "#e15759",
  "Housing and Community Development":             "#8a5948",
  "Immigration":                                   "#9c755f",
  "International Affairs":                         "#3aa6dc",
  "Labor and Employment":                          "#f28e2b",
  "Law":                                           "#dabe8a",
  "Native Americans":                              "#a0522d",
  "Other":                                         "#cccccc",
  "Public Lands and Natural Resources":            "#8cd17d",
  "Science, Technology, Communications":           "#76b7b2",
  "Social Welfare":                                "#d37295",
  "Sports and Recreation":                         "#499894",
  "Taxation":                                      "#ffbf00",
  "Transportation and Public Works":               "#bab0ac",
  "Water Resources Development":                   "#85c7d4",
};

import {
  groupBillsByYear,
  makeSecondaryName,
  makePrimaryName,
  DOLLAR_SIGN_BASE,
  BUILDING_BASE,
  HEALTH_CROSS_BASE,
  SCIENCE_BASE,
  ENVIRONMENT_BASE,
  EDUCATION_CAP_BASE,
  CRIME_SIREN_BASE,
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
  FINANCE_COINS_BASE,
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
import { getMemberDetails, getSponsoredLegislation, countBillsByPolicyArea, searchMembers } from "./congress-utils.js";

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

function attachBillTooltip(el, bill, color, category, tooltip) {
  const primary = makePrimaryName(bill);
  const secondary = makeSecondaryName(bill, primary);
  const introduced = bill.introducedDate || "";

  el.addEventListener("mouseenter", () => {
    const summary = bill._summary || "";
    tooltip.innerHTML =
      `<div class="tt-category" style="color:${color}">${category}</div>` +
      `<div class="tt-primary">${primary}</div>` +
      (summary ? `<div class="tt-summary">${summary}</div>` : "") +
      (secondary ? `<div class="tt-secondary">${secondary}</div>` : "") +
      (introduced ? `<div class="tt-date">${introduced}</div>` : "");
    tooltip.style.display = "block";
  });
  el.addEventListener("mousemove", (e) => {
    const pad = 14;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + tw > window.innerWidth) x = e.clientX - tw - pad;
    if (y + th > window.innerHeight) y = e.clientY - th - pad;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  });
  el.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
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
  results: document.getElementById("member-results"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  raw: document.getElementById("raw"),
  sessions: document.getElementById("sessions"),
  memberProfile: document.getElementById("member-profile"),
  memberName: document.getElementById("member-name"),
  memberFacts: document.getElementById("member-facts"),
  focusAreasSection: document.getElementById("focus-areas-section"),
  focusAreas: document.getElementById("focus-areas"),
  focusAreasBar: document.getElementById("focus-areas-bar"),
  focusAreasMeta: document.getElementById("focus-areas-meta"),
};

// Keeps the status line out of the layout entirely when it has nothing to say,
// so it doesn't leave a stray gap under the timeline.
function setStatus(text) {
  ui.status.textContent = text || "";
  ui.status.hidden = !text;
}

const TOP_FOCUS_AREA_COUNT = 4;

function capitalizeFirst(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

function renderFocusAreas(topGroups, areaTexts, yearBills = []) {
  ui.focusAreas.innerHTML = "";
  ui.focusAreasBar.innerHTML = "";
  if (!topGroups.length) {
    ui.focusAreasSection.hidden = true;
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

  for (const g of topGroups) {
    const li = document.createElement("li");
    li.className = "focus-area-item";

    const color = CATEGORY_PALETTE[g.category] ?? "#cccccc";

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
    const items = Array.isArray(areaTexts?.[g.category]) ? areaTexts[g.category] : [];
    items.forEach((item, i) => {
      const label = String(item.label || "").trim();
      const span = document.createElement("span");
      span.className = "focus-area-list-item";
      span.textContent = i === 0 ? capitalizeFirst(label) : label;

      const bill = g.bills[item.bill - 1];
      if (bill) attachBillTooltip(span, bill, color, g.category, tooltip);

      desc.appendChild(span);
      if (i < items.length - 1) {
        const sep = document.createElement("span");
        sep.className = "focus-area-sep";
        sep.textContent = " · ";
        desc.appendChild(sep);
      }
    });

    li.append(key, desc);
    ui.focusAreas.appendChild(li);
  }

  ui.focusAreasSection.hidden = false;
}

const SHAPED_CATEGORIES = {
  "Taxation":                             { base: DOLLAR_SIGN_BASE },
  "Health":                               { base: HEALTH_CROSS_BASE },
  "Crime and Law Enforcement":            { base: CRIME_SIREN_BASE },
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
  "Finance and Financial Sector":         { base: FINANCE_COINS_BASE },
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

function renderGroups(groups, totalCounts = {}) {
  ui.grid.innerHTML = "";

  const sponsoredMap = new Map(groups.map((g) => [g.category, g]));
  const allCategoryNames = new Set([
    ...Object.keys(totalCounts),
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
        total: totalCounts[category] ?? 0,
      };
    })
    .sort((a, b) => b.total - a.total);

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
    counts.textContent = `${g.count} / ${g.total}`;

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
      node.addEventListener("click", async () => {
        renderYearTimeline(yearGroups, group.key, bioguideId, member);
        renderMemberProfile(member, group.year);
        setStatus(`Summarizing ${group.bills.length} sponsored bills…`);
        ui.focusAreasSection.hidden = true;
        ui.grid.innerHTML = "";
        try {
          const grouped = groupBillsByPolicyArea(group.bills);
          const topGroups = grouped.slice(0, TOP_FOCUS_AREA_COUNT);
          const [, totalCounts, areaTexts] = await Promise.all([
            summarizeBillsWithClaude(group.bills),
            countBillsByPolicyArea(group.congress),
            getFocusAreas(bioguideId, group.year, topGroups),
          ]);
          renderGroups(grouped, totalCounts);
          setStatus("");
          renderFocusAreas(topGroups, areaTexts, group.bills);
        } catch (err) {
          setStatus(`Failed to summarize: ${err.message}`);
        }
      });
    }

    ui.sessions.appendChild(node);
  }
}

function districtForYear(member, year) {
  const terms = Array.isArray(member.terms) ? member.terms : [];
  const term = terms.find((t) => t.startYear <= year && (t.endYear == null || year <= t.endYear));
  return term ? term.district ?? null : member.district;
}

function renderMemberProfile(member, year) {
  ui.memberName.textContent = member.directOrderName || member.invertedOrderName || member.name || "";

  const termCount = Array.isArray(member.terms) ? member.terms.length : 0;
  const district = year != null ? districtForYear(member, year) : member.district;
  const districtLabel = district != null ? `District ${district}` : null;
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
      setStatus(`Summarizing ${activeYear.bills.length} bills…`);
      const grouped = groupBillsByPolicyArea(activeYear.bills);
      const topGroups = grouped.slice(0, TOP_FOCUS_AREA_COUNT);
      const [, totalCounts, areaTexts] = await Promise.all([
        summarizeBillsWithClaude(activeYear.bills),
        countBillsByPolicyArea(activeYear.congress),
        getFocusAreas(bioguideId, activeYear.year, topGroups),
      ]);
      renderGroups(grouped, totalCounts);
      setStatus("");
      renderFocusAreas(topGroups, areaTexts, activeYear.bills);
    } else {
      setStatus(`Found ${bills.length} sponsored bills.`);
    }

  } catch (err) {
    setStatus("Failed to load bills.");
    ui.raw.textContent = String(err && err.message ? err.message : err);
  }
}

let searchDebounceTimer = null;
let latestSearchToken = 0;

function clearResults() {
  ui.results.innerHTML = "";
  ui.results.hidden = true;
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
  for (const m of members) {
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
ui.memberDistrict.addEventListener("input", scheduleSearch);

// Picking a state means "show me this state's members", so drop the name and
// district left over from the last selection — they AND with the state and would
// otherwise match nothing.
ui.memberState.addEventListener("change", () => {
  ui.memberQuery.value = "";
  ui.memberDistrict.value = "";
  clearTimeout(searchDebounceTimer);
  runSearch();
});
ui.searchBtn.addEventListener("click", () => {
  clearTimeout(searchDebounceTimer);
  runSearch();
});
document.addEventListener("click", (e) => {
  if (
    !ui.results.contains(e.target) &&
    e.target !== ui.memberQuery &&
    e.target !== ui.memberState
  ) {
    clearResults();
  }
});

ui.memberQuery.value = "Beyer, Donald S.";
loadBills("B001292");
