// LinkedIn DevOps Scanner - Post DOM Helpers
// Pure functions for extracting text and URL from LinkedIn post elements.

function getPostText(postEl) {
  const bodySelectors = [
    "[data-testid='expandable-text-box']",
    ".feed-shared-update-v2__description",
    ".update-components-text",
    ".feed-shared-text",
    ".feed-shared-inline-show-more-text",
    ".update-components-update-v2__commentary",
    "[data-test-id='main-feed-activity-card__commentary']",
  ];
  const parts = [];
  bodySelectors.forEach((sel) => {
    postEl.querySelectorAll(sel).forEach((n) => {
      const txt = n.innerText || n.textContent || "";
      if (txt) parts.push(txt);
    });
  });
  if (parts.length === 0) {
    parts.push(postEl.innerText || postEl.textContent || "");
  }
  return parts.join("\n");
}

// Returns only the post author's body text: no fallback to full element so
// comments and replies are never included. Used for email extraction.
function getPostBodyOnly(postEl) {
  const bodySelectors = [
    "[data-testid='expandable-text-box']",
    ".feed-shared-update-v2__description",
    ".update-components-text",
    ".feed-shared-text",
    ".feed-shared-inline-show-more-text",
    ".update-components-update-v2__commentary",
    "[data-test-id='main-feed-activity-card__commentary']",
  ];
  const parts = [];
  bodySelectors.forEach((sel) => {
    postEl.querySelectorAll(sel).forEach((n) => {
      if (n.closest('.comments-container, .social-details-social-activity, [data-test-id="comments-container"]')) return;
      const txt = n.innerText || n.textContent || "";
      if (txt) parts.push(txt);
    });
  });
  if (parts.length === 0) {
    const clone = postEl.cloneNode(true);
    clone.querySelectorAll('.devops-scan-bar, .comments-container, .social-details-social-activity, [data-test-id="comments-container"]').forEach(function(n){ n.remove(); });
    const txt = (clone.innerText || clone.textContent || '').trim();
    if (txt) parts.push(txt);
  }
  return parts.join("\n");
}

function getPostUrl(postEl) {
  let urn = postEl.getAttribute("data-urn");
  if (!urn) {
    const inner = postEl.querySelector("[data-urn*=':activity:']");
    if (inner) urn = inner.getAttribute("data-urn");
  }
  if (urn && urn.includes(":activity:")) {
    const id = urn.split(":activity:")[1];
    return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
  }
  const a = postEl.querySelector(
    "a[href*='/feed/update/'], a[href*='/posts/'], a.app-aware-link[href*='/feed/update/'], a.app-aware-link[href*='/posts/']"
  );
  return a ? a.href : null;
}
