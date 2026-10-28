/**
 * Retroflex tablet pairing shell.
 *
 * Kept as an external file (rather than inline in tablet.html) so that page can
 * run `script-src 'self'` — an inline block would force 'unsafe-inline' on a
 * page whose whole job is to be a trustworthy pairing entry point.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var code = params.get("display");
  var position = params.get("position") === "front" ? "front" : "rear";
  document.getElementById("position-label").textContent =
    "Retroflex · " + (position === "front" ? "Front" : "Rear") + " Tablet";
  var root = window.location.pathname.replace(/tablet\.html$/, "");
  if (!root.endsWith("/")) root += "/";
  function openDisplay(value) {
    var clean = String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (clean.length !== 6) return;
    window.location.replace(
      root + "?mode=tablet&position=" + position + "&display=" + encodeURIComponent(clean)
    );
  }
  if (code) openDisplay(code);
  document.getElementById("pair-form").addEventListener("submit", function (event) {
    event.preventDefault();
    openDisplay(document.getElementById("pair-code").value);
  });
})();
