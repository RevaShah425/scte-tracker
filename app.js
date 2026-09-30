"use strict";

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "scte-stream-games-v2";

let streams = [];
let screenshotNames = [];
let selected = null;
let historyEvents = [];
let fetchedAt = null;
let loaded = false;
let busy = false;
let timer = null;
let games = {};

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    games = saved;
  }
} catch {
  games = {};
}

function currentGame() {
  if (!selected) return null;

  const game = games[selected.key];

  if (
    !game ||
    !Array.isArray(game.events) ||
    !Number.isFinite(Date.parse(game.startedAt))
  ) {
    return null;
  }

  return game;
}

function showError(message = "") {
  $("error-message").textContent = message;
  $("error-message").hidden = !message;
}

function announce(message) {
  $("update-message").textContent = message;
}

function saveGames() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
  } catch {
    showError(
      "Browser storage is unavailable or full. Keep this page open to retain the current game."
    );
  }
}

function formatTime(value) {
  if (value == null) return "—";
  return new Date(value).toLocaleString();
}

function eventKey(event) {
  return JSON.stringify([
    event.tuningId,
    event.serviceId,
    event.raw?.pid,
    event.recordId,
    event.receivedAt,
    event.scteEventId,
    event.raw?.spliceCommand,
    event.raw?.segmentationType,
  ]);
}

function uniqueEvents(events) {
  return [
    ...new Map(
      events.map((event) => [eventKey(event), event])
    ).values(),
  ].sort(
    (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)
  );
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

function renderOptions() {
  const query = $("stream-search").value.trim().toLowerCase();
  const list = $("stream-results");

  list.replaceChildren();

  const liveNames = new Set(
    streams.map((stream) => stream.streamName)
  );

  const matches = streams.filter((stream) =>
    stream.streamName.toLowerCase().includes(query)
  );

  for (const stream of matches) {
    const duplicate =
      streams.filter(
        (item) => item.streamName === stream.streamName
      ).length > 1;

    const label = duplicate
      ? `${stream.streamName} (${stream.probeName})`
      : stream.streamName;

    list.add(new Option(label, stream.key));
  }

  for (const name of screenshotNames) {
    if (
      !name.toLowerCase().includes(query) ||
      liveNames.has(name)
    ) {
      continue;
    }

    const option = new Option(`${name} — unavailable`, "");
    option.disabled = true;
    list.add(option);
  }

  list.value = selected?.key || "";

  if (!selected) {
    $("stream-source").textContent =
      `${matches.length} selectable matches. ` +
      "Unavailable streams were not returned by the probes.";
  }
}

function getWindow() {
  const mode = $("time-range").value;
  const now = Date.now();

  if (mode === "game") {
    const game = currentGame();

    if (!game) {
      return {
        valid: false,
        label: "Current game",
        message: "Start tracking a game for this stream first.",
      };
    }

    return {
      valid: true,
      label: game.name,
      start: Date.parse(game.startedAt),
      end: game.endedAt ? Date.parse(game.endedAt) : now,
      isGame: true,
    };
  }

  if (mode === "custom") {
    const start = new Date($("range-start").value).getTime();
    const end = new Date($("range-end").value).getTime();

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      return {
        valid: false,
        label: "Custom time range",
        message: "Choose a start and end time. End must be after start.",
      };
    }

    if (end > now) {
      return {
        valid: false,
        label: "Custom time range",
        message: "Choose an end time that is not in the future.",
      };
    }

    return {
      valid: true,
      label: "Custom time range",
      start,
      end,
      isGame: false,
    };
  }

  const minutes = Number(mode);

  return {
    valid: true,
    label: {
      15: "Last 15 minutes",
      30: "Last 30 minutes",
      60: "Last hour",
      180: "Last 3 hours",
    }[minutes],
    start: now - minutes * 60 * 1000,
    end: now,
    isGame: false,
  };
}

function getVisibleEvents(windowRange) {
  if (!windowRange.valid) return [];

  const game = currentGame();

  // Saved game records can supplement the current probe history.
  const source = windowRange.isGame
    ? game.events
    : uniqueEvents([
        ...historyEvents,
        ...(game?.events || []),
      ]);

  return source.filter((event) => {
    const time = Date.parse(event.receivedAt);

    return (
      time >= windowRange.start &&
      time <= windowRange.end
    );
  });
}

function renderEvents(events) {
  const body = $("events-body");
  body.replaceChildren();

  $("events-caption").textContent =
    `${selected?.streamName || "SCTE"} · selected time range · UTC`;

  for (const event of events.slice(-50).reverse()) {
    const row = document.createElement("tr");

    for (const value of [
      event.receivedAt,
      event.recordId ?? "—",
      event.serviceName ?? "Unknown",
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }

    const cell = document.createElement("td");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const raw = document.createElement("pre");

    summary.textContent = "View raw event";
    raw.textContent = JSON.stringify(event.raw, null, 2);
    raw.style.whiteSpace = "pre-wrap";
    raw.style.overflowWrap = "anywhere";

    details.append(summary, raw);
    cell.appendChild(details);
    row.appendChild(cell);
    body.appendChild(row);
  }

  if (!events.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 4;
    cell.textContent = selected
      ? "No available records in this time range."
      : "Select a stream.";

    row.appendChild(cell);
    body.appendChild(row);
  }
}

function render() {
  const game = currentGame();
  const active = Boolean(game && !game.endedAt);
  const windowRange = getWindow();
  const events = getVisibleEvents(windowRange);
  const count = events.length;

  // A game target applies only to the game view.
  const target = windowRange.isGame
    ? game?.target || null
    : null;

  const hasData =
    Boolean(selected) &&
    windowRange.valid &&
    (loaded || Boolean(windowRange.isGame && game));

  $("custom-time-fields").hidden =
    $("time-range").value !== "custom";

  $("tracker-heading").textContent =
    selected?.streamName || "Select a stream";

  $("stream-location").textContent =
    selected?.probeName || "SCTE tracker";

  if (selected) {
    $("stream-source").textContent =
      `${selected.probeName} · ${selected.streamName}`;
  }

  $("tracking-status").textContent = !selected
    ? "Select a stream"
    : active
      ? "Game tracking · auto refresh"
      : "Auto refresh · every 10 seconds";

  $("active-game").textContent = windowRange.label;

  $("count-label").textContent = windowRange.isGame
    ? "SCTE records this game"
    : `SCTE records · ${windowRange.label.toLowerCase()}`;

  $("message-count").textContent = hasData
    ? count.toLocaleString()
    : "—";

  $("target-count").textContent = target || "—";

  const divider = document.querySelector(".count-divider");
  if (divider) divider.hidden = !target;
  $("target-count").hidden = !target;

  $("progress-percentage").textContent = target
    ? `${((count / target) * 100).toFixed(1)}% of target`
    : windowRange.label;

  $("remaining-count").textContent = target
    ? count <= target
      ? `${target - count} remaining`
      : `${count - target} above target`
    : "";

  const progress = $("target-progress");
  progress.max = target || 96;
  progress.value = target ? Math.min(count, target) : 0;
  progress.hidden = !target;

  const progressLabel =
    document.querySelector('label[for="target-progress"]');

  if (progressLabel) progressLabel.hidden = !target;

  const tiles = target ? Math.min(target, 96) : 96;
  const filled = target
    ? Math.floor((Math.min(count, target) / target) * tiles)
    : Math.min(count, 96);

  const fragment = document.createDocumentFragment();

  for (let index = 0; index < tiles; index += 1) {
    const tile = document.createElement("span");

    tile.className =
      "message-cell" +
      (hasData && index < filled ? " is-counted" : "");

    fragment.appendChild(tile);
  }

  $("message-grid").replaceChildren(fragment);

  document.querySelector(".grid-legend").textContent =
    target && target > 96
      ? "The 96 squares show proportional progress toward the game target."
      : !target
        ? "One square per record, up to 96 visible squares. The number shows the full count."
        : "One square per counted record.";

  $("target-status").textContent = target
    ? count >= target
      ? "Game target reached. Additional records still count."
      : "Counting records toward this game’s target."
    : "Time-range count. No game target applied.";

  $("range-description").textContent = !windowRange.valid
    ? windowRange.message
    : `${formatTime(windowRange.start)} → ${formatTime(windowRange.end)}`;

  // A timestamp filter cannot recover history the probe no longer retains.
  if (
    windowRange.valid &&
    !windowRange.isGame &&
    loaded &&
    historyEvents.length
  ) {
    const earliest = Date.parse(historyEvents[0].receivedAt);

    if (earliest > windowRange.start) {
      $("range-description").textContent +=
        " · Available history starts later than this window; older records may be unavailable.";
    }
  }

  $("tracking-started").textContent =
    formatTime(game?.startedAt);

  $("tracking-ended").textContent =
    formatTime(game?.endedAt);

  $("last-updated").textContent =
    formatTime(fetchedAt || game?.fetchedAt);

  $("start-button").disabled = busy || !selected || active;
  $("start-button").textContent = game
    ? "Start new game"
    : "Start tracking";

  $("refresh-button").disabled = busy || !selected;
  $("end-button").disabled = busy || !active;

  for (const id of ["game-name", "message-target"]) {
    $(id).disabled = busy || active;
  }

  for (const id of [
    "stream-search",
    "stream-results",
    "reload-streams",
  ]) {
    $(id).disabled = busy;
  }

  $("setup-notice").textContent =
    "The selected stream refreshes every 10 seconds while this page is open. " +
    "Game counts are saved separately per stream.";

  renderEvents(events);
}

async function getSelectedEvents() {
  const data = await fetchJSON(
    "/api/events?stream=" + encodeURIComponent(selected.key)
  );

  if (
    data.streamKey !== selected.key ||
    !Array.isArray(data.events) ||
    !Number.isFinite(Date.parse(data.fetchedAt))
  ) {
    throw new Error(
      "Unexpected stream response. No records were counted."
    );
  }

  return data;
}

function mergeEvents(data) {
  let invalid = 0;

  const valid = data.events.filter((event) => {
    const okay = Number.isFinite(Date.parse(event.receivedAt));
    if (!okay) invalid += 1;
    return okay;
  });

  // Preserve the returned history even while tracking a game,
  // so the time-range selector can display either view.
  historyEvents = uniqueEvents(valid);
  fetchedAt = data.fetchedAt;
  loaded = true;

  const game = currentGame();

  if (game) {
    const start = Date.parse(game.startedAt);
    const end = game.endedAt
      ? Date.parse(game.endedAt)
      : Infinity;

    const gameEvents = valid.filter((event) => {
      const time = Date.parse(event.receivedAt);
      return time >= start && time <= end;
    });

    game.events = uniqueEvents([
      ...game.events,
      ...gameEvents,
    ]);

    game.fetchedAt = data.fetchedAt;
    saveGames();
  }

  $("connection-status").textContent = "Bridge connected";

  announce(
    "Updated selected stream. The grid shows only the selected time range." +
      (invalid
        ? ` ${invalid} records with invalid timestamps were skipped.`
        : "")
  );
}

function scheduleRefresh() {
  clearTimeout(timer);

  if (selected) {
    timer = setTimeout(() => {
      runRequest(async () => {
        mergeEvents(await getSelectedEvents());
      });
    }, 10000);
  }
}

async function runRequest(action) {
  if (busy) return;

  clearTimeout(timer);
  busy = true;
  showError();

  $("connection-status").textContent = "Requesting data…";
  render();

  try {
    await action();
  } catch (error) {
    showError(error.message);

    $("connection-status").textContent = "Update failed";

    announce(
      "Update failed. Showing retained records; the count may be incomplete."
    );
  } finally {
    busy = false;
    render();
    scheduleRefresh();
  }
}

async function loadStreams() {
  const data = await fetchJSON("/api/streams");

  if (!Array.isArray(data.streams)) {
    throw new Error("The server returned an invalid stream list.");
  }

  streams = data.streams.sort((a, b) =>
    a.streamName.localeCompare(
      b.streamName,
      undefined,
      { numeric: true }
    )
  );

  if (
    selected &&
    !streams.some((stream) => stream.key === selected.key)
  ) {
    selected = null;
    historyEvents = [];
    loaded = false;
    fetchedAt = null;
  }

  renderOptions();

  if (data.warnings?.length) {
    showError(data.warnings.join(" | "));
  }

  $("connection-status").textContent = streams.length
    ? "Stream list loaded"
    : "No live streams found";
}

$("stream-search").addEventListener("input", renderOptions);

$("stream-results").addEventListener("change", () => {
  runRequest(async () => {
    selected =
      streams.find(
        (stream) => stream.key === $("stream-results").value
      ) || null;

    historyEvents = [];
    loaded = false;
    fetchedAt = null;

    $("game-name").value = currentGame()?.name || "";
    $("message-target").value = currentGame()?.target || "";

    if (
      $("time-range").value === "game" &&
      !currentGame()
    ) {
      $("time-range").value = "60";
    }

    if (selected) {
      mergeEvents(await getSelectedEvents());
    }
  });
});

$("reload-streams").addEventListener("click", () => {
  runRequest(loadStreams);
});

$("refresh-button").addEventListener("click", () => {
  runRequest(async () => {
    mergeEvents(await getSelectedEvents());
  });
});

for (const id of ["time-range", "range-start", "range-end"]) {
  $(id).addEventListener("change", render);
}

$("game-form").addEventListener("submit", (event) => {
  event.preventDefault();

  const existing = currentGame();

  if (
    busy ||
    !selected ||
    (existing && !existing.endedAt)
  ) {
    return;
  }

  const name = $("game-name").value.trim();
  const rawTarget = $("message-target").value;
  const target = rawTarget === "" ? null : Number(rawTarget);

  if (
    !name ||
    (target !== null &&
      (!Number.isInteger(target) || target < 1 || target > 10000))
  ) {
    showError(
      "Enter a game name and, optionally, a whole-number target from 1 to 10,000."
    );
    return;
  }

  if (
    existing &&
    !window.confirm(
      "Replace this stream’s previous game with a new game?"
    )
  ) {
    return;
  }

  const startedAt = new Date().toISOString();

  runRequest(async () => {
    const data = await getSelectedEvents();

    games[selected.key] = {
      name,
      target,
      startedAt,
      endedAt: null,
      fetchedAt: null,
      events: [],
    };

    $("time-range").value = "game";
    mergeEvents(data);

    announce(
      "Game started. Earlier records are excluded. Refreshing every 10 seconds."
    );
  });
});

$("end-button").addEventListener("click", () => {
  const game = currentGame();

  if (busy || !game || game.endedAt) return;

  game.endedAt = new Date().toISOString();
  saveGames();

  runRequest(async () => {
    mergeEvents(await getSelectedEvents());
  });
});

// Keep rolling windows moving even between successful fetches.
setInterval(() => {
  if (selected && !busy) render();
}, 1000);

render();

runRequest(async () => {
  try {
    const names = await fetchJSON("/streams.json");

    screenshotNames = Array.isArray(names)
      ? names.filter((name) => typeof name === "string")
      : [];
  } catch {
    screenshotNames = [];
  }

  await loadStreams();
});
