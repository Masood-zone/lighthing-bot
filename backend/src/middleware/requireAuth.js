function getBearerToken(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function requireAuth({ authService, userStore }) {
  return (req, res, next) => {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const rec = authService.authenticate(token);
    if (!rec) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const user = userStore.getUser(rec.userId);
    if (!user) {
      authService.revoke(token);
      return res.status(401).json({ error: "unauthorized" });
    }

    req.auth = {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      expiresAt: rec.expiresAt,
    };

    return next();
  };
}

module.exports = { requireAuth };
