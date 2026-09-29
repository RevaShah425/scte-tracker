"use strict";

// UI prototype only. No requests are sent to the Bridge probe.
// Demo state resets when the browser page is reloaded.

const $ = (id) => document.getElementById(id);

const ui = {
  form: $("game-form"),
  gameName: $("game-name"),
  targetInput: $("message-target"),
  start: $("start-button"),
  refresh: $("refresh-button"),
  end: $("end-button"),
  connection: $("connection-status"),
  tracking: $("tracking-status"),
  notice: $("setup-notice"),
  activeGame: $("active-game"),
  count: $("message-count"),
  target: $("target-count"),
  percentage: $("progress-percentage"),
  remaining: $("remaining-count"),
  progress: $("target-progress"),
  grid: $("message-grid"),
  targetStatus: $("target-status"),
  started: $("tracking-started"),
  updated: $("last-updated"),
  ended: $("tracking-ended"),
  message: $("update-message"),
  error: $("error-message"),
  events: $("events-body"),
};

const state = {
  phase: "idle",
  gameName: "",
  target: 96,
  startedAt: null,
  endedAt: null,
  updatedAt: null,
  events: [],
  eventKeys: new Set(),
  nextDemoId: 1,
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

function formatDate(value) {
  return value ? dateFormat.format(new Date(value)) : "—";
}

function showError(message = "") {
  ui.error.textContent = message;
  ui.error.hidden = !message;
}

function announce(message) {
  ui.message.textContent = message;
}

// Create the target squares. A large future target is capped visually
// at 96 tiles, while the numeric count and percentage stay exact.
function renderGrid(count) {
  const tileCount = Math.min(state.target, 96);
  const filledCount = Math.floor(
    (Math.min(count, state.target) / state.target) * tileCount
  );

  const fragment = document.createDocumentFragment();

  for (let index = 0; index < tileCount; index += 1) {
    const tile = document.createElement("span");

    tile.className =
      index < filledCount
        ? "message-cell is-counted"
        : "message-cell";

    fragment.appendChild(tile);
  }

  ui.grid.replaceChildren(fragment);

  document.querySelector(".grid-legend").textContent =
    state.target <= 96
      ? "One filled square represents one counted message."
      : "The 96-square grid shows proportional progress toward the target.";
}

function renderEvents() {
  const fragment = document.createDocumentFragment();

  if (state.events.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 4;
    cell.textContent = "No messages counted in this demo game yet.";
    row.appendChild(cell);
    fragment.appendChild(row);
  } else {
    // Keep the table compact; the total includes all demo events.
    const recentEvents = state.events.slice(-20).reverse();

    for (const event of recentEvents) {
      const row = document.createElement("tr");
      const values = [
        event.receivedAt,
        event.recordId,
        event.service,
        "Simulated SCTE message",
      ];

      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      }

      fragment.appendChild(row);
    }
  }

  ui.events.replaceChildren(fragment);
}

function render() {
  const count = state.events.length;
  const hasStarted = state.phase !== "idle";
  const isActive = state.phase === "active";
  const percent = (count / state.target) * 100;

  ui.tracking.textContent = {
    idle: "Demo · not started",
    active: "Demo · tracking",
    ended: "Demo · ended",
  }[state.phase];

  ui.activeGame.textContent = state.gameName || "No game selected";
  ui.count.textContent = hasStarted ? count.toLocaleString() : "—";
  ui.target.textContent = state.target.toLocaleString();

  ui.percentage.textContent = hasStarted
    ? `${percent.toFixed(1)}% of target`
    : "Awaiting demo game";

  ui.remaining.textContent = !hasStarted
    ? "Remaining: —"
    : count <= state.target
      ? `${state.target - count} remaining`
      : `${count - state.target} above target`;

  ui.progress.max = state.target;

  if (hasStarted) {
    // The bar stops at 100%; the displayed count can exceed the target.
    ui.progress.value = Math.min(count, state.target);
  } else {
    ui.progress.removeAttribute("value");
  }

  ui.targetStatus.textContent = !hasStarted
    ? "Counts will continue beyond the target."
    : count >= state.target
      ? "Target reached. Additional messages still count."
      : "Counting every simulated message, regardless of type.";

  ui.started.textContent = formatDate(state.startedAt);
  ui.updated.textContent = state.updatedAt
    ? `${formatDate(state.updatedAt)} · demo`
    : "Never";
  ui.ended.textContent = formatDate(state.endedAt);

  ui.start.disabled = isActive;
  ui.start.textContent =
    state.phase === "ended" ? "Start new demo game" : "Start demo game";

  ui.refresh.disabled = !isActive;
  ui.end.disabled = !isActive;
  ui.gameName.disabled = isActive;
  ui.targetInput.disabled = isActive;

  renderGrid(count);
  renderEvents();
}

// Keep separate messages separate, but ignore repeated copies of
// the same demo record. Live event identity will be handled by
// the backend after we inspect the actual event response.
function recordEvents(incomingEvents) {
  let added = 0;

  for (const event of incomingEvents) {
    const key = `${event.source}:${event.recordId}`;

    if (state.eventKeys.has(key)) {
      continue;
    }

    state.eventKeys.add(key);
    state.events.push(event);
    added += 1;
  }

  return added;
}

function startGame(event) {
  event.preventDefault();
  showError();

  const name = ui.gameName.value.trim();
  const target = Number(ui.targetInput.value);

  if (!name) {
    showError("Enter a game name.");
    ui.gameName.focus();
    return;
  }

  if (!Number.isInteger(target) || target < 1 || target > 10000) {
    showError("Enter a whole-number target between 1 and 10,000.");
    ui.targetInput.focus();
    return;
  }

  if (
    state.phase === "ended" &&
    !window.confirm(
      "Start a new demo game? This clears the previous demo's messages."
    )
  ) {
    return;
  }

  state.phase = "active";
  state.gameName = name;
  state.target = target;
  state.startedAt = new Date().toISOString();
  state.endedAt = null;
  state.updatedAt = null;
  state.events = [];
  state.eventKeys = new Set();
  state.nextDemoId = 1;

  render();
  announce(
    "Demo game started. Click Simulate refresh to add sample messages."
  );
}

function simulateRefresh() {
  if (state.phase !== "active") {
    return;
  }

  showError();

  const receivedAt = new Date().toISOString();

  // Exactly four synthetic messages per click, for predictable testing.
  const newEvents = Array.from({ length: 4 }, () => ({
    source: "demo-nbam",
    recordId: `DEMO-${state.nextDemoId++}`,
    service: "NBAM",
    receivedAt,
  }));

  // Include prior records to mimic overlapping API responses.
  // recordEvents() must not count those prior records again.
  const response = [
    ...state.events.slice(-4),
    ...newEvents,
  ];

  const added = recordEvents(response);
  state.updatedAt = receivedAt;

  render();
  announce(
    `Demo updated: ${added} new messages. ` +
    `${state.events.length} counted in this game.`
  );
}

function endGame() {
  if (state.phase !== "active") {
    return;
  }

  state.phase = "ended";
  state.endedAt = new Date().toISOString();

  render();
  announce(
    `Demo game ended with ${state.events.length} messages ` +
    `against a target of ${state.target}.`
  );
}

// Label demo behavior explicitly.
ui.connection.textContent = "Demo · no probe connection";
ui.notice.textContent =
  "Demo only. Simulate refresh adds four sample messages. " +
  "Reloading the page clears demo data.";

ui.refresh.textContent = "Simulate refresh +4";
ui.end.textContent = "End demo game";

ui.form.addEventListener("submit", startGame);
ui.refresh.addEventListener("click", simulateRefresh);
ui.end.addEventListener("click", endGame);

render();
