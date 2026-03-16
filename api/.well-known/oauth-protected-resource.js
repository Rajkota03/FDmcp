module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const baseUrl = `https://${req.headers.host}`;
  res.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
  });
};
