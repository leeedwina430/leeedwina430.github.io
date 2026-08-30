(function () {
  "use strict";

  var config = window.VISITOR_ANALYTICS_CONFIG || {};
  var siteId = typeof config.siteId === "string" ? config.siteId : "site";
  var storagePrefix = "visitor-analytics:" + siteId + ":";
  var visitorKey = storagePrefix + "visitor";
  var sessionKey = storagePrefix + "session";
  var optOutKey = storagePrefix + "opt-out";
  var sessionLengthMs = 30 * 60 * 1000;

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Storage can be unavailable in private or hardened browser modes.
    }
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    var bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(2, "0");
    }).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  function validId(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function getVisitorId() {
    var existing = storageGet(visitorKey);
    if (validId(existing)) {
      return existing;
    }
    var created = createId();
    storageSet(visitorKey, created);
    return created;
  }

  function getSessionId(now) {
    var existing;
    try {
      existing = JSON.parse(storageGet(sessionKey) || "null");
    } catch (_error) {
      existing = null;
    }

    if (existing && validId(existing.id) && Number.isFinite(existing.lastSeen) && now - existing.lastSeen < sessionLengthMs) {
      existing.lastSeen = now;
      storageSet(sessionKey, JSON.stringify(existing));
      return existing.id;
    }

    var created = { id: createId(), lastSeen: now };
    storageSet(sessionKey, JSON.stringify(created));
    return created.id;
  }

  function hasPrivacySignal() {
    return navigator.globalPrivacyControl === true ||
      navigator.doNotTrack === "1" ||
      window.doNotTrack === "1" ||
      navigator.msDoNotTrack === "1";
  }

  function isOptedOut() {
    return storageGet(optOutKey) === "1";
  }

  window.VisitorAnalytics = Object.freeze({
    isOptedOut: isOptedOut,
    optOut: function () {
      storageSet(optOutKey, "1");
      storageRemove(visitorKey);
      storageRemove(sessionKey);
    },
    optIn: function () {
      storageRemove(optOutKey);
    },
  });

  function externalReferrerHost() {
    if (!document.referrer) {
      return "";
    }
    try {
      var referrer = new URL(document.referrer);
      return referrer.hostname === window.location.hostname ? "" : referrer.hostname.slice(0, 255);
    } catch (_error) {
      return "";
    }
  }

  function validEndpoint(endpoint) {
    if (typeof endpoint !== "string" || endpoint.length > 500) {
      return false;
    }
    try {
      var url = new URL(endpoint);
      return url.pathname.endsWith("/api/event") &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
    } catch (_error) {
      return false;
    }
  }

  function sendPageView() {
    var endpoint = config.endpoint;
    if (window.top !== window.self || !validEndpoint(endpoint) || hasPrivacySignal() || isOptedOut()) {
      return;
    }
    if (document.querySelector('meta[name="visitor-analytics"][content="disabled"]')) {
      return;
    }

    var now = Date.now();
    var body = JSON.stringify({
      version: 1,
      siteId: siteId,
      visitorId: getVisitorId(),
      sessionId: getSessionId(now),
      path: window.location.pathname.slice(0, 512),
      referrerHost: externalReferrerHost(),
    });

    if (navigator.sendBeacon) {
      var queued = navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" }));
      if (queued) {
        return;
      }
    }

    window.fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: body,
    }).catch(function () {
      // Analytics must never interfere with the website experience.
    });
  }

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(sendPageView, { timeout: 1500 });
  } else {
    window.setTimeout(sendPageView, 0);
  }
}());
