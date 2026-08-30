const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4096;

const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request, env, context) {
    try {
      return await routeRequest(request, env, context);
    } catch (error) {
      const url = new URL(request.url);
      console.error("analytics request failed", url.pathname, error instanceof Error ? error.message : "unknown error");
      return jsonResponse({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_event, env, context) {
    context.waitUntil(cleanupExpiredData(env, Date.now()));
  },
};

async function routeRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/" && request.method === "GET") {
    return Response.redirect(new URL("/admin", url), 302);
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return healthResponse(env);
  }

  if (url.pathname === "/api/event") {
    if (request.method === "OPTIONS") {
      return eventOptionsResponse(request, env);
    }
    if (request.method !== "POST") {
      return methodNotAllowed(["POST", "OPTIONS"]);
    }
    return collectEvent(request, env);
  }

  if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
    if (!(await isAdminAuthorized(request, env))) {
      return adminUnauthorized();
    }
    return adminPageResponse(env);
  }

  if (url.pathname === "/api/admin/summary" && request.method === "GET") {
    if (!(await isAdminAuthorized(request, env))) {
      return adminUnauthorized();
    }
    return adminSummaryResponse(url, env);
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function healthResponse(env) {
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first();
    const configured = Boolean(env.ADMIN_USERNAME && env.ADMIN_PASSWORD && env.IP_HASH_KEY);
    return jsonResponse({ status: row?.ok === 1 ? "ok" : "degraded", configured }, row?.ok === 1 ? 200 : 503);
  } catch (_error) {
    return jsonResponse({ status: "degraded", configured: false }, 503);
  }
}

function eventOptionsResponse(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!parseAllowedOrigins(env.ALLOWED_ORIGINS).has(origin)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  return new Response(null, {
    status: 204,
    headers: eventCorsHeaders(origin),
  });
}

async function collectEvent(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!parseAllowedOrigins(env.ALLOWED_ORIGINS).has(origin)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }

  const corsHeaders = eventCorsHeaders(origin);
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "payload_too_large" }, 413, corsHeaders);
  }

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "payload_too_large" }, 413, corsHeaders);
  }

  let rawEvent;
  try {
    rawEvent = JSON.parse(bodyText);
  } catch (_error) {
    return jsonResponse({ error: "invalid_json" }, 400, corsHeaders);
  }

  const event = normalizeEvent(rawEvent, env.SITE_ID || "site");
  if (!event) {
    return jsonResponse({ error: "invalid_event" }, 400, corsHeaders);
  }

  const userAgent = request.headers.get("User-Agent") || "";
  if (isLikelyBot(userAgent)) {
    return jsonResponse({ accepted: true }, 202, corsHeaders);
  }

  if (!env.IP_HASH_KEY) {
    return jsonResponse({ error: "analytics_not_configured" }, 503, corsHeaders);
  }

  const now = Date.now();
  const ipAddress = request.headers.get("CF-Connecting-IP") || "visitor:" + event.visitorId;
  const allowed = await consumeRateLimit(env, ipAddress, now);
  if (!allowed) {
    return jsonResponse({ error: "rate_limited" }, 429, {
      ...corsHeaders,
      "Retry-After": "60",
    });
  }

  const geo = normalizeGeo(request.cf || {});
  const visitorInsert = await env.DB.prepare(`
    INSERT OR IGNORE INTO visitors (
      visitor_id, first_seen, last_seen,
      first_country, first_region, first_city,
      last_country, last_region, last_city,
      landing_path, first_referrer_host, visit_count, pageview_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).bind(
    event.visitorId,
    now,
    now,
    geo.country,
    geo.region,
    geo.city,
    geo.country,
    geo.region,
    geo.city,
    event.path,
    event.referrerHost,
  ).run();

  const sessionInsert = await env.DB.prepare(`
    INSERT OR IGNORE INTO sessions (
      session_id, visitor_id, started_at, last_seen, pageview_count
    ) VALUES (?, ?, ?, ?, 0)
  `).bind(event.sessionId, event.visitorId, now, now).run();

  const isNewVisitor = Number(visitorInsert.meta?.changes || 0) > 0;
  const isNewSession = Number(sessionInsert.meta?.changes || 0) > 0;

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE visitors
      SET last_seen = ?,
          last_country = ?,
          last_region = ?,
          last_city = ?,
          visit_count = visit_count + ?,
          pageview_count = pageview_count + 1
      WHERE visitor_id = ?
    `).bind(now, geo.country, geo.region, geo.city, isNewSession ? 1 : 0, event.visitorId),
    env.DB.prepare(`
      UPDATE sessions
      SET last_seen = ?, pageview_count = pageview_count + 1
      WHERE session_id = ?
    `).bind(now, event.sessionId),
    env.DB.prepare(`
      INSERT INTO pageviews (
        visitor_id, session_id, occurred_at, path, referrer_host,
        country, region, city, device_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.visitorId,
      event.sessionId,
      now,
      event.path,
      event.referrerHost,
      geo.country,
      geo.region,
      geo.city,
      deviceType(userAgent),
    ),
  ]);

  return jsonResponse({ accepted: true, newVisitor: isNewVisitor }, 202, corsHeaders);
}

async function consumeRateLimit(env, identity, now) {
  const limit = clampInteger(env.RATE_LIMIT_PER_MINUTE, 1, 300, 30);
  const minute = Math.floor(now / 60000);
  const digest = await hmacHex(env.IP_HASH_KEY, identity + ":" + minute);
  const bucketKey = minute + ":" + digest.slice(0, 32);

  await env.DB.prepare(`
    INSERT INTO rate_limits (bucket_key, window_started_at, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + 1
  `).bind(bucketKey, minute * 60000).run();

  const row = await env.DB.prepare(
    "SELECT request_count FROM rate_limits WHERE bucket_key = ?",
  ).bind(bucketKey).first();
  return Number(row?.request_count || 0) <= limit;
}

export function normalizeEvent(value, expectedSiteId) {
  if (!value || typeof value !== "object" || value.version !== 1 || value.siteId !== expectedSiteId) {
    return null;
  }
  if (!isValidId(value.visitorId) || !isValidId(value.sessionId)) {
    return null;
  }

  const path = normalizePath(value.path);
  if (!path) {
    return null;
  }

  return {
    visitorId: value.visitorId.toLowerCase(),
    sessionId: value.sessionId.toLowerCase(),
    path,
    referrerHost: normalizeReferrerHost(value.referrerHost),
  };
}

export function isValidId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function normalizePath(value) {
  if (typeof value !== "string") {
    return null;
  }
  const path = value.split(/[?#]/, 1)[0].replace(/[\u0000-\u001f\u007f]/g, "");
  if (!path.startsWith("/") || path.length === 0) {
    return null;
  }
  return path.slice(0, 512);
}

export function normalizeReferrerHost(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (value.length > 255 || /[\s/:?#]/.test(value)) {
    return null;
  }
  try {
    const hostname = new URL("https://" + value).hostname.toLowerCase();
    return hostname && hostname.length <= 255 ? hostname : null;
  } catch (_error) {
    return null;
  }
}

export function parseAllowedOrigins(value) {
  return new Set(String(value || "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

function normalizeGeo(cf) {
  const countryValue = cleanText(cf.country, 2);
  return {
    country: countryValue && /^[a-z]{2}$/i.test(countryValue) ? countryValue.toUpperCase() : null,
    region: cleanText(cf.region, 100),
    city: cleanText(cf.city, 100),
  };
}

function cleanText(value, maximumLength) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, maximumLength) : null;
}

export function isLikelyBot(userAgent) {
  if (typeof userAgent !== "string" || userAgent.length < 8) {
    return true;
  }
  return /(bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pagespeed|monitoring|uptime)/i.test(userAgent);
}

export function deviceType(userAgent) {
  const value = String(userAgent || "");
  if (/ipad|tablet|kindle|silk/i.test(value)) {
    return "tablet";
  }
  if (/mobile|iphone|ipod|android/i.test(value)) {
    return "mobile";
  }
  return "desktop";
}

async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isAdminAuthorized(request, env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return false;
  }
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Basic ")) {
    return false;
  }

  let decoded;
  try {
    const binary = atob(authorization.slice(6));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch (_error) {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) {
    return false;
  }
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return (await constantTimeEqual(username, env.ADMIN_USERNAME)) &&
    (await constantTimeEqual(password, env.ADMIN_PASSWORD));
}

export async function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(right))),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function adminUnauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Visitor analytics", charset="UTF-8"',
    },
  });
}

async function adminSummaryResponse(url, env) {
  const days = clampInteger(url.searchParams.get("days"), 1, 365, 30);
  const now = Date.now();
  const since = now - days * DAY_MS;
  const offsetMinutes = clampInteger(env.DASHBOARD_UTC_OFFSET_MINUTES, -720, 840, 480);
  const offsetMs = offsetMinutes * 60 * 1000;
  const todayStartedAt = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS - offsetMs;

  const statements = [
    env.DB.prepare(`
      SELECT
        COUNT(*) AS retainedVisitors,
        COALESCE(SUM(pageview_count), 0) AS retainedPageviews,
        COALESCE(SUM(visit_count), 0) AS retainedSessions,
        SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) AS newToday,
        (SELECT COUNT(DISTINCT visitor_id) FROM pageviews WHERE occurred_at >= ?) AS uniqueToday,
        (SELECT COUNT(*) FROM pageviews WHERE occurred_at >= ?) AS pageviewsToday
      FROM visitors
    `).bind(todayStartedAt, todayStartedAt, todayStartedAt),
    env.DB.prepare(`
      SELECT
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(*) AS pageviews,
        (SELECT COUNT(*) FROM visitors WHERE first_seen >= ?) AS newVisitors
      FROM pageviews
      WHERE occurred_at >= ?
    `).bind(since, since),
    env.DB.prepare(`
      WITH pageview_days AS (
        SELECT date((occurred_at + ?) / 1000, 'unixepoch') AS day,
               COUNT(*) AS pageviews,
               COUNT(DISTINCT visitor_id) AS visitors
        FROM pageviews
        WHERE occurred_at >= ?
        GROUP BY day
      ), new_visitor_days AS (
        SELECT date((first_seen + ?) / 1000, 'unixepoch') AS day,
               COUNT(*) AS newVisitors
        FROM visitors
        WHERE first_seen >= ?
        GROUP BY day
      )
      SELECT pageview_days.day,
             pageview_days.pageviews,
             pageview_days.visitors,
             COALESCE(new_visitor_days.newVisitors, 0) AS newVisitors
      FROM pageview_days
      LEFT JOIN new_visitor_days ON new_visitor_days.day = pageview_days.day
      ORDER BY pageview_days.day
    `).bind(offsetMs, since, offsetMs, since),
    env.DB.prepare(`
      SELECT COALESCE(country, 'Unknown') AS label,
             COUNT(DISTINCT visitor_id) AS visitors,
             COUNT(*) AS pageviews
      FROM pageviews
      WHERE occurred_at >= ?
      GROUP BY country
      ORDER BY visitors DESC, pageviews DESC
      LIMIT 20
    `).bind(since),
    env.DB.prepare(`
      SELECT COALESCE(city, 'Unknown') AS city,
             COALESCE(region, '') AS region,
             COALESCE(country, 'Unknown') AS country,
             COUNT(DISTINCT visitor_id) AS visitors,
             COUNT(*) AS pageviews
      FROM pageviews
      WHERE occurred_at >= ?
      GROUP BY country, region, city
      ORDER BY visitors DESC, pageviews DESC
      LIMIT 30
    `).bind(since),
    env.DB.prepare(`
      SELECT COALESCE(device_type, 'other') AS label,
             COUNT(DISTINCT visitor_id) AS visitors,
             COUNT(*) AS pageviews
      FROM pageviews
      WHERE occurred_at >= ?
      GROUP BY device_type
      ORDER BY visitors DESC, pageviews DESC
    `).bind(since),
    env.DB.prepare(`
      SELECT path AS label,
             COUNT(DISTINCT visitor_id) AS visitors,
             COUNT(*) AS pageviews
      FROM pageviews
      WHERE occurred_at >= ?
      GROUP BY path
      ORDER BY pageviews DESC, visitors DESC
      LIMIT 20
    `).bind(since),
    env.DB.prepare(`
      SELECT referrer_host AS label,
             COUNT(DISTINCT visitor_id) AS visitors,
             COUNT(*) AS pageviews
      FROM pageviews
      WHERE occurred_at >= ? AND referrer_host IS NOT NULL AND referrer_host != ''
      GROUP BY referrer_host
      ORDER BY visitors DESC, pageviews DESC
      LIMIT 20
    `).bind(since),
    env.DB.prepare(`
      SELECT substr(visitor_id, 1, 8) AS visitor,
             first_seen AS firstSeen,
             last_seen AS lastSeen,
             COALESCE(first_country, 'Unknown') AS country,
             COALESCE(first_region, '') AS region,
             COALESCE(first_city, '') AS city,
             landing_path AS landingPath,
             COALESCE(first_referrer_host, 'Direct') AS referrer,
             visit_count AS visits,
             pageview_count AS pageviews
      FROM visitors
      ORDER BY first_seen DESC
      LIMIT 30
    `),
  ];

  const results = await env.DB.batch(statements);
  const firstRow = (result, fallback) => result?.results?.[0] || fallback;
  const rows = (result) => result?.results || [];

  return jsonResponse({
    generatedAt: now,
    rangeDays: days,
    timezone: offsetLabel(offsetMinutes),
    retentionDays: clampInteger(env.RETENTION_DAYS, 30, 730, 180),
    totals: firstRow(results[0], {}),
    range: firstRow(results[1], {}),
    trend: rows(results[2]),
    countries: rows(results[3]),
    cities: rows(results[4]),
    devices: rows(results[5]),
    paths: rows(results[6]),
    referrers: rows(results[7]),
    recentVisitors: rows(results[8]),
  }, 200, { "Cache-Control": "no-store" });
}

export function offsetLabel(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return "UTC" + sign + hours + ":" + minutes;
}

function adminPageResponse(env) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const brand = escapeHtml(cleanText(env.DASHBOARD_BRAND, 100) || env.SITE_ID || "Website");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${brand} · 访客统计</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; --ink:#10202a; --muted:#60717b; --paper:#eef3f5; --surface:#fff; --line:#d8e1e5; --accent:#12627d; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    main { width:min(1180px,calc(100% - 28px)); margin:0 auto; padding:32px 0 64px; }
    header { display:flex; flex-wrap:wrap; align-items:end; justify-content:space-between; gap:18px; margin-bottom:24px; }
    h1 { margin:0 0 4px; font-size:32px; letter-spacing:0; }
    h2 { margin:0 0 14px; font-size:18px; }
    p { margin:0; color:var(--muted); }
    .controls { display:flex; gap:10px; align-items:center; }
    select,button { border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--ink); padding:9px 12px; font:inherit; }
    button { width:40px; height:40px; padding:0; cursor:pointer; font-size:20px; font-weight:650; line-height:1; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:18px; }
    .metric,.panel { background:var(--surface); border:1px solid var(--line); border-radius:6px; }
    .metric { padding:16px; }
    .metric strong { display:block; color:var(--accent); font-size:28px; letter-spacing:0; }
    .metric span { color:var(--muted); font-size:13px; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin-top:14px; }
    .panel { padding:17px; overflow:hidden; }
    .wide { grid-column:1/-1; }
    .table-wrap { overflow:auto; max-height:430px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { padding:9px 10px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
    th { position:sticky; top:0; background:var(--surface); color:var(--muted); font-size:11px; letter-spacing:.06em; text-transform:uppercase; }
    td:first-child { max-width:380px; overflow:hidden; text-overflow:ellipsis; }
    .status { min-height:24px; margin:10px 0; }
    .note { margin-top:18px; padding:13px 15px; border:1px solid var(--line); border-radius:6px; background:rgba(255,255,255,.55); font-size:13px; }
    @media (max-width:760px) { h1 { font-size:26px; } .grid { grid-template-columns:1fr; } .wide { grid-column:auto; } header { align-items:start; } }
  </style>
</head>
<body>
<main>
  <header>
    <div><p>${brand}</p><h1>访客统计</h1><p id="updated">正在加载……</p></div>
    <div class="controls"><label for="days">统计范围</label><select id="days"><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option><option value="180">180 天</option><option value="365">365 天</option></select><button id="refresh" type="button" aria-label="刷新" title="刷新">&#x21bb;</button></div>
  </header>
  <div class="status" id="status" role="status"></div>
  <section class="metrics">
    <div class="metric"><strong id="newToday">—</strong><span>今日新访客</span></div>
    <div class="metric"><strong id="uniqueToday">—</strong><span>今日独立访客</span></div>
    <div class="metric"><strong id="pageviewsToday">—</strong><span>今日页面浏览</span></div>
    <div class="metric"><strong id="rangeNew">—</strong><span>范围内新访客</span></div>
    <div class="metric"><strong id="rangeVisitors">—</strong><span>范围内独立访客</span></div>
    <div class="metric"><strong id="retainedVisitors">—</strong><span>保留期内累计访客</span></div>
  </section>
  <section class="grid">
    <article class="panel wide"><h2>每日趋势</h2><div class="table-wrap"><table><thead><tr><th>日期</th><th>新访客</th><th>独立访客</th><th>浏览量</th></tr></thead><tbody id="trend"></tbody></table></div></article>
    <article class="panel"><h2>国家/地区</h2><div class="table-wrap"><table><thead><tr><th>国家</th><th>访客</th><th>浏览量</th></tr></thead><tbody id="countries"></tbody></table></div></article>
    <article class="panel"><h2>城市（IP 推测）</h2><div class="table-wrap"><table><thead><tr><th>地点</th><th>访客</th><th>浏览量</th></tr></thead><tbody id="cities"></tbody></table></div></article>
    <article class="panel"><h2>设备类型</h2><div class="table-wrap"><table><thead><tr><th>设备</th><th>访客</th><th>浏览量</th></tr></thead><tbody id="devices"></tbody></table></div></article>
    <article class="panel"><h2>热门页面</h2><div class="table-wrap"><table><thead><tr><th>页面</th><th>访客</th><th>浏览量</th></tr></thead><tbody id="paths"></tbody></table></div></article>
    <article class="panel"><h2>外部来源</h2><div class="table-wrap"><table><thead><tr><th>来源</th><th>访客</th><th>浏览量</th></tr></thead><tbody id="referrers"></tbody></table></div></article>
    <article class="panel wide"><h2>最近的新访客</h2><div class="table-wrap"><table><thead><tr><th>访客</th><th>首次访问</th><th>最近访问</th><th>首次位置</th><th>入口页面</th><th>来源</th><th>访问次数</th><th>浏览量</th></tr></thead><tbody id="recent"></tbody></table></div></article>
  </section>
  <p class="note" id="privacyNote">不保存原始 IP；国家和城市由 IP 近似推断，VPN、代理和移动网络可能导致偏差。</p>
</main>
<script nonce="${nonce}">
(function(){
  "use strict";
  var number = new Intl.NumberFormat("zh-CN");
  var dateTime = new Intl.DateTimeFormat("zh-CN", { dateStyle:"medium", timeStyle:"short" });
  function byId(id){ return document.getElementById(id); }
  function setNumber(id,value){ byId(id).textContent=number.format(Number(value||0)); }
  function cell(row,value){ var td=document.createElement("td"); td.textContent=value == null || value === "" ? "—" : String(value); row.appendChild(td); }
  function render(id,rows,values){
    var body=byId(id); body.textContent="";
    if(!rows.length){ var empty=document.createElement("tr"); var td=document.createElement("td"); td.colSpan=values.length; td.textContent="暂无数据"; empty.appendChild(td); body.appendChild(empty); return; }
    rows.forEach(function(item){ var row=document.createElement("tr"); values.forEach(function(get){ cell(row,get(item)); }); body.appendChild(row); });
  }
  function location(item){ return [item.city,item.region,item.country].filter(Boolean).join(", ") || "Unknown"; }
  var deviceNames={desktop:"桌面",mobile:"手机",tablet:"平板",other:"其他"};
  function device(item){ return deviceNames[item.label] || item.label || "未知"; }
  async function load(){
    var days=byId("days").value;
    byId("status").textContent="正在更新……";
    try {
      var response=await fetch("/api/admin/summary?days="+encodeURIComponent(days),{cache:"no-store"});
      if(!response.ok) throw new Error("HTTP "+response.status);
      var data=await response.json();
      setNumber("newToday",data.totals.newToday); setNumber("uniqueToday",data.totals.uniqueToday); setNumber("pageviewsToday",data.totals.pageviewsToday);
      setNumber("rangeNew",data.range.newVisitors); setNumber("rangeVisitors",data.range.visitors); setNumber("retainedVisitors",data.totals.retainedVisitors);
      render("trend",data.trend,[function(x){return x.day;},function(x){return number.format(x.newVisitors||0);},function(x){return number.format(x.visitors||0);},function(x){return number.format(x.pageviews||0);}]);
      render("countries",data.countries,[function(x){return x.label;},function(x){return number.format(x.visitors||0);},function(x){return number.format(x.pageviews||0);}]);
      render("cities",data.cities,[location,function(x){return number.format(x.visitors||0);},function(x){return number.format(x.pageviews||0);}]);
      render("devices",data.devices,[device,function(x){return number.format(x.visitors||0);},function(x){return number.format(x.pageviews||0);}]);
      render("paths",data.paths,[function(x){return x.label;},function(x){return number.format(x.visitors||0);},function(x){return number.format(x.pageviews||0);}]);
      render("referrers",data.referrers,[function(x){return x.label;},function(x){return number.format(x.visitors||0);},function(x){return number.format(x.pageviews||0);}]);
      render("recent",data.recentVisitors,[function(x){return x.visitor;},function(x){return dateTime.format(new Date(x.firstSeen));},function(x){return dateTime.format(new Date(x.lastSeen));},location,function(x){return x.landingPath;},function(x){return x.referrer;},function(x){return number.format(x.visits||0);},function(x){return number.format(x.pageviews||0);}]);
      byId("updated").textContent="更新于 "+dateTime.format(new Date(data.generatedAt))+" · "+data.timezone;
      byId("privacyNote").textContent="不保存原始 IP；地点由 IP 近似推断。个人级记录默认保留 "+data.retentionDays+" 天。";
      byId("status").textContent="";
    } catch(error) { byId("status").textContent="加载失败："+error.message; }
  }
  byId("days").addEventListener("change",load); byId("refresh").addEventListener("click",load); load();
}());
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function cleanupExpiredData(env, now) {
  const retentionDays = clampInteger(env.RETENTION_DAYS, 30, 730, 180);
  const cutoff = now - retentionDays * DAY_MS;
  const rateLimitCutoff = now - 2 * DAY_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE window_started_at < ?").bind(rateLimitCutoff),
    env.DB.prepare("DELETE FROM pageviews WHERE occurred_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM sessions WHERE last_seen < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM visitors WHERE last_seen < ?").bind(cutoff),
  ]);
}

function eventCorsHeaders(origin) {
  return {
    ...SECURITY_HEADERS,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function methodNotAllowed(methods) {
  return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: methods.join(", ") });
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
