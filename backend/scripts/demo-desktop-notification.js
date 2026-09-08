const { showWindowsToast } = require("../src/services/desktopNotifications");

showWindowsToast({
  title: "Lighthing Bot — Booking confirmed",
  message: "Mykie: 27 Jan 2027 at 8:30 AM",
}).then((result) => {
  if (!result.sent) {
    console.error(`Desktop notification was not sent: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("Desktop notification request sent.");
});
