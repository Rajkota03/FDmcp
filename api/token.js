const crypto = require("crypto");

module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Always issue a token — auto-approve everything
  res.json({
    access_token: crypto.randomUUID(),
    token_type: "Bearer",
    expires_in: 86400,
    refresh_token: crypto.randomUUID(),
  });
};
