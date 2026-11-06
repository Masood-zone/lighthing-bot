const HUNT_WINDOW_MS = 60 * 60 * 1000;

class HuntWindowExpiredError extends Error {
  constructor() {
    super("The one-hour hunting window has ended");
    this.name = "HuntWindowExpiredError";
  }
}

function createHuntWindow({
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let deadline = 0;
  return {
    start() {
      deadline = now() + HUNT_WINDOW_MS;
    },
    remaining() {
      return Math.max(0, deadline - now());
    },
    expired() {
      return now() >= deadline;
    },
    assertOpen() {
      if (now() >= deadline) throw new HuntWindowExpiredError();
    },
    wait(ms) {
      return sleep(Math.min(ms, Math.max(0, deadline - now())));
    },
  };
}

// Register before requesting admission so an immediate grant cannot be lost.
function createResumeGate(channel = process) {
  let sequence = 0;
  return {
    request(page) {
      const requestId = ++sequence;
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          channel.removeListener("message", onMessage);
          channel.removeListener("disconnect", onDisconnect);
          page.removeListener("close", onClose);
        };
        const fail = (message) => {
          cleanup();
          reject(new Error(message));
        };
        const onClose = () =>
          fail("Browser closed while waiting for a hunting slot");
        const onDisconnect = () =>
          fail("Worker disconnected while waiting for a hunting slot");
        const onMessage = (message) => {
          if (
            message?.type !== "hunt_resume_granted" ||
            message.requestId !== requestId
          )
            return;
          cleanup();
          resolve();
        };
        if (page.isClosed?.()) return onClose();
        channel.on("message", onMessage);
        channel.once("disconnect", onDisconnect);
        page.once("close", onClose);
        if (!channel.send || channel.connected === false) return onDisconnect();
        try {
          channel.send(
            { type: "hunt_resume_requested", requestId },
            (error) => {
              if (error) fail("Could not request a hunting slot");
            },
          );
        } catch {
          onDisconnect();
        }
      });
    },
  };
}

module.exports = {
  HUNT_WINDOW_MS,
  HuntWindowExpiredError,
  createHuntWindow,
  createResumeGate,
};
