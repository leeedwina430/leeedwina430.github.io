---
permalink: /privacy/
title: "Privacy & Analytics"
modified: 2026-08-30
author_profile: false
visitor_analytics: false
---

This site uses a privacy-preserving, pseudonymous visitor analytics system to
understand broad usage patterns and improve the website. It does not use Google
Analytics or an analytics cookie.

## What is collected

- A random browser identifier stored in local storage to estimate new and returning visitors.
- A random session identifier. A session expires after 30 minutes of inactivity.
- The page path without its query string or fragment.
- The hostname of an external referrer, when available.
- A broad device category.
- Approximate country, region, and city supplied by Cloudflare.

Cloudflare necessarily processes the network request and its IP address. The
analytics database does not store the raw IP address. A keyed digest scoped to
one minute is used only to limit abusive request rates.

Approximate location may be wrong when a visitor uses a VPN, proxy, mobile
network, or shared gateway. Visitor-level records are deleted after 180 days.

Global Privacy Control, Do Not Track, and the local choice below are respected.
Clearing browser storage, changing browsers or devices, or using private browsing
can create a new random identifier. "Unique visitors" is therefore an estimate,
not a verified count of people.

## Your choice

This privacy page is never counted. You can disable or re-enable analytics for
this browser at any time. Re-enabling takes effect on the next counted page view.

<div class="notice--info" id="visitor-analytics-controls">
  <p id="visitor-analytics-status" role="status" aria-live="polite">Checking your current preference...</p>
  <button type="button" class="btn" id="visitor-analytics-opt-out">Disable visitor analytics</button>
  <button type="button" class="btn btn--inverse" id="visitor-analytics-opt-in" hidden>Enable visitor analytics</button>
</div>

<script>
(function () {
  "use strict";

  function initializeControls() {
    var analytics = window.VisitorAnalytics;
    var status = document.getElementById("visitor-analytics-status");
    var optOut = document.getElementById("visitor-analytics-opt-out");
    var optIn = document.getElementById("visitor-analytics-opt-in");

    if (!analytics || !status || !optOut || !optIn) {
      if (status) {
        status.textContent = "Analytics controls could not be loaded in this browser.";
      }
      return;
    }

    function render() {
      var optedOut = analytics.isOptedOut();
      status.textContent = optedOut
        ? "Visitor analytics is disabled in this browser."
        : "Visitor analytics is enabled in this browser.";
      optOut.hidden = optedOut;
      optIn.hidden = !optedOut;
    }

    optOut.addEventListener("click", function () {
      analytics.optOut();
      render();
    });
    optIn.addEventListener("click", function () {
      analytics.optIn();
      render();
    });
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeControls);
  } else {
    initializeControls();
  }
}());
</script>
