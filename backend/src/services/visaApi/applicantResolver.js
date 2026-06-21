const {
  VisaApplicationNotFoundError,
  VisaApiContractError,
} = require("./errors");

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
  for (const response of networkState?.responses || []) {
    if (response?.body) {
      ids.push(...collectValuesDeep(response.body, "applicationId"));
    }
  }
  return Array.from(new Set(ids.map(String).filter(Boolean)));
}

function appointmentResponsesFromNetwork(networkState) {
  const appointments = [];
  for (const response of networkState?.responses || []) {
    const url = String(response?.url || "");
    if (!/\/visaappointmentapi\/appointments\/search/i.test(url)) continue;
    if (!Array.isArray(response.body)) continue;
    appointments.push(...response.body);
  }
  return appointments;
}

function bootstrapSources({ networkState, bootstrapData }) {
  const sources = [];

  if (bootstrapData !== undefined) sources.push(bootstrapData);

  for (const response of networkState?.responses || []) {
    if (response?.body) sources.push(response.body);
  }

  for (const request of networkState?.requests || []) {
    const body = parseRequestPostData(request?.postData);
    if (body) sources.push(body);
  }

  return sources;
}

function firstKnownValue(sources, keys) {
  for (const key of keys) {
    for (const source of sources) {
      const value = firstValueDeep(source, key);
      if (value !== null && value !== undefined && value !== "") {
        return value;
      }
    }
  }
  return null;
}

const REQUIRED_APPOINTMENT_FIELDS = [
  "applicationId",
  "applicantId",
  "appointmentId",
  "visaType",
  "visaClass",
  "appointmentLocationType",
];

function missingAppointmentFields(appointment) {
  return REQUIRED_APPOINTMENT_FIELDS.filter((key) => {
    const value = appointment?.[key];
    return value === null || value === undefined || value === "";
  });
}

function isCompleteAppointment(appointment, mode) {
  const expectedStatus = mode === "reschedule" ? "SCHEDULED" : "NEW";
  return (
    missingAppointmentFields(appointment).length === 0 &&
    String(appointment?.appointmentStatus || "").toUpperCase() === expectedStatus
  );
}

function contextDiagnostics({ mode, networkState, bootstrapData }) {
  const sources = bootstrapSources({ networkState, bootstrapData });
  const candidate = {
    applicationId: firstKnownValue(sources, ["applicationId"]),
    applicantId: firstKnownValue(sources, ["applicantId"]),
    appointmentId: firstKnownValue(sources, ["appointmentId"]),
    visaType: firstKnownValue(sources, ["visaType"]),
    visaClass: firstKnownValue(sources, ["visaClass"]),
    appointmentLocationType: firstKnownValue(sources, [
      "appointmentLocationType",
      "locationType",
    ]),
  };
  return {
    mode,
    missingFields: missingAppointmentFields(candidate),
    capturedRequests: networkState?.requests?.length || 0,
    capturedResponses: networkState?.responses?.length || 0,
    appointmentSearchResponses: appointmentResponsesFromNetwork(networkState).length,
    applicationIds: applicationIdsFromNetwork(networkState).length,
  };
}

function synthesizeAppointmentContext({ mode, networkState, bootstrapData }) {
  const sources = bootstrapSources({ networkState, bootstrapData });
  const applicationId = firstKnownValue(sources, ["applicationId"]);
  const applicantId = firstKnownValue(sources, ["applicantId"]);
  const appointmentId = firstKnownValue(sources, ["appointmentId"]);
  const appointmentUUID = firstKnownValue(sources, ["appointmentUUID"]);
  const applicantUUID = firstKnownValue(sources, ["applicantUUID"]);
  const postUserId = firstKnownValue(sources, ["postUserId"]);
  const missionId = firstKnownValue(sources, ["missionId"]);
  const visaType = firstKnownValue(sources, ["visaType"]);
  const visaClass = firstKnownValue(sources, ["visaClass"]);
  const visaCategory = firstKnownValue(sources, ["visaCategory"]);
  const appointmentLocationType = firstKnownValue(sources, [
    "appointmentLocationType",
    "locationType",
  ]);
  const appointmentStatus = mode === "reschedule" ? "SCHEDULED" : "NEW";

  if (
    !applicationId ||
    !applicantId ||
    !appointmentId ||
    !visaType ||
    !visaClass ||
    !appointmentLocationType
  ) {
    return null;
  }

  return {
    applicationId: String(applicationId),
    applicantId: String(applicantId),
    appointment: {
      applicantId: String(applicantId),
      applicantUUID: applicantUUID ?? null,
      applicationId: String(applicationId),
      appointmentId: appointmentId == null ? null : String(appointmentId),
      appointmentLocationType,
      appointmentStatus,
      appointmentType: firstKnownValue(sources, ["appointmentType"]) || null,
      appointmentUUID: appointmentUUID ?? null,
      missionId: missionId ?? null,
      postUserId: postUserId == null ? null : String(postUserId),
      visaCategory: visaCategory ?? null,
      visaClass: String(visaClass),
      visaType: String(visaType),
    },
    appointments: [],
    source: "synthetic_context_from_bootstrap",
  };
}

function chooseAppointment(appointments, { mode, applicationId, applicantId }) {
  if (!Array.isArray(appointments)) return null;
  const wantedStatus = mode === "reschedule" ? "SCHEDULED" : "NEW";
  const matches = appointments.filter((appointment) => {
    if (String(appointment.appointmentStatus).toUpperCase() !== wantedStatus) {
      return false;
    }
    if (!isCompleteAppointment(appointment, mode)) return false;
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
  allowDirectSearch = false,
}) {
  const knownApplicationIds = [
    ...applicationIdsFromNetwork(networkState),
    ...collectValuesDeep(bootstrapData, "applicationId"),
  ];
  const uniqueApplicationIds = Array.from(
    new Set(knownApplicationIds.map(String).filter(Boolean)),
  );

  const capturedAppointments = appointmentResponsesFromNetwork(networkState);
  const capturedAppointment = chooseAppointment(capturedAppointments, { mode });
  if (capturedAppointment) {
    return {
      applicationId: String(capturedAppointment.applicationId || ""),
      applicantId: String(capturedAppointment.applicantId || ""),
      appointment: capturedAppointment,
      appointments: capturedAppointments,
      source: "captured_appointments_search",
    };
  }

  const synthetic = synthesizeAppointmentContext({
    mode,
    networkState,
    bootstrapData,
  });
  if (synthetic) {
    return synthetic;
  }

  if (allowDirectSearch && client) {
    let lastAppointments = [];
    for (const applicationId of uniqueApplicationIds) {
      // eslint-disable-next-line no-await-in-loop
      const appointments = await client.searchCurrentAppointments(applicationId);
      lastAppointments = appointments;
      const appointment = chooseAppointment(appointments, {
        mode,
        applicationId,
      });
      if (appointment) {
        return {
          applicationId: String(appointment.applicationId || applicationId),
          applicantId: String(appointment.applicantId || ""),
          appointment,
          appointments,
          source: "direct_appointments_search",
        };
      }
    }
    if (lastAppointments.length > 0) {
      throw new VisaApiContractError(
        `No complete ${mode === "reschedule" ? "SCHEDULED" : "NEW"} appointment found`,
      );
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

  throw new VisaApplicationNotFoundError(
    "No appointment context found in authenticated responses",
  );
}

function buildAvailabilityContext(appointment, { postUserIdOverride } = {}) {
  const context = {
    postUserId: postUserIdOverride || appointment?.postUserId,
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
  synthesizeAppointmentContext,
  applicationIdsFromNetwork,
  appointmentResponsesFromNetwork,
  missingAppointmentFields,
  isCompleteAppointment,
  contextDiagnostics,
  buildAvailabilityContext,
};
