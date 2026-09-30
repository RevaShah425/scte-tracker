"use strict";

const path = require("node:path");
const express = require("express");
const dotenv = require("dotenv");
const { Pool, fetch } = require("undici");
const { XMLParser, XMLValidator } = require("fast-xml-parser");

dotenv.config({
  path: path.join(__dirname, ".env"),
});

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 3000);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a whole number between 1 and 65535.");
}

const allowInsecureTLS =
  process.env.PROBE_ALLOW_INSECURE_TLS === "true";

if (allowInsecureTLS && process.env.NODE_ENV === "production") {
  throw new Error(
    "The certificate exception is allowed only for local testing."
  );
}

const probes = [];

function addProbe(id, label, baseURL, username, password) {
  const url = new URL(baseURL);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(`Invalid address for ${label}.`);
  }

  if (!username || !password) {
    throw new Error(`Missing username or password for ${label}.`);
  }

  probes.push({
    id,
    label,
    origin: url.origin,
    authorization: Buffer.from(
      `${username}:${password}`
    ).toString("base64"),
    pool: new Pool(url.origin, {
      connect: {
        rejectUnauthorized: !allowInsecureTLS,
      },
    }),
  });
}

for (const [id, label, prefix] of [
  ["halsey", "Halsey", "HALSEY"],
  ["aurora", "Aurora", "AURORA"],
]) {
  const baseURL = process.env[`${prefix}_BASE_URL`];

  if (!baseURL) continue;

  addProbe(
    id,
    label,
    baseURL,
    process.env[`${prefix}_USERNAME`] ||
      process.env.PROBE_USERNAME,
    process.env[`${prefix}_PASSWORD`] ||
      process.env.PROBE_PASSWORD
  );
}

// Fall back to the old single-probe settings if no site URLs are set.
if (!probes.length && process.env.PROBE_BASE_URL) {
  addProbe(
    "configured",
    "Configured probe",
    process.env.PROBE_BASE_URL,
    process.env.PROBE_USERNAME,
    process.env.PROBE_PASSWORD
  );
}

if (!probes.length) {
  throw new Error(
    "Add AURORA_BASE_URL and HALSEY_BASE_URL to your .env file."
  );
}

if (allowInsecureTLS) {
  console.warn(
    "LOCAL TEST ONLY: certificate verification is disabled for the probes."
  );
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function readableAttributes(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.startsWith("@_") ? key.slice(2) : key,
      item,
    ])
  );
}

// Successful results are cached briefly.
// Concurrent requests for the same resource share one request.
const cache = new Map();

async function cached(key, lifetime, load) {
  const previous = cache.get(key);

  if (previous?.pending) {
    return previous.pending;
  }

  if (
    previous?.value &&
    Date.now() - previous.updatedAt < lifetime
  ) {
    return previous.value;
  }

  const entry = {};
  cache.set(key, entry);

  entry.pending = load()
    .then((value) => {
      entry.value = value;
      entry.updatedAt = Date.now();
      return value;
    })
    .finally(() => {
      delete entry.pending;

      if (!entry.value) {
        cache.delete(key);
      }
    });

  return entry.pending;
}

async function requestProbeXML(probe, tuningId) {
  const url = new URL("/probe/scte35data", probe.origin);

  // Without tuningId: discover SCTE streams.
  // With tuningId: request all services for the selected stream.
  if (tuningId !== undefined) {
    url.searchParams.set("tuningId", tuningId);
  }

  const response = await fetch(url, {
    dispatcher: probe.pool,
    method: "GET",
    headers: {
      Authorization: `Basic ${probe.authorization}`,
      Accept: "application/xml, text/xml",
      "Cache-Control": "no-cache",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${probe.label} returned HTTP ${response.status}.`
    );
  }

  const xml = await response.text();

  if (
    /<!DOCTYPE/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  ) {
    throw new Error(
      `${probe.label} did not return valid SCTE XML.`
    );
  }

  const document = parser.parse(xml);

  if (!Object.hasOwn(document, "Scte35ExportData")) {
    throw new Error(
      `${probe.label} returned an unexpected page, possibly a login page.`
    );
  }

  return asArray(document.Scte35ExportData?.tuningSetup);
}

async function getCatalog(probe) {
  return cached(`catalog:${probe.id}`, 30000, async () => {
    const rows = await requestProbeXML(probe);
    const streams = new Map();

    for (const row of rows) {
      const tuningId = row["@_tuningId"];
      const streamName = row["@_name"];

      if (tuningId == null || !streamName) continue;

      const key = JSON.stringify([
        probe.id,
        String(tuningId),
      ]);

      streams.set(key, {
        key,
        streamName: String(streamName),
        probeId: probe.id,
        probeName: probe.label,
        tuningId: String(tuningId),
      });
    }

    return [...streams.values()];
  });
}

// Only these files can be requested by the browser.
const publicFiles = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/streams.json": "streams.json",
};

for (const [route, filename] of Object.entries(publicFiles)) {
  app.get(route, (_request, response) => {
    response.sendFile(path.join(__dirname, filename));
  });
}

app.get("/api/streams", async (_request, response) => {
  response.set("Cache-Control", "no-store");

  const results = await Promise.allSettled(
    probes.map(getCatalog)
  );

  response.json({
    streams: results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    ),
    warnings: results.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${probes[index].label}: ${result.reason.message}`]
        : []
    ),
  });
});

app.get("/api/events", async (request, response) => {
  response.set("Cache-Control", "no-store");

  try {
    const key = request.query.stream;

    if (typeof key !== "string") {
      return response.status(400).json({
        error: "Select a stream first.",
      });
    }

    let identity;

    try {
      identity = JSON.parse(key);
    } catch {
      return response.status(400).json({
        error: "Invalid stream selection.",
      });
    }

    if (!Array.isArray(identity) || identity.length !== 2) {
      return response.status(400).json({
        error: "Invalid stream selection.",
      });
    }

    const probe = probes.find(
      (item) => item.id === identity[0]
    );

    if (!probe) {
      return response.status(404).json({
        error: "This probe is not configured.",
      });
    }

    const stream = (await getCatalog(probe)).find(
      (item) => item.key === key
    );

    if (!stream) {
      return response.status(404).json({
        error:
          "This stream is not currently in the SCTE list. Reload the stream list.",
      });
    }

    const result = await cached(
      `events:${key}`,
      5000,
      async () => {
        const rows = await requestProbeXML(
          probe,
          stream.tuningId
        );

        if (
          rows.some(
            (row) =>
              String(row["@_tuningId"]) !== stream.tuningId
          )
        ) {
          throw new Error(
            "The probe returned a different stream. No records were counted."
          );
        }

        const events = rows.flatMap((row) =>
          asArray(row.events?.event).map((event) => {
            const raw = readableAttributes(event);

            return {
              tuningId: stream.tuningId,
              serviceId:
                raw.serviceId ??
                row["@_serviceId"] ??
                null,
              serviceName:
                raw.serviceName ??
                row["@_serviceName"] ??
                "Unknown",
              recordId: raw.eventNumber ?? null,
              scteEventId: raw.id ?? null,
              receivedAt: raw.time ?? null,
              raw,
            };
          })
        );

        return {
          streamKey: key,
          streamName: stream.streamName,
          probeName: probe.label,
          fetchedAt: new Date().toISOString(),
          events,
        };
      }
    );

    response.json(result);
  } catch (error) {
    const code = error.cause?.code || error.code || "";
    let message = error.message;

    if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code)) {
      message =
        "Probe certificate verification failed. Check its certificate.";
    } else if (
      error.name === "TimeoutError" ||
      error.name === "AbortError"
    ) {
      message =
        "The probe timed out. Check your network or VPN.";
    } else if (message === "fetch failed") {
      message =
        "Could not connect to the probe. Check its address, network, or VPN.";
    }

    response.status(502).json({
      error: message,
      code: code || undefined,
    });
  }
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log("Press Control+C to stop.");
});

server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Stop the other server.`
      : error.message
  );

  process.exit(1);
});
