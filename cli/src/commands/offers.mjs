import { readFileSync } from "node:fs";

import { UsageError } from "../errors.mjs";
import { enc, fields, isoDate, jsonData, list as parseList, optionalString, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Commercial offers and sponsor rate card (packages, prices, validity)";

export const help = `dataops offers - DataTalks.Club commercial offers and sponsor rate card

One structured record of sponsorship packages, prices (EUR/USD), channels,
validity dates, deliverables, pitch snippets, non-offers, and inbound routing.
Any signed-in agent or operator can read it; admins can update or import it.

Usage
  dataops offers list [--channel CHANNEL] [--tag TAG] [--json]
  dataops offers show [<slug>] [--json]
  dataops offers update <slug> [--name NAME] [--price AMOUNT] [--price-usd USD]
      [--currency EUR] [--price-min MIN] [--price-max MAX]
      [--channels ch1,ch2] [--notes TEXT] [--price-note TEXT]
      [--valid-from YYYY-MM-DD] [--valid-until YYYY-MM-DD] [--as-of YYYY-MM-DD]
      [--deliverables "item1|item2"] [--templates t1,t2] [--skill-tags tag1,tag2]
      [--evidence-strength high|medium|low|owner-stated] [--data '{...}']
  dataops offers update [--from-file offers.json] [--data '{...}']
      [--title TITLE] [--floor-eur AMOUNT] [--media-kit-url URL] [--rule TEXT]
      [--as-of YYYY-MM-DD] [--valid-from YYYY-MM-DD] [--valid-until YYYY-MM-DD]
  dataops offers import --from-file offers.json [--valid-from YYYY-MM-DD]
      [--valid-until YYYY-MM-DD] [--as-of YYYY-MM-DD]
`;

function formatPrice(offer) {
  if (!offer?.price || offer.price.amount === null || offer.price.amount === undefined) {
    return "n/a";
  }
  const { amount, currency = "EUR", range, usd } = offer.price;
  const base = range && range.min !== undefined && range.max !== undefined
    ? `${amount} ${currency} (${range.min}-${range.max})`
    : `${amount} ${currency}`;
  return usd !== undefined && usd !== null ? `${base} / $${usd}` : base;
}

function formatValidity(validity) {
  if (!validity) return "";
  const parts = [];
  if (validity.validFrom || validity.validUntil) {
    parts.push(`${validity.validFrom || "..."}..${validity.validUntil || "..."}`);
  }
  if (validity.asOf) {
    parts.push(`as of ${validity.asOf}`);
  }
  return parts.join(" ");
}

export async function list(args, io) {
  const channel = optionalString(args, "channel");
  const tag = optionalString(args, "tag");
  const result = await apiFor(args).get("/api/offers", {
    query: { channel, tag },
  });
  if (args.json) return result;
  const meta = result?.meta || {};
  const validity = result?.validity || {};
  fields(io, [
    ["Title", meta.title],
    ["Currency", meta.currency_default],
    ["Floor (EUR)", meta.floor_eur !== null && meta.floor_eur !== undefined ? String(meta.floor_eur) : ""],
    ["Media kit", meta.media_kit_url],
    ["Validity", formatValidity(validity)],
    ["Version", String(result?.version ?? 0)],
  ]);
  table(
    io,
    result?.offers || [],
    [
      ["SLUG", (offer) => offer.slug],
      ["NAME", (offer) => offer.name],
      ["PRICE", (offer) => formatPrice(offer)],
      ["CHANNELS", (offer) => (offer.channels || []).join(",")],
      ["VALIDITY", (offer) => formatValidity(offer.validity)],
      ["NOTES", (offer) => offer.price_note || offer.notes || ""],
    ],
    "No offers configured.",
  );
  return result;
}

export async function show(args, io) {
  const slug = args._[0] !== undefined && args._[0] !== "" ? String(args._[0]) : undefined;
  if (!slug) {
    return list(args, io);
  }
  const result = await apiFor(args).get(`/api/offers/${enc(slug)}`);
  if (args.json) return result;
  if (result?.kind === "non_offer") {
    fields(io, [
      ["slug", result.slug],
      ["kind", "non_offer"],
      ["name", result.name],
      ["response", result.response],
      ["templates", result.templates || []],
      ["version", String(result.version ?? "")],
    ]);
    return result;
  }
  fields(io, [
    ["slug", result.slug],
    ["name", result.name],
    ["channels", result.channels || []],
    ["price", formatPrice(result)],
    ["notes", result.price_note || result.notes || ""],
    ["validity", formatValidity(result.validity)],
    ["deliverables", (result.deliverables || []).join(" | ")],
    ["when_to_offer", (result.when_to_offer || []).join(" | ")],
    ["when_to_deflect", (result.when_to_deflect_elsewhere || []).join(" | ")],
    ["templates", result.templates || []],
    ["does_not_offer", (result.does_not_offer || []).join(" | ")],
    ["evidence_strength", result.evidence_strength || ""],
    ["skill_tags", result.skill_tags || []],
    ["version", String(result.version ?? "")],
  ]);
  return result;
}

function parseNumberFlag(value, flagName) {
  if (value === undefined) return undefined;
  if (value === "none" || value === "null") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new UsageError(`--${flagName} must be a non-negative number (or "none" to clear).`);
  }
  return num;
}

function parseDateOrNull(value, flagName) {
  if (value === undefined) return undefined;
  if (value === "none" || value === "null") return null;
  return isoDate(value, flagName);
}

function readJsonFileFlag(args) {
  const fileArg = args.fromFile ?? args.file;
  if (fileArg === undefined) return undefined;
  if (fileArg === true || fileArg === "") {
    throw new UsageError("--from-file needs a path, or - for stdin.");
  }
  const raw = fileArg === "-" ? readFileSync(0, "utf8") : readFileSync(String(fileArg), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`--from-file is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--from-file must hold a JSON object.");
  }
  return parsed;
}

function collectPackagePatch(args, currentOffer = null) {
  const patch = {};
  const fromData = jsonData(args, { required: false });
  const fromFile = readJsonFileFlag(args);
  if (fromFile) Object.assign(patch, fromFile);
  if (fromData) Object.assign(patch, fromData);

  const name = optionalString(args, "name");
  if (name !== undefined) patch.name = name;

  if (args.channels !== undefined) {
    patch.channels = args.channels === "none" ? [] : parseList(args.channels);
  }
  if (args.templates !== undefined) {
    patch.templates = args.templates === "none" ? [] : parseList(args.templates);
  }
  if (args.skillTags !== undefined) {
    patch.skill_tags = args.skillTags === "none" ? [] : parseList(args.skillTags);
  }
  if (args.deliverables !== undefined) {
    const raw = optionalString(args, "deliverables");
    patch.deliverables = raw === "none"
      ? []
      : String(raw).split("|").map((s) => s.trim()).filter(Boolean);
  }

  const notes = optionalString(args, "priceNote") ?? optionalString(args, "notes");
  if (notes !== undefined) {
    const val = notes === "none" ? null : notes;
    patch.price_note = val;
    patch.notes = val;
  }

  const evidenceStrength = optionalString(args, "evidenceStrength");
  if (evidenceStrength !== undefined) {
    patch.evidence_strength = evidenceStrength === "none" ? null : evidenceStrength;
  }

  const priceAmount = parseNumberFlag(args.price, "price");
  const priceUsd = parseNumberFlag(args.priceUsd, "price-usd");
  const priceMin = parseNumberFlag(args.priceMin, "price-min");
  const priceMax = parseNumberFlag(args.priceMax, "price-max");
  const currency = optionalString(args, "currency");

  if (
    priceAmount !== undefined
    || priceUsd !== undefined
    || priceMin !== undefined
    || priceMax !== undefined
    || currency !== undefined
  ) {
    if (priceAmount === null && priceUsd === undefined && priceMin === undefined && priceMax === undefined) {
      patch.price = null;
    } else {
      const existingPrice = (patch.price && typeof patch.price === "object" ? patch.price : currentOffer?.price) || {};
      const nextAmount = priceAmount !== undefined ? priceAmount : (existingPrice.amount ?? null);
      const nextCurrency = currency ? currency.toUpperCase() : (existingPrice.currency || "EUR");
      let nextRange = existingPrice.range ?? null;
      if (priceMin !== undefined || priceMax !== undefined) {
        if (priceMin === null || priceMax === null) {
          nextRange = null;
        } else {
          const min = priceMin !== undefined ? priceMin : (existingPrice.range?.min ?? nextAmount ?? 0);
          const max = priceMax !== undefined ? priceMax : (existingPrice.range?.max ?? min);
          nextRange = { min, max };
        }
      }
      const nextUsd = priceUsd !== undefined ? priceUsd : existingPrice.usd;
      patch.price = {
        amount: nextAmount,
        currency: nextCurrency,
        range: nextRange,
        ...(nextUsd !== undefined && nextUsd !== null ? { usd: nextUsd } : {}),
      };
      if (priceUsd !== undefined) patch.priceUsd = priceUsd;
    }
  }

  const asOf = parseDateOrNull(optionalString(args, "asOf"), "as-of");
  const validFrom = parseDateOrNull(optionalString(args, "validFrom"), "valid-from");
  const validUntil = parseDateOrNull(optionalString(args, "validUntil"), "valid-until");
  if (asOf !== undefined) patch.asOf = asOf;
  if (validFrom !== undefined) patch.validFrom = validFrom;
  if (validUntil !== undefined) patch.validUntil = validUntil;

  return patch;
}

function collectCardChanges(args) {
  const changes = {};
  const fromFile = readJsonFileFlag(args);
  const fromData = jsonData(args, { required: false });
  if (fromFile) Object.assign(changes, fromFile);
  if (fromData) Object.assign(changes, fromData);

  const title = optionalString(args, "title");
  if (title !== undefined) changes.title = title;

  const currencyDefault = optionalString(args, "currencyDefault") ?? optionalString(args, "currency");
  if (currencyDefault !== undefined) changes.currency_default = currencyDefault.toUpperCase();

  const mediaKitUrl = optionalString(args, "mediaKitUrl");
  if (mediaKitUrl !== undefined) changes.media_kit_url = mediaKitUrl;

  const rule = optionalString(args, "rule");
  if (rule !== undefined) changes.rule = rule;

  const floorEur = parseNumberFlag(args.floorEur, "floor-eur");
  if (floorEur !== undefined) changes.floor_eur = floorEur;

  const asOf = parseDateOrNull(optionalString(args, "asOf"), "as-of");
  const validFrom = parseDateOrNull(optionalString(args, "validFrom"), "valid-from");
  const validUntil = parseDateOrNull(optionalString(args, "validUntil"), "valid-until");
  if (asOf !== undefined) changes.as_of = asOf;
  if (validFrom !== undefined) changes.valid_from = validFrom;
  if (validUntil !== undefined) changes.valid_until = validUntil;

  return changes;
}

export async function update(args, io) {
  const slug = args._[0] !== undefined && args._[0] !== "" ? String(args._[0]) : undefined;
  const api = apiFor(args);
  const current = await api.get("/api/offers");
  const expectedVersion = current?.version ?? 0;

  if (slug) {
    const currentOffer = (current?.offers || []).find((item) => item.slug === slug || item.id === slug) || null;
    const patch = collectPackagePatch(args, currentOffer);
    if (!Object.keys(patch).length) {
      throw new UsageError("Nothing to update. Pass package flags or --data / --from-file. See `dataops offers --help`.");
    }
    const result = await api.put(`/api/offers/${enc(slug)}`, {
      ...patch,
      expectedVersion,
    });
    if (!args.json) {
      io.print(`Updated offer ${result.slug} (version ${result.version}).`);
    }
    return result;
  }

  const changes = collectCardChanges(args);
  if (!Object.keys(changes).length) {
    throw new UsageError("Nothing to update. Specify an offer <slug> or rate-card flags / --from-file / --data.");
  }
  const result = await api.put("/api/offers", {
    ...changes,
    expectedVersion,
  });
  if (!args.json) {
    io.print(`Updated offers rate card (${(result?.offers || []).length} packages, version ${result?.version}).`);
  }
  return result;
}

export async function importOffers(args, io) {
  const parsed = readJsonFileFlag(args) ?? jsonData(args, { required: false });
  if (!parsed) {
    throw new UsageError("Pass --from-file <offers.json> (or --data @offers.json) to import.");
  }
  const asOfFlag = parseDateOrNull(optionalString(args, "asOf"), "as-of");
  const validFromFlag = parseDateOrNull(optionalString(args, "validFrom"), "valid-from");
  const validUntilFlag = parseDateOrNull(optionalString(args, "validUntil"), "valid-until");

  const meta = { ...(parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {}) };
  const asOf = asOfFlag !== undefined ? asOfFlag : (meta.as_of ?? meta.asOf ?? null);
  const defaultYear = typeof asOf === "string" && /^\d{4}-/.test(asOf) ? asOf.slice(0, 4) : "2026";
  const validFrom = validFromFlag !== undefined
    ? validFromFlag
    : (meta.valid_from ?? meta.validFrom ?? parsed.validity?.validFrom ?? `${defaultYear}-01-01`);
  const validUntil = validUntilFlag !== undefined
    ? validUntilFlag
    : (meta.valid_until ?? meta.validUntil ?? parsed.validity?.validUntil ?? `${defaultYear}-12-31`);

  meta.as_of = asOf;
  meta.valid_from = validFrom;
  meta.valid_until = validUntil;

  const api = apiFor(args);
  const current = await api.get("/api/offers");
  const expectedVersion = current?.version ?? 0;

  const result = await api.put("/api/offers", {
    meta,
    validity: { asOf, validFrom, validUntil },
    offers: parsed.offers ?? parsed.packages ?? [],
    non_offers: parsed.non_offers ?? [],
    inbound_routing: parsed.inbound_routing ?? [],
    expectedVersion,
  });
  if (!args.json) {
    io.print(
      `Imported ${(result?.offers || []).length} offers and ${(result?.non_offers || []).length} non-offers (version ${result?.version}).`,
    );
  }
  return result;
}

export const commands = {
  list,
  show,
  update,
  set: update,
  import: importOffers,
};
