// api/tv-feed.js
// Server-side proxy for The Axe Factor Bookeo iCal feed.
// Keeps the signed feed URL out of the page source and dodges browser CORS.
// Parses Bookeo's "X booked, Y available" description into a clean session list.

const ICAL_URL =
  "https://ical.bookeo.com/2242560APAAR3197CA21F149AJTJUW/6YFFPWEF7ERWTL4C/Z/ical.ics";

let cache = { at: 0, data: null };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

// --- iCal helpers -----------------------------------------------------------

// Bookeo emits UTC stamps like 20260618T094000Z
function parseICalDate(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(
    Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  );
}

// DESCRIPTION is escaped: "4 booked\,\n0 available" or
// "0 booked\,\n8 blocked\,\n0 available"
function parseDescription(raw) {
  const text = (raw || "")
    .replace(/\\n/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .toLowerCase();
  const num = (label) => {
    const m = text.match(new RegExp("(\\d+)\\s+" + label));
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    booked: num("booked"),
    available: num("available"),
    blocked: num("blocked"),
  };
}

function unfold(ics) {
  // RFC 5545 line folding: a CRLF followed by space/tab continues the line
  return ics.replace(/\r?\n[ \t]/g, "");
}

function parseEvents(ics) {
  const out = [];
  const blocks = unfold(ics).split("BEGIN:VEVENT").slice(1);
  for (const b of blocks) {
    const body = b.split("END:VEVENT")[0];
    const get = (key) => {
      const m = body.match(new RegExp("^" + key + "[^:]*:(.*)$", "m"));
      return m ? m[1].trim() : "";
    };
    const dtstart = parseICalDate(get("DTSTART"));
    if (!dtstart) continue;
    const desc = parseDescription(get("DESCRIPTION"));
    const summary = get("SUMMARY").trim();
    // Capacity = booked + available (blocked slots have neither bookable)
    const capacity = desc.booked + desc.available;
    out.push({
      start: dtstart.toISOString(),
      summary,
      booked: desc.booked,
      available: desc.available,
      blocked: desc.blocked,
      capacity,
      isOpen: desc.blocked === 0, // blocked => closed / not bookable
    });
  }
  out.sort((a, b) => new Date(a.start) - new Date(b.start));
  return out;
}

// --- handler ----------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  try {
    const now = Date.now();
    if (cache.data && now - cache.at < CACHE_MS) {
      return res.status(200).json({ ...cache.data, cached: true });
    }

    const r = await fetch(ICAL_URL, {
      headers: { "User-Agent": "AxeFactorTV/1.0" },
    });
    if (!r.ok) throw new Error("Feed HTTP " + r.status);
    const ics = await r.text();
    const events = parseEvents(ics);

    const payload = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      count: events.length,
      events,
    };
    cache = { at: now, data: payload };
    return res.status(200).json(payload);
  } catch (err) {
    // Serve stale cache if we have it, so the screen never goes blank
    if (cache.data) {
      return res
        .status(200)
        .json({ ...cache.data, stale: true, error: String(err) });
    }
    return res.status(502).json({ ok: false, error: String(err) });
  }
}
