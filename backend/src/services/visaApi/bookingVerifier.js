const { parseIsoDateOnly } = require("./dateSelector");

function appointmentMatchesSubmission(appointment, payload) {
  if (!appointment || !payload) return false;

  const appointmentDate = parseIsoDateOnly(appointment.appointmentDt);
  const payloadDate = parseIsoDateOnly(payload.appointmentDt);

  return (
    String(appointment.applicationId) === String(payload.applicationId) &&
    String(appointment.applicantId) === String(payload.applicantId) &&
    String(appointment.appointmentId) === String(payload.appointmentId) &&
    String(appointment.appointmentStatus) === "SCHEDULED" &&
    appointmentDate === payloadDate &&
    String(appointment.appointmentTime || "").trim() ===
      String(payload.appointmentTime || "").trim() &&
    String(appointment.slotId || "") === String(payload.slotId || "")
  );
}

function findVerifiedAppointment(appointments, payload) {
  if (!Array.isArray(appointments)) return null;
  return (
    appointments.find((appointment) =>
      appointmentMatchesSubmission(appointment, payload),
    ) || null
  );
}

module.exports = {
  appointmentMatchesSubmission,
  findVerifiedAppointment,
};
