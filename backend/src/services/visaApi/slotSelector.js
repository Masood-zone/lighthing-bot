function parseSlotStart(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatAppointmentTime(startTime) {
  const date = parseSlotStart(startTime);
  if (!date) return null;

  let hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours %= 12;
  if (hours === 0) hours = 12;

  return `${hours}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

function isUsableSlot(slot) {
  if (!slot || typeof slot !== "object") return false;
  if (!slot.slotId) return false;
  if (slot.slotStatus !== "UNBOOKED") return false;
  if (slot.status !== "A") return false;
  return Boolean(parseSlotStart(slot.startTime));
}

function selectEarliestUsableSlot(slots) {
  if (!Array.isArray(slots)) {
    return { selectedSlot: null, reason: "slots_not_array" };
  }

  const usable = slots
    .filter(isUsableSlot)
    .map((slot) => ({
      slot,
      start: parseSlotStart(slot.startTime).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  if (!usable.length) {
    return { selectedSlot: null, reason: "no_usable_slots" };
  }

  return { selectedSlot: usable[0].slot, reason: "earliest_usable_slot" };
}

module.exports = {
  formatAppointmentTime,
  isUsableSlot,
  selectEarliestUsableSlot,
};
