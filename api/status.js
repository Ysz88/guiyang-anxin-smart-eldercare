function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  const ownOrigin = req.headers.host ? `https://${req.headers.host}` : "";
  const allowedOrigin = String(process.env.ALLOWED_ORIGIN || "");
  if (origin && (origin === ownOrigin || origin === allowedOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  return res.status(200).json({
    configured: Boolean(process.env.DEEPSEEK_API_KEY),
    provider: "DeepSeek",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    model_adjusted: false,
    source: "Vercel encrypted environment variable",
    video_upload: false,
    database: null
  });
};
