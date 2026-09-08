const { spawn } = require("node:child_process");

function readBoolEnv(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function encodePowerShell(value) {
  return Buffer.from(String(value || ""), "utf16le").toString("base64");
}

function encodeUtf8(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function buildToastCommand(title, message) {
  const titleBase64 = encodeUtf8(title);
  const messageBase64 = encodeUtf8(message);
  return [
    "$ErrorActionPreference = 'Stop'",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
    `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleBase64}'))`,
    `$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${messageBase64}'))`,
    "$text = $xml.GetElementsByTagName('text')",
    "[void]$text.Item(0).AppendChild($xml.CreateTextNode($title))",
    "[void]$text.Item(1).AppendChild($xml.CreateTextNode($message))",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)",
  ].join("; ");
}

function showWindowsToast({ title, message }) {
  if (process.platform !== "win32") {
    return Promise.resolve({ sent: false, reason: "unsupported_platform" });
  }

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(buildToastCommand(title, message)),
    ], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      resolve({ sent: false, reason: String(error?.message || error) });
    });
    child.once("close", (code) => {
      resolve(code === 0
        ? { sent: true }
        : { sent: false, reason: stderr.trim() || `PowerShell exited with ${code}` });
    });
  });
}

class DesktopNotificationService {
  constructor({ enabled = readBoolEnv("VISA_ENABLE_DESKTOP_NOTIFICATIONS") === true } = {}) {
    this.enabled = Boolean(enabled);
  }

  async notifyBookingSuccess({ session, booking } = {}) {
    if (!this.enabled) return { sent: false, reason: "disabled" };
    const account = String(session?.config?.displayName || session?.config?.email || "Account").trim();
    const date = String(booking?.dateKey || "date unavailable").trim();
    const time = String(booking?.timeSlot || "time unavailable").trim();
    return showWindowsToast({
      title: "Lighthing Bot — Booking confirmed",
      message: `${account}: ${date} at ${time}`,
    });
  }
}

module.exports = { DesktopNotificationService, showWindowsToast };
