const { platformDateTime } = require("./dateSelector");
const { formatAppointmentTime } = require("./slotSelector");
const { VisaApiContractError } = require("./errors");

function required(value, name) {
  if (value === null || value === undefined || value === "") {
    throw new VisaApiContractError(`Missing required booking field: ${name}`);
  }
  return value;
}

function buildAppointmentPayload({ appointment, selectedDate, selectedSlot }) {
  const appointmentDt = platformDateTime(selectedDate);
  const appointmentTime = formatAppointmentTime(selectedSlot?.startTime);

  if (!appointmentDt) {
    throw new VisaApiContractError("Selected date is not a valid date");
  }
  if (!appointmentTime) {
    throw new VisaApiContractError("Selected slot startTime is invalid");
  }

  return {
    applicantId: required(appointment?.applicantId, "applicantId"),
    applicantUUID: appointment?.applicantUUID ?? null,
    applicationId: required(appointment?.applicationId, "applicationId"),
    appointmentDt,
    appointmentId: required(appointment?.appointmentId, "appointmentId"),
    appointmentLocationType: required(
      appointment?.appointmentLocationType,
      "appointmentLocationType",
    ),
    appointmentStatus: "SCHEDULED",
    appointmentTime,
    postUserId: required(appointment?.postUserId, "postUserId"),
    slotId: required(selectedSlot?.slotId, "slotId"),
  };
}

function fingerprintAttempt({ accountId, payload }) {
  return {
    accountId,
    applicationId: payload.applicationId,
    appointmentId: payload.appointmentId,
    slotId: payload.slotId,
    appointmentDt: payload.appointmentDt,
    appointmentTime: payload.appointmentTime,
  };
}

module.exports = { buildAppointmentPayload, fingerprintAttempt };
