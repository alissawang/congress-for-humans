const CATEGORY_PALETTE = {
  "Agriculture and Food":                          "#59a14f",
  "Animals":                                       "#8cd17d",
  "Armed Forces and National Security":            "#4e79a7",
  "Arts, Culture, Religion":                       "#d4a6c8",
  "Civil Rights and Liberties, Minority Issues":   "#b07aa1",
  "Commerce":                                      "#f28e2b",
  "Congress":                                      "#499894",
  "Crime and Law Enforcement":                     "#ff9da7",
  "Economics and Public Finance":                  "#b6992d",
  "Education":                                     "#86bcb6",
  "Emergency Management":                          "#e15759",
  "Energy":                                        "#edc948",
  "Environmental Protection":                      "#59a14f",
  "Families":                                      "#fabfd2",
  "Finance and Financial Sector":                  "#b6992d",
  "Foreign Trade and International Finance":       "#76b7b2",
  "Government Operations and Politics":            "#79706e",
  "Health":                                        "#e15759",
  "Housing and Community Development":             "#d37295",
  "Immigration":                                   "#9c755f",
  "International Affairs":                         "#b07aa1",
  "Labor and Employment":                          "#f28e2b",
  "Law":                                           "#bab0ac",
  "Native Americans":                              "#a0522d",
  "Other":                                         "#cccccc",
  "Public Lands and Natural Resources":            "#8cd17d",
  "Science, Technology, Communications":           "#76b7b2",
  "Social Welfare":                                "#d37295",
  "Sports and Recreation":                         "#499894",
  "Taxation":                                      "#edc948",
  "Transportation and Public Works":               "#bab0ac",
  "Water Resources Development":                   "#86bcb6",
};

import {
  durationMonths,
  groupBillsByCongress,
  makeSecondaryName,
  makePrimaryName,
  yearTickLabel,
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
  pixelArtPositions,
} from "./utils.js";
import { summarizeBillsWithClaude } from "./claude-utils.js";
import { getSponsoredLegislation, countBillsByPolicyArea } from "./congress-utils.js";

function mutedColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 0.3;
  return `rgb(${Math.round(r * f + 255 * (1 - f))},${Math.round(g * f + 255 * (1 - f))},${Math.round(b * f + 255 * (1 - f))})`;
}


function makeBillSquare(bill, color, category, tooltip) {
  const sq = document.createElement("div");
  sq.className = "bill-square";
  sq.style.backgroundColor = color;

  const primary = makePrimaryName(bill);
  const secondary = makeSecondaryName(bill, primary);
  const introduced = bill.introducedDate || "";

  sq.addEventListener("mouseenter", () => {
    const summary = bill._summary || "";
    tooltip.innerHTML =
      `<div class="tt-category" style="color:${color}">${category}</div>` +
      `<div class="tt-primary">${primary}</div>` +
      (summary ? `<div class="tt-summary">${summary}</div>` : "") +
      (secondary ? `<div class="tt-secondary">${secondary}</div>` : "") +
      (introduced ? `<div class="tt-date">${introduced}</div>` : "");
    tooltip.style.display = "block";
  });
  sq.addEventListener("mousemove", (e) => {
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
  sq.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });

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
  bioguide: document.getElementById("bioguide"),
  load: document.getElementById("load"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  raw: document.getElementById("raw"),
  sessions: document.getElementById("sessions"),
  ticks: document.getElementById("ticks"),
};

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
};

function fillPixelArtSquares(squares, base, gap, bills, fillerCount, color, filler, category, tooltip) {
  const totalForCategory = bills.length + fillerCount;
  const scale = Math.max(1, Math.round(Math.sqrt(totalForCategory / pixelArtPositions(base, 1).length)));
  const positions = pixelArtPositions(base, scale);

  squares.style.display = "grid";
  squares.style.gridTemplateColumns = `repeat(${base[0].length * scale}, 5px)`;
  squares.style.gridTemplateRows = `repeat(${base.length * scale}, 5px)`;
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

  let tooltip = document.getElementById("bill-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "bill-tooltip";
    tooltip.className = "bill-tooltip";
    document.body.appendChild(tooltip);
  }

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

function renderSessions(sessionGroups, activeKey) {
  ui.sessions.innerHTML = "";
  if (!sessionGroups.length) return;

  for (const s of sessionGroups) {
    const chip = document.createElement("button");
    chip.className = `chip${s.key === activeKey ? " active" : ""}`;
    chip.textContent = s.label;
    chip.style.flex = String(s.duration || 1);
    chip.addEventListener("click", async () => {
      renderSessions(sessionGroups, s.key);
      ui.status.textContent = `Analyzing ${s.bills.length} bills…`;
      ui.grid.innerHTML = "";
      try {
        const grouped = groupBillsByPolicyArea(s.bills);
        const [, totalCounts] = await Promise.all([
          summarizeBillsWithClaude(s.bills),
          countBillsByPolicyArea(s.congress),
        ]);
        renderGroups(grouped, totalCounts);
        ui.status.textContent = `Showing ${s.bills.length} bills from ${s.label}.`;
      } catch (err) {
        ui.status.textContent = `Failed to summarize: ${err.message}`;
      }
    });
    ui.sessions.appendChild(chip);
  }
}

function renderTicks(sessionGroups) {
  ui.ticks.innerHTML = "";
  if (!sessionGroups.length) return;

  for (const s of sessionGroups) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.textContent = yearTickLabel(s.minDate, s.maxDate);
    tick.style.flex = String(s.duration || 1);
    ui.ticks.appendChild(tick);
  }
}

async function loadBills() {
  const bioguideId = ui.bioguide.value.trim();
  if (!bioguideId) return;
  ui.status.textContent = "Loading bills…";
  ui.raw.textContent = "";
  ui.grid.innerHTML = "";
  ui.sessions.innerHTML = "";
  ui.ticks.innerHTML = "";

  try {
    const bills = await getSponsoredLegislation(bioguideId);
    const congressGroups = groupBillsByCongress(bills).map((g) => ({
      ...g,
      duration: durationMonths(g.minDate, g.maxDate),
    }));
    const activeCongress = congressGroups[0];
    renderTicks(congressGroups);
    renderSessions(congressGroups, activeCongress ? activeCongress.key : null);

    if (activeCongress) {
      ui.status.textContent = `Summarizing ${activeCongress.bills.length} bills…`;
      const grouped = groupBillsByPolicyArea(activeCongress.bills);
      const [, totalCounts] = await Promise.all([
        summarizeBillsWithClaude(activeCongress.bills),
        countBillsByPolicyArea(activeCongress.congress),
      ]);
      renderGroups(grouped, totalCounts);
      ui.status.textContent = `Showing ${activeCongress.bills.length} bills from ${activeCongress.label}.`;
    } else {
      ui.status.textContent = `Found ${bills.length} sponsored bills.`;
    }

    ui.raw.textContent = "Tip: click Load Bills again after changing the Bioguide ID.";
  } catch (err) {
    ui.status.textContent = "Failed to load bills.";
    ui.raw.textContent = String(err && err.message ? err.message : err);
  }
}

ui.load.addEventListener("click", loadBills);
loadBills();
