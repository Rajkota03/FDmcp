const crypto = require("crypto");

module.exports = function handler(req, res) {
  // Auto-approve: redirect back with an authorization code
  const redirectUri = req.query.redirect_uri;
  const state = req.query.state || "";
  const code = crypto.randomUUID();

  if (!redirectUri) {
    return res.status(400).json({ error: "Missing redirect_uri" });
  }

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  res.redirect(302, url.toString());
};
