module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ status: "ok", name: "Final Draft MCP", version: "1.0.0" });
};
