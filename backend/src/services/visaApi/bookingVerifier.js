const { parseIsoDateOnly } = require("./dateSelector");

function appointmentMatchesSubmission(appointment, payload, { mode = "pending" } = {}) {
  if (!appointment || !payload) return false;

  const appointmentDate = parseIsoDateOnly(appointment.appointmentDt);
  const payloadDate = parseIsoDateOnly(payload.appointmentDt);

  const isReschedule = mode === "reschedule";

  return (
    String(appointment.applicationId) === String(payload.applicationId) &&
    String(appointment.applicantId) === String(payload.applicantId) &&
    (isReschedule ||
      String(appointment.appointmentId) === String(payload.appointmentId)) &&
    String(appointment.appointmentStatus) ===
      (isReschedule ? "RESCHEDULED" : "SCHEDULED") &&
    appointmentDate === payloadDate &&
    String(appointment.appointmentTime || "").trim() ===
      String(payload.appointmentTime || "").trim()
  );
}

module.exports = {
  appointmentMatchesSubmission,
};
