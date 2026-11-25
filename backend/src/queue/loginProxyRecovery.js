function requestLoginProxy(page, channel = process) {
  return new Promise((resolve, reject) => {
    const requestId = require("node:crypto").randomUUID();
    const finish = (error, value) => {
      clearTimeout(timer);
      channel.removeListener("message", onMessage);
      channel.removeListener("disconnect", onDisconnect);
      page.removeListener("close", onClose);
      error ? reject(error) : resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type !== "login_proxy_result" || message.requestId !== requestId) return;
      if (!message.proxyUrl) finish(new Error("No different verified proxy is available; manual review required"));
      else finish(null, message.proxyUrl);
    };
    const onClose = () => finish(new Error("Login browser closed during proxy recovery"));
    const onDisconnect = () => finish(new Error("Backend disconnected during proxy recovery"));
    const timer = setTimeout(() => finish(new Error("Proxy recovery timed out")), 120000);
    channel.on("message", onMessage);
    channel.once("disconnect", onDisconnect);
    page.once("close", onClose);
    if (page.isClosed?.()) return onClose();
    if (!channel.send || channel.connected === false) return onDisconnect();
    try {
      channel.send({ type: "login_proxy_request", requestId }, (error) => { if (error) finish(error); });
    } catch (error) { finish(error); }
  });
}

function loginForbidden(response) {
  if (response?.status() !== 403) return;
  const error = new Error("Visa login page returned HTTP 403");
  error.code = "VISA_LOGIN_FORBIDDEN";
  return error;
}

module.exports = { requestLoginProxy, loginForbidden };
