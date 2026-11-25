// Proteção por senha única (APP_PASSWORD). Depois de entrar, o aparelho fica
// lembrado por 1 ano via cookie — a TV só precisa digitar a senha uma vez.
import crypto from "node:crypto";

const COOKIE = "fin_session";
const ONE_YEAR = 365 * 24 * 3600;

const sessionValue = (password) =>
  crypto.createHmac("sha256", password).update("financas-session-v1").digest("hex");

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function authRoutes(app, password) {
  app.post("/api/login", (req, res) => {
    if (!password) return res.json({ ok: true });
    if (!safeEqual(req.body?.password ?? "", password)) {
      return res.status(401).json({ error: "Senha incorreta." });
    }
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie",
      `${COOKIE}=${sessionValue(password)}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
    res.json({ ok: true });
  });

  app.post("/api/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  });

  // Tudo em /api exige sessão, exceto o login.
  app.use("/api", (req, res, next) => {
    if (!password) return next();
    if (safeEqual(readCookie(req, COOKIE) ?? "", sessionValue(password))) return next();
    res.status(401).json({ error: "login" });
  });
}
