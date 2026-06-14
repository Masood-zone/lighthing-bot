const { VisaApplicationNotFoundError, VisaApiContractError } = require("./errors");

function collectValuesDeep(value, keyName, output = []) {
  if (value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectValuesDeep(item, keyName, output);
    return output;
  }
  if (typeof value !== "object") return output;

  for (const [key, child] of Object.entries(value)) {
    if (key === keyName && child !== null && child !== undefined && child !== "") {
      output.push(child);
    }
    collectValuesDeep(child, keyName, output);
  }

  return output;
}

function firstValueDeep(value, keyName) {
  return collectValuesDeep(value, keyName)[0] || null;
}

function parseRequestPostData(postData) {
  if (!postData || typeof postData !== "string") return null;
  try {
    return JSON.parse(postData);
  } catch {
    return null;
  }
}

function applicationIdsFromNetwork(networkState) {
  const ids = [];
  for (const request of networkState?.requests || []) {
    const url = String(request.url || "");
    const transformMatch = url.match(/getTransformData\/([^/?#]+)/i);
    if (transformMatch?.[1]) ids.push(decodeURIComponent(transformMatch[1]));

    const body = parseRequestPostData(request.postData);
    if (body) ids.push(...collectValuesDeep(body, "applicationId"));
  }
  return Array.from(new Set(ids.map(String).filter(Boolean)));
}

function chooseAppointment(appointments, { mode, applicationId, applicantId }) {
  if (!Array.isArray(appointments)) return null;
  const wantedStatus = mode === "reschedule" ? "SCHEDULED" : "NEW";
  const matches = appointments.filter((appointment) => {
    if (String(appointment.appointmentStatus) !== wantedStatus) return false;
    if (
      applicationId &&
      String(appointment.applicationId) !== String(applicationId)
    ) {
      return false;
    }
    if (applicantId && String(appointment.applicantId) !== String(applicantId)) {
      return false;
    }
    return true;
  });

  if (mode === "reschedule") {
    return (
      matches
        .slice()
        .sort(
          (a, b) =>
            (Date.parse(b.appointmentDt || b.createdDt || "") || 0) -
            (Date.parse(a.appointmentDt || a.createdDt || "") || 0),
        )[0] || null
    );
  }

  return (
    matches
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(b.createdDt || "") || 0) -
          (Date.parse(a.createdDt || "") || 0),
      )[0] || null
  );
}

async function resolveApplicantContext({
  client,
  mode,
  networkState,
  bootstrapData,
}) {
  const knownApplicationIds = [
    ...applicationIdsFromNetwork(networkState),
    ...collectValuesDeep(bootstrapData, "applicationId"),
  ];
  const uniqueApplicationIds = Array.from(
    new Set(knownApplicationIds.map(String).filter(Boolean)),
  );

  let lastAppointments = [];
  for (const applicationId of uniqueApplicationIds) {
    // eslint-disable-next-line no-await-in-loop
    const appointments = await client.searchCurrentAppointments(applicationId);
    lastAppointments = appointments;
    const appointment = chooseAppointment(appointments, { mode, applicationId });
    if (appointment) {
      return {
        applicationId: String(appointment.applicationId || applicationId),
        applicantId: String(appointment.applicantId || ""),
        appointment,
        appointments,
      };
    }
  }

  if (!uniqueApplicationIds.length) {
    const appId = firstValueDeep(bootstrapData, "applicationId");
    if (!appId) {
      throw new VisaApplicationNotFoundError(
        "Could not resolve applicationId from authenticated responses",
      );
    }
  }

  if (lastAppointments.length > 0) {
    throw new VisaApiContractError(
      `No ${mode === "reschedule" ? "SCHEDULED" : "NEW"} appointment found for resolved application`,
    );
  }

  throw new VisaApplicationNotFoundError("No appointment records found");
}

function buildAvailabilityContext(appointment) {
  const context = {
    postUserId: appointment?.postUserId,
    applicantId: appointment?.applicantId,
    applicationId: appointment?.applicationId,
    locationType: appointment?.appointmentLocationType || "POST",
    visaClass: appointment?.visaClass,
    visaType: appointment?.visaType,
  };

  for (const [key, value] of Object.entries(context)) {
    if (value === null || value === undefined || value === "") {
      throw new VisaApiContractError(`Missing ${key} for availability request`);
    }
  }

  return context;
}

module.exports = {
  collectValuesDeep,
  firstValueDeep,
  resolveApplicantContext,
  chooseAppointment,
  buildAvailabilityContext,
};
